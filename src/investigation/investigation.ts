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
}

const EPISODE = "episode";

/**
 * One Investigation per Alert episode `(org, monitor, group)`; named by `durable.ts`.
 *
 * Patterns (docs: scratchpad conventions): every RPC begins with `await this.lifecycle.start()`; never define
 * `alarm()`/`fetch()`; outward actions go through `#notify`, which checks the outbox first.
 */
export class Investigation extends DurableObject<Env> {
  readonly lifecycle = Lifecycle.install(this);

  /** A Triggered notification for this Alert episode. */
  async triggered(alert: Alert): Promise<string> {
    await this.lifecycle.start();
    const episode: Episode = { number: 1, alert, openedAt: ports().now(), status: "Queued" };
    await this.#save(episode);
    await this.#start(episode);
    return "opened";
  }

  /** Queued -> Running. #5 defers this until the Coordinator grants a run slot. */
  async #start(episode: Episode): Promise<void> {
    episode.status = "Running";
    episode.startedAt = ports().now();
    await this.#save(episode);
    // #2: submit the alert to the agent instead; its finishing tool pushes `finalize`.
    await this.lifecycle.jobs.push({ id: "finalize", fn: "finalize", time: Date.now() });
  }

  async onJob({ job }: LifecycleJobContext): Promise<void> {
    if (job.fn === "finalize") await this.#finalize();
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
