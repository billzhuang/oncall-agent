import type { OncallConfig } from "./config";
import type { DatadogConnection } from "./datadog-mcp";
import { appInstallationFor, githubRepoFromUrl, repoName } from "./github";
import type { Alert } from "./intake";
import type { TeamsMessage } from "./teams";

/**
 * Repo resolution: before the agent starts, the harness (deterministic code, not the model) finds the code that
 * runs in production. The repo comes only from the service's Datadog source code integration git tags
 * (`git.repository_url`, `git.commit.sha`): no mapping file, no monitor-tag override.
 */
export type RepoResolution =
  /** The repo and the deployed commit, in a repo the GitHub App is installed on. */
  | { outcome: "resolved"; service: string; repo: string; repoUrl: string; sha: string; installationId?: number }
  /**
   * Unmapped service: no git tags (or no service tag to look them up by). `reason` is set when tags exist but
   * cannot be trusted to name one repo and commit (the service's spans disagree).
   */
  | { outcome: "unmapped"; service?: string; reason?: string }
  /**
   * Repo not enabled: git tags found, but the GitHub App is not installed on the repo, or the repo is not on
   * GitHub. `repo` is `owner/name` on GitHub, else only the host and path of the URL (never userinfo or query).
   */
  | { outcome: "not-enabled"; service: string; repo: string; onGitHub: boolean; sha: string }
  /** The lookup itself failed (Datadog or GitHub unreachable); the Investigation goes on without code. */
  | { outcome: "unresolved"; service?: string; reason: string };

/** The Datadog MCP tool that returns spans with their tags; `git.*` is in its default attribute set. */
export const SPANS_TOOL = "search_datadog_spans";
/** How far back to look for spans of the service carrying git tags. */
const LOOKBACK = "now-24h";
/** Spans read per lookup: all of them must agree on the repo and deployed commit. */
const SPAN_LIMIT = 20;

/** The service an alert is about: its `service:` tag, else the `service:` part of the monitor group. */
export function serviceOf(alert: Alert): string | undefined {
  const fromTags = alert.tags.find((t) => t.startsWith("service:"));
  const fromGroup = alert.group.split(",").map((p) => p.trim()).find((p) => p.startsWith("service:"));
  const service = (fromTags ?? fromGroup)?.slice("service:".length).trim();
  return service && /^[A-Za-z0-9_.\/-]+$/.test(service) ? service : undefined;
}

/** Resolves the alert's repo. Never throws: a failed lookup is the `unresolved` outcome. */
export async function resolveRepo(
  env: Env,
  config: OncallConfig,
  datadog: DatadogConnection,
  alert: Alert,
): Promise<RepoResolution> {
  const service = serviceOf(alert);
  if (!service) return { outcome: "unmapped" };
  let found: GitTags[];
  try {
    found = await gitTagsOf(datadog, service);
  } catch (error) {
    return { outcome: "unresolved", service, reason: `reading git tags from Datadog failed: ${message(error)}` };
  }
  if (found.length === 0) return { outcome: "unmapped", service };
  if (found.length > 1) {
    const reason = `the spans of service ${service} disagree on the repository or deployed commit (${found.length} different git tags)`;
    return { outcome: "unmapped", service, reason };
  }
  const [tags] = found as [GitTags];
  const repo = githubRepoFromUrl(tags.repositoryUrl);
  if (!repo) return { outcome: "not-enabled", service, repo: repoDisplay(tags.repositoryUrl), onGitHub: false, sha: tags.sha };
  let installationId: number | undefined;
  try {
    installationId = await appInstallationFor(env, config, repo);
  } catch (error) {
    return { outcome: "unresolved", service, reason: `checking the GitHub App installation failed: ${message(error)}` };
  }
  if (installationId === undefined) {
    return { outcome: "not-enabled", service, repo: repoName(repo), onGitHub: true, sha: tags.sha };
  }
  const repoUrl = `https://github.com/${repoName(repo)}`;
  return { outcome: "resolved", service, repo: repoName(repo), repoUrl, sha: tags.sha, installationId };
}

