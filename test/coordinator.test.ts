import { afterEach, describe, expect, it, vi } from "vitest";
import { TEST_SECRETS } from "./config";
import { investigate, toolCall, type Transcript } from "./fakes/model";
import { alertPayload, cleanUp, gate, installFakes, sendWebhook, settle, type Fakes } from "./harness";

let fakes: Fakes;
afterEach(cleanUp);

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
});
