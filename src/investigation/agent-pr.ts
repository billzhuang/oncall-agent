import type { OncallConfig } from "../config";
import { AGENT_BRANCH_PREFIX, GitHubError, RepoClient, appInstallationFor, installationToken, type RepoRef } from "../github";
import type { AlertEpisodeKey } from "../intake";
import { owningTeam } from "../teams";
import type { FileChange } from "../workspace/code-workspace";

/**
 * The Agent PR (ADR 0002): when the agent declares a fix and Report-only mode is off, the harness commits the
 * agent's workspace edits on top of `main`, pushes them to the monitor group's `oncall-agent/*` branch and opens a
 * draft PR from it, or updates the open one. Code owners are requested by CODEOWNERS; the agent never merges.
 */

/** The branch every Agent PR comes from: the repo's default branch. */
export const BASE_BRANCH = "main";

/** What the Investigation records about its Agent PR, once per Alert episode. */
export type AgentPrRecord =
  /** A draft PR was opened, or the open one for this monitor group updated. */
  | { outcome: "opened" | "updated"; number: number; url: string; branch: string; drift: string[] }
  /** The agent declared a fix, but Report-only mode is on for the Owning team (or globally). */
  | { outcome: "report-only" }
  /** The agent declared a fix but changed no file. */
  | { outcome: "no-changes" }
  /** GitHub refused or kept failing; the report says so. */
  | { outcome: "failed"; reason: string };

/** Whether Report-only mode applies to an alert: the Owning team's switch where config names one, else the global one. */
export function reportOnly(config: OncallConfig, tags: readonly string[]): boolean {
  const team = owningTeam(tags);
  return (team !== undefined ? config.reportOnly.teams[team] : undefined) ?? config.reportOnly.global;
}

/**
 * The Agent PR branch of a monitor group: the same for every Alert episode of `(org, monitor, group)`, so a later
 * episode finds and updates it. The group is hashed: it holds characters refs cannot (`:`, `,`, spaces).
 */
export async function agentBranch(key: AlertEpisodeKey): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key.group));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
  return `${AGENT_BRANCH_PREFIX}${key.org}-${key.monitorId}-${hash}`;
}

type AgentPrStep = "commit" | "branch" | "pr-before" | "pr";

/** The steps of one Agent PR push, recorded so a replay after eviction repeats none of them. */
export interface AgentPrSteps {
  get<T>(step: AgentPrStep): Promise<T | undefined>;
  put(step: AgentPrStep, value: unknown): Promise<void>;
}

export interface AgentPrInput {
  repo: RepoRef;
  installationId?: number;
  /** The deployed commit the agent's edits were made on. */
  deployedSha: string;
  branch: string;
  changes: FileChange[];
  title: string;
  commitMessage: string;
  /** The PR description, given the changed paths that also changed on `main` since the deployed commit. */
  body(drift: string[]): string;
}

/**
 * Pushes the agent's edits and opens (or updates) the draft Agent PR. Every outward step looks before it acts and
 * is recorded in `steps`, so a replay converges on one branch and one PR. Mints a token for the one repo with
 * contents:write and pull_requests:write only, kept in memory for this call. Throws a `GitHubError` or network error,
 * never carrying the token.
 */
export async function pushAgentPr(
  env: Env,
  config: OncallConfig,
  input: AgentPrInput,
  steps: AgentPrSteps,
): Promise<Extract<AgentPrRecord, { outcome: "opened" | "updated" }>> {
  const installationId = input.installationId ?? (await appInstallationFor(env, config, input.repo));
  if (installationId === undefined) throw new GitHubError(404, "the GitHub App is no longer installed on the repo");
  const token = await installationToken(env, config, installationId, input.repo, { contents: "write", pull_requests: "write" });
  try {
    const github = new RepoClient(input.repo, token);
    let commit = await steps.get<{ sha: string; drift: string[] }>("commit");
    if (!commit) {
      const main = await github.branchHead(BASE_BRANCH);
      const changedOnMain = new Set(await github.changedFiles(input.deployedSha, main.sha));
      const drift = input.changes.map((c) => c.path).filter((p) => changedOnMain.has(p));
      commit = { sha: await github.commit(main, input.changes, input.commitMessage), drift };
      await steps.put("commit", commit);
    }
    if (!(await steps.get("branch"))) {
      await github.pushAgentBranch(input.branch, commit.sha);
      await steps.put("branch", { branch: input.branch, sha: commit.sha });
    }
    let pr = await steps.get<{ outcome: "opened" | "updated"; number: number; url: string }>("pr");
    if (!pr) {
      const content = { title: input.title, body: input.body(commit.drift) };
      const open = await github.openPull(input.branch);
      // Which PR was open before this push decides opened vs updated, also when a replay finds the one it opened.
      let before = await steps.get<{ number: number | null }>("pr-before");
      if (!before) {
        before = { number: open?.number ?? null };
        await steps.put("pr-before", before);
      }
      const answer = open
        ? await github.updatePull(open.number, content)
        : await github.createDraftPull({ branch: input.branch, base: BASE_BRANCH, ...content });
      pr = { outcome: before.number === answer.number ? "updated" : "opened", number: answer.number, url: answer.html_url };
      await steps.put("pr", pr);
    }
    return { ...pr, branch: input.branch, drift: commit.drift };
  } catch (error) {
    if (error instanceof Error && error.message.includes(token)) error.message = error.message.split(token).join("[token]");
    throw error;
  }
}

/** Whether a failed Agent PR push is worth retrying: GitHub down or throttled, or the network; not a refusal. */
export function retryable(error: unknown): boolean {
  return !(error instanceof GitHubError) || error.status >= 500 || error.status === 429;
}
