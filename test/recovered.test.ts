import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDurableObjectAlarm } from "cloudflare:test";
import { alertPayload, cleanUp, evictedWhileTeamsDown, gate, installFakes, investigationOf, sendWebhook, settle, uniqueMonitorId, type Fakes, waitFor } from "./harness";
import { TEST_SECRETS, testConfig } from "./config";

let fakes: Fakes;
beforeEach(() => {
  fakes = installFakes();
});
afterEach(cleanUp);

/** The structured `investigation.finished` records the Worker logged. */
function finishedRecords(log: { mock: { calls: unknown[][] } }): Array<Record<string, any>> {
  return log.mock.calls
    .map(([line]) => {
      try {
        return typeof line === "string" ? JSON.parse(line) : undefined;
      } catch {
        return undefined;
      }
    })
    .filter((r) => r?.event === "investigation.finished");
}

/** Holds the Org's Datadog log search open until the test releases it, so the Investigation stays running. */
function holdDatadog() {
  const held = gate();
  let searches = 0;
  fakes.datadog.org(TEST_SECRETS.GAP_DATADOG_TOKEN, [
    {
      name: "search_datadog_logs",
      result: async () => {
        searches++;
        await held.opened;
        return { logs: ["OutOfMemoryError in checkout-worker"] };
      },
    },
  ]);
  return { release: held.open, searches: () => searches };
}

/** Runs the Investigation's due alarms until `check` passes (a finalize may wait for the run to settle). */
async function untilPosted(alert: ReturnType<typeof alertPayload>, n: number) {
  await waitFor(
    async () => {
      await runDurableObjectAlarm(investigationOf(alert));
      expect(fakes.teams.posts).toHaveLength(n);
    },
    { interval: 200 },
  );
}

describe("Recovered", () => {
  it("stops a running Investigation and posts the stopped on recovery note once, not a report", async () => {
    const log = vi.spyOn(console, "log");
    const datadog = holdDatadog();
    const monitorId = uniqueMonitorId();
    const triggered = alertPayload({ monitorId });
    await sendWebhook(triggered);
    await waitFor(() => expect(datadog.searches()).toBe(1));

    const res = await sendWebhook(alertPayload({ monitorId, transition: "Recovered" }));

    expect(res.status).toBe(202);
    await untilPosted(triggered, 1);
    const [note] = fakes.teams.posts;
    expect(note.channel).toBe("sre");
    expect(note.text).toMatch(/stopped/i);
    expect(note.text).toMatch(/recovered/i);
    expect(note.text).not.toContain("Investigation report:");
    await waitFor(() => expect(finishedRecords(log)).toMatchObject([{ status: "Stopped", monitorId }]));

    datadog.release();
    const modelRequests = fakes.model.requests.length;
    await settle();
    expect(fakes.teams.posts).toHaveLength(1);
    expect(fakes.model.requests).toHaveLength(modelRequests);
  });

  it("has no extra effect when Datadog delivers the same Recovered twice", async () => {
    const datadog = holdDatadog();
    const monitorId = uniqueMonitorId();
    const triggered = alertPayload({ monitorId });
    await sendWebhook(triggered);
    await waitFor(() => expect(datadog.searches()).toBe(1));
    const recovered = alertPayload({ monitorId, transition: "Recovered" });

    await sendWebhook(recovered);
    const retry = await sendWebhook(recovered);

    expect(await retry.json()).toEqual({ outcome: "duplicate" });
    await untilPosted(triggered, 1);
    datadog.release();
    await settle();
    expect(fakes.teams.posts).toHaveLength(1);
  });

  it("only closes the Alert episode when its Investigation has already finished: no note", async () => {
    const monitorId = uniqueMonitorId();
    await sendWebhook(alertPayload({ monitorId }));
    await waitFor(() => expect(fakes.teams.posts).toHaveLength(1));
    await settle();

    const res = await sendWebhook(alertPayload({ monitorId, transition: "Recovered" }));

    expect(res.status).toBe(202);
    await settle();
    expect(fakes.teams.posts).toHaveLength(1);
    expect(fakes.teams.posts[0].text).toContain("Investigation report:");
  });

  it("posts the note once when Teams fails and the Investigation is evicted before it retries", async () => {
    const datadog = holdDatadog();
    const monitorId = uniqueMonitorId();
    const triggered = alertPayload({ monitorId });
    await sendWebhook(triggered);
    await waitFor(() => expect(datadog.searches()).toBe(1));
    fakes.teams.fail(1_000_000);

    await sendWebhook(alertPayload({ monitorId, transition: "Recovered" }));
    await evictedWhileTeamsDown(fakes, triggered);

    datadog.release();
    await settle();
    expect(fakes.teams.posts).toHaveLength(1);
    expect(fakes.teams.posts[0].text).toMatch(/stopped/i);
  });

  it("posts the note once when Teams fails at first", async () => {
    const datadog = holdDatadog();
    const monitorId = uniqueMonitorId();
    const triggered = alertPayload({ monitorId });
    await sendWebhook(triggered);
    await waitFor(() => expect(datadog.searches()).toBe(1));
    fakes.teams.fail(1);

    await sendWebhook(alertPayload({ monitorId, transition: "Recovered" }));

    await untilPosted(triggered, 1);
    expect(fakes.teams.posts[0].text).toMatch(/stopped/i);
    datadog.release();
    await settle();
    expect(fakes.teams.posts).toHaveLength(1);
  });
});

