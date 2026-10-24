import { secret, type OncallConfig } from "./config";
import { ports } from "./ports";

/**
 * GitHub, reached only by the harness with the GitHub App (ADR 0002): the agent never holds GitHub credentials.
 * Every call goes through `ports().fetch`.
 */

const API = "https://api.github.com";

/** A GitHub repository, `owner/name`. */
export interface RepoRef {
  owner: string;
  name: string;
}

export const repoName = (repo: RepoRef): string => `${repo.owner}/${repo.name}`;

/**
 * The GitHub repo a source code integration `git.repository_url` names, in any of the forms Datadog stores:
 * `github.com/o/r`, `https://github.com/o/r(.git)`, `git@github.com:o/r.git`, `ssh://git@github.com/o/r`.
 * Undefined for repos not on github.com.
 */
export function githubRepoFromUrl(repositoryUrl: string): RepoRef | undefined {
  const match = repositoryUrl
    .trim()
    .match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?github\.com[:/]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i);
  if (!match) return undefined;
  return { owner: match[1]!, name: match[2]! };
}

/**
 * The GitHub App installation covering `repo`, or undefined when the App is not installed on it (GitHub
 * answers 404). Throws on any other answer.
 */
export async function appInstallationFor(env: Env, config: OncallConfig, repo: RepoRef): Promise<number | undefined> {
  const res = await ports().fetch(`${API}/repos/${repo.owner}/${repo.name}/installation`, {
    headers: { ...HEADERS, authorization: `Bearer ${await appJwt(env, config)}` },
  });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for the App installation of ${repoName(repo)}`);
  return ((await res.json()) as { id: number }).id;
}

/** What an installation access token may do: GitHub App permission name -> level. */
export type TokenPermissions = Partial<Record<"contents" | "pull_requests" | "metadata", "read" | "write">>;

/**
 * An installation access token limited to the one repo and to `permissions` (1 hour). For the harness only: it is
 * never put in a tool result, a prompt or a message, and is never stored.
 */
export async function installationToken(
  env: Env,
  config: OncallConfig,
  installationId: number,
  repo: RepoRef,
  permissions: TokenPermissions,
): Promise<string> {
  const res = await ports().fetch(`${API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { ...HEADERS, authorization: `Bearer ${await appJwt(env, config)}`, "content-type": "application/json" },
    body: JSON.stringify({ repositories: [repo.name], permissions }),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for an installation token for ${repoName(repo)}`);
  const { token } = (await res.json()) as { token?: unknown };
  if (typeof token !== "string" || !token) throw new Error(`GitHub returned no installation token for ${repoName(repo)}`);
  return token;
}

const HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "oncall-agent",
};

/** The App JWT last signed, reused for a few minutes: RSA signing is the slow part of every GitHub call. */
let lastJwt: { pem: string; appId: string; iat: number; jwt: string } | undefined;
/** How long a signed App JWT is reused (it is valid 9 minutes past `iat + 60`). */
const JWT_REUSE_SECONDS = 5 * 60;

/** A GitHub App JWT (RS256; issued a minute back for clock skew, valid 9 minutes). */
async function appJwt(env: Env, config: OncallConfig): Promise<string> {
  const pem = secret(env, config.github.privateKeySecret);
  if (!pem) throw new Error(`Worker secret ${config.github.privateKeySecret} (GitHub App private key) is not set`);
  const now = Math.floor(ports().now() / 1000);
  const appId = config.github.appId;
  const cached = lastJwt;
  if (cached && cached.pem === pem && cached.appId === appId && now >= cached.iat + 60 && now < cached.iat + 60 + JWT_REUSE_SECONDS) {
    return cached.jwt;
  }
  const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: appId })}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemBytes(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${base64url(new Uint8Array(signature))}`;
  lastJwt = { pem, appId, iat: now - 60, jwt };
  return jwt;
}

function pemBytes(pem: string): Uint8Array {
  if (pem.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error("GitHub App private key is PKCS#1; store it as PKCS#8 (openssl pkcs8 -topk8 -nocrypt)");
  }
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
