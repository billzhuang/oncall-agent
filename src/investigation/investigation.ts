import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry } from "@earendil-works/pi-durable";
import { Lifecycle, type LifecycleJobContext } from "agents/lifecycle";
import { orgByName, type OncallConfig, type Org } from "../config";
import type { InvestigationRef } from "../coordinator";
import { DatadogConnection, type DatadogToolSpec } from "../datadog-mcp";
import { coordinatorStub } from "../durable";
import type { Alert } from "../intake";
import { ports } from "../ports";
import { checkOutDeployedCommit, checkoutFailedLine, type WorkspaceState } from "../workspace/checkout";
import { codeLine, reminderFor, resolveRepo, type RepoResolution } from "../repo-resolution";
import { postToTeams, teamsChannelSecret, type TeamsMessage, type TeamsMessageKind } from "../teams";
import {
  MODEL_PROVIDER,
  alertPrompt,
  createAgentHarness,
  installDatadogTools,
  installWorkspaceTools,
  modelAvailable,
  type AgentHost,
  type WorkspaceTools,
} from "./agent";
import { agentBranch, blockedPaths, pushAgentPr, reportOnly, retryable, type AgentPrRecord } from "./agent-pr";
import {
  MAX_EVIDENCE_LINES,
  agentPrBody,
  boundedReport,
  budgetExhaustedMessage,
  evidenceLine,
  failedMessage,
  partialMessage,
  reportMessage,
  stoppedMessage,
  type InvestigationRecord,
  type InvestigationReport,
} from "./report";

/** Investigation lifecycle: Queued -> Running -> one of the finished states. */
export type InvestigationStatus = "Queued" | "Running" | "Completed" | "Partial" | "Failed" | "Stopped" | "Skipped";

/** The Alert episode this Durable Object hosts, and its Investigation. */
interface Episode {
  /** 1 for the first Alert episode of this monitor group; a later Triggered after a Recovered opens the next. */
  number: number;
  /** The Triggered alert that opened the episode. */
  alert: Alert;
  openedAt: number;
  status: InvestigationStatus;
  startedAt?: number;
  finishedAt?: number;
  /** Why the Investigation ended as it did (Failed, Partial, Stopped). */
  reason?: string;
  /** Model spend and wall-clock duration, recorded when the Investigation finishes. */
  costUsd?: number;
  durationMs?: number;
  /** Re-triggers that joined this episode. */
  retriggers: number;
  lastTriggeredAt: number;
  /** Set when the episode ends (Recovered, #3). Until then every Triggered joins this Investigation. */
  closedAt?: number;
}

/** What a notification did, returned to intake (and Datadog) for diagnostics. */
export type TriggerOutcome = "opened" | "joined" | "duplicate";
/** What a Recovered did: stopped the running Investigation, only closed the Alert episode, or nothing. */
export type RecoverOutcome = "stopped" | "closed" | "ignored" | "duplicate";

/** A Teams message of one kind for one Alert episode: meant to be sent (intent), and sent once Teams accepted it. */
interface OutboxEntry {
  intentAt: number;
  sentAt?: number;
  channel: string;
}

type FinishedStatus = Exclude<InvestigationStatus, "Queued" | "Running">;
const finished = (status: InvestigationStatus) => status !== "Queued" && status !== "Running";

/** Why the agent's run was interrupted, recorded durably before the run is aborted. */
export interface Interruption {
  /** Stopped (Recovered), or Partial (cost cap, time limit). */
  status: Extract<FinishedStatus, "Stopped" | "Partial">;
  reason: string;
}

const EPISODE = "episode";
const DATADOG_TOOLS = "datadog-tools";
/** A Triggered that arrived after a Recovered, while the closed episode's run was still being stopped. */
const PENDING_TRIGGER = "pending-trigger";
const MAX_JOB_FAILURES = 12;
/** How often a finalize that found the run still going looks again. Real time: it only schedules a wake-up. */
const RUN_POLL_MS = 30_000;

