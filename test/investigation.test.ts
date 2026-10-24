import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alertPayload, cleanUp, installFakes, sendWebhook, settle, type Fakes } from "./harness";
import { TEST_SECRETS } from "./config";
import { DATADOG_WRITE_TOOLS } from "./fakes/datadog-mcp";
import { investigate, text, textOf, toolCall, type Transcript } from "./fakes/model";

let fakes: Fakes;
beforeEach(() => {
  fakes = installFakes();
});
afterEach(cleanUp);

/** The adaptive card's Action.OpenUrl links: the only clickable links in a Teams message. */
function actionUrls(body: unknown): string[] {
  const card = (body as any).attachments[0].content;
  return (card.actions ?? []).map((a: any) => a.url);
}

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

describe("Investigation report", () => {
  it("posts what fired, the Datadog evidence, the suspected cause and the monitor link to the Owning team's channel", async () => {
    const alert = alertPayload({ tags: ["oncall-agent:enabled", "team:sre"] });

    await sendWebhook(alert);

    await vi.waitFor(() => expect(fakes.teams.posts).toHaveLength(1));
    const [post] = fakes.teams.posts;
    expect(post.channel).toBe("sre");
    expect(post.text).toContain("Error rate on checkout above 5%");
    expect(post.text).toContain("NullPointerException in CheckoutController.placeOrder");
    expect(post.text).toContain("A null customer record reaches CheckoutController");
    expect(actionUrls(post.body)).toEqual([alert.link]);
    expect(fakes.datadog.calls.map((c) => c.tool)).toEqual(["search_datadog_logs"]);
    await settle();
    expect(fakes.teams.posts).toHaveLength(1);
  });
});

describe("Run ending without a report", () => {
  const userTurns = (t: Transcript) => t.messages.filter((m) => m.role === "user").length;

  it("asks an agent that answers in plain text to submit its report, and posts that report", async () => {
    fakes.model.script((t) => {
      if (t.userSpoke && userTurns(t) === 1) return text("It is probably the database.");
      if (t.userSpoke) {
        return toolCall("submit_report", { whatFired: "Errors", evidence: ["none"], suspectedCause: "The database is slow" });
      }
      return text("done");
    });

    await sendWebhook(alertPayload());

    await vi.waitFor(() => expect(fakes.teams.posts).toHaveLength(1));
    expect(fakes.teams.posts[0].text).toContain("The database is slow");
    await settle();
    expect(fakes.teams.posts).toHaveLength(1);
  });

  it("posts a failed message, not a report, when the agent never submits one", async () => {
    const log = vi.spyOn(console, "log");
    fakes.model.script(() => text("I give up."));

    await sendWebhook(alertPayload());

    await vi.waitFor(() => expect(fakes.teams.posts).toHaveLength(1));
    const [post] = fakes.teams.posts;
    expect(post.channel).toBe("sre");
    expect(post.text).toMatch(/failed/i);
    expect(post.text).not.toContain("Investigation report:");
    expect(fakes.model.requests).toHaveLength(2); // told once to submit, then it ends
    await vi.waitFor(() => expect(finishedRecords(log)).toMatchObject([{ status: "Failed" }]));
    await settle();
    expect(fakes.teams.posts).toHaveLength(1);
  });
});

describe("Model", () => {
  it("runs the agent on the model named in config", async () => {
    fakes = installFakes({ config: { modelId: "@cf/acme/other-model-2" } });

    await sendWebhook(alertPayload());

    await vi.waitFor(() => expect(fakes.teams.posts).toHaveLength(1));
    expect(fakes.model.requests.length).toBeGreaterThan(0);
    expect(new Set(fakes.model.requests.map((r) => r.modelId))).toEqual(new Set(["@cf/acme/other-model-2"]));
  });

  it("gives the agent the alert to investigate", async () => {
    const alert = alertPayload({ title: "[Triggered] p99 latency on search-api" });

    await sendWebhook(alert);

    await vi.waitFor(() => expect(fakes.teams.posts).toHaveLength(1));
    const prompt = textOf(fakes.model.requests[0].messages.find((m) => m.role === "user")?.content);
    expect(prompt).toContain("p99 latency on search-api");
    expect(prompt).toContain(alert.monitorId);
  });
});