interface GitTags {
  repositoryUrl: string;
  sha: string;
}

/**
 * The distinct git tags on the service's recent spans (empty when none carry them). Reads the tool result as
 * structured data and takes the tags only from each span's tag list or git attribute fields, by exact key, so
 * text inside a span (a log line, an error message, a URL) can never name the repo.
 */
async function gitTagsOf(datadog: DatadogConnection, service: string): Promise<GitTags[]> {
  const result = await datadog.callTool(SPANS_TOOL, {
    query: `service:${service}`,
    from: LOOKBACK,
    limit: SPAN_LIMIT,
    custom_attributes: ["git.*"],
    telemetry: { intent: "Oncall agent repo resolution: read the service's source code integration git tags" },
  });
  const texts = (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "");
  if (result.isError) throw new Error(cut(texts.join(" ") || "tool error", 200));
  const spans = [result.structuredContent, ...texts.map(parseJson)].map(spanList).find((list) => list !== undefined);
  if (!spans) throw new Error("the span search result is not structured data");
  const distinct = new Map<string, GitTags>();
  for (const span of spans) {
    const tags = spanGitTags(span);
    if (!tags) continue;
    const github = githubRepoFromUrl(tags.repositoryUrl);
    distinct.set(`${github ? repoName(github).toLowerCase() : tags.repositoryUrl}@${tags.sha}`, tags);
  }
  return [...distinct.values()];
}

type Fields = Record<string, unknown>;
const isFields = (v: unknown): v is Fields => typeof v === "object" && v !== null && !Array.isArray(v);
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** The spans in a search result: the result itself when a list, else its `data` or `spans` list. */
function spanList(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (!isFields(value)) return undefined;
  for (const key of ["data", "spans"]) if (Array.isArray(value[key])) return value[key] as unknown[];
  return undefined;
}

/** A span's `git.repository_url` and `git.commit.sha`, from its tag list or git attribute fields only. */
function spanGitTags(span: unknown): GitTags | undefined {
  if (!isFields(span)) return undefined;
  const fromTagList = (key: string) => {
    const tags = span.tags;
    if (Array.isArray(tags)) {
      const tag = tags.find((t): t is string => typeof t === "string" && t.startsWith(`${key}:`));
      return tag?.slice(key.length + 1);
    }
    return isFields(tags) ? tags[key] : undefined;
  };
  const fromFields = (flat: string, nested: (git: Fields) => unknown) => {
    for (const fields of [span, span.attributes, span.custom, span.meta]) {
      if (!isFields(fields)) continue;
      if (fields[flat] !== undefined) return fields[flat];
      if (isFields(fields.git)) {
        const value = nested(fields.git);
        if (value !== undefined) return value;
      }
    }
    return undefined;
  };
  const repositoryUrl = fromTagList("git.repository_url") ?? fromFields("git.repository_url", (git) => git.repository_url);
  const sha =
    fromTagList("git.commit.sha") ??
    fromFields("git.commit.sha", (git) => (isFields(git.commit) ? git.commit.sha : git["commit.sha"]));
  if (typeof repositoryUrl !== "string" || typeof sha !== "string") return undefined;
  if (!repositoryUrl.trim() || !/^[0-9a-f]{7,40}$/i.test(sha.trim())) return undefined;
  return { repositoryUrl: repositoryUrl.trim(), sha: sha.trim().toLowerCase() };
}

/**
 * A repository URL that is not on GitHub, shown as its host and path only: userinfo (credentials), port, query
 * and fragment are dropped. Handles `scheme://…`, scp-like `user@host:path` and bare `host/path` forms.
 */