/** Storage keys per Alert episode, kept apart from the episode record so concurrent writers never clash. */
const reportKey = (e: Episode) => `report:${e.number}`;
const nudgedKey = (e: Episode) => `nudged:${e.number}`;
const costBaselineKey = (e: Episode) => `cost-baseline:${e.number}`;
const interruptedKey = (e: Episode) => `interrupted:${e.number}`;
const freshContextKey = (e: Episode) => `fresh-context:${e.number}`;
/** Set when a job gave up for good on this Alert episode (see `#abandon`). */
const abandonedKey = (e: Episode) => `abandoned:${e.number}`;
/** Set once the agent's one input was submitted. */
const submittedKey = (e: Episode) => `submitted:${e.number}`;
/** Evidence gathered by the agent's tools, one key per tool call so parallel and replayed calls never clash. */
const evidencePrefix = (e: Episode) => `evidence:${e.number}:`;
/** The episode's RepoResolution; when resolved it holds `{repoUrl, sha}`, the code the workspace (#7) reads. */
const repoKey = (e: Episode) => `repo:${e.number}`;
/** The episode's WorkspaceState: whether its code is checked out (never the token used to clone it). */
const workspaceKey = (e: Episode) => `workspace:${e.number}`;
/** The episode's AgentPrRecord; its GitHub steps are recorded under `${agentPrKey}:<step>`. */
const agentPrKey = (e: Episode) => `outbox:${e.number}:agent-pr`;
/** Tries of the finalize job before a GitHub failure is reported instead of retried. */
const AGENT_PR_ATTEMPTS = 4;
/** Whether the Coordinator granted this episode's reminder (decided once, so a retried run job keeps the answer). */
const reminderClaimKey = (e: Episode) => `reminder-claim:${e.number}`;
/** The agent's one submission per Alert episode; pi ignores a second submit with the same id. */
const operationId = (e: Episode) => `episode:${e.number}`;

/**
 * One Investigation per Alert episode `(org, monitor, group)`; named by `durable.ts`.
 *
 * The agent runs as a pi-durable session (PiHarness, see `agent.ts`). The Investigation gives it exactly one
 * input per Alert episode (job `run`), and once the run has ended, job `finalize` posts the outcome and
 * finishes the Investigation through `#finish`, the one place a finished state is recorded.
 *
 * Every RPC begins with `await this.lifecycle.start()`; never define `alarm()`/`fetch()` (Lifecycle owns them,
 * use `onAlarm`/`onJob`). Outward actions go through `#notify`, which checks the outbox first, because work
 * may be replayed after eviction.
 */
