import { afterEach, describe, expect, it, vi } from "vitest";
import { TEST_SECRETS, testConfig } from "./config";
import { investigate, textOf, toolCall, type ModelRequest, type Transcript } from "./fakes/model";
import { alertPayload, cleanUp, gate, installFakes, sendWebhook, settle, type Fakes } from "./harness";

let fakes: Fakes;
afterEach(cleanUp);

const BUDGETS = testConfig().budgets;

/** The alert a model request's Investigation was started with. */
const alertText = (r: ModelRequest) => textOf(r.messages.find((m) => m.role === "user")?.content);

/** The monitor an Investigation's agent was started on, read from the alert it was given. */
const monitorOf = (t: Transcript) => /Monitor ID: (\d+)/.exec(t.alert)?.[1] ?? "";

/**
 * Agents whose Datadog log search blocks until the test releases that monitor, so the test decides when each
 * Investigation finishes. `started` lists monitors in the order their agents began working.
 */
function holdInvestigations(f: Fakes, monitors: string[]) {
  // Made here, in the test: a promise made inside one Durable Object must not be awaited by another.
  const gates = new Map(monitors.map((m) => [m, gate()]));
  const gateFor = (monitor: string) => {
    const held = gates.get(monitor);
    if (!held) throw new Error(`no gate for monitor ${monitor}`);
    return held;
  };
  const started: string[] = [];
  f.datadog.org(TEST_SECRETS.GAP_DATADOG_TOKEN, [
    {
      name: "search_datadog_logs",
      result: async ({ query }: { query: string }) => {
        if (!started.includes(query)) started.push(query);
        await gateFor(query).opened;
        return { logs: [`errors on monitor ${query}`] };
      },
    },
  ]);
  const finish = investigate();
  f.model.script((t) => (t.userSpoke ? toolCall("datadog_search_datadog_logs", { query: monitorOf(t) }) : finish(t)));
  return { started, release: (monitor: string) => gateFor(monitor).open() };
}

describe("Concurrency", () => {
  it("runs at most 5 Investigations at once and starts waiting ones in arrival order as slots free", async () => {
    fakes = installFakes();
    const alerts = Array.from({ length: 7 }, () => alertPayload());
    const held = holdInvestigations(fakes, alerts.map((a) => a.monitorId));
    for (const alert of alerts) await sendWebhook(alert);

    await vi.waitFor(() => expect(held.started).toHaveLength(5));
    await settle();
    expect(held.started).toEqual(alerts.slice(0, 5).map((a) => a.monitorId));
    expect(fakes.teams.posts).toHaveLength(0);

    held.release(alerts[0].monitorId);
    await vi.waitFor(() => expect(held.started).toHaveLength(6));
    expect(held.started[5]).toBe(alerts[5].monitorId);
    expect(fakes.teams.posts).toHaveLength(1);

    held.release(alerts[3].monitorId);
    await vi.waitFor(() => expect(held.started).toHaveLength(7));
    expect(held.started[6]).toBe(alerts[6].monitorId);

    for (const alert of alerts) held.release(alert.monitorId);
    await vi.waitFor(() => expect(fakes.teams.posts).toHaveLength(7));
    expect(fakes.teams.posts.every((p) => p.text.startsWith("Investigation report"))).toBe(true);
  });

  it("takes the concurrency limit from config", async () => {
    fakes = installFakes({ config: { budgets: { ...BUDGETS, maxConcurrent: 2 } } });
    const alerts = Array.from({ length: 3 }, () => alertPayload());
    const held = holdInvestigations(fakes, alerts.map((a) => a.monitorId));
    for (const alert of alerts) await sendWebhook(alert);

    await vi.waitFor(() => expect(held.started).toHaveLength(2));
    await settle();
    expect(held.started).toEqual([alerts[0].monitorId, alerts[1].monitorId]);

    held.release(alerts[1].monitorId);
    await vi.waitFor(() => expect(held.started).toEqual(alerts.map((a) => a.monitorId)));
  });

  it("keeps the run slot of an Investigation still running past its lease, so the limit is never exceeded", async () => {
    fakes = installFakes({ config: { budgets: { ...BUDGETS, maxConcurrent: 1 } } });
    const alerts = Array.from({ length: 3 }, () => alertPayload());
    const held = holdInvestigations(fakes, alerts.map((a) => a.monitorId));
    await sendWebhook(alerts[0]);
    await sendWebhook(alerts[1]);
    await vi.waitFor(() => expect(held.started).toHaveLength(1));

    // Past the run slot's lease (30-minute limit plus 5), short of its hard cap (plus 15). No settle(): it would
    // run the Investigation's alarm, and the time limit (#4) may then rightly stop it and free its slot.
    fakes.clock.advance(40 * 60_000);
    await sendWebhook(alerts[2]);
    await new Promise((r) => setTimeout(r, 500));
    expect(held.started).toEqual([alerts[0].monitorId]);

    held.release(alerts[0].monitorId);
    await vi.waitFor(() => expect(held.started).toEqual([alerts[0].monitorId, alerts[1].monitorId]));
  });

  it("takes back the run slot of an Investigation stuck past its hard cap, stopping it with a failed message", async () => {
    fakes = installFakes({ config: { budgets: { ...BUDGETS, maxConcurrent: 1 } } });
    const alerts = Array.from({ length: 3 }, () => alertPayload());
    const held = holdInvestigations(fakes, alerts.map((a) => a.monitorId));
    await sendWebhook(alerts[0]);
    await sendWebhook(alerts[1]);
    await vi.waitFor(() => expect(held.started).toHaveLength(1));

    fakes.clock.advance(46 * 60_000); // stuck in a Datadog call past the 30-minute limit plus 15
    await sendWebhook(alerts[2]);

    await vi.waitFor(() => expect(held.started).toEqual([alerts[0].monitorId, alerts[1].monitorId]));
    await vi.waitFor(() => expect(fakes.teams.posts).toHaveLength(1));
    expect(fakes.teams.posts[0].text).toMatch(/^Investigation failed/);
    expect(fakes.teams.posts[0].text).toContain(alerts[0].monitorId);
    expect(held.started).toHaveLength(2);
  });
});