export function repoDisplay(repositoryUrl: string): string {
  const raw = repositoryUrl.trim();
  let host: string | undefined;
  let path = "";
  const scp = !raw.includes("://") && raw.match(/^(?:[^@/\s]+@)?([A-Za-z0-9.-]+):([^?#\s]*)/);
  if (scp) {
    host = scp[1];
    path = `/${scp[2]!.replace(/^\/+/, "")}`;
  } else {
    try {
      const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
      host = url.hostname;
      path = url.pathname;
    } catch {
      host = undefined;
    }
  }
  const shown = `${host ?? ""}${path.replace(/\/+$/, "").replace(/\.git$/, "")}`;
  return host && /^[A-Za-z0-9.-]+(\/[A-Za-z0-9._~\/-]*)?$/.test(shown) ? shown : "(unreadable repository URL)";
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const message = (error: unknown) => cut(error instanceof Error ? error.message : String(error), 300);

/** The Investigation report's line about the code: what was resolved, or why there is none. */
export function codeLine(resolution: RepoResolution): string {
  switch (resolution.outcome) {
    case "resolved":
      return `Code: ${resolution.repo} at deployed commit ${resolution.sha}.`;
    case "unmapped": {
      const why = resolution.reason
        ? resolution.reason
        : resolution.service
          ? `service ${resolution.service} has no source code integration git tags`
          : "the monitor names no service";
      return `Code: Unmapped service: ${why}, so its code was not read and no Agent PR can be opened.`;
    }
    case "not-enabled":
      return resolution.onGitHub
        ? `Code: repo not enabled: the GitHub App is not installed on ${resolution.repo}, so its code was not read and no Agent PR can be opened.`
        : `Code: repo not enabled: the repository ${resolution.repo} is not on GitHub, so its code was not read and no Agent PR can be opened.`;
    case "unresolved":
      return `Code: not read: ${resolution.reason}.`;
  }
}

/** A reminder for the Owning team and its dedup key in the Coordinator (one per 7 days per key), if any. */
export interface Reminder {
  kind: "unmapped-reminder" | "repo-reminder";
  key: string;
  message: TeamsMessage;
}

export function reminderFor(org: string, resolution: RepoResolution): Reminder | undefined {
  if (resolution.outcome === "unmapped" && resolution.service && !resolution.reason) {
    // Per Org and service. Without a service tag there is nothing to add git tags to, and when the tags exist but
    // disagree, "add git tags" would be wrong advice: no reminder in either case.
    return {
      kind: "unmapped-reminder",
      key: `unmapped:${org}:${resolution.service}`,
      message: {
        title: `Unmapped service: ${resolution.service}`,
        lines: [
          `Service ${resolution.service} in Org ${org} has no Datadog source code integration git tags (git.repository_url and git.commit.sha), so the oncall agent cannot find its code or propose Agent PRs.`,
          "Add the tags to the service's telemetry, for example by setting DD_GIT_REPOSITORY_URL and DD_GIT_COMMIT_SHA at build or deploy time. Investigation reports still arrive meanwhile.",
        ],
        facts: [
          ["Org", org],
          ["Service", resolution.service],
        ],
      },
    };
  }
  if (resolution.outcome === "not-enabled") {
    // Per repo, across Orgs and services.
    return {
      kind: "repo-reminder",
      key: `repo-not-enabled:${resolution.repo.toLowerCase()}`,
      message: {
        title: `Repo not enabled: ${resolution.repo}`,
        lines: resolution.onGitHub
          ? [
              `The oncall agent's GitHub App is not installed on ${resolution.repo}, the repo of service ${resolution.service}, so the agent cannot read its code or propose Agent PRs.`,
              "Install the GitHub App on the repo to opt it in. Investigation reports still arrive meanwhile.",
            ]
          : [
              `The repository ${resolution.repo} of service ${resolution.service} is not on GitHub, so the oncall agent cannot read its code or propose Agent PRs.`,
              "Only GitHub repos with the oncall agent's GitHub App installed can be read. Investigation reports still arrive meanwhile.",
            ],
        facts: [
          ["Repo", resolution.repo],
          ["Service", resolution.service],
          ["Org", org],
        ],
      },
    };
  }
  return undefined;
}
