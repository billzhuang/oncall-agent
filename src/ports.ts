import type { Provider } from "@earendil-works/pi-ai";
import { createAI } from "agents/models/pi-ai";
import { parseConfig, type OncallConfig } from "./config";
import type { CodeWorkspace } from "./workspace/code-workspace";
import { ComputerWorkspace } from "./workspace/computer";

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
  /** The Investigation's code workspace (native Computer in its own storage; in-memory in tests). */
  workspace(ctx: DurableObjectState, env: Env): CodeWorkspace;
}

const providers = new WeakMap<object, Provider>();
/** One Workspace per Durable Object, so every caller sees the same filesystem state. */
const workspaces = new WeakMap<DurableObjectState, CodeWorkspace>();

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
  workspace: (ctx) => {
    let workspace = workspaces.get(ctx);
    if (!workspace) {
      workspace = new ComputerWorkspace(ctx);
      workspaces.set(ctx, workspace);
    }
    return workspace;
  },
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
