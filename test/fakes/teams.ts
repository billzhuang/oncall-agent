import type { FakeService } from "./router";

/** One recorded Teams Workflows webhook post. */
export interface TeamsPost {
  url: string;
  /** Last path segment of the webhook URL: `https://teams.test/<channel>`. */
  channel: string;
  body: unknown;
  /** All text in the adaptive card, joined by newlines, for content assertions. */
  text: string;
}

/** Records every post to `teams.test`. `fail(n)` makes the next n posts answer 500. */
export function fakeTeams() {
  const posts: TeamsPost[] = [];
  let failures = 0;
  const service: FakeService = {
    async handle(request) {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      if (failures > 0) {
        failures--;
        return new Response("teams unavailable", { status: 500 });
      }
      const body = await request.json();
      const url = request.url;
      posts.push({ url, channel: new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "", body, text: cardText(body) });
      return new Response(null, { status: 202 });
    },
  };
  return {
    ...service,
    posts,
    /** Posts to one channel. */
    to: (channel: string) => posts.filter((p) => p.channel === channel),
    fail(n: number) {
      failures = n;
    },
  };
}
export type FakeTeams = ReturnType<typeof fakeTeams>;

function cardText(body: unknown): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (["text", "title", "value", "url"].includes(k) && typeof v === "string") out.push(v);
        else walk(v);
      }
    }
  };
  walk(body);
  return out.join("\n");
}
