import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry } from "@earendil-works/pi-durable";
import { Lifecycle, type LifecycleJobContext } from "agents/lifecycle";
import { orgByName, type Org } from "../config";
import type { InvestigationRef } from "../coordinator";
import { coordinatorStub } from "../durable";
import { DatadogConnection, type DatadogToolSpec } from "../datadog-mcp";
import type { Alert } from "../intake";
import { ports } from "../ports";
import { postToTeams, teamsChannelSecret, type TeamsMessage, type TeamsMessageKind } from "../teams";
import {
  MODEL_PROVIDER,
  alertPrompt,
  createAgentHarness,
  installDatadogTools,
  modelAvailable,
  type AgentHost,
} from "./agent";
import {
  boundedReport,
  budgetExhaustedMessage,
  failedMessage,
  reportMessage,
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

const EPISODE = "episode";
const DATADOG_TOOLS = "datadog-tools";
const MAX_JOB_FAILURES = 12;
/** How often a finalize that found the run still going looks again. Real time: it only schedules a wake-up. */
const RUN_POLL_MS = 30_000;

/** Storage keys per Alert episode, kept apart from the episode record so concurrent writers never clash. */
const reportKey = (e: Episode) => `report:${e.number}`;
const nudgedKey = (e: Episode) => `nudged:${e.number}`;
const costBaselineKey = (e: Episode) => `cost-baseline:${e.number}`;
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
    const episode: Episode = {
      number: (current?.number ?? 0) + 1,
      alert,
      openedAt: now,
      status: "Queued",
      retriggers: 0,
      lastTriggeredAt: now,
    };
    await this.#save(episode);
    await this.#start(episode);
    return "opened";
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

  async onJob({ job }: LifecycleJobContext): Promise<void | { rescheduleAt: number }> {
    if (job.fn === "admit") return this.#withBackoff(job.id, () => this.#admit());
    if (job.fn === "run") return this.#withBackoff(job.id, () => this.#run());
    if (job.fn === "finalize") return this.#withBackoff(job.id, () => this.#finalize());
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
    episode.status = "Running";
    episode.startedAt = ports().now();
    await this.#save(episode);
    await this.lifecycle.jobs.push({ id: "run", fn: "run", time: Date.now() });
  }

  /** This Alert episode's Investigation, as the Coordinator knows it. */
  #ref(episode: Episode): InvestigationRef {
    return { name: this.lifecycle.name, episode: episode.number };
  }

  /**
   * Gives the agent its one input for this Alert episode: the Org's read-only Datadog tools, the model from
   * config, then the alert. Safe to re-run: the submit is idempotent by operation id.
   */
  async #run(): Promise<void> {
    const episode = await this.#episode();
    if (!episode || episode.status !== "Running") return;
    const config = ports().config(this.env);
    if (!modelAvailable(this.env, config.modelId)) {
      return this.#endWithoutReport(episode, `the configured model ${config.modelId} is not available`);
    }
    const specs = await this.datadog.listReadOnlyTools(config.datadog.tools);
    await this.ctx.storage.put(DATADOG_TOOLS, specs);
    installDatadogTools(this.#agentHost(), specs);
    // TODO(#3): a later Alert episode in this object reuses the root session; start it on a fresh context.
    await this.harness.session().setModel({ provider: MODEL_PROVIDER, id: config.modelId });
    if ((await this.ctx.storage.get(costBaselineKey(episode))) === undefined) {
      await this.ctx.storage.put(costBaselineKey(episode), await this.#spentUsd());
    }
    await this.harness.submit(alertPrompt(episode.alert), { operationId: operationId(episode) });
    // Host jobs run only while pi is idle, so this looks once the run has ended (or at a heartbeat).
    await this.#scheduleFinalize();
  }

  /**
   * Once the agent's run has ended: posts the Investigation report, or the failed message when the run ended
   * without one, and finishes the Investigation. Safe to re-run.
   */
  async #finalize(): Promise<void | { rescheduleAt: number }> {
    const episode = await this.#episode();
    if (!episode || episode.status !== "Running") return;
    const running = (await this.harness.pending()).some((p) => p.operationId === operationId(episode));
    if (running) return { rescheduleAt: Date.now() + RUN_POLL_MS };
    const report = await this.ctx.storage.get<InvestigationReport>(reportKey(episode));
    if (!report) return this.#endWithoutReport(episode, await this.#runEndReason(episode));
    const record = await this.#record(episode);
    await this.#notify(episode, "report", reportMessage(episode.alert, report, record));
    await this.#finish(episode, "Completed", record);
  }

  async #endWithoutReport(episode: Episode, reason: string): Promise<void> {
    const record = await this.#record(episode);
    await this.#notify(episode, "failed", failedMessage(episode.alert, reason, record));
    await this.#finish(episode, "Failed", record, reason);
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
    status: Exclude<InvestigationStatus, "Queued" | "Running">,
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
  }

  /** Model spend of this Alert episode so far, and its duration since it started running. */
  async #record(episode: Episode): Promise<InvestigationRecord> {
    const baseline = (await this.ctx.storage.get<number>(costBaselineKey(episode))) ?? 0;
    return {
      costUsd: Math.max(0, (await this.#spentUsd()) - baseline),
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
  ): Promise<void | { rescheduleAt: number }> {
    const key = `failures:${jobId}`;
    try {
      const outcome = await work();
      await this.ctx.storage.delete(key);
      return outcome;
    } catch (error) {
      const failures = ((await this.ctx.storage.get<number>(key)) ?? 0) + 1;
      await this.ctx.storage.put(key, failures);
      console.error(`Investigation ${this.lifecycle.name}: job ${jobId} failed (${failures})`, error);
      if (failures >= MAX_JOB_FAILURES) return; // give up; #4 reports Failed investigations
      return { rescheduleAt: Date.now() + Math.min(1_000 * 2 ** (failures - 1), 5 * 60_000) };
    }
  }

  /** Sends a Teams message at most once per Alert episode and kind: check the outbox, send, record. */
  async #notify(episode: Episode, kind: TeamsMessageKind, message: TeamsMessage): Promise<void> {
    const key = `outbox:${episode.number}:${kind}`;
    if (await this.ctx.storage.get(key)) return;
    const channel = teamsChannelSecret(ports().config(this.env), episode.alert.org, episode.alert.tags);
    await postToTeams(this.env, channel, message);
    await this.ctx.storage.put(key, { sentAt: ports().now(), channel });
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
