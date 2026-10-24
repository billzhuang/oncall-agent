import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alertPayload, cleanUp, installFakes, sendWebhook, settle, uniqueMonitorId, type Fakes } from "./harness";

let fakes: Fakes;
beforeEach(() => {
  fakes = installFakes();
});
afterEach(cleanUp);

describe("Alert to Teams", () => {
  it("posts a placeholder Investigation report to the Owning team's channel when an Opted-in monitor triggers", async () => {
    const alert = alertPayload({ tags: ["oncall-agent:enabled", "team:sre"], title: "[Triggered] High error rate on checkout" });

    const res = await sendWebhook(alert);

    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(fakes.teams.posts).toHaveLength(1));
    const [post] = fakes.teams.posts;
    expect(post.channel).toBe("sre");
    expect(post.text).toContain("High error rate on checkout");
    expect(post.text).toContain(alert.link);
    expect(post.text).toContain("gap");
  });

  it("builds the placeholder report from the alert alone, without calling the model", async () => {
    fakes.clock.set(Date.UTC(2026, 6, 4, 8, 30));

    await sendWebhook(alertPayload());

    await vi.waitFor(() => expect(fakes.teams.posts).toHaveLength(1));
    expect(fakes.teams.posts[0].text).toContain("2026-07-04T08:30:00.000Z");
    expect(fakes.model.faux.state.callCount).toBe(0);
  });

  it("links the monitor on the Org's Datadog site, never a link the webhook supplied elsewhere", async () => {
    const monitorId = uniqueMonitorId();
    const alert = { ...alertPayload({ monitorId }), link: "https://evil.example/monitors/1?next=app.datadoghq.eu" };

    await sendWebhook(alert);

    await vi.waitFor(() => expect(fakes.teams.posts).toHaveLength(1));
    expect(fakes.teams.posts[0].text).toContain(`https://app.datadoghq.eu/monitors/${monitorId}`);
    expect(fakes.teams.posts[0].text).not.toContain("evil.example");
  });

  it("keeps a webhook monitor link that points at the Org's Datadog site", async () => {
    const monitorId = uniqueMonitorId();
    const link = `https://app.datadoghq.eu/monitors/${monitorId}?group=service%3Acheckout`;

    await sendWebhook({ ...alertPayload({ monitorId }), link });

    await vi.waitFor(() => expect(fakes.teams.posts).toHaveLength(1));
    expect(fakes.teams.posts[0].text).toContain(link);
  });
});

describe("Teams routing", () => {
  it("posts to the Org's default channel when the monitor has no team tag", async () => {
    await sendWebhook(alertPayload({ tags: ["oncall-agent:enabled", "service:checkout"] }));

    await vi.waitFor(() => expect(fakes.teams.posts).toHaveLength(1));
    expect(fakes.teams.posts[0].channel).toBe("gap-default");
  });

  it("posts to the Org's default channel when the team tag has no channel mapping", async () => {
    await sendWebhook(alertPayload({ org: "wk", tags: ["oncall-agent:enabled", "team:search"] }));

    await vi.waitFor(() => expect(fakes.teams.posts).toHaveLength(1));
    expect(fakes.teams.posts[0].channel).toBe("wk-default");
  });

  it("reads the team-channel map from config", async () => {
    fakes = installFakes({ config: { teams: { search: "TEAMS_PAYMENTS_URL" } } });

    await sendWebhook(alertPayload({ tags: ["oncall-agent:enabled", "team:search"] }));

    await vi.waitFor(() => expect(fakes.teams.posts).toHaveLength(1));
    expect(fakes.teams.posts[0].channel).toBe("payments");
  });

  it("accepts tags as Datadog's comma-separated $TAGS string", async () => {
    await sendWebhook(alertPayload({ tags: "service:checkout, oncall-agent:enabled, team:payments" }));

    await vi.waitFor(() => expect(fakes.teams.posts).toHaveLength(1));
    expect(fakes.teams.posts[0].channel).toBe("payments");
  });
});

describe("Webhook validation", () => {
  it("rejects a webhook from an Org not in the Org registry, with no effect", async () => {
    const res = await sendWebhook({ ...alertPayload(), orgId: "9999" }, { secret: "gap-webhook-secret" });

    expect(res.status).toBe(401);
    await settle();
    expect(fakes.teams.posts).toHaveLength(0);
  });

  it("rejects a webhook with the wrong per-Org secret, with no effect", async () => {
    const res = await sendWebhook(alertPayload(), { secret: "not-the-secret" });

    expect(res.status).toBe(401);
    await settle();
    expect(fakes.teams.posts).toHaveLength(0);
  });

  it("rejects a webhook signed with another Org's secret", async () => {
    const res = await sendWebhook(alertPayload({ org: "gap" }), { org: "wk" });

    expect(res.status).toBe(401);
    await settle();
    expect(fakes.teams.posts).toHaveLength(0);
  });

  it("rejects a webhook without the secret header", async () => {
    const res = await sendWebhook(alertPayload(), { secret: null });

    expect(res.status).toBe(401);
    await settle();
    expect(fakes.teams.posts).toHaveLength(0);
  });

  it("rejects every webhook for an Org whose webhook secret is not set as a Worker secret", async () => {
    fakes = installFakes({
      config: {
        orgs: [
          {
            name: "gap",
            datadogOrgId: "1001",
            tokenSecret: "GAP_DATADOG_TOKEN",
            tokenExpiresOn: "2027-06-01",
            webhookSecret: "UNSET_WEBHOOK_SECRET",
            defaultTeamsSecret: "GAP_DEFAULT_TEAMS_URL",
          },
        ],
      },
    });

    for (const secret of [null, "", "undefined"]) {
      expect((await sendWebhook(alertPayload(), { secret })).status).toBe(401);
    }
    await settle();
    expect(fakes.teams.posts).toHaveLength(0);
  });

  it("leaves no trace of a rejected webhook: the genuine delivery that follows still starts the Investigation", async () => {
    const alert = alertPayload();
    await sendWebhook(alert, { secret: "forged" });

    const res = await sendWebhook(alert);

    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(fakes.teams.posts).toHaveLength(1));
  });

  it("rejects a body that is not the webhook contract", async () => {
    expect((await sendWebhook("{not json", { org: "gap" })).status).toBe(400);
    expect((await sendWebhook({ orgId: "1001", transition: "Triggered" })).status).toBe(400);
    expect((await sendWebhook(alertPayload({ transition: "Exploded" }))).status).toBe(400);
    expect((await sendWebhook({ ...alertPayload(), monitorId: "../../admin" })).status).toBe(400);
    await settle();
    expect(fakes.teams.posts).toHaveLength(0);
  });

  it("answers only POST on the webhook endpoint", async () => {
    const { exports } = await import("cloudflare:workers");
    expect((await exports.default.fetch("https://oncall.test/webhook/datadog")).status).toBe(405);
    expect((await exports.default.fetch("https://oncall.test/elsewhere")).status).toBe(404);
  });
});

