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

/** A held run slot, leased until `leaseUntil` (business clock). */
interface Slot extends InvestigationRef {
  leaseUntil: number;
}

/** What a granted Investigation was charged up front, and on which UTC day, until its recorded spend replaces it. */
interface Charge {
  day: string;
  usd: number;
  settled?: boolean;
}

const SLOTS = "run-slots";
const QUEUE = "run-queue";
/**
 * Slack past the Investigation time limit before a run slot's lease lapses: time to post the outcome and finish.
 * A lapsed lease is only a prompt to look: the Investigation stops its own run at the time limit (#4), so by
 * then it has normally finished; the slot is reclaimed only if the Investigation says it is no longer running.
 */
const LEASE_SLACK_MS = 15 * 60_000;
/** Retry delay when a queued Investigation could not be told it may run. Real time: only a wake-up. */
const DISPATCH_RETRY_MS = 5_000;

const same = (a: InvestigationRef, b: InvestigationRef) => a.name === b.name && a.episode === b.episode;
/** The UTC day (YYYY-MM-DD) of a business-clock time: the daily budget's ledger key. */
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const spendKey = (day: string) => `spend:${day}`;
const chargeKey = (ref: InvestigationRef) => `charge:${ref.name}#${ref.episode}`;

/**
 * Coordinator (singleton): run slots (at most `budgets.maxConcurrent` Investigations running, the rest queued in
 * arrival order), the daily spend ledger (`budgets.dailyUsd` per UTC day) and the daily notice ledger.
 *
 * An Investigation asks with `admit` before it runs and calls `release` from its one finishing path, whatever
 * state it ends in. Both are idempotent, so Investigation work replayed after eviction is safe.
 *
 * The budget fails closed: a granted Investigation is charged the per-Investigation cap up front, on the day it
 * was granted, and `release` replaces that with its recorded spend. One that never releases (it died, or could
 * never post its outcome) stays charged the cap.
 */
export class Coordinator extends DurableObject<Env> {
  readonly lifecycle = Lifecycle.install(this);