describe("Recovered while Queued", () => {
  it("records no model cost for an Alert episode stopped before it ran, whatever earlier episodes spent", async () => {
    fakes = installFakes({ config: { budgets: { ...testConfig().budgets, maxConcurrent: 1 } } });
    const log = vi.spyOn(console, "log");
    const monitorId = uniqueMonitorId();
    await sendWebhook(alertPayload({ monitorId }));
    await waitFor(() => expect(finishedRecords(log)).toMatchObject([{ monitorId, episode: 1, status: "Completed" }]));
    expect(finishedRecords(log)[0].costUsd).toBeGreaterThan(0);
    await sendWebhook(alertPayload({ monitorId, transition: "Recovered" }));

    const datadog = holdDatadog(); // another monitor's Investigation takes the only run slot
    await sendWebhook(alertPayload());
    await waitFor(() => expect(datadog.searches()).toBe(1));
    await sendWebhook(alertPayload({ monitorId })); // episode 2: queued behind it
    await sendWebhook(alertPayload({ monitorId, transition: "Recovered" }));

    await waitFor(() => expect(finishedRecords(log).filter((r) => r.monitorId === monitorId)).toHaveLength(2));
    expect(finishedRecords(log).find((r) => r.monitorId === monitorId && r.episode === 2)).toMatchObject({
      status: "Stopped",
      costUsd: 0,
    });
    datadog.release();
  });
});

describe("A later Triggered after Recovered", () => {
  /** The user messages a model request saw: the alert, and any nudges. */
  const userTexts = (r: { messages: Array<{ role: string; content: unknown }> }) =>
    r.messages.filter((m) => m.role === "user").map((m) => JSON.stringify(m.content));

  it("starts a new Alert episode: a fresh Investigation, on a fresh context, with exactly one report", async () => {
    const monitorId = uniqueMonitorId();
    await sendWebhook(alertPayload({ monitorId }));
    await waitFor(() => expect(fakes.teams.posts).toHaveLength(1));
    await settle();
    await sendWebhook(alertPayload({ monitorId, transition: "Recovered" }));
    await settle();
    const firstEpisodeRequests = fakes.model.requests.length;

    fakes.clock.advance(60 * 60_000);
    const res = await sendWebhook(alertPayload({ monitorId, title: "[Triggered] checkout errors are back" }));

    expect(await res.json()).toEqual({ outcome: "opened" });
    await waitFor(() => expect(fakes.teams.posts).toHaveLength(2));
    expect(fakes.teams.posts[1].text).toContain("Investigation report:");
    expect(fakes.teams.posts[1].text).toContain("checkout errors are back");
    const secondEpisode = fakes.model.requests.slice(firstEpisodeRequests);
    expect(secondEpisode.length).toBeGreaterThan(0);
    expect(userTexts(secondEpisode[0])).toHaveLength(1); // only the new alert: nothing of the first episode
    expect(userTexts(secondEpisode[0])[0]).toContain("checkout errors are back");
    await settle();
    expect(fakes.teams.posts).toHaveLength(2);
  });

  it("starts a new Alert episode after one that was stopped on recovery", async () => {
    const datadog = holdDatadog();
    const monitorId = uniqueMonitorId();
    const triggered = alertPayload({ monitorId });
    await sendWebhook(triggered);
    await waitFor(() => expect(datadog.searches()).toBe(1));
    await sendWebhook(alertPayload({ monitorId, transition: "Recovered" }));
    await untilPosted(triggered, 1);
    datadog.release();
    await settle();

    await sendWebhook(alertPayload({ monitorId, title: "[Triggered] checkout errors are back" }));

    await untilPosted(triggered, 2);
    expect(fakes.teams.posts[1].text).toContain("Investigation report:");
    expect(fakes.teams.posts[1].text).toContain("checkout errors are back");
    await settle();
    expect(fakes.teams.posts).toHaveLength(2);
  });

  it("waits for a flapping monitor's stopped Investigation to finish, then investigates the new Alert episode", async () => {
    const log = vi.spyOn(console, "log");
    const datadog = holdDatadog();
    const monitorId = uniqueMonitorId();
    const triggered = alertPayload({ monitorId });
    await sendWebhook(triggered);
    await waitFor(() => expect(datadog.searches()).toBe(1));
    fakes.teams.fail(1); // the stopped on recovery note is delayed, so the new Triggered arrives mid-stop

    await sendWebhook(alertPayload({ monitorId, transition: "Recovered" }));
    await sendWebhook(alertPayload({ monitorId, title: "[Triggered] checkout errors are back" }));
    datadog.release();

    await untilPosted(triggered, 2);
    const [note, report] = fakes.teams.posts;
    expect(note.text).toMatch(/stopped/i);
    expect(report.text).toContain("Investigation report:");
    expect(report.text).toContain("checkout errors are back");
    await waitFor(() =>
      expect(finishedRecords(log).map((r) => [r.episode, r.status])).toEqual([
        [1, "Stopped"],
        [2, "Completed"],
      ]),
    );
    await settle();
    expect(fakes.teams.posts).toHaveLength(2);
  });
});
