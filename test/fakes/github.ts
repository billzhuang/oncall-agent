import { env } from "cloudflare:workers";
import { ports } from "../../src/ports";
import type { FakeService } from "./router";

// #6: GitHub App installations (repo enabled or not), with App JWT verification. #8: refs, blobs, trees, commits,
// pull requests and compare, with state the tests inspect, behind installation-token checks.

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

/** A ref write the fake accepted. */
export interface RefWrite {
  repo: string;
  method: string;
  /** Full ref name, `refs/heads/…`. */
  ref: string;
  sha: string;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  draft: boolean;
  state: "open" | "closed";
}

interface RepoState {
  blobs: Map<string, string>;
  /** Tree sha -> path -> blob sha (flat). */
  trees: Map<string, Record<string, string>>;
  commits: Map<string, { tree: string; parents: string[]; message: string }>;
  /** `heads/<branch>` -> commit sha. */
  refs: Map<string, string>;
  pulls: Pull[];
}

/** The owner whose repos the test GitHub App is installed on by default (all repos). */
export const DEFAULT_INSTALLED_OWNER = "acme";

interface Installation {
  id: number;
  owner: string;
  /** Repo names (without owner) the installation covers, or "all". */
  repos: string[] | "all";
}

let shaCounter = 0;
/** A fresh 40-hex object id. */
function nextSha(): string {
  shaCounter++;
  return `f${shaCounter.toString(16).padStart(39, "0")}`;
}

