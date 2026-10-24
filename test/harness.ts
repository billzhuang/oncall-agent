import { env, exports } from "cloudflare:workers";
import { abortAllDurableObjects, listDurableObjectIds, reset, runDurableObjectAlarm } from "cloudflare:test";
import { parseConfig } from "../src/config";
import { resetPorts, setPorts } from "../src/ports";
import { fakeClock } from "./fakes/clock";
import { defaultDatadogTools, fakeDatadogMcp } from "./fakes/datadog-mcp";
import { fakeGitHub } from "./fakes/github";
import { scriptedModel } from "./fakes/model";
import { router } from "./fakes/router";
import { fakeTeams } from "./fakes/teams";
import { GAP_ORG_ID, MODEL_ID, TEST_SECRETS, WK_ORG_ID, testConfig } from "./config";

/**
 * Replaces every external system behind the Worker's outer edge with a fake the test controls,
 * through the one seam (`src/ports.ts`). Call in `beforeEach`; pair with `cleanUp()` in `afterEach`.
 */
export function installFakes(opts: { config?: Record<string, unknown>; now?: number; costPerMTok?: number } = {}) {
  const clock = fakeClock(opts.now);
  const teams = fakeTeams();
  const github = fakeGitHub();
  const datadog = fakeDatadogMcp();
  const model = scriptedModel(String(opts.config?.modelId ?? MODEL_ID), opts.costPerMTok);
  datadog.org(TEST_SECRETS.GAP_DATADOG_TOKEN, defaultDatadogTools("gap"));
  datadog.org(TEST_SECRETS.WK_DATADOG_TOKEN, defaultDatadogTools("wk"));
  const network = router({ "teams.test": teams, "api.github.com": github, "mcp.datadoghq.eu": datadog });
  setPorts({
    now: clock.now,
    fetch: network.fetch,
    modelProvider: () => model.provider,
    config: () => parseConfig(testConfig(opts.config)), // still goes through the real parser
  });
  return { clock, teams, github, datadog, model, network };
}
export type Fakes = ReturnType<typeof installFakes>;

/** Stops live Durable Objects before deleting their storage, then restores production ports. */
export async function cleanUp(): Promise<void> {
  await abortAllDurableObjects();
  await reset();
  resetPorts();
}

// ---- Driving the Worker's outer edge ----

export const WEBHOOK_URL = "https://oncall.test/webhook/datadog";
export const SECRET_HEADER = "x-oncall-agent-secret";

const ORG_IDS = { gap: GAP_ORG_ID, wk: WK_ORG_ID } as const;
const ORG_SECRETS = { gap: TEST_SECRETS.GAP_WEBHOOK_SECRET, wk: TEST_SECRETS.WK_WEBHOOK_SECRET } as const;

let sequence = 0;
/** Storage is not isolated between tests, so every test uses its own monitors. */
export function uniqueMonitorId(): string {
  sequence++;
  return String(Date.now() % 1_000_000_000) + String(sequence).padStart(4, "0");
}
/** A fresh Datadog event ID: one per notification; Datadog retries resend the same one. */
export function uniqueAlertId(): string {
  sequence++;
  return `evt-${Date.now()}-${sequence}`;
}

export interface AlertOptions {
  org?: keyof typeof ORG_IDS;
  monitorId?: string;
  group?: string;
  transition?: string;
  tags?: string[] | string;
  alertId?: string;
  title?: string;
}

/** The JSON body an Org's Datadog webhook is configured to send (see src/intake.ts for the contract). */
export function alertPayload(o: AlertOptions = {}) {
  const monitorId = o.monitorId ?? uniqueMonitorId();
  return {
    orgId: ORG_IDS[o.org ?? "gap"],
    alertId: o.alertId ?? uniqueAlertId(),
    transition: o.transition ?? "Triggered",
    monitorId,
    group: o.group ?? "service:checkout,env:prod",
    tags: o.tags ?? ["oncall-agent:enabled", "team:sre", "service:checkout"],
    link: `https://app.datadoghq.eu/monitors/${monitorId}`,
    title: o.title ?? `[Triggered] High error rate on checkout (monitor ${monitorId})`,
    date: String(Date.UTC(2026, 5, 1, 9, 59)),
  };
}

/** POST a webhook to the real Worker, signed with the Org's secret unless `secret` says otherwise. */
export async function sendWebhook(
  body: unknown,
  opts: { org?: keyof typeof ORG_SECRETS; secret?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const secret = opts.secret === undefined ? ORG_SECRETS[opts.org ?? orgOf(body)] : opts.secret;
  if (secret !== null) headers[SECRET_HEADER] = secret;
  return exports.default.fetch(WEBHOOK_URL, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function orgOf(body: unknown): keyof typeof ORG_SECRETS {
  const orgId = (body as { orgId?: string } | null)?.orgId;
  return orgId === WK_ORG_ID ? "wk" : "gap";
}

/** The Investigation Durable Object of an Alert episode, as a fresh stub (e.g. after eviction). */
export function investigationOf(payload: { orgId: string; monitorId: string; group: string }) {
  const org = payload.orgId === WK_ORG_ID ? "wk" : "gap";
  return env.INVESTIGATION.getByName(`${org}:${payload.monitorId}:${payload.group}`);
}

/** A promise the test resolves later, e.g. to hold a Datadog tool call open. */
export function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

/**
 * Lets pending Durable Object work finish before a negative assertion ("nothing more was posted"):
 * runs every due alarm of every Investigation until none is left, then waits a moment for async effects.
 */
export async function settle(): Promise<void> {
  for (let round = 0; round < 5; round++) {
    let ran = false;
    for (const id of await listDurableObjectIds(env.INVESTIGATION)) {
      if (await runDurableObjectAlarm(env.INVESTIGATION.get(id))) ran = true;
    }
    await new Promise((r) => setTimeout(r, 50));
    if (!ran) return;
  }
}
