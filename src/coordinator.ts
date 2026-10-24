import { DurableObject } from "cloudflare:workers";
import { Lifecycle, type LifecycleJobContext } from "agents/lifecycle";
import { investigationStubByName } from "./durable";
import { ports } from "./ports";

/** One Alert episode's Investigation, as the Coordinator knows it: its Durable Object name and episode number. */
export interface InvestigationRef {
  name: string;
  episode: number;
}

/** The Coordinator's answer to an Investigation asking to run. */
export type Admission = "granted" | "queued" | "budget-exhausted";

/** A held run slot. It lapses at `leaseUntil` (business clock), so an Investigation that dies never holds it forever. */
interface Slot extends InvestigationRef {
  leaseUntil: number;
}

const SLOTS = "run-slots";
const QUEUE = "run-queue";
/** Slack past the Investigation time limit before a run slot lapses: time to post the outcome and finish. */
const LEASE_SLACK_MS = 15 * 60_000;
/** Retry delay when a queued Investigation could not be told it may run. Real time: only a wake-up. */
const DISPATCH_RETRY_MS = 5_000;

const same = (a: InvestigationRef, b: InvestigationRef) => a.name === b.name && a.episode === b.episode;
/** The UTC day (YYYY-MM-DD) of a business-clock time: the daily budget's ledger key. */
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const spendKey = (day: string) => `spend:${day}`;
const settledKey = (ref: InvestigationRef) => `settled:${ref.name}#${ref.episode}`;

/**
 * Coordinator (singleton): run slots (at most `budgets.maxConcurrent` Investigations running, the rest queued in
 * arrival order), the daily spend ledger (`budgets.dailyUsd` per UTC day) and the daily notice ledger.
 *
 * An Investigation asks with `admit` before it runs and calls `release` from its one finishing path, whatever
 * state it ends in. Both are idempotent, so Investigation work replayed after eviction is safe.
 */
export class Coordinator extends DurableObject<Env> {
  readonly lifecycle = Lifecycle.install(this);

  /**
   * An Investigation asks to run. Granted while a run slot is free and nobody is queued ahead; queued otherwise,
   * and told later through `Investigation#slotGranted`. Once the day's recorded spend reaches the daily budget,
   * the answer is budget-exhausted. Asking again gives the same answer.
   */
  async admit(ref: InvestigationRef): Promise<Admission> {
    await this.lifecycle.start();
    const { slots, queue } = await this.#state();
    if (slots.some((s) => same(s, ref))) return "granted";
    if (await this.#budgetExhausted()) {
      await this.#putQueue(queue.filter((q) => !same(q, ref)));
      return "budget-exhausted";
    }
    const waiting = queue.filter((q) => !same(q, ref));
    if (slots.length < this.#maxConcurrent() && waiting.length === 0) {
      await this.#putSlots([...slots, this.#slot(ref)]);
      await this.#putQueue(waiting);
      return "granted";
    }
    if (!queue.some((q) => same(q, ref))) await this.#putQueue([...queue, ref]);
    await this.#wakeAtFirstLapse(slots);
    return "queued";
  }

  /**
   * An Investigation finished (in any state): frees its run slot or queue place, adds its model spend to today's
   * ledger once, and starts the next queued Investigation.
   */
  async release(ref: InvestigationRef, costUsd: number): Promise<void> {
    await this.lifecycle.start();
    const { slots, queue } = await this.#state();
    await this.#putSlots(slots.filter((s) => !same(s, ref)));
    await this.#putQueue(queue.filter((q) => !same(q, ref)));
    if (costUsd > 0 && !(await this.ctx.storage.get(settledKey(ref)))) {
      const key = spendKey(utcDay(ports().now()));
      const spent = (await this.ctx.storage.get<number>(key)) ?? 0;
      await this.ctx.storage.put({ [key]: spent + costUsd, [settledKey(ref)]: true });
    }
    // A job, not inline, so the releasing Investigation does not wait on starting the next one.
    await this.#scheduleDispatch("dispatch", 0);
  }

  async onJob({ job }: LifecycleJobContext): Promise<void> {
    if (job.fn === "dispatch") await this.#dispatch();
  }

