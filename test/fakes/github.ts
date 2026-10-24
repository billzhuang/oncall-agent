import { env } from "cloudflare:workers";
import { ports } from "../../src/ports";
import type { FakeService } from "./router";

// #6: GitHub App installations (repo enabled or not), with App JWT verification. #8 adds refs, blobs, trees,
// commits, PRs and compare, with state the tests inspect.

export interface GitHubCall {
  method: string;
  path: string;
  body: unknown;
}

/** An installation access token the fake issued, with what it was scoped to. */
export interface IssuedToken {
  token: string;
  installationId: number;
  /** Repo names the token was limited to, or undefined when the request did not limit it. */
  repositories: string[] | undefined;
  permissions: Record<string, string>;
}

/** The owner whose repos the test GitHub App is installed on by default (all repos). */
export const DEFAULT_INSTALLED_OWNER = "acme";

interface Installation {
  id: number;
  owner: string;
  /** Repo names (without owner) the installation covers, or "all". */
  repos: string[] | "all";
}

/**
 * Fake api.github.com: records every call. The GitHub App (id from the test config) is installed on every repo of
 * `DEFAULT_INSTALLED_OWNER`; other owners have no installation unless a test adds one. App-authenticated routes
 * verify the App JWT's RS256 signature against the test App's public key, so a broken signer fails the test.
 */
export function fakeGitHub(opts: { appId: string } = { appId: "123456" }) {
  const calls: GitHubCall[] = [];
  /** Problems with App JWTs presented to the fake; a test asserts this stays empty. */
  const jwtErrors: string[] = [];
  const installations: Installation[] = [{ id: 1, owner: DEFAULT_INSTALLED_OWNER, repos: "all" }];
  const tokens: IssuedToken[] = [];
  const service: FakeService = {
    async handle(request) {
      const url = new URL(request.url);
      const text = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
      calls.push({ method: request.method, path: url.pathname + url.search, body: text ? JSON.parse(text) : undefined });
      if (!request.headers.get("user-agent")) return Response.json({ message: "User-Agent required" }, { status: 403 });

      const repoInstallation = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/installation$/);
      if (request.method === "GET" && repoInstallation) {
        const problem = await verifyAppJwt(request.headers.get("authorization"), opts.appId);
        if (problem) {
          jwtErrors.push(problem);
          return Response.json({ message: problem }, { status: 401 });
        }
        const [, owner, repo] = repoInstallation.map((s) => s.toLowerCase());
        const found = installations.find(
          (i) => i.owner.toLowerCase() === owner && (i.repos === "all" || i.repos.some((r) => r.toLowerCase() === repo)),
        );
        if (!found) return Response.json({ message: "Not Found" }, { status: 404 });
        return Response.json({ id: found.id, account: { login: found.owner }, repository_selection: found.repos === "all" ? "all" : "selected" });
      }

      const accessTokens = url.pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
      if (request.method === "POST" && accessTokens) {
        const problem = await verifyAppJwt(request.headers.get("authorization"), opts.appId);
        if (problem) {
          jwtErrors.push(problem);
          return Response.json({ message: problem }, { status: 401 });
        }
        const installation = installations.find((i) => i.id === Number(accessTokens[1]));
        if (!installation) return Response.json({ message: "Not Found" }, { status: 404 });
        const body = (text ? JSON.parse(text) : {}) as { repositories?: string[]; permissions?: Record<string, string> };
        const covered = (repo: string) =>
          installation.repos === "all" || installation.repos.some((r) => r.toLowerCase() === repo.toLowerCase());
        if (body.repositories?.some((r) => !covered(r))) {
          return Response.json({ message: "There is at least one repository that does not exist or is not accessible" }, { status: 422 });
        }
        const token = `ghs_test${tokens.length + 1}x${crypto.randomUUID().replace(/-/g, "")}`;
        const permissions = body.permissions ?? { contents: "write", pull_requests: "write", metadata: "read" };
        tokens.push({ token, installationId: installation.id, repositories: body.repositories, permissions });
        return Response.json(
          { token, expires_at: new Date(ports().now() + 3_600_000).toISOString(), permissions, repository_selection: "selected" },
          { status: 201 },
        );
      }
      return Response.json({ message: "Not Found" }, { status: 404 });
    },
  };
  return {
    ...service,
    calls,
    jwtErrors,
    /** Installation access tokens issued, in order. */
    tokens,
    /** Installs the App on some repos of an owner ("all" for every repo). */
    install(owner: string, repos: string[] | "all") {
      installations.push({ id: installations.length + 1, owner, repos });
    },
  };
}
export type FakeGitHub = ReturnType<typeof fakeGitHub>;

/** Checks an `Authorization: Bearer <App JWT>`; returns what is wrong, or undefined when valid. */
async function verifyAppJwt(authorization: string | null, appId: string): Promise<string | undefined> {
  const token = authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return "missing App JWT";
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) return "malformed App JWT";
  const decode = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const json = (s: string) => JSON.parse(new TextDecoder().decode(decode(s)));
  if (json(header).alg !== "RS256") return "App JWT is not RS256";
  const pem = (env as unknown as Record<string, string>).TEST_GITHUB_APP_PUBLIC_KEY;
  const der = decode(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""));
  const key = await crypto.subtle.importKey("spki", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decode(signature), new TextEncoder().encode(`${header}.${payload}`));
  if (!valid) return "App JWT signature invalid";
  const claims = json(payload);
  if (String(claims.iss) !== appId) return `App JWT iss ${claims.iss} is not the App ${appId}`;
  const now = Math.floor(ports().now() / 1000); // the business clock stands in for GitHub's clock
  if (!(claims.iat <= now && claims.exp > now && claims.exp - claims.iat <= 600)) return "App JWT iat/exp out of range";
  return undefined;
}
