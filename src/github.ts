import { secret, type OncallConfig } from "./config";
import { ports } from "./ports";
import { scrubSecret } from "./text";

/**
 * GitHub, reached only by the harness with the GitHub App (ADR 0002): the agent never holds GitHub credentials.
 * Every call goes through `ports().fetch`.
 */

const API = "https://api.github.com";
/** The object id GraphQL `updateRefs` takes as "this ref must not exist yet". */
const ZERO_OID = "0".repeat(40);

/** A GitHub repository, `owner/name`. */
export interface RepoRef {
  owner: string;
  name: string;
}

export const repoName = (repo: RepoRef): string => `${repo.owner}/${repo.name}`;

/** Whether `sha` is a full 40-hex commit SHA, the only form a clone can be pinned to. */
export const isFullSha = (sha: string): boolean => /^[0-9a-f]{40}$/.test(sha);

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

/** A GitHub answer other than the one expected. Its message never holds a token. */
export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The only branches the harness ever writes (ADR 0002). */
export const AGENT_BRANCH_PREFIX = "oncall-agent/";

/**
 * GitHub REST on one repo with an installation token, for the Agent PR: Git Data (blobs, trees, commits, refs),
 * pulls and compare. The token stays inside: never in an error, a log line or a return value.
 */
export class RepoClient {
  readonly #token: string;
  constructor(
    readonly repo: RepoRef,
    token: string,
  ) {
    this.#token = token;
  }

  /** The head commit of a branch and its tree. */
  async branchHead(branch: string): Promise<{ sha: string; treeSha: string }> {
    const ref = await this.#call<{ object: { sha: string } }>("GET", `git/ref/heads/${branch}`);
    const commit = await this.#call<{ tree: { sha: string } }>("GET", `git/commits/${ref.object.sha}`);
    return { sha: ref.object.sha, treeSha: commit.tree.sha };
  }

