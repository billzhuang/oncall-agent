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
  | { outcome: "resolved"; service: string; repo: string; repoUrl: string; sha: string }
  /** Unmapped service: no git tags (or no service tag to look them up by). */
  | { outcome: "unmapped"; service?: string }
  /** Repo not enabled: git tags found, but the GitHub App is not installed on the repo (or it is not on GitHub). */
  | { outcome: "not-enabled"; service: string; repo: string; sha: string }
  /** The lookup itself failed (Datadog or GitHub unreachable); the Investigation goes on without code. */
  | { outcome: "unresolved"; service?: string; reason: string };

/** The Datadog MCP tool that returns spans with their tags; `git.*` is in its default attribute set. */
export const SPANS_TOOL = "search_datadog_spans";
/** How far back to look for a span of the service carrying git tags. */
const LOOKBACK = "now-24h";

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
  let tags: { repositoryUrl: string; sha: string } | undefined;
  try {
    tags = await gitTagsOf(datadog, service);
  } catch (error) {
    return { outcome: "unresolved", service, reason: `reading git tags from Datadog failed: ${message(error)}` };
  }
  if (!tags) return { outcome: "unmapped", service };
  const repo = githubRepoFromUrl(tags.repositoryUrl);
  if (!repo) return { outcome: "not-enabled", service, repo: tags.repositoryUrl, sha: tags.sha };
  try {
    if ((await appInstallationFor(env, config, repo)) === undefined) {
      return { outcome: "not-enabled", service, repo: repoName(repo), sha: tags.sha };
    }
  } catch (error) {
    return { outcome: "unresolved", service, reason: `checking the GitHub App installation failed: ${message(error)}` };
  }
  return { outcome: "resolved", service, repo: repoName(repo), repoUrl: `https://github.com/${repoName(repo)}`, sha: tags.sha };
}

/**
 * The service's git tags from its newest span. The tool's text format is not a contract, so this reads the two
 * tags from the text in either form they appear: `git.commit.sha:abc…` (tag) or `"git.commit.sha": "abc…"` (JSON).
 */
async function gitTagsOf(datadog: DatadogConnection, service: string) {
  const result = await datadog.callTool(SPANS_TOOL, {
    query: `service:${service}`,
    from: LOOKBACK,
    limit: 1,
    custom_attributes: ["git.*"],
    telemetry: { intent: "Oncall agent repo resolution: read the service's source code integration git tags" },
  });
  const text = (result.content as Array<{ type: string; text?: string }>)
    .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
    .join("\n");
  if (result.isError) throw new Error(text || "tool error");
  const value = (tag: string, pattern: string) =>
    text.match(new RegExp(`${tag.replace(/\./g, "\\.")}["']?\\s*[:=]\\s*["']?(${pattern})`, "i"))?.[1];
  const repositoryUrl = value("git.repository_url", `[^\\s"',}\\]]+`);
  const sha = value("git.commit.sha", "[0-9a-f]{7,40}");
  return repositoryUrl && sha ? { repositoryUrl, sha: sha.toLowerCase() } : undefined;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The Investigation report's line about the code: what was resolved, or why there is none. */
export function codeLine(resolution: RepoResolution): string {
  switch (resolution.outcome) {
    case "resolved":
      return `Code: ${resolution.repo} at deployed commit ${resolution.sha}.`;
    case "unmapped":
      return resolution.service
        ? `Code: Unmapped service: service ${resolution.service} has no source code integration git tags, so its code was not read and no Agent PR can be opened.`
        : "Code: Unmapped service: the monitor names no service, so its code was not read and no Agent PR can be opened.";
    case "not-enabled":
      return `Code: repo not enabled: the GitHub App is not installed on ${resolution.repo}, so its code was not read and no Agent PR can be opened.`;
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
  if (resolution.outcome === "unmapped" && resolution.service) {
    // Per Org and service. Without a service tag there is nothing to add git tags to, so no reminder.
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
        lines: [
          `The oncall agent's GitHub App is not installed on ${resolution.repo}, the repo of service ${resolution.service}, so the agent cannot read its code or propose Agent PRs.`,
          "Install the GitHub App on the repo to opt it in. Investigation reports still arrive meanwhile.",
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
