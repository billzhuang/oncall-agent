import type { FakeService } from "./router";

// Skeleton (#11): nothing calls GitHub yet. #6 adds installations (repo enabled or not), #8 refs, blobs, trees,
// commits, PRs and compare, with state the tests inspect.

export interface GitHubCall {
  method: string;
  path: string;
  body: unknown;
}

/** Fake api.github.com: records every call and answers 404 until later tickets add routes. */
export function fakeGitHub() {
  const calls: GitHubCall[] = [];
  const service: FakeService = {
    async handle(request) {
      const url = new URL(request.url);
      const text = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
      calls.push({ method: request.method, path: url.pathname + url.search, body: text ? JSON.parse(text) : undefined });
      return Response.json({ message: "Not Found" }, { status: 404 });
    },
  };
  return { ...service, calls };
}
export type FakeGitHub = ReturnType<typeof fakeGitHub>;