  /**
   * An Investigation asks to run. Granted while a run slot is free and nobody is queued ahead; queued otherwise,
   * and told later through `Investigation#slotGranted`. Once the day's spend reaches the daily budget, the
   * answer is budget-exhausted. Asking again gives the same answer.
   */
  async admit(ref: InvestigationRef): Promise<Admission> {
    await this.lifecycle.start();
    await this.#reclaimLapsed();
    const { slots, queue } = await this.#state();
    if (slots.some((s) => same(s, ref))) return "granted";
    if (await this.#budgetExhausted()) {
      await this.#putQueue(queue.filter((q) => !same(q, ref)));
      return "budget-exhausted";
    }
    const waiting = queue.filter((q) => !same(q, ref));
    if (slots.length < this.#maxConcurrent() && waiting.length === 0) {
      await this.#grant(ref);
      await this.#putQueue(waiting);
      return "granted";
    }
    if (!queue.some((q) => same(q, ref))) await this.#putQueue([...queue, ref]);
    // A free slot with others waiting (e.g. one just reclaimed): start the oldest waiting one now.
    if (slots.length < this.#maxConcurrent()) await this.#scheduleDispatch("dispatch", 0);
    else await this.#wakeAtFirstLapse(slots);
    return "queued";
  }

  /**
   * An Investigation finished (in any state), or gave up: frees its run slot or queue place, replaces its up-front
   * charge with its recorded spend (once), and starts the next queued Investigation.
   */
  async release(ref: InvestigationRef, costUsd: number): Promise<void> {
    await this.lifecycle.start();
    const { slots, queue } = await this.#state();
    await this.#putSlots(slots.filter((s) => !same(s, ref)));
    await this.#putQueue(queue.filter((q) => !same(q, ref)));
    // Never granted means the agent never ran, so there is nothing to charge.
    const charge = await this.ctx.storage.get<Charge>(chargeKey(ref));
    if (charge && !charge.settled) {
      const key = spendKey(charge.day);
      const spent = (await this.ctx.storage.get<number>(key)) ?? 0;
      await this.ctx.storage.put({
        [key]: Math.max(0, spent - charge.usd + Math.max(0, costUsd)),
        [chargeKey(ref)]: { ...charge, settled: true },
      });
    }
    // A job, not inline, so the releasing Investigation does not wait on starting the next one.
    await this.#scheduleDispatch("dispatch", 0);
  }

  async onJob({ job }: LifecycleJobContext): Promise<void> {
    if (job.fn === "dispatch") await this.#dispatch();
  }

  /** Starts queued Investigations, oldest first, while run slots are free. */
  async #dispatch(): Promise<void> {
    await this.#reclaimLapsed();
    for (;;) {
      const { slots, queue } = await this.#state();
      const next = queue[0];
      if (!next) return;
      if (slots.length >= this.#maxConcurrent()) return this.#wakeAtFirstLapse(slots);
      // Once the budget is exhausted, waiting Investigations are told too: they ask again and are Skipped.
      const exhausted = await this.#budgetExhausted();
      // Take the slot before calling out: other requests may run while this one waits on the Investigation.
      if (!exhausted) await this.#grant(next);
      await this.#putQueue(queue.slice(1));
      try {
        const waiting = await investigationStubByName(this.env, next.name).slotGranted(next.episode);
        if (!waiting && !exhausted) await this.#ungrant(next); // it finished meanwhile
      } catch (error) {
        console.error(`Coordinator: could not start Investigation ${next.name}#${next.episode}`, error);
        if (!exhausted) await this.#ungrant(next);
        const { queue: now } = await this.#state();
        if (!now.some((q) => same(q, next))) await this.#putQueue([next, ...now]);
        await this.#scheduleDispatch("dispatch-retry", DISPATCH_RETRY_MS);
        return;
      }
    }
  }

  /** Takes a run slot for `ref` and charges the per-Investigation cap to today, once. */
  async #grant(ref: InvestigationRef): Promise<void> {
    const { slots } = await this.#state();
    const slot: Slot = { name: ref.name, episode: ref.episode, leaseUntil: ports().now() + this.#leaseMs() };
    await this.#putSlots([...slots.filter((s) => !same(s, ref)), slot]);
    if (await this.ctx.storage.get(chargeKey(ref))) return;
    const day = utcDay(ports().now());
    const usd = ports().config(this.env).budgets.investigationUsd;
    const spent = (await this.ctx.storage.get<number>(spendKey(day))) ?? 0;
    await this.ctx.storage.put({ [spendKey(day)]: spent + usd, [chargeKey(ref)]: { day, usd } satisfies Charge });
  }

  /** Undoes a grant whose Investigation could not be told (it stays queued and is tried again). */
  async #ungrant(ref: InvestigationRef): Promise<void> {
    const { slots } = await this.#state();
    await this.#putSlots(slots.filter((s) => !same(s, ref)));
    const charge = await this.ctx.storage.get<Charge>(chargeKey(ref));
    if (!charge || charge.settled) return;
    const spent = (await this.ctx.storage.get<number>(spendKey(charge.day))) ?? 0;
    await this.ctx.storage.put(spendKey(charge.day), Math.max(0, spent - charge.usd));
    await this.ctx.storage.delete(chargeKey(ref));
  }

  /**
   * Run slots whose lease lapsed: asks each Investigation whether it is still running. If so the lease is
   * extended (the concurrency limit holds); if not, or it cannot answer, the slot is reclaimed. A reclaimed
   * Investigation stays charged the cap, as it never reported its spend.
   */
  async #reclaimLapsed(): Promise<void> {
    const now = ports().now();
    const lapsed = (await this.#state()).slots.filter((s) => s.leaseUntil <= now);
    for (const slot of lapsed) {
      let running = false;
      try {
        running = await investigationStubByName(this.env, slot.name).stillRunning(slot.episode);
      } catch (error) {
        console.error(`Coordinator: could not ask Investigation ${slot.name}#${slot.episode} whether it runs`, error);
      }
      const { slots } = await this.#state(); // re-read: other requests may have run meanwhile
      const current = slots.find((s) => same(s, slot));
      if (!current || current.leaseUntil > now) continue;
      if (running) {
        await this.#putSlots(slots.map((s) => (same(s, slot) ? { ...s, leaseUntil: ports().now() + this.#leaseMs() } : s)));
      } else {
        console.warn(`Coordinator: reclaimed the run slot of Investigation ${slot.name}#${slot.episode}, which never released it`);
        await this.#putSlots(slots.filter((s) => !same(s, slot)));
      }
    }
  }

  async #budgetExhausted(): Promise<boolean> {
    const spent = (await this.ctx.storage.get<number>(spendKey(utcDay(ports().now())))) ?? 0;
    return spent >= ports().config(this.env).budgets.dailyUsd;
  }

  async #state(): Promise<{ slots: Slot[]; queue: InvestigationRef[] }> {
    return {
      slots: (await this.ctx.storage.get<Slot[]>(SLOTS)) ?? [],
      queue: (await this.ctx.storage.get<InvestigationRef[]>(QUEUE)) ?? [],
    };
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

  /** While Investigations wait, a wake-up for when the first run slot's lease lapses, to look at it then. */
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