describe("Alert episodes", () => {
  it("has no extra effect when Datadog delivers the same webhook twice", async () => {
    const alert = alertPayload();
    await sendWebhook(alert);
    await vi.waitFor(() => expect(fakes.teams.posts).toHaveLength(1));

    const res = await sendWebhook(alert);

    expect(res.status).toBe(202);
    await settle();
    expect(fakes.teams.posts).toHaveLength(1);
  });

  it("has no extra effect when the duplicate arrives before the report is posted", async () => {
    const alert = alertPayload();

    await Promise.all([sendWebhook(alert), sendWebhook(alert)]);

    await vi.waitFor(() => expect(fakes.teams.posts).toHaveLength(1));
    await settle();
    expect(fakes.teams.posts).toHaveLength(1);
  });

  it.each(["Triggered", "Re-Triggered"])(
    "joins a %s re-trigger to the open Alert episode's Investigation: one report",
    async (transition) => {
      const monitorId = uniqueMonitorId();
      await sendWebhook(alertPayload({ monitorId }));
      await vi.waitFor(() => expect(fakes.teams.posts).toHaveLength(1));

      fakes.clock.advance(10 * 60_000);
      const res = await sendWebhook(alertPayload({ monitorId, transition }));

      expect(res.status).toBe(202);
      await settle();
      expect(fakes.teams.posts).toHaveLength(1);
    },
  );

  it("gives each group of a monitor its own Investigation", async () => {
    const monitorId = uniqueMonitorId();
    await sendWebhook(alertPayload({ monitorId, group: "service:checkout" }));
    await sendWebhook(alertPayload({ monitorId, group: "service:search" }));

    await vi.waitFor(() => expect(fakes.teams.posts).toHaveLength(2));
    expect(fakes.teams.posts.map((p) => p.text).join()).toContain("service:search");
  });

  it("gives the same monitor in two Orgs two Investigations", async () => {
    const monitorId = uniqueMonitorId();
    await sendWebhook(alertPayload({ org: "gap", monitorId, tags: ["oncall-agent:enabled"] }));
    await sendWebhook(alertPayload({ org: "wk", monitorId, tags: ["oncall-agent:enabled"] }));

    await vi.waitFor(() => expect(fakes.teams.posts).toHaveLength(2));
    expect(fakes.teams.to("gap-default")).toHaveLength(1);
    expect(fakes.teams.to("wk-default")).toHaveLength(1);
  });

  it("still posts the report, once, when Teams is failing at first", async () => {
    fakes.teams.fail(2);

    await sendWebhook(alertPayload());

    await vi.waitFor(
      async () => {
        await settle();
        expect(fakes.teams.posts).toHaveLength(1);
      },
      { timeout: 15_000, interval: 250 },
    );
    await settle();
    expect(fakes.teams.posts).toHaveLength(1);
  });
});

describe("Opt-in and transitions", () => {
  it("ignores a monitor without the oncall-agent:enabled tag", async () => {
    const res = await sendWebhook(alertPayload({ tags: ["team:sre", "oncall-agent:disabled"] }));

    expect(res.status).toBe(202); // 2xx, or Datadog would retry
    await settle();
    expect(fakes.teams.posts).toHaveLength(0);
  });

  it.each(["Warn", "No Data", "Re-Warn"])("ignores a %s transition", async (transition) => {
    const res = await sendWebhook(alertPayload({ transition }));

    expect(res.status).toBe(202);
    await settle();
    expect(fakes.teams.posts).toHaveLength(0);
  });

  it("does not start an Investigation on Recovered", async () => {
    const res = await sendWebhook(alertPayload({ transition: "Recovered" }));

    expect(res.status).toBe(202);
    await settle();
    expect(fakes.teams.posts).toHaveLength(0);
  });

  it("ignores a Warn that precedes the Triggered, then starts on the Triggered", async () => {
    const monitorId = uniqueMonitorId();
    await sendWebhook(alertPayload({ monitorId, transition: "Warn" }));
    await sendWebhook(alertPayload({ monitorId, transition: "Triggered" }));

    await vi.waitFor(() => expect(fakes.teams.posts).toHaveLength(1));
  });
});
