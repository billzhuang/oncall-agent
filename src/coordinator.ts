import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";

/**
 * Coordinator (singleton): run slots, daily spend ledger, reminder dedup ledger.
 * Skeleton (#11): declared so the binding and migration exist. #5 adds run slots and the budget, #6 reminders.
 */
export class Coordinator extends DurableObject<Env> {
  readonly lifecycle = Lifecycle.install(this);

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
