import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alertPayload, cleanUp, installFakes, sendWebhook, settle, type Fakes } from "./harness";

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
});
