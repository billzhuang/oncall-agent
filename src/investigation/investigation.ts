import { DurableObject } from "cloudflare:workers";
import { Lifecycle, type LifecycleJobContext } from "agents/lifecycle";
import type { Alert } from "../intake";
import { ports } from "../ports";
import { postToTeams, teamsChannelSecret, type TeamsMessage, type TeamsMessageKind } from "../teams";
import { placeholderReport } from "./report";

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
  /** Re-triggers that joined this episode. */
  retriggers: number;
  lastTriggeredAt: number;
  /** Set when the episode ends (Recovered, #3). Until then every Triggered joins this Investigation. */
  closedAt?: number;
}

/** What a notification did, returned to intake (and Datadog) for diagnostics. */
export type TriggerOutcome = "opened" | "joined" | "duplicate";

const EPISODE = "episode";
const MAX_JOB_FAILURES = 12;

/**
 * One Investigation per Alert episode `(org, monitor, group)`; named by `durable.ts`.
 *
 * Every RPC begins with `await this.lifecycle.start()`; never define `alarm()`/`fetch()` (Lifecycle owns them,
 * use `onAlarm`/`onJob`). Outward actions go through `#notify`, which checks the outbox first, because work
 * may be replayed after eviction.
 */
export class Investigation extends DurableObject<Env> {
  readonly lifecycle = Lifecycle.install(this);

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

  /** Queued -> Running. #5 defers this until the Coordinator grants a run slot. */
  async #start(episode: Episode): Promise<void> {
    episode.status = "Running";
    episode.startedAt = ports().now();
    await this.#save(episode);
    // #2: submit the alert to the agent instead; its finishing tool pushes `finalize`.
    await this.lifecycle.jobs.push({ id: "finalize", fn: "finalize", time: Date.now() });
  }

  async onJob({ job }: LifecycleJobContext): Promise<void | { rescheduleAt: number }> {
    if (job.fn === "finalize") return this.#withBackoff(job.id, () => this.#finalize());
  }

  /**
   * Runs an outward job; when it keeps failing (e.g. Teams is down) after Lifecycle's in-process retries,
   * reschedules it with exponential backoff instead of dropping it. Real time: this only schedules a wake-up.
   */
  async #withBackoff(jobId: string, work: () => Promise<void>): Promise<void | { rescheduleAt: number }> {
    const key = `failures:${jobId}`;
    try {
      await work();
      await this.ctx.storage.delete(key);
    } catch (error) {
      const failures = ((await this.ctx.storage.get<number>(key)) ?? 0) + 1;
      await this.ctx.storage.put(key, failures);
      console.error(`Investigation ${this.lifecycle.name}: job ${jobId} failed (${failures})`, error);
      if (failures >= MAX_JOB_FAILURES) return; // give up; #4 reports Failed investigations
      return { rescheduleAt: Date.now() + Math.min(1_000 * 2 ** (failures - 1), 5 * 60_000) };
    }
  }

  /** Posts the Investigation report and finishes the Investigation. Safe to re-run. */
  async #finalize(): Promise<void> {
    const episode = await this.#episode();
    if (!episode || episode.status !== "Running") return;
    await this.#notify(episode, "report", placeholderReport(episode.alert, episode.startedAt ?? episode.openedAt));
    episode.status = "Completed";
    episode.finishedAt = ports().now();
    await this.#save(episode);
  }

  /** Sends a Teams message at most once per Alert episode and kind: check the outbox, send, record. */
  async #notify(episode: Episode, kind: TeamsMessageKind, message: TeamsMessage): Promise<void> {
    const key = `outbox:${episode.number}:${kind}`;
    if (await this.ctx.storage.get(key)) return;
    const channel = teamsChannelSecret(ports().config(this.env), episode.alert.org, episode.alert.tags);
    await postToTeams(this.env, channel, message);
    await this.ctx.storage.put(key, { sentAt: ports().now(), channel });
  }

  async #episode(): Promise<Episode | undefined> {
    return this.ctx.storage.get<Episode>(EPISODE);
  }

  async #save(episode: Episode): Promise<void> {
    await this.ctx.storage.put(EPISODE, episode);
  }
}
