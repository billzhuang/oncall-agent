import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";

/**
 * Coordinator (singleton): run slots, daily spend ledger, reminder dedup ledger.
 * Skeleton (#11): declared so the binding and migration exist. #5 adds run slots and the budget, #6 reminders.
 */
export class Coordinator extends DurableObject<Env> {
  readonly lifecycle = Lifecycle.install(this);
}
