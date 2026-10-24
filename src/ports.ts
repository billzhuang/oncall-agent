import type { Provider } from "@earendil-works/pi-ai";
import { createAI } from "agents/models/pi-ai";
import { parseConfig, type OncallConfig } from "./config";

/**
 * The one seam: everything outside the Worker that tests replace. Production defaults below.
 *
 * Rules: call `ports()` at the point of use and never cache its result (Durable Object instances outlive tests).
 * No code outside this module calls global `fetch`, `Date.now()` for decisions, or `createAI`.
 * Timer scheduling (Lifecycle job `time`, alarms) is the one exception: it uses real `Date.now()`.
 */
export interface Ports {
  /** Business clock: every decision (episode times, budgets, deadlines, expiry) reads it. */
  now(): number;
  /** All outbound HTTP: Teams, GitHub, Datadog MCP. */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  /** pi-ai Provider with id "cloudflare" (Workers AI through env.AI). */
  modelProvider(env: Env): Provider;
  /** Parsed ONCALL_CONFIG. */
  config(env: Env): OncallConfig;
}

const providers = new WeakMap<object, Provider>();

const production: Ports = {
  now: () => Date.now(),
  fetch: (input, init) => fetch(input, init),
  modelProvider: (env) => {
    let provider = providers.get(env.AI);
    if (!provider) {
      provider = createAI({ binding: env.AI }).provider;
      providers.set(env.AI, provider);
    }
    return provider;
  },
  config: (env) => parseConfig(env.ONCALL_CONFIG),
};

let current: Ports = production;

export const ports = (): Ports => current;

/** Tests only: tests share the isolate with the Worker and its Durable Objects. */
export function setPorts(overrides: Partial<Ports>): void {
  current = { ...production, ...overrides };
}

/** Tests only. */
export function resetPorts(): void {
  current = production;
}