describe("Investigation record", () => {
  it("records status, model cost and duration for every Investigation", async () => {
    const log = vi.spyOn(console, "log");
    const minutes = (n: number) => n * 60_000;
    fakes.datadog.org(TEST_SECRETS.GAP_DATADOG_TOKEN, [
      {
        name: "search_datadog_logs",
        result: () => {
          fakes.clock.advance(minutes(4)); // the investigation takes four minutes of business time
          return { logs: ["timeout talking to payments"] };
        },
      },
    ]);
    const alert = alertPayload();

    await sendWebhook(alert);

    await vi.waitFor(() => expect(fakes.teams.posts).toHaveLength(1));
    const report = fakes.teams.posts[0].text;
    expect(report).toContain("4m 0s");
    expect(report).toMatch(/\$0\.\d\d/);
    await vi.waitFor(() => expect(finishedRecords(log)).toHaveLength(1));
    const [record] = finishedRecords(log);
    expect(record).toMatchObject({ status: "Completed", monitorId: alert.monitorId, org: "gap", durationMs: minutes(4) });
    expect(record.costUsd).toBeGreaterThan(0);
    expect(record.costUsd).toBeLessThan(1);
  });
});

describe("Datadog MCP per Org", () => {
  it("reaches each Org only through its own Datadog MCP connection and token", async () => {
    const tags = ["oncall-agent:enabled", "service:checkout"]; // no team tag: each Org's default channel
    await sendWebhook(alertPayload({ org: "gap", tags }));
    await sendWebhook(alertPayload({ org: "wk", tags }));

    await vi.waitFor(() => expect(fakes.teams.posts).toHaveLength(2));
    const [gap] = fakes.teams.to("gap-default");
    const [wk] = fakes.teams.to("wk-default");
    expect(gap.text).toContain("gap: NullPointerException");
    expect(gap.text).not.toContain("wk: NullPointerException");
    expect(wk.text).toContain("wk: NullPointerException");
    expect(wk.text).not.toContain("gap: NullPointerException");
    const tokens = new Set(fakes.datadog.requests.map((r) => r.token));
    expect(tokens).toEqual(new Set([TEST_SECRETS.GAP_DATADOG_TOKEN, TEST_SECRETS.WK_DATADOG_TOKEN]));
    expect(fakes.datadog.requests.every((r) => r.path === "/v1/mcp")).toBe(true);
  });

  it("offers the agent no Datadog write tools", async () => {
    await sendWebhook(alertPayload());

    await vi.waitFor(() => expect(fakes.teams.posts).toHaveLength(1));
    const offered = fakes.model.requests[0].tools;
    expect(offered).toEqual(
      expect.arrayContaining(["datadog_search_datadog_logs", "datadog_get_datadog_metric", "submit_report"]),
    );
    for (const write of DATADOG_WRITE_TOOLS) expect(offered).not.toContain(`datadog_${write}`);
  });

  it("never lets a Datadog write reach the Org, even when the agent asks for one", async () => {
    fakes.model.script(investigate({ tool: "datadog_update_datadog_monitor", args: { query: "mute everything" } }));

    await sendWebhook(alertPayload());

    await vi.waitFor(() => expect(fakes.teams.posts).toHaveLength(1));
    expect(fakes.datadog.calls.filter((c) => DATADOG_WRITE_TOOLS.includes(c.tool))).toEqual([]);
  });

  it("does not expose a tool the Org's server marks as not read-only, even if it is allowlisted", async () => {
    fakes = installFakes({ config: { datadog: { tools: ["search_datadog_logs", "update_datadog_monitor"] } } });
    fakes.datadog.org(TEST_SECRETS.GAP_DATADOG_TOKEN, [
      { name: "search_datadog_logs", annotations: { readOnlyHint: true }, result: () => ({ logs: [] }) },
      { name: "update_datadog_monitor", annotations: { readOnlyHint: false }, result: () => ({ written: true }) },
    ]);

    await sendWebhook(alertPayload());

    await vi.waitFor(() => expect(fakes.teams.posts).toHaveLength(1));
    expect(fakes.model.requests[0].tools).toEqual(["datadog_search_datadog_logs", "submit_report"]);
  });
});
