import { afterEach, describe, expect, it, vi } from "vitest";
import { abortAllDurableObjects, runDurableObjectAlarm } from "cloudflare:test";
import { alertPayload, cleanUp, installFakes, investigationOf, sendWebhook, settle, type Fakes } from "./harness";
import { TEST_SECRETS } from "./config";
import { toolCall, type Script } from "./fakes/model";

let fakes: Fakes;
afterEach(cleanUp);

const minutes = (n: number) => n * 60_000;

/** An agent that keeps querying Datadog and never submits its report. */
const keepsSearching: Script = () => toolCall("datadog_search_datadog_logs", { query: "service:checkout status:error" });

/** $ per million tokens at which each model request costs about a dollar or more. */
const EXPENSIVE = 5_000;

describe("Cost cap", () => {
  it("ends an Investigation that spends more than $3 as Partial, with the evidence so far and the reason", async () => {
    fakes = installFakes({ costPerMTok: EXPENSIVE });
    fakes.model.script(keepsSearching);

    await sendWebhook(alertPayload());

    await vi.waitFor(() => expect(fakes.teams.posts).toHaveLength(1), { timeout: 10_000 });
    const [post] = fakes.teams.posts;
    expect(post.channel).toBe("sre");
    expect(post.text).toMatch(/partial/i);
    expect(post.text).toMatch(/cost cap/i);
    expect(post.text).toContain("$3");
    expect(post.text).toContain("NullPointerException in CheckoutController.placeOrder"); // evidence gathered so far
    expect(post.text).not.toContain("Investigation report:");
    expect(fakes.model.requests.length).toBeLessThan(10);
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

    await vi.waitFor(() => expect(fakes.teams.posts).toHaveLength(1), { timeout: 10_000 });
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
});
