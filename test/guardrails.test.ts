import { afterEach, describe, expect, it, vi } from "vitest";
import { abortAllDurableObjects, runDurableObjectAlarm } from "cloudflare:test";
import {
  alertPayload,
  cleanUp,
  evictedWhileTeamsDown,
  gate,
  installFakes,
  investigationOf,
  sendWebhook,
  settle,
  type Fakes,
  waitFor,
} from "./harness";
import { TEST_SECRETS } from "./config";
import { toolCall, type Script } from "./fakes/model";

let fakes: Fakes;
afterEach(cleanUp);

const minutes = (n: number) => n * 60_000;

/** An agent that keeps querying Datadog and never submits its report. */
const keepsSearching: Script = () => toolCall("datadog_search_datadog_logs", { query: "service:checkout status:error" });

/** The structured `investigation.finished` records the Worker logged. */
function finishedRecords(log: { mock: { calls: unknown[][] } }): Array<Record<string, any>> {
  return log.mock.calls
    .map(([line]) => (typeof line === "string" && line.startsWith("{") ? JSON.parse(line) : undefined))
    .filter((r) => r?.event === "investigation.finished");
}

/**
 * No code workspace for the alert's service (its checkout fails): the workspace tools and prompt section would
 * make the first request alone cost over $3 at EXPENSIVE, before any evidence is gathered.
 */
const withoutCode = (f: Fakes) => f.workspace.unavailable("acme/checkout");

/** $ per million tokens at which each model request costs about a dollar or more. */
const EXPENSIVE = 5_000;

describe("Cost cap", () => {
  it("ends an Investigation that spends more than $3 as Partial, with the evidence so far and the reason", async () => {
    const log = vi.spyOn(console, "log");
    fakes = installFakes({ costPerMTok: EXPENSIVE });
    withoutCode(fakes);
    fakes.model.script(keepsSearching);

    await sendWebhook(alertPayload());

    await waitFor(() => expect(fakes.teams.posts).toHaveLength(1));
    const [post] = fakes.teams.posts;
    expect(post.channel).toBe("sre");
    expect(post.text).toMatch(/partial/i);
    expect(post.text).toMatch(/cost cap/i);
    expect(post.text).toContain("$3");
    expect(post.text).toContain("NullPointerException in CheckoutController[.]placeOrder"); // evidence gathered so far
    expect(post.text).not.toContain("Investigation report:");
    expect(fakes.model.requests.length).toBeLessThan(10);
    await waitFor(() => expect(finishedRecords(log)).toMatchObject([{ status: "Partial" }]));
    expect(finishedRecords(log)[0].costUsd).toBeGreaterThanOrEqual(3);
    const requests = fakes.model.requests.length;
    await settle();
    expect(fakes.teams.posts).toHaveLength(1);
    expect(fakes.model.requests).toHaveLength(requests);
  });
});

describe("30-minute limit", () => {
  it("ends an Investigation that runs past 30 minutes as Partial, with the evidence so far and the reason", async () => {
    fakes = installFakes();
    fakes.datadog.org(TEST_SECRETS.GAP_DATADOG_TOKEN, [
      {
        name: "search_datadog_logs",
        result: () => {
          fakes.clock.advance(minutes(11)); // each query takes eleven minutes of business time
          return { logs: ["connection pool exhausted in checkout-db"] };
        },
      },
    ]);
    fakes.model.script(keepsSearching);

    await sendWebhook(alertPayload());

    await waitFor(() => expect(fakes.teams.posts).toHaveLength(1));
    const [post] = fakes.teams.posts;
    expect(post.text).toMatch(/partial/i);
    expect(post.text).toMatch(/30 minutes/);
    expect(post.text).toContain("connection pool exhausted in checkout-db");
    expect(post.text).toContain("33m 0s");
    expect(fakes.datadog.calls).toHaveLength(3);
    await settle();
    expect(fakes.teams.posts).toHaveLength(1);
    expect(fakes.datadog.calls).toHaveLength(3);
  });

  it("stops a run wedged in a Datadog call when its alarm finds it past 30 minutes", async () => {
    fakes = installFakes();
    const held = gate();
    fakes.datadog.org(TEST_SECRETS.GAP_DATADOG_TOKEN, [
      {
        name: "search_datadog_logs",
        result: async () => {
          await held.opened; // never answers on its own
          return { logs: ["late answer"] };
        },
      },
    ]);
    fakes.model.script(keepsSearching);
    const alert = alertPayload();
    await sendWebhook(alert);
    await waitFor(() => expect(fakes.datadog.calls).toHaveLength(1));

    fakes.clock.advance(minutes(31));
    await waitFor(
      async () => {
        await runDurableObjectAlarm(investigationOf(alert));
        expect(fakes.teams.posts).toHaveLength(1);
      },
      { interval: 200 },
    );

    const [post] = fakes.teams.posts;
    expect(post.text).toMatch(/partial/i);
    expect(post.text).toMatch(/30 minutes/);
    held.open();
    await settle();
    expect(fakes.teams.posts).toHaveLength(1);
    expect(fakes.datadog.calls).toHaveLength(1);
  });
});

describe("Once across replays", () => {
  it("posts the partial message once when Teams fails at first and the Investigation is evicted", async () => {
    fakes = installFakes({ costPerMTok: EXPENSIVE });
    withoutCode(fakes);
    fakes.model.script(keepsSearching);
    fakes.teams.fail(1_000_000);
    const alert = alertPayload();
    await sendWebhook(alert);

    await evictedWhileTeamsDown(fakes, alert);
    expect(fakes.teams.posts).toHaveLength(1);
    expect(fakes.teams.posts[0].text).toMatch(/cost cap/i);
    const requests = fakes.model.requests.length;

    await abortAllDurableObjects();
    await runDurableObjectAlarm(investigationOf(alert));
    await settle();
    expect(fakes.teams.posts).toHaveLength(1);
    expect(fakes.model.requests).toHaveLength(requests);
  });
});

describe("Crash", () => {
  it("ends an Investigation that cannot run because Datadog MCP is down as Failed, with a message", async () => {
    fakes = installFakes();
    fakes.datadog.setDown(true);
    const alert = alertPayload();
    await sendWebhook(alert);
    await waitFor(() => expect(fakes.datadog.requests.length).toBeGreaterThan(0));

    fakes.clock.advance(minutes(31));
    await waitFor(
      async () => {
        await runDurableObjectAlarm(investigationOf(alert));
        expect(fakes.teams.posts).toHaveLength(1);
      },
      { interval: 200 },
    );

    const [post] = fakes.teams.posts;
    expect(post.channel).toBe("sre");
    expect(post.text).toMatch(/failed/i);
    expect(post.text).toMatch(/503|unavailable/i);
    expect(fakes.model.requests).toHaveLength(0);
    fakes.datadog.setDown(false);
    await settle();
    expect(fakes.teams.posts).toHaveLength(1);
    expect(fakes.model.requests).toHaveLength(0);
  });
});
