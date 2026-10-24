import { orgByName, type OncallConfig } from "./config";
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
   * Repo not enabled: git tags found, but the repo is not on GitHub, its owner is not one the Org allows
   * (`allowedRepoOwners`), or the GitHub App is not installed on it. `repo` is `owner/name` on GitHub, else only
   * the host and path of the URL (never userinfo or query).
   */
  | { outcome: "not-enabled"; service: string; repo: string; why: NotEnabledReason; sha: string }
  /** The lookup itself failed (Datadog or GitHub unreachable); the Investigation goes on without code. */
  | { outcome: "unresolved"; service?: string; reason: string };

export type NotEnabledReason = "not-on-github" | "owner-not-allowed" | "not-installed";

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
  if (!repo) return { outcome: "not-enabled", service, repo: repoDisplay(tags.repositoryUrl), why: "not-on-github", sha: tags.sha };
  // Before any GitHub call: a repo of an owner the Org does not allow is never looked up, cloned or written to.
  const allowed = orgByName(config, alert.org)?.allowedRepoOwners;
  if (allowed && !allowed.some((owner) => owner.toLowerCase() === repo.owner.toLowerCase())) {
    return { outcome: "not-enabled", service, repo: repoName(repo), why: "owner-not-allowed", sha: tags.sha };
  }
  let installationId: number | undefined;
  try {
    installationId = await appInstallationFor(env, config, repo);
  } catch (error) {
    return { outcome: "unresolved", service, reason: `checking the GitHub App installation failed: ${message(error)}` };
  }
  if (installationId === undefined) {
    return { outcome: "not-enabled", service, repo: repoName(repo), why: "not-installed", sha: tags.sha };
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
 * structured data and takes the tags only from each span's reserved tag list, by exact key, so
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

/**
 * A span's `git.repository_url` and `git.commit.sha`, from its reserved tag list only: the tags source code
 * integration sets. Attribute maps (`attributes`, `custom`, `meta`, top-level fields) are never read, since
 * instrumented application code can write any key there. The real Datadog MCP result shape is still unverified,
 * so this is the one function to adjust during the pilot.
 */
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
  const repositoryUrl = fromTagList("git.repository_url");
  const sha = fromTagList("git.commit.sha");
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
export function codeLine(org: string, resolution: RepoResolution): string {
  switch (resolution.outcome) {
    case "resolved":
      return `Code: ${resolution.repo} at deployed commit ${resolution.sha}.`;
    case "unmapped":
      return `Code: Unmapped service: ${unmappedWhy(resolution)}, so its code was not read and no Agent PR can be opened.`;
    case "not-enabled":
      return `Code: repo not enabled: ${notEnabledWhy(org, resolution)}, so its code was not read and no Agent PR can be opened.`;
    case "unresolved":
      return `Code: not read: ${resolution.reason}.`;
  }
}

function unmappedWhy(resolution: Extract<RepoResolution, { outcome: "unmapped" }>): string {
  if (resolution.reason) return resolution.reason;
  return resolution.service ? `service ${resolution.service} has no source code integration git tags` : "the monitor names no service";
}

/** Why a repo is not enabled, in words for messages. */
function notEnabledWhy(org: string, resolution: Extract<RepoResolution, { outcome: "not-enabled" }>): string {
  switch (resolution.why) {
    case "not-on-github":
      return `the repository ${resolution.repo} is not on GitHub`;
    case "owner-not-allowed":
      return `the owner ${resolution.repo.split("/")[0]} of ${resolution.repo} is not allowed for Org ${org}`;
    case "not-installed":
      return `the GitHub App is not installed on ${resolution.repo}`;
  }
}

/** A reminder for the Owning team and its dedup key in the Coordinator (one per 7 days per key), if any. */
export interface Reminder {
  kind: "unmapped-reminder" | "repo-reminder";
  key: string;
  message: TeamsMessage;
}

/** What fixes each case, for the reminder. */
const NOT_ENABLED_FIX: Record<NotEnabledReason, string> = {
  "not-on-github": "Only GitHub repos with the oncall agent's GitHub App installed can be read.",
  "owner-not-allowed": "Only repos of the owners allowed for the Org can be read; ask the oncall agent's maintainers to allow the owner if it should be.",
  "not-installed": "Install the GitHub App on the repo to opt it in.",
};

/**
 * The reminder for an Unmapped service or a repo not enabled. Unmapped: per Org and service, or per Org and
 * monitor when the monitor names no service. Repo not enabled: per repo across Orgs, except an owner one Org does
 * not allow, which is per Org and repo.
 */
export function reminderFor(alert: { org: string; monitorId: string }, resolution: RepoResolution): Reminder | undefined {
  const { org } = alert;
  if (resolution.outcome === "unmapped") return unmappedReminder(alert, resolution);
  if (resolution.outcome !== "not-enabled") return undefined;
  const repo = resolution.repo.toLowerCase();
  return {
    kind: "repo-reminder",
    key: resolution.why === "owner-not-allowed" ? `repo-owner-not-allowed:${org}:${repo}` : `repo-not-enabled:${repo}`,
    message: {
      title: `Repo not enabled: ${resolution.repo}`,
      lines: [
        `The repo of service ${resolution.service} cannot be used: ${notEnabledWhy(org, resolution)}. So the oncall agent cannot read its code or propose Agent PRs.`,
        `${NOT_ENABLED_FIX[resolution.why]} Investigation reports still arrive meanwhile.`,
      ],
      facts: [
        ["Repo", resolution.repo],
        ["Service", resolution.service],
        ["Org", org],
      ],
    },
  };
}

function unmappedReminder(
  { org, monitorId }: { org: string; monitorId: string },
  resolution: Extract<RepoResolution, { outcome: "unmapped" }>,
): Reminder {
  const service = resolution.service;
  if (!service) {
    return {
      kind: "unmapped-reminder",
      key: `unmapped:${org}:monitor:${monitorId}`,
      message: {
        title: `Unmapped service: monitor ${monitorId} names no service`,
        lines: [
          `Monitor ${monitorId} in Org ${org} names no service (no service tag, and no service in its group), so the oncall agent cannot look up the service's code or propose Agent PRs.`,
          "Add a service:<name> tag to the monitor, or group it by service. Investigation reports still arrive meanwhile.",
        ],
        facts: [
          ["Org", org],
          ["Monitor", monitorId],
        ],
      },
    };
  }
  const lines = resolution.reason
    ? [
        `Service ${service} in Org ${org} cannot be mapped to its code: ${resolution.reason}. So the oncall agent cannot pick its code or propose Agent PRs.`,
        "Make every deployment of the service report the same DD_GIT_REPOSITORY_URL and DD_GIT_COMMIT_SHA as the code it runs. Investigation reports still arrive meanwhile.",
      ]
    : [
        `Service ${service} in Org ${org} has no Datadog source code integration git tags (git.repository_url and git.commit.sha), so the oncall agent cannot find its code or propose Agent PRs.`,
        "Add the tags to the service's telemetry, for example by setting DD_GIT_REPOSITORY_URL and DD_GIT_COMMIT_SHA at build or deploy time. Investigation reports still arrive meanwhile.",
      ];
  return {
    kind: "unmapped-reminder",
    key: `unmapped:${org}:${service}`,
    message: {
      title: `Unmapped service: ${service}`,
      lines,
      facts: [
        ["Org", org],
        ["Service", service],
      ],
    },
  };
}