export class Investigation extends DurableObject<Env> {
  readonly registry = createRegistry();
  readonly datadog = new DatadogConnection(this.env, () => this.#org());
  readonly harness = createAgentHarness(this.#agentHost());
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  /**
   * A Triggered notification for this Alert episode. A delivery seen before has no effect; a re-trigger while
   * the episode is open only joins it (never a second agent run or report); otherwise a new episode opens.
   */
  async triggered(alert: Alert): Promise<TriggerOutcome> {
    await this.lifecycle.start();
    if (!(await this.#firstDelivery(alert))) return "duplicate";
    const now = ports().now();
    const current = await this.#episode();
    if (current && current.closedAt === undefined) {
      current.retriggers++;
      current.lastTriggeredAt = now;
      await this.#save(current);
      return "joined";
    }
    if (current && !finished(current.status)) {
      // Recovered, but its run is still being stopped: open the next Alert episode once it has finished.
      if (await this.ctx.storage.get(PENDING_TRIGGER)) return "joined";
      await this.ctx.storage.put(PENDING_TRIGGER, alert);
      return "opened";
    }
    await this.#open(alert, (current?.number ?? 0) + 1);
    return "opened";
  }

  /**
   * A Recovered notification: closes the open Alert episode. A running Investigation is stopped (Stopped) and
   * the stopped on recovery note posted; a finished one is left as it is. An Agent PR already opened stays.
   */
  async recovered(alert: Alert): Promise<RecoverOutcome> {
    await this.lifecycle.start();
    if (!(await this.#firstDelivery(alert))) return "duplicate";
    if (await this.ctx.storage.get(PENDING_TRIGGER)) {
      // The next Alert episode recovered before it opened.
      await this.ctx.storage.delete(PENDING_TRIGGER);
      return "closed";
    }
    const episode = await this.#episode();
    if (!episode || episode.closedAt !== undefined) return "ignored";
    episode.closedAt = ports().now();
    await this.#save(episode);
    if (episode.status === "Queued") {
      await this.#finish(episode, "Stopped", await this.#record(episode), "the monitor recovered before it started");
      return "closed";
    }
    if (episode.status !== "Running") return "closed";
    await this.interrupt({ status: "Stopped", reason: "the monitor recovered" });
    return "stopped";
  }

  /**
   * Interrupts the running agent: records why first (durable, so a crash before the abort is caught by
   * `#finalize`), aborts the run, then lets `#finalize` post the message and finish the Investigation.
   * Call from an RPC or `onAlarm`, or un-awaited from a hook: abort waits for the run to go idle.
   */
  private async interrupt(reason: Interruption): Promise<void> {
    if ((await this.#flagInterruption(reason)) === "not-running") return;
    await this.harness.abort();
    await this.#scheduleFinalize();
  }

  /**
   * `interrupt` for the run's own hooks and for alarms: records why, then aborts without waiting, since abort
   * waits for the run to go idle. `#finalize` re-aborts if an eviction came between the flag and the abort.
   */
  async #interruptFromRun(reason: Interruption): Promise<void> {
    if ((await this.#flagInterruption(reason)) !== "flagged") return; // one abort per run, not one per hook call
    void this.harness
      .abort()
      .then(() => this.#scheduleFinalize())
      .catch((error) => console.error(`Investigation ${this.lifecycle.name}: abort failed`, error));
  }

  /** Records why the run is interrupted; the first reason wins. */
  async #flagInterruption(reason: Interruption): Promise<"flagged" | "already-flagged" | "not-running"> {
    const episode = await this.#episode();
    if (!episode || finished(episode.status)) return "not-running";
    if (await this.ctx.storage.get(interruptedKey(episode))) return "already-flagged";
    await this.ctx.storage.put(interruptedKey(episode), reason);
    return "flagged";
  }

  /** Opens an Alert episode and starts its Investigation. */
  async #open(alert: Alert, number: number): Promise<void> {
    const now = ports().now();
    const episode: Episode = { number, alert, openedAt: now, status: "Queued", retriggers: 0, lastTriggeredAt: now };
    await this.#save(episode);
    await this.#start(episode);
  }

  /** Opens the Alert episode of a Triggered that arrived while the previous episode was being stopped. */
  async #openPending(): Promise<void> {
    const alert = await this.ctx.storage.get<Alert>(PENDING_TRIGGER);
    if (!alert) return;
    const current = await this.#episode();
    if (!current || finished(current.status)) await this.#open(alert, (current?.number ?? 0) + 1);
    await this.ctx.storage.delete(PENDING_TRIGGER);
  }

  /** Records a webhook delivery; false when it was seen before (a Datadog retry). */
  async #firstDelivery(alert: Alert): Promise<boolean> {
    const key = `delivery:${alert.transition}:${alert.alertId}`;
    if (await this.ctx.storage.get(key)) return false;
    await this.ctx.storage.put(key, ports().now());
    return true;
  }

  /**
   * Queued: asks the Coordinator for a run slot. A durable job, not inline: it survives eviction and a
   * Coordinator hiccup, and keeps Datadog round trips out of the webhook.
   */
  async #start(_episode: Episode): Promise<void> {
    await this.lifecycle.jobs.push({ id: "admit", fn: "admit", time: Date.now() });
  }

  /**
   * The Coordinator has a run slot for this waiting Investigation, or the daily budget ran out while it waited:
   * ask again. False when the episode is no longer waiting (it finished meanwhile), so the Coordinator moves on.
   */
  async slotGranted(episodeNumber: number): Promise<boolean> {
    await this.lifecycle.start();
    const episode = await this.#episode();
    if (!episode || episode.number !== episodeNumber || episode.status !== "Queued") return false;
    await this.#start(episode);
    return true;
  }

  /** Whether this Alert episode's Investigation has yet to finish: the Coordinator asks before reclaiming its slot. */
  async stillRunning(episodeNumber: number): Promise<boolean> {
    await this.lifecycle.start();
    const episode = await this.#episode();
    if (!episode || episode.number !== episodeNumber || finished(episode.status)) return false;
    return !(await this.ctx.storage.get(abandonedKey(episode)));
  }

  /**
   * The Coordinator took back this Investigation's run slot at its hard cap, well past the time limit: stop the
   * run (Partial). Does not wait for the abort, as the run may be wedged.
   */
  async overran(episodeNumber: number): Promise<void> {
    await this.lifecycle.start();
    const episode = await this.#episode();
    if (!episode || episode.number !== episodeNumber || episode.status !== "Running") return;
    const { budgets } = ports().config(this.env);
    await this.#interruptFromRun({
      status: "Partial",
      reason: `time limit of ${budgets.investigationMinutes} minutes long passed and its run slot was taken back`,
    });
  }

  /** Queued -> Running, once the Coordinator granted a run slot: the agent's run, and the time limit. */
  async #begin(episode: Episode): Promise<void> {
    episode.status = "Running";
    episode.startedAt = ports().now();
    await this.#save(episode);
    // A durable job, not inline: it survives eviction, and keeps Datadog round trips out of the webhook.
    await this.lifecycle.jobs.push({ id: "run", fn: "run", time: Date.now() });
    // A wake-up at the time limit (real time), so the limit holds even if the run is wedged between alarms.
    const { budgets } = ports().config(this.env);
    await this.lifecycle.jobs.push({ id: "deadline", fn: "deadline", time: Date.now() + budgets.investigationMinutes * 60_000 });
  }

  /** Every alarm (pi's heartbeat while the agent runs, job wake-ups otherwise) checks the time limit. */
  async onAlarm(): Promise<void> {
    await this.#serially("deadline", () => this.#checkDeadline());
  }

  /** Past its time limit, a Running Investigation is stopped (Partial), whatever its run is doing. */
  async #checkDeadline(): Promise<void> {
    const episode = await this.#episode();
    if (!episode || episode.status !== "Running" || episode.startedAt === undefined) return;
    const { budgets } = ports().config(this.env);
    if (ports().now() - episode.startedAt < budgets.investigationMinutes * 60_000) return;
    if (!(await this.ctx.storage.get(submittedKey(episode)))) {
      // The agent never got its input: the run job kept failing (e.g. Datadog MCP down). A crash, not a partial.
      const limit = `it did not start within ${budgets.investigationMinutes} minutes`;
      return this.#endWithoutReport(episode, await this.#runFailure(limit));
    }
    await this.#interruptFromRun({ status: "Partial", reason: `time limit of ${budgets.investigationMinutes} minutes reached` });
  }

  /**
   * Lifecycle may drive the same job from two overlapping alarm invocations (jobs are not single-flight by
   * default), and outward work awaits the network, so two runs of `finalize` could both find the outbox empty.
   * Each job function therefore runs one at a time in this instance; a second invocation waits for the first.
   */
  #jobRuns = new Map<string, Promise<unknown>>();

  async onJob(context: LifecycleJobContext): Promise<void | { rescheduleAt: number }> {
    return this.#serially(context.job.fn, () => this.#runJob(context));
  }

  /** Runs `work` after any earlier work under the same key in this instance has settled. */
  async #serially<T>(key: string, work: () => Promise<T>): Promise<T> {
    const run = (this.#jobRuns.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
    this.#jobRuns.set(key, run);
    try {
      return await run;
    } finally {
      if (this.#jobRuns.get(key) === run) this.#jobRuns.delete(key);
    }
  }

  async #runJob({ job }: LifecycleJobContext): Promise<void | { rescheduleAt: number }> {
    if (job.fn === "deadline") return this.#checkDeadline();
    if (job.fn === "admit") return this.#withBackoff(job.id, () => this.#admit());
    if (job.fn === "run") return this.#withBackoff(job.id, () => this.#run(), () => this.#runGaveUp());
    if (job.fn === "finalize") return this.#withBackoff(job.id, () => this.#finalize());
    if (job.fn === "open-pending") return this.#withBackoff(job.id, () => this.#openPending());
  }

  /** Queued -> Running once the Coordinator grants a run slot; Skipped when the daily budget is exhausted. */
  async #admit(): Promise<void> {
    const episode = await this.#episode();
    if (!episode || episode.status !== "Queued") return;
    const admission = await coordinatorStub(this.env).admit(this.#ref(episode));
    if (admission === "queued") return; // the Coordinator calls slotGranted when a run slot frees
    if (admission === "budget-exhausted") {
      await this.#notify(episode, "budget", budgetExhaustedMessage(episode.alert));
      return this.#finish(episode, "Skipped", { costUsd: 0, durationMs: 0 }, "daily budget exhausted");
    }
    await this.#begin(episode);
  }

  /** This Alert episode's Investigation, as the Coordinator knows it. */
  #ref(episode: Episode): InvestigationRef {
    return { name: this.lifecycle.name, episode: episode.number };
  }