function decodeBase64(b64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

/** A commit sha, or the head of a branch (`main`, `heads/main`, `refs/heads/main`). */
function resolve(repo: RepoState, refOrSha: string): string | undefined {
  if (repo.commits.has(refOrSha)) return refOrSha;
  const branch = refOrSha.replace(/^refs\//, "").replace(/^heads\//, "");
  return repo.refs.get(`heads/${branch}`);
}

function filesOf(repo: RepoState, commitSha: string): Record<string, string> {
  const tree = repo.trees.get(repo.commits.get(commitSha)!.tree)!;
  return Object.fromEntries(Object.entries(tree).map(([path, blob]) => [path, repo.blobs.get(blob)!]));
}

function isAncestor(repo: RepoState, ancestor: string, of: string): boolean {
  const queue = [of];
  while (queue.length) {
    const sha = queue.shift()!;
    if (sha === ancestor) return true;
    queue.push(...(repo.commits.get(sha)?.parents ?? []));
  }
  return false;
}

/** Adds a commit with these files (flat tree) to a repo. */
function addCommit(repo: RepoState, sha: string, files: Record<string, string>, parents: string[], message: string): void {
  const tree: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    const blob = nextSha();
    repo.blobs.set(blob, content);
    tree[path] = blob;
  }
  const treeSha = nextSha();
  repo.trees.set(treeSha, tree);
  repo.commits.set(sha, { tree: treeSha, parents, message });
}

/**
 * Fake api.github.com: records every call. The GitHub App (id from the test config) is installed on every repo of
 * `DEFAULT_INSTALLED_OWNER`; other owners have no installation unless a test adds one. App-authenticated routes
 * verify the App JWT's RS256 signature against the test App's public key, so a broken signer fails the test.
 * Repos created with `repo()` answer the Git Data, pulls and compare routes, each checked against the installation
 * token presented: it must be one the fake issued, scoped to the repo, with the permission the route needs.
 */
export function fakeGitHub(opts: { appId: string } = { appId: "123456" }) {
  const calls: GitHubCall[] = [];
  /** Problems with App JWTs presented to the fake; a test asserts this stays empty. */
  const jwtErrors: string[] = [];
  const installations: Installation[] = [{ id: 1, owner: DEFAULT_INSTALLED_OWNER, repos: "all" }];
  const tokens: IssuedToken[] = [];
  const authErrors: string[] = [];
  const refWrites: RefWrite[] = [];
  const repos = new Map<string, RepoState>();
  const losses: Array<{ method: string; path: RegExp; reached: () => void }> = [];
  let nextPull = 1;

  /** What is wrong with an `Authorization: Bearer <installation token>` for a call needing `scope` at `level`. */
  const tokenProblem = (authorization: string | null, repoName: string, scope: string, level: "read" | "write") => {
    const presented = authorization?.match(/^Bearer (.+)$/)?.[1];
    const issued = tokens.find((t) => t.token === presented);
    if (!issued) return "bad credentials: not an installation token the fake issued";
    if (issued.repositories && !issued.repositories.some((r) => r.toLowerCase() === repoName.toLowerCase())) {
      return `token not scoped to ${repoName}`;
    }
    const has = issued.permissions[scope];
    if (has !== "write" && !(has === "read" && level === "read")) return `token lacks ${scope}:${level}`;
    return undefined;
  };

  const pullJson = (full: string, p: Pull) => ({
    number: p.number,
    html_url: `https://github.com/${full}/pull/${p.number}`,
    state: p.state,
    draft: p.draft,
    title: p.title,
    body: p.body,
    head: { ref: p.head },
    base: { ref: p.base },
  });

  const repoRoute = (
    full: string,
    repo: RepoState,
    method: string,
    route: string,
    query: URLSearchParams,
    body: Record<string, any>,
  ): Response => {
    const notFound = () => Response.json({ message: "Not Found" }, { status: 404 });
    const invalid = (message: string) => Response.json({ message }, { status: 422 });
    let m: RegExpMatchArray | null;
    if (method === "GET" && (m = route.match(/^git\/ref\/(heads\/.+)$/))) {
      const sha = repo.refs.get(m[1]!);
      return sha ? Response.json({ ref: `refs/${m[1]}`, object: { sha, type: "commit" } }) : notFound();
    }
    if (method === "GET" && (m = route.match(/^git\/commits\/([0-9a-f]{40})$/))) {
      const commit = repo.commits.get(m[1]!);
      if (!commit) return notFound();
      return Response.json({
        sha: m[1],
        tree: { sha: commit.tree },
        parents: commit.parents.map((sha) => ({ sha })),
        message: commit.message,
      });
    }
    if (method === "POST" && route === "git/blobs") {
      const content = body.encoding === "base64" ? decodeBase64(String(body.content)) : String(body.content);
      const sha = nextSha();
      repo.blobs.set(sha, content);
      return Response.json({ sha }, { status: 201 });
    }
    if (method === "POST" && route === "git/trees") {
      const base = body.base_tree ? repo.trees.get(body.base_tree) : {};
      if (!base) return invalid("base_tree not found");
      const tree = { ...base };
      for (const entry of body.tree as Array<{ path: string; sha: string | null }>) {
        if (entry.sha === null) delete tree[entry.path];
        else if (repo.blobs.has(entry.sha)) tree[entry.path] = entry.sha;
        else return invalid(`blob ${entry.sha} not found`);
      }
      const sha = nextSha();
      repo.trees.set(sha, tree);
      return Response.json({ sha }, { status: 201 });
    }
    if (method === "POST" && route === "git/commits") {
      if (!repo.trees.has(body.tree)) return invalid("tree not found");
      const sha = nextSha();
      repo.commits.set(sha, { tree: body.tree, parents: body.parents ?? [], message: body.message });
      return Response.json({ sha }, { status: 201 });
    }
    if (method === "POST" && route === "git/refs") {
      const ref = String(body.ref).replace(/^refs\//, "");
      if (repo.refs.has(ref)) return invalid("Reference already exists");
      if (!repo.commits.has(body.sha)) return invalid("Object does not exist");
      repo.refs.set(ref, body.sha);
      refWrites.push({ repo: full, method, ref: `refs/${ref}`, sha: body.sha });
      return Response.json({ ref: `refs/${ref}`, object: { sha: body.sha, type: "commit" } }, { status: 201 });
    }
    if (method === "PATCH" && (m = route.match(/^git\/refs\/(heads\/.+)$/))) {
      const ref = m[1]!;
      if (!repo.refs.has(ref)) return invalid("Reference does not exist");
      if (!repo.commits.has(body.sha)) return invalid("Object does not exist");
      if (!body.force && !isAncestor(repo, repo.refs.get(ref)!, body.sha)) return invalid("Update is not a fast forward");
      repo.refs.set(ref, body.sha);
      refWrites.push({ repo: full, method, ref: `refs/${ref}`, sha: body.sha });
      return Response.json({ ref: `refs/${ref}`, object: { sha: body.sha, type: "commit" } });
    }
    if (method === "GET" && route === "pulls") {
      const head = query.get("head")?.toLowerCase();
      const state = query.get("state") ?? "open";
      const owner = full.split("/")[0]!.toLowerCase();
      const found = repo.pulls.filter(
        (p) => (state === "all" || p.state === state) && (!head || head === `${owner}:${p.head}`.toLowerCase()),
      );
      return Response.json(found.map((p) => pullJson(full, p)));
    }
    if (method === "POST" && route === "pulls") {
      if (!repo.refs.has(`heads/${body.head}`) || !repo.refs.has(`heads/${body.base}`)) {
        return invalid("Validation Failed: head or base does not exist");
      }
      if (repo.pulls.some((p) => p.state === "open" && p.head === body.head)) {
        return invalid(`A pull request already exists for ${body.head}.`);
      }
      const pull: Pull = {
        number: nextPull++,
        title: body.title,
        body: body.body ?? "",
        head: body.head,
        base: body.base,
        draft: body.draft === true,
        state: "open",
      };
      repo.pulls.push(pull);
      return Response.json(pullJson(full, pull), { status: 201 });
    }
    if (method === "PATCH" && (m = route.match(/^pulls\/(\d+)$/))) {
      const pull = repo.pulls.find((p) => p.number === Number(m![1]));
      if (!pull) return notFound();
      if (typeof body.title === "string") pull.title = body.title;
      if (typeof body.body === "string") pull.body = body.body;
      if (body.state === "open" || body.state === "closed") pull.state = body.state;
      return Response.json(pullJson(full, pull));
    }
    if (method === "GET" && (m = route.match(/^compare\/(.+)\.\.\.(.+)$/))) {
      const base = resolve(repo, m[1]!);
      const head = resolve(repo, m[2]!);
      if (!base || !head) return notFound();
      const [a, b] = [filesOf(repo, base), filesOf(repo, head)];
      const paths = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
      const files = paths
        .filter((p) => a[p] !== b[p])
        .map((filename) => ({ filename, status: !(filename in a) ? "added" : !(filename in b) ? "removed" : "modified" }));
      return Response.json({ status: "ahead", files });
    }
    return notFound();
  };

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

      const rest = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/(.+)$/);
      const repo = rest && repos.get(`${rest[1]}/${rest[2]}`.toLowerCase());
      if (rest && repo) {
        const [, owner, name, route] = rest as unknown as [string, string, string, string];
        const scope = route.startsWith("pulls") ? "pull_requests" : "contents";
        const level = request.method === "GET" ? "read" : "write";
        const problem = tokenProblem(request.headers.get("authorization"), name, scope, level);
        if (problem) {
          authErrors.push(`${request.method} ${url.pathname}: ${problem}`);
          return Response.json({ message: problem }, { status: problem.startsWith("bad") ? 401 : 403 });
        }
        const body = (text ? JSON.parse(text) : {}) as Record<string, any>;
        const response = repoRoute(`${owner}/${name}`, repo, request.method, route, url.searchParams, body);
        const loss = losses.findIndex((l) => l.method === request.method && l.path.test(url.pathname));
        if (loss >= 0) {
          const [{ reached }] = losses.splice(loss, 1) as [(typeof losses)[number]];
          reached();
          throw new Error(`connection reset before GitHub's answer to ${request.method} ${url.pathname} arrived`);
        }
        return response;
      }
      return Response.json({ message: "Not Found" }, { status: 404 });
    },
  };

  return {
    ...service,
    calls,
    jwtErrors,
    /** Installation-token problems on REST calls (unknown token, wrong repo, missing permission). */
    authErrors,
    /** Every ref write the fake accepted, in order. */
    refWrites,
    /** Installation access tokens issued, in order. */
    tokens,
    /** Installs the App on some repos of an owner ("all" for every repo). */
    install(owner: string, repos: string[] | "all") {
      installations.push({ id: installations.length + 1, owner, repos });
    },
    /**
     * Creates a repo (`owner/name`): commit `deployed.sha` with `deployed.files`, and `main` one commit later with
     * the files `main` (the deployed files when omitted).
     */
    repo(full: string, deployed: { sha: string; files: Record<string, string> }, main?: Record<string, string>) {
      const repo: RepoState = { blobs: new Map(), trees: new Map(), commits: new Map(), refs: new Map(), pulls: [] };
      addCommit(repo, deployed.sha, deployed.files, [], "deployed");
      const mainSha = nextSha();
      addCommit(repo, mainSha, main ?? deployed.files, [deployed.sha], "main");
      repo.refs.set("heads/main", mainSha);
      repos.set(full.toLowerCase(), repo);
    },
    /** Moves `main` of a repo on by one commit with these files. */
    advanceMain(full: string, files: Record<string, string>) {
      const repo = repos.get(full.toLowerCase())!;
      const sha = nextSha();
      addCommit(repo, sha, files, [repo.refs.get("heads/main")!], "main moved on");
      repo.refs.set("heads/main", sha);
    },
    /** The files at a branch (`main`, `oncall-agent/…`) or commit of a repo; undefined when there is none. */
    files(full: string, refOrSha: string): Record<string, string> | undefined {
      const repo = repos.get(full.toLowerCase());
      const sha = repo && resolve(repo, refOrSha);
      return repo && sha ? filesOf(repo, sha) : undefined;
    },
    /** A commit of a repo, by sha or branch: its parents and message. */
    commit(full: string, refOrSha: string) {
      const repo = repos.get(full.toLowerCase());
      const sha = repo && resolve(repo, refOrSha);
      return repo && sha ? { sha, ...repo.commits.get(sha)! } : undefined;
    },
    /** Branches of a repo (without `refs/heads/`). */
    branches(full: string): string[] {
      return [...(repos.get(full.toLowerCase())?.refs.keys() ?? [])].map((r) => r.replace(/^heads\//, "")).sort();
    },
    /** Pull requests of a repo. */
    pulls(full: string): Pull[] {
      return repos.get(full.toLowerCase())?.pulls ?? [];
    },
    /**
     * Loses the answer to the next matching repo call: GitHub carries it out (state applied), then the connection
     * drops, so the Worker sees a network error. Poll `lost()` for it: a promise the Worker's side resolves and the
     * test awaits crashes workerd ("Promise callback destroyed itself").
     */
    loseAnswer(method: string, path: RegExp) {
      let lost = false;
      losses.push({ method, path, reached: () => (lost = true) });
      return { lost: () => lost };
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