  /** Starts queued Investigations, oldest first, while run slots are free. */
  async #dispatch(): Promise<void> {
    for (;;) {
      const { slots, queue } = await this.#state();
      const next = queue[0];
      if (!next) return;
      if (slots.length >= this.#maxConcurrent()) return this.#wakeAtFirstLapse(slots);
      // Once the budget is exhausted, waiting Investigations are told too: they ask again and are Skipped.
      const exhausted = await this.#budgetExhausted();
      // Take the slot before calling out: other requests may run while this one waits on the Investigation.
      if (!exhausted) await this.#putSlots([...slots, this.#slot(next)]);
      await this.#putQueue(queue.slice(1));
      try {
        const waiting = await investigationStubByName(this.env, next.name).slotGranted(next.episode);
        if (!waiting && !exhausted) await this.#dropSlot(next);
      } catch (error) {
        console.error(`Coordinator: could not start Investigation ${next.name}#${next.episode}`, error);
        if (!exhausted) await this.#dropSlot(next);
        const { queue: now } = await this.#state();
        if (!now.some((q) => same(q, next))) await this.#putQueue([next, ...now]);
        await this.#scheduleDispatch("dispatch-retry", DISPATCH_RETRY_MS);
        return;
      }
    }
  }

  async #dropSlot(ref: InvestigationRef): Promise<void> {
    const { slots } = await this.#state();
    await this.#putSlots(slots.filter((s) => !same(s, ref)));
  }

  async #budgetExhausted(): Promise<boolean> {
    const spent = (await this.ctx.storage.get<number>(spendKey(utcDay(ports().now())))) ?? 0;
    return spent >= ports().config(this.env).budgets.dailyUsd;
  }

  /** Run slots still leased (lapsed ones are dropped) and the queue. */
  async #state(): Promise<{ slots: Slot[]; queue: InvestigationRef[] }> {
    const now = ports().now();
    const stored = (await this.ctx.storage.get<Slot[]>(SLOTS)) ?? [];
    const slots = stored.filter((s) => s.leaseUntil > now);
    if (slots.length !== stored.length) {
      for (const s of stored.filter((s) => s.leaseUntil <= now)) {
        console.warn(`Coordinator: run slot of Investigation ${s.name}#${s.episode} lapsed without a release`);
      }
      await this.#putSlots(slots);
    }
    return { slots, queue: (await this.ctx.storage.get<InvestigationRef[]>(QUEUE)) ?? [] };
  }

  #slot(ref: InvestigationRef): Slot {
    return { name: ref.name, episode: ref.episode, leaseUntil: ports().now() + this.#leaseMs() };
  }

  #leaseMs(): number {
    return ports().config(this.env).budgets.investigationMinutes * 60_000 + LEASE_SLACK_MS;
  }

  #maxConcurrent(): number {
    return ports().config(this.env).budgets.maxConcurrent;
  }

  async #putSlots(slots: Slot[]): Promise<void> {
    await this.ctx.storage.put(SLOTS, slots);
  }

  async #putQueue(queue: InvestigationRef[]): Promise<void> {
    await this.ctx.storage.put(QUEUE, queue);
  }

  /** While Investigations wait, a wake-up for when the first run slot would lapse, so it is reclaimed then. */
  async #wakeAtFirstLapse(slots: Slot[]): Promise<void> {
    if (slots.length === 0) return;
    const first = Math.min(...slots.map((s) => s.leaseUntil));
    await this.#scheduleDispatch("dispatch-lapse", Math.max(0, first - ports().now()) + 1_000);
  }

  /** A wake-up to start queued Investigations. Real time: the decision is re-made then on the business clock. */
  async #scheduleDispatch(id: string, delayMs: number): Promise<void> {
    await this.lifecycle.jobs.push({ id, fn: "dispatch", time: Date.now() + delayMs });
  }

  /**
   * Claims the once-per-UTC-day notice `key` (for example a token expiry warning for one Org) for `day`
   * (YYYY-MM-DD). True for the first claim of that day; false when it was already claimed, so the caller
   * sends nothing. Release the claim if sending fails, so a later run can retry the same day.
   */
  async claimDailyNotice(key: string, day: string): Promise<boolean> {
    await this.lifecycle.start();
    const storageKey = `daily-notice:${key}`;
    if ((await this.ctx.storage.get<string>(storageKey)) === day) return false;
    await this.ctx.storage.put(storageKey, day);
    return true;
  }

  async releaseDailyNotice(key: string, day: string): Promise<void> {
    await this.lifecycle.start();
    const storageKey = `daily-notice:${key}`;
    if ((await this.ctx.storage.get<string>(storageKey)) === day) await this.ctx.storage.delete(storageKey);
  }
}