  /**
   * Resolves the repo (and reminds the Owning team when it cannot), then gives the agent its one input for this
   * Alert episode: the Org's read-only Datadog tools, the model from config, then the alert. Safe to re-run:
   * the resolution and the reminder are recorded, and the submit is idempotent by operation id.
   */
  async #run(): Promise<void> {
    const episode = await this.#episode();
    if (!episode || episode.status !== "Running") return;
    if (await this.ctx.storage.get(interruptedKey(episode))) return; // interrupted before the agent got its input
    const config = ports().config(this.env);
    const resolution = await this.#resolveRepo(episode);
    if (!modelAvailable(this.env, config.modelId)) {
      await this.#remind(episode, resolution);
      return this.#endWithoutReport(episode, `the configured model ${config.modelId} is not available`);
    }
    const specs = await this.datadog.listReadOnlyTools(config.datadog.tools);
    await this.ctx.storage.put(DATADOG_TOOLS, specs);
    installDatadogTools(this.#agentHost(), specs);
    await this.#prepareWorkspace(episode, resolution);
    installWorkspaceTools(this.#agentHost(), await this.#workspaceTools(episode));
    // A later Alert episode starts the root session on a fresh context, once (never mid-run, on a replay).
    if (episode.number > 1 && !(await this.ctx.storage.get(freshContextKey(episode)))) {
      await this.harness.session().reset();
      await this.ctx.storage.put(freshContextKey(episode), true);
    }
    await this.harness.session().setModel({ provider: MODEL_PROVIDER, id: config.modelId });
    if ((await this.ctx.storage.get(costBaselineKey(episode))) === undefined) {
      await this.ctx.storage.put(costBaselineKey(episode), await this.#spentUsd());
    }
    if (await this.ctx.storage.get(interruptedKey(episode))) return this.#scheduleFinalize();
    await this.harness.submit(alertPrompt(episode.alert), { operationId: operationId(episode) });
    await this.ctx.storage.put(submittedKey(episode), true);
    // After the submit, so a Teams outage delays only the reminder, not the agent.
    await this.#remind(episode, resolution);
    // Host jobs run only while pi is idle, so this looks once the run has ended (or at a heartbeat).
    await this.#scheduleFinalize();
  }

  /**
   * Once the agent's run has ended: posts the Investigation report, or the message for an interrupted run, or
   * the failed message when the run ended without a report, and finishes the Investigation. Safe to re-run.
   */
  async #finalize(): Promise<void | { rescheduleAt: number }> {
    const episode = await this.#episode();
    if (!episode || episode.status !== "Running") return;
    const interruption = await this.ctx.storage.get<Interruption>(interruptedKey(episode));
    const running = (await this.harness.pending()).some((p) => p.operationId === operationId(episode));
    if (running) {
      if (interruption) await this.harness.abort(); // a crash came between the durable flag and the abort
      return { rescheduleAt: Date.now() + RUN_POLL_MS };
    }
    const report = await this.ctx.storage.get<InvestigationReport>(reportKey(episode));
    // A report submitted before the interruption landed wins: the agent had finished its work.
    if (!report && interruption) return this.#endInterrupted(episode, interruption);
    if (!report) return this.#endWithoutReport(episode, await this.#runEndReason(episode));
    // Before the report, so the report can link the Agent PR.
    const agentPr = await this.#agentPr(episode, report);
    const record = await this.#record(episode);
    await this.#notify(episode, "report", reportMessage(episode.alert, report, record, await this.#codeLine(episode), agentPr));
    await this.#finish(episode, "Completed", record);
  }

  /**
   * The Agent PR for a report that declares a fix, once per Alert episode (recorded; each GitHub step is recorded
   * too, see `pushAgentPr`). Nothing without a declared fix or a checked-out workspace; nothing but a note under
   * Report-only mode. A GitHub refusal, or a failure that persists past a few retries of this job, is recorded as
   * failed so the report still goes out.
   */
  async #agentPr(episode: Episode, report: InvestigationReport): Promise<AgentPrRecord | undefined> {
    const key = agentPrKey(episode);
    const stored = await this.ctx.storage.get<AgentPrRecord>(key);
    if (stored) return stored;
    if (!report.fixProposed) return undefined;
    const workspace = await this.ctx.storage.get<WorkspaceState>(workspaceKey(episode));
    if (workspace?.outcome !== "ready") return undefined;
    const config = ports().config(this.env);
    const decided = await this.#proposeFix(episode, report, workspace, config);
    await this.ctx.storage.put(key, decided);
    return decided;
  }

