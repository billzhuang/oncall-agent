import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alertPayload, cleanUp, installFakes, sendWebhook, settle, type Fakes } from "./harness";
import { TEST_SECRETS } from "./config";

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
