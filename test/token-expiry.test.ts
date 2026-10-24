import { env } from "cloudflare:workers";
import { createScheduledController } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { testConfig } from "./config";
import { cleanUp, installFakes, type Fakes } from "./harness";

let fakes: Fakes;
afterEach(cleanUp);

// Durable Object storage is not isolated between tests and the Org names are fixed, so each test uses its own
// calendar days: a warning recorded for one test's day must not suppress another test's.

/** The Org registry with the given token expiry dates (UTC, YYYY-MM-DD) for the two test Orgs. */
function withExpiry(expiry: { gap?: string; wk?: string }) {
  const orgs = testConfig().orgs.map((org) => ({
    ...org,
    tokenExpiresOn: expiry[org.name as "gap" | "wk"] ?? "2027-06-01",
  }));
  return { orgs };
}

/** Fires the daily scheduled check the way the cron trigger does, at the fake clock's time. */
async function runDailyCheck(): Promise<void> {
  const now = fakes.clock.now();
  await worker.scheduled(createScheduledController({ scheduledTime: now, cron: "0 6 * * *" }), env);
}

describe("Token expiry warning", () => {
  it("warns the Org's default Teams channel when its Datadog token expires within 14 days, naming the Org and date", async () => {
    fakes = installFakes({ now: Date.UTC(2026, 5, 1, 6, 0), config: withExpiry({ gap: "2026-06-10" }) });

    await runDailyCheck();

    expect(fakes.teams.posts).toHaveLength(1);
    const [post] = fakes.teams.posts;
    expect(post.channel).toBe("gap-default");
    expect(post.text).toContain("gap");
    expect(post.text).toContain("2026-06-10");
  });

  it("does not warn when every token expires more than 14 days away", async () => {
    fakes = installFakes({ now: Date.UTC(2026, 6, 1, 6, 0), config: withExpiry({ gap: "2026-07-16", wk: "2027-06-01" }) });

    await runDailyCheck();

    expect(fakes.teams.posts).toHaveLength(0);
  });

  it("warns on the 14th day before expiry, and only for the Org whose token is expiring", async () => {
    fakes = installFakes({ now: Date.UTC(2026, 7, 1, 23, 30), config: withExpiry({ gap: "2027-06-01", wk: "2026-08-15" }) });

    await runDailyCheck();

    expect(fakes.teams.posts.map((p) => p.channel)).toEqual(["wk-default"]);
    expect(fakes.teams.posts[0].text).toContain("wk");
    expect(fakes.teams.posts[0].text).toContain("2026-08-15");
  });

  it("sends one warning per day: a second run on the same UTC day posts nothing more, the next day warns again", async () => {
    fakes = installFakes({ now: Date.UTC(2026, 8, 1, 6, 0), config: withExpiry({ gap: "2026-09-10" }) });

    await runDailyCheck();
    fakes.clock.set(Date.UTC(2026, 8, 1, 23, 59));
    await runDailyCheck();

    expect(fakes.teams.posts).toHaveLength(1);

    fakes.clock.set(Date.UTC(2026, 8, 2, 6, 0));
    await runDailyCheck();

    expect(fakes.teams.posts).toHaveLength(2);
    expect(fakes.teams.posts[1].channel).toBe("gap-default");
  });

  it("retries later the same day when Teams rejects the warning, without holding up other Orgs", async () => {
    fakes = installFakes({ now: Date.UTC(2026, 9, 1, 6, 0), config: withExpiry({ gap: "2026-10-05", wk: "2026-10-06" }) });
    fakes.teams.fail(1);

    await expect(runDailyCheck()).rejects.toThrow();
    expect(fakes.teams.posts).toHaveLength(1);
    const delivered = fakes.teams.posts[0].channel;

    fakes.clock.set(Date.UTC(2026, 9, 1, 12, 0));
    await runDailyCheck();

    expect(fakes.teams.posts.map((p) => p.channel).sort()).toEqual(["gap-default", "wk-default"]);
    expect(fakes.teams.posts[1].channel).not.toBe(delivered);
  });

  it("keeps warning daily once a token has expired, saying it has expired", async () => {
    fakes = installFakes({ now: Date.UTC(2026, 10, 3, 6, 0), config: withExpiry({ gap: "2026-11-01" }) });

    await runDailyCheck();

    expect(fakes.teams.posts).toHaveLength(1);
    expect(fakes.teams.posts[0].text).toMatch(/expired on 2026-11-01/);
  });
});