  async #proposeFix(
    episode: Episode,
    report: InvestigationReport,
    workspace: Extract<WorkspaceState, { outcome: "ready" }>,
    config: OncallConfig,
  ): Promise<AgentPrRecord> {
    if (reportOnly(config, episode.alert.tags)) return { outcome: "report-only" };
    const changes = await ports().workspace(this.ctx, this.env).changes();
    if (changes.length === 0) return { outcome: "no-changes" };
    // Checked before any token is minted: a pushed branch runs the repo's CI with its secrets.
    const blocked = blockedPaths(config, workspace.repo, changes);
    if (blocked.paths.length) return { outcome: "protected-paths", ...blocked };
    const resolution = await this.ctx.storage.get<RepoResolution>(repoKey(episode));
    const [owner = "", name = ""] = workspace.repo.split("/");
    const { alert } = episode;
    const prefix = `${agentPrKey(episode)}:`;
    try {
      return await pushAgentPr(
        this.env,
        config,
        {
          repo: { owner, name },
          installationId: resolution?.outcome === "resolved" ? resolution.installationId : undefined,
          deployedSha: workspace.sha,
          branch: await agentBranch(alert),
          changes,
          title: `Agent PR: proposed fix for monitor ${alert.monitorId} (${alert.org})`,
          commitMessage: `Proposed fix for monitor ${alert.monitorId} (${alert.org}) by the oncall agent`,
          body: (drift) => agentPrBody(alert, report, { deployedSha: workspace.sha, changedPaths: changes.map((c) => c.path), drift }),
        },
        {
          get: (step) => this.ctx.storage.get(`${prefix}${step}`),
          put: (step, value) => this.ctx.storage.put(`${prefix}${step}`, value),
        },
      );
    } catch (error) {
      const failures = (await this.ctx.storage.get<number>("failures:finalize")) ?? 0;
      if (retryable(error) && failures + 1 < AGENT_PR_ATTEMPTS) throw error; // the finalize job retries with backoff
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`Investigation ${this.lifecycle.name}: Agent PR failed: ${reason}`);
      return { outcome: "failed", reason: reason.length > 300 ? `${reason.slice(0, 299)}…` : reason };
    }
  }

  /**
   * The run was interrupted before it submitted a report: posts the stopped on recovery note, or (cost cap,
   * time limit) the partial message with the evidence gathered so far, and finishes the Investigation.
   */
  async #endInterrupted(episode: Episode, interruption: Interruption): Promise<void> {
    const record = await this.#record(episode);
    if (interruption.status === "Stopped") {
      await this.#notify(episode, "stopped", stoppedMessage(episode.alert, record));
      return this.#finish(episode, "Stopped", record, interruption.reason);
    }
    const evidence = await this.ctx.storage.list<{ at: number; line: string }>({ prefix: evidencePrefix(episode) });
    const lines = [...evidence.values()]
      .sort((a, b) => a.at - b.at)
      .slice(0, MAX_EVIDENCE_LINES)
      .map((e) => e.line);
    await this.#notify(episode, "partial", partialMessage(episode.alert, interruption.reason, lines, record));
    await this.#finish(episode, "Partial", record, interruption.reason);
  }

  async #endWithoutReport(episode: Episode, reason: string): Promise<void> {
    const record = await this.#record(episode);
    await this.#notify(episode, "failed", failedMessage(episode.alert, reason, record, await this.#codeLine(episode)));
    await this.#finish(episode, "Failed", record, reason);
  }

  /** The run job kept failing: the Investigation could not start its agent, so it ends Failed. */
  async #runGaveUp(): Promise<void> {
    const episode = await this.#episode();
    if (!episode || episode.status !== "Running" || (await this.ctx.storage.get(submittedKey(episode)))) return;
    await this.#endWithoutReport(episode, await this.#runFailure("it kept failing"));
  }

  /** Why the agent could not be started, in words for the failed message, with the last error seen. */
  async #runFailure(what: string): Promise<string> {
    const error = await this.ctx.storage.get<string>("last-error:run");
    return `the Investigation could not start its agent: ${what}${error ? ` (last error: ${error.slice(0, 300)})` : ""}`;
  }

  /** Repo resolution for this Alert episode, done once by the harness (not the model) before the agent starts. */
  async #resolveRepo(episode: Episode): Promise<RepoResolution> {
    const stored = await this.ctx.storage.get<RepoResolution>(repoKey(episode));
    if (stored) return stored;
    const resolution = await resolveRepo(this.env, ports().config(this.env), this.datadog, episode.alert);
    await this.ctx.storage.put(repoKey(episode), resolution);
    return resolution;
  }

  /**
   * Unmapped service or repo not enabled: reminds the Owning team, at most once per 7 days per key (the
   * Coordinator's reminder ledger) and once per Alert episode (the outbox).
   */
  async #remind(episode: Episode, resolution: RepoResolution): Promise<void> {
    const reminder = reminderFor(episode.alert, resolution);
    if (!reminder) return;
    let granted = await this.ctx.storage.get<boolean>(reminderClaimKey(episode));
    if (granted === undefined) {
      granted = await coordinatorStub(this.env).claimReminder(reminder.key);
      await this.ctx.storage.put(reminderClaimKey(episode), granted);
    }
    if (granted) await this.#notify(episode, reminder.kind, reminder.message);
  }

  /**
   * Checks out the resolved repo at the deployed commit, once per Alert episode (recorded, so a re-run job
   * neither clones again nor mints another token). No workspace without a resolved repo.
   */
  async #prepareWorkspace(episode: Episode, resolution: RepoResolution): Promise<void> {
    if (resolution.outcome !== "resolved" || (await this.ctx.storage.get(workspaceKey(episode)))) return;
    const workspace = ports().workspace(this.ctx, this.env);
    const state = await checkOutDeployedCommit(this.env, ports().config(this.env), workspace, resolution);
    if (state.outcome === "failed") console.warn(`Investigation ${this.lifecycle.name}: checkout failed: ${state.reason}`);
    await this.ctx.storage.put(workspaceKey(episode), state);
  }

  /** The agent's workspace tools for this Alert episode, when its code is checked out. */
  async #workspaceTools(episode: Episode): Promise<WorkspaceTools | undefined> {
    const state = await this.ctx.storage.get<WorkspaceState>(workspaceKey(episode));
    if (state?.outcome !== "ready") return undefined;
    return { repo: state.repo, sha: state.sha, tools: ports().workspace(this.ctx, this.env).tools() };
  }

  /** What the Investigation's messages say about the code, once repo resolution ran. */
  async #codeLine(episode: Episode): Promise<string | undefined> {
    const workspace = await this.ctx.storage.get<WorkspaceState>(workspaceKey(episode));
    if (workspace?.outcome === "failed") return checkoutFailedLine(workspace);
    const resolution = await this.ctx.storage.get<RepoResolution>(repoKey(episode));
    return resolution && codeLine(episode.alert.org, resolution);
  }

  /** Why the agent's run ended without a report, in words for the failed message. */
  async #runEndReason(episode: Episode): Promise<string> {
    try {
      const result = await this.harness.wait(operationId(episode), { signal: AbortSignal.timeout(5_000) });
      if (result.status === "done") return "the agent ended without submitting an Investigation report";
      return `the agent's run ended unanswered (${result.reason ?? "unknown reason"})`;
    } catch {
      return "the agent's run ended without an Investigation report";
    }
  }

  /**
   * Records a finished state with the Investigation's status, cost and duration: the one place an
   * Investigation finishes. Later states (Partial, Stopped, Skipped) finish through here too.
   */
  async #finish(
    episode: Episode,
    status: FinishedStatus,
    record: InvestigationRecord,
    reason?: string,
  ): Promise<void> {
    const current = (await this.#episode()) ?? episode; // re-read: a re-trigger may have joined meanwhile
    if (current.number !== episode.number) return;
    current.status = status;
    current.finishedAt = ports().now();
    current.costUsd = record.costUsd;
    current.durationMs = record.durationMs;
    if (reason !== undefined) current.reason = reason;
    // Free the run slot before recording the finished state: this path is retried only while the episode still
    // looks unfinished. Release is idempotent and the Coordinator counts the spend once.
    await coordinatorStub(this.env).release(this.#ref(current), record.costUsd);
    await this.#save(current);
    await this.lifecycle.jobs.cancel("deadline");
    await this.datadog.close();
    console.log(
      JSON.stringify({
        event: "investigation.finished",
        investigation: this.lifecycle.name,
        org: current.alert.org,
        monitorId: current.alert.monitorId,
        group: current.alert.group,
        episode: current.number,
        status,
        reason,
        costUsd: record.costUsd,
        durationMs: record.durationMs,
      }),
    );
    if (await this.ctx.storage.get(PENDING_TRIGGER)) {
      await this.lifecycle.jobs.push({ id: "open-pending", fn: "open-pending", time: Date.now() });
    }
  }

  /**
   * Model spend of this Alert episode so far, and its duration since it started running. Spend is pi's session
   * spend minus the baseline taken just before the agent's input: no baseline means the agent never ran for this
   * episode, so it spent nothing (whatever earlier episodes of this monitor group spent).
   */
  async #record(episode: Episode): Promise<InvestigationRecord> {
    const baseline = await this.ctx.storage.get<number>(costBaselineKey(episode));
    return {
      costUsd: baseline === undefined ? 0 : Math.max(0, (await this.#spentUsd()) - baseline),
      durationMs: ports().now() - (episode.startedAt ?? episode.openedAt),
    };
  }

  /** Everything this object's pi sessions have spent, in USD (pi's cost tracking). */
  async #spentUsd(): Promise<number> {
    const usage = await (await this.harness.pi()).usage(BACKGROUND_CONTEXT);
    const sum = (byKey: Record<string, { cost: { total: number } }>) =>
      Object.values(byKey).reduce((total, u) => total + u.cost.total, 0);
    return sum(usage.models) + sum(usage.tools);
  }

  async #scheduleFinalize(): Promise<void> {
    await this.lifecycle.jobs.push({ id: "finalize", fn: "finalize", time: Date.now() });
  }

  /**
   * Runs an outward job; when it keeps failing (e.g. Teams is down) after Lifecycle's in-process retries,
   * reschedules it with exponential backoff instead of dropping it. Real time: this only schedules a wake-up.
   */
  async #withBackoff(
    jobId: string,
    work: () => Promise<void | { rescheduleAt: number }>,
    gaveUp?: () => Promise<void>,
  ): Promise<void | { rescheduleAt: number }> {
    const key = `failures:${jobId}`;
    try {
      const outcome = await work();
      await this.ctx.storage.delete([key, `last-error:${jobId}`]);
      return outcome;
    } catch (error) {
      const failures = ((await this.ctx.storage.get<number>(key)) ?? 0) + 1;
      await this.ctx.storage.put(key, failures);
      await this.ctx.storage.put(`last-error:${jobId}`, error instanceof Error ? error.message : String(error));
      console.error(`Investigation ${this.lifecycle.name}: job ${jobId} failed (${failures})`, error);
      if (failures >= MAX_JOB_FAILURES) {
        try {
          await gaveUp?.();
        } finally {
          await this.#abandon();
        }
        return;
      }
      return { rescheduleAt: Date.now() + Math.min(1_000 * 2 ** (failures - 1), 5 * 60_000) };
    }
  }

  /**
   * A job gave up for good: stops the agent's run, then hands back the run slot and reports the spend so far to
   * the daily budget, so neither waits for a finish that may never come. If the run cannot be confirmed stopped,
   * or the Coordinator cannot be reached, the slot stays held (up to its hard cap) and the up-front charge stands.
   */
  async #abandon(): Promise<void> {
    const episode = await this.#episode();
    if (!episode || finished(episode.status)) return;
    try {
      await this.harness.abort();
      if ((await this.harness.pending()).some((p) => p.operationId === operationId(episode))) return;
    } catch (error) {
      console.error(`Investigation ${this.lifecycle.name}: could not stop its run before giving up`, error);
      return;
    }
    await this.ctx.storage.put(abandonedKey(episode), true);
    try {
      await coordinatorStub(this.env).release(this.#ref(episode), (await this.#record(episode)).costUsd);
    } catch (error) {
      console.error(`Investigation ${this.lifecycle.name}: could not hand back its run slot`, error);
    }
  }

  /**
   * Sends a Teams message once per Alert episode and kind, at least once: records the intent, sends, then marks it
   * sent. Teams webhooks take no idempotency key, so a crash or a lost answer between the send and the mark leaves
   * an intent without `sentAt`, and the replay sends again (a possible duplicate, never a lost message).
   */
  async #notify(episode: Episode, kind: TeamsMessageKind, message: TeamsMessage): Promise<void> {
    const key = `outbox:${episode.number}:${kind}`;
    const entry = await this.ctx.storage.get<OutboxEntry>(key);
    if (entry?.sentAt !== undefined) return;
    if (entry) console.warn(`Investigation ${this.lifecycle.name}: sending the ${kind} message again; Teams may show it twice`);
    const channel = teamsChannelSecret(ports().config(this.env), episode.alert.org, episode.alert.tags);
    const intent: OutboxEntry = { intentAt: ports().now(), channel };
    await this.ctx.storage.put(key, intent);
    await postToTeams(this.env, channel, message);
    await this.ctx.storage.put(key, { ...intent, sentAt: ports().now() } satisfies OutboxEntry);
  }

  /** What the agent (agent.ts) may use of this Investigation. */
  #agentHost(): AgentHost {
    const storage = this.ctx.storage;
    const current = async () => {
      const episode = await this.#episode();
      if (!episode) throw new Error(`Investigation ${this.lifecycle.name} has no Alert episode`);
      return episode;
    };
    return {
      env: this.env,
      registry: this.registry,
      datadog: this.datadog,
      datadogToolSpecs: () => storage.get<DatadogToolSpec[]>(DATADOG_TOOLS),
      reportSubmitted: async (report) => {
        const episode = await current();
        if (episode.status !== "Running") return;
        await storage.put(reportKey(episode), boundedReport(report));
        await this.#scheduleFinalize();
      },
      hasReport: async () => (await storage.get(reportKey(await current()))) !== undefined,
      firstNudge: async () => {
        const key = nudgedKey(await current());
        if (await storage.get(key)) return false;
        await storage.put(key, true);
        return true;
      },
      guardrails: async () => {
        const episode = await this.#episode();
        if (!episode || episode.status !== "Running") return undefined;
        const { budgets } = ports().config(this.env);
        return {
          startedAt: episode.startedAt ?? episode.openedAt,
          spentUsd: (await this.#record(episode)).costUsd,
          maxUsd: budgets.investigationUsd,
          maxMinutes: budgets.investigationMinutes,
        };
      },
      interrupt: (reason) => this.#interruptFromRun({ status: "Partial", reason }),
      workspaceTools: async () => {
        const episode = await this.#episode();
        return episode && this.#workspaceTools(episode);
      },
      evidenceGathered: async (callId, tool, text) => {
        const key = `${evidencePrefix(await current())}${callId}`;
        if (await storage.get(key)) return;
        await storage.put(key, { at: ports().now(), line: evidenceLine(tool, text) });
      },
    };
  }

  /** The Org this Investigation belongs to, from the Org registry. */
  async #org(): Promise<Org> {
    const episode = await this.#episode();
    const org = episode && orgByName(ports().config(this.env), episode.alert.org);
    if (!org) throw new Error(`Investigation ${this.lifecycle.name}: Org not in the Org registry`);
    return org;
  }

  async #episode(): Promise<Episode | undefined> {
    return this.ctx.storage.get<Episode>(EPISODE);
  }

  async #save(episode: Episode): Promise<void> {
    await this.ctx.storage.put(EPISODE, episode);
  }
}