describe("Daily budget", () => {
  /** Below the cost of one Investigation with the scripted model, so the first one exhausts the day's budget. */
  const TINY_BUDGET = { ...BUDGETS, dailyUsd: 0.000001 };

  /** Sends an alert and waits for its one Teams message. */
  async function alertAndWait(alert: ReturnType<typeof alertPayload>) {
    const before = fakes.teams.posts.length;
    await sendWebhook(alert);
    await vi.waitFor(() => expect(fakes.teams.posts).toHaveLength(before + 1));
    await settle();
    return fakes.teams.posts[before];
  }

  const investigatedMonitors = () => new Set(fakes.model.requests.map((r) => /Monitor ID: (\d+)/.exec(alertText(r))?.[1]));

  it("skips new Alert episodes once the day's spend reaches the budget, with one notice to the Owning team", async () => {
    fakes = installFakes({ config: { budgets: TINY_BUDGET } });
    const first = alertPayload();
    const second = alertPayload();

    expect((await alertAndWait(first)).text).toMatch(/^Investigation report/);
    const notice = await alertAndWait(second);

    expect(notice.channel).toBe("sre");
    expect(notice.text).toMatch(/budget exhausted, not investigated/i);
    expect(notice.text).toContain(second.link);
    expect(investigatedMonitors().has(second.monitorId)).toBe(false);

    await sendWebhook(alertPayload({ monitorId: second.monitorId })); // a re-trigger of the skipped episode
    await settle();
    expect(fakes.teams.posts).toHaveLength(2);
    expect(investigatedMonitors().has(second.monitorId)).toBe(false);
  });

  it("counts an Investigation's spend against the budget even when its outcome cannot be posted", async () => {
    fakes = installFakes({ config: { budgets: TINY_BUDGET } });
    fakes.teams.fail(1_000_000); // Teams is down: the first Investigation never manages to post its report
    const first = alertPayload();
    const second = alertPayload();

    await sendWebhook(first);
    await vi.waitFor(() => expect(investigatedMonitors().has(first.monitorId)).toBe(true));
    await vi.waitFor(() => expect(fakes.model.requests.length).toBeGreaterThanOrEqual(2)); // report submitted
    await settle();
    await sendWebhook(second);
    await settle();

    expect(investigatedMonitors().has(second.monitorId)).toBe(false);
  });

  it("charges an Investigation's recorded spend, not a reservation, once it finishes", async () => {
    // Each Investigation costs cents, but a run in progress is reserved at the $3 per-Investigation cap.
    fakes = installFakes({ config: { budgets: { ...BUDGETS, dailyUsd: 5 } } });
    for (let i = 0; i < 3; i++) {
      expect((await alertAndWait(alertPayload())).text).toMatch(/^Investigation report/);
    }
  });

  it("does not skip while the day's spend is below the budget", async () => {
    fakes = installFakes(); // $30 a day
    for (let i = 0; i < 3; i++) {
      expect((await alertAndWait(alertPayload())).text).toMatch(/^Investigation report/);
    }
  });

  it("resets at 00:00 UTC", async () => {
    fakes = installFakes({ config: { budgets: TINY_BUDGET }, now: Date.UTC(2026, 5, 1, 23, 50) });
    await alertAndWait(alertPayload());

    fakes.clock.set(Date.UTC(2026, 5, 1, 23, 59, 59));
    expect((await alertAndWait(alertPayload())).text).toMatch(/budget exhausted/i);

    fakes.clock.set(Date.UTC(2026, 5, 2, 0, 0, 0));
    expect((await alertAndWait(alertPayload())).text).toMatch(/^Investigation report/);
  });

  it("reserves a running Investigation's cap: episodes arriving meanwhile are skipped if it could exhaust the budget", async () => {
    fakes = installFakes({ config: { budgets: TINY_BUDGET } });
    const alerts = Array.from({ length: 3 }, () => alertPayload());
    const held = holdInvestigations(fakes, alerts.map((a) => a.monitorId));
    await sendWebhook(alerts[0]);
    await vi.waitFor(() => expect(held.started).toHaveLength(1));

    await sendWebhook(alerts[1]);
    await sendWebhook(alerts[2]);
    await vi.waitFor(() => expect(fakes.teams.posts).toHaveLength(2));
    expect(fakes.teams.posts.map((p) => /budget exhausted/i.test(p.text))).toEqual([true, true]);

    held.release(alerts[0].monitorId);
    await vi.waitFor(() => expect(fakes.teams.posts).toHaveLength(3));
    await settle();
    expect(fakes.teams.posts[2].text).toMatch(/^Investigation report/);
    expect(held.started).toEqual([alerts[0].monitorId]);
  });
});