  /**
   * The blob id of `path` at a commit (`null` when no file is there), from the contents API: one path at a time, so
   * nothing is silently left out the way the compare API's 300-file limit does. Throws on any other answer.
   */
  async blobAt(path: string, commit: string): Promise<string | null> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const entry = await this.#call<{ type?: string; sha?: string } | unknown[] | undefined>(
      "GET",
      `contents/${encoded}?ref=${encodeURIComponent(commit)}`,
      undefined,
      [404],
    );
    if (entry === undefined) return null;
    if (Array.isArray(entry) || entry.type !== "file" || typeof entry.sha !== "string") {
      throw new GitHubError(422, `${path} at ${commit} is not a file`);
    }
    return entry.sha;
  }

  /** One commit on top of `parent`: its tree with `changes` applied (`content: null` deletes the file). */
  async commit(
    parent: { sha: string; treeSha: string },
    changes: ReadonlyArray<{ path: string; content: string | null }>,
    message: string,
  ): Promise<string> {
    const tree = [];
    for (const change of changes) {
      if (change.content === null) {
        tree.push({ path: change.path, mode: "100644", type: "blob", sha: null });
        continue;
      }
      const blob = await this.#call<{ sha: string }>("POST", "git/blobs", { content: change.content, encoding: "utf-8" });
      tree.push({ path: change.path, mode: "100644", type: "blob", sha: blob.sha });
    }
    const created = await this.#call<{ sha: string }>("POST", "git/trees", { base_tree: parent.treeSha, tree });
    const commit = await this.#call<{ sha: string }>("POST", "git/commits", { message, tree: created.sha, parents: [parent.sha] });
    return commit.sha;
  }

  /**
   * Points an `oncall-agent/*` branch at `sha` only if it still points at `expected` (undefined: only if it does not
   * exist yet): a compare-and-swap, GraphQL `updateRefs` with `beforeOid`, so a commit someone pushed after the
   * caller looked is never forced over. Returns false when the branch had moved (nothing was written). Refuses any
   * other branch.
   */
  async moveAgentBranch(branch: string, expected: string | undefined, sha: string): Promise<boolean> {
    if (!branch.startsWith(AGENT_BRANCH_PREFIX) || branch.includes("..")) {
      throw new Error(`refusing to write branch ${branch}: the harness writes only ${AGENT_BRANCH_PREFIX}* branches`);
    }
    const repository = await this.#request<{ node_id: string }>("GET", `${API}/repos/${this.repo.owner}/${this.repo.name}`);
    const answer = await this.#request<{ data?: { updateRefs?: unknown } | null; errors?: Array<{ message?: string }> }>(
      "POST",
      `${API}/graphql`,
      {
        query: "mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }",
        variables: {
          input: {
            repositoryId: repository.node_id,
            refUpdates: [{ name: `refs/heads/${branch}`, beforeOid: expected ?? ZERO_OID, afterOid: sha, force: true }],
          },
        },
      },
    );
    if (!answer.errors?.length && answer.data?.updateRefs) return true;
    // Refused: if the branch is no longer where we expected, someone else moved it; anything else is an error.
    if ((await this.branchSha(branch)) !== expected) return false;
    const reason = (answer.errors ?? []).map((e) => e.message ?? "").join("; ") || "no answer";
    throw new GitHubError(502, `GitHub refused to move ${branch} on ${repoName(this.repo)}: ${scrubSecret(reason, this.#token).slice(0, 200)}`);
  }

  /** The commit a branch points at, or undefined when there is no such branch. */
  async branchSha(branch: string): Promise<string | undefined> {
    const ref = await this.#call<{ object: { sha: string } } | undefined>("GET", `git/ref/heads/${branch}`, undefined, [404]);
    return ref?.object.sha;
  }

  /** Bodies of the comments on a pull request (first page: the harness comments at most once per Alert episode). */
  async pullComments(number: number): Promise<string[]> {
    const comments = await this.#call<Array<{ body?: string }>>("GET", `issues/${number}/comments?per_page=100`);
    return comments.map((c) => c.body ?? "");
  }

  /** Comments on a pull request. */
  async commentOnPull(number: number, body: string): Promise<void> {
    await this.#call("POST", `issues/${number}/comments`, { body });
  }

  /** The open pull request from `branch`, if any. */
  async openPull(branch: string): Promise<{ number: number; html_url: string } | undefined> {
    const head = encodeURIComponent(`${this.repo.owner}:${branch}`);
    const pulls = await this.#call<Array<{ number: number; html_url: string }>>("GET", `pulls?head=${head}&state=open`);
    return pulls[0];
  }

  /** Opens a draft pull request from `branch` into `base`. */
  async createDraftPull(input: { branch: string; base: string; title: string; body: string }) {
    return this.#call<{ number: number; html_url: string }>("POST", "pulls", {
      title: input.title,
      head: input.branch,
      base: input.base,
      body: input.body,
      draft: true,
    });
  }

  /** Replaces a pull request's title and description. */
  async updatePull(number: number, input: { title: string; body: string }) {
    return this.#call<{ number: number; html_url: string }>("PATCH", `pulls/${number}`, input);
  }

  /** One REST call on the repo; `tolerate` lists statuses answered with undefined instead of an error. */
  async #call<T = unknown>(method: string, path: string, body?: unknown, tolerate: number[] = []): Promise<T> {
    return this.#request<T>(method, `${API}/repos/${this.repo.owner}/${this.repo.name}/${path}`, body, tolerate);
  }

  /** One call to the GitHub API with the installation token. Errors never carry the token. */
  async #request<T>(method: string, url: string, body?: unknown, tolerate: number[] = []): Promise<T> {
    const path = url.slice(API.length + 1);
    const res = await ports().fetch(url, {
      method,
      headers: {
        ...HEADERS,
        authorization: `Bearer ${this.#token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (tolerate.includes(res.status)) return undefined as T;
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const message = scrubSecret(detail, this.#token).slice(0, 200);
      throw new GitHubError(res.status, `GitHub answered ${res.status} to ${method} ${path.split("?")[0]} on ${repoName(this.repo)}: ${message}`);
    }
    return (await res.json()) as T;
  }
}

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
