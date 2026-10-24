import type { OncallConfig } from "../config";
import {
  AGENT_BRANCH_PREFIX,
  GitHubError,
  RepoClient,
  appInstallationFor,
  installationToken,
  repoName,
  type RepoRef,
} from "../github";
import type { Alert, AlertEpisodeKey } from "../intake";
import { owningTeam } from "../teams";
import { errorMessage, scrubSecret, truncate } from "../text";
import type { CodeWorkspace, FileChange } from "../workspace/code-workspace";
import { agentPrBody, type InvestigationReport } from "./report";

/**
 * The Agent PR (ADR 0002): when the agent declares a fix and Report-only mode does not apply, the harness commits
 * the agent's workspace edits on top of `main`, pushes them to the monitor group's `oncall-agent/*` branch and opens
 * a draft PR from it, or updates the open one. Code owners are requested by CODEOWNERS; the agent never merges.
 */

/** The branch every Agent PR comes from: the repo's default branch. */
export const BASE_BRANCH = "main";
/** Tries of the finalize job before a GitHub failure is reported instead of retried. */
export const AGENT_PR_ATTEMPTS = 4;

/** What the Investigation records about its Agent PR, once per Alert episode. */
export type AgentPrRecord =
  /** A draft PR was opened, or the open one for this monitor group updated. */
  | { outcome: "opened" | "updated"; repo: RepoRef; number: number; url: string; branch: string }
  /**
   * Files the fix changes also changed on `main` since the deployed commit. The edits were made on the deployed
   * version, so pushed onto `main` they would undo those changes: nothing is pushed.
   */
  | { outcome: "drifted"; paths: string[] }
  /**
   * The monitor group's branch has commits not made by the harness (a Code owner's): nothing is forced over them.
   * When an Agent PR is open from it, it gets a comment and is linked.
   */
  | { outcome: "human-commits"; repo: RepoRef; branch: string; number?: number; url?: string }
  /** The agent declared a fix, but Report-only mode applies (globally, or the Owning team is not allowed Agent PRs). */
  | { outcome: "report-only" }
  /** The agent declared a fix but changed no file. */
  | { outcome: "no-changes" }
  /**
   * The fix changes protected paths (CI, build, dependency or ownership files), or paths outside the repo's
   * `allowedPrefixes` when it has them: nothing is pushed.
   */
  | { outcome: "protected-paths"; paths: string[]; allowedPrefixes?: string[] }
  /** GitHub refused or kept failing; the report says so. */
  | { outcome: "failed"; reason: string };

/**
 * Whether Report-only mode applies to an alert: always while the global switch is on; otherwise unless its Owning
 * team is one allowed Agent PRs. No team tag means Report-only.
 */
export function reportOnly(config: OncallConfig, tags: readonly string[]): boolean {
  const team = owningTeam(tags);
  return config.reportOnly || team === undefined || !config.agentPrTeams.includes(team);
}

/**
 * The changed paths an Agent PR may not push to `repo`: those matching `config.github.protectedPaths`
 * (case-insensitive), and, when the repo has `allowedPathPrefixes`, those outside every prefix. A deleted file
 * counts like a changed one. (This narrows, but cannot close, the risk of CI running model-written code with the
 * repo's secrets; see DEFAULT_PROTECTED_PATHS.)
 */
export function blockedPaths(
  config: OncallConfig,
  repo: RepoRef,
  changes: readonly FileChange[],
): { paths: string[]; allowedPrefixes?: string[] } {
  const patterns = config.github.protectedPaths.map(globRegExp);
  const full = repoName(repo).toLowerCase();
  const settings = Object.entries(config.github.repos).find(([name]) => name.toLowerCase() === full)?.[1];
  const prefixes = settings?.allowedPathPrefixes;
  const paths = changes.map((c) => c.path).filter((path) => {
    const normal = path.replace(/^(?:\.\/)+/, "").replace(/\/{2,}/g, "/");
    if (prefixes && !prefixes.some((prefix) => normal.startsWith(prefix.replace(/^(?:\.\/)+/, "")))) return true;
    return patterns.some((re) => re.test(normal));
  });
  return prefixes ? { paths, allowedPrefixes: prefixes } : { paths };
}

/**
 * A glob as a case-insensitive RegExp: `**\/` any leading directories, `**` anything, `*` and `?` within a segment,
 * `{a,b}` either alternative.
 */
function globRegExp(glob: string): RegExp {
  const source = glob
    .replace(/[.+^$()|[\]\\]/g, "\\$&")
    .replace(/\{([^{}]*)\}/g, (_, alternatives: string) => `(?:${alternatives.split(",").join("|")})`)
    .replace(/\*\*\//g, "\u0001")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0001/g, "(?:.*/)?")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${source}$`, "i");
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

/** The monitor group's Agent PR branch as the harness last left it, kept across Alert episodes. */
export interface AgentBranchState {
  repo: RepoRef;
  branch: string;
  /** The commit the harness last pushed to the branch: any other head means someone else pushed. */
  sha: string;
  /** The Agent PR from the branch, once opened. */
  number?: number;
  url?: string;
}

type AgentPrStep = "commit" | "branch" | "pr-before" | "pr";

/**
 * Where an Agent PR push records itself: its steps for this Alert episode, so a replay after eviction repeats none
 * of them, and the monitor group's branch state, which outlives the episode.
 */
export interface AgentPrStore {
  get<T>(step: AgentPrStep): Promise<T | undefined>;
  put(step: AgentPrStep, value: unknown): Promise<void>;
  branchState(): Promise<AgentBranchState | undefined>;
  setBranchState(state: AgentBranchState): Promise<void>;
}

export interface ProposedFix {
  alert: Alert;
  /** The Alert episode of the monitor group, for the PR comment that says why a fix was not pushed. */
  episodeNumber: number;
  report: InvestigationReport;
  repo: RepoRef;
  /** The deployed commit the agent's edits were made on. */
  deployedSha: string;
  installationId?: number;
  /** The checked-out workspace holding the agent's edits. */
  workspace: CodeWorkspace;
  /** How many times the finalize job running this has failed before. */
  failures: number;
}

/**
 * The Agent PR for a report that declares a fix. Nothing but a note under Report-only mode, for no changes, or for
 * changes to protected paths (checked before any token is minted: a pushed branch runs the repo's CI with its
 * secrets). A GitHub refusal, or a failure that persists past a few tries of the finalize job, is returned as
 * `failed` so the report still goes out; a retryable failure before that throws, for the job to retry.
 */
export async function proposeAgentPr(env: Env, config: OncallConfig, fix: ProposedFix, store: AgentPrStore): Promise<AgentPrRecord> {
  if (reportOnly(config, fix.alert.tags)) return { outcome: "report-only" };
  const changes = await fix.workspace.changes();
  if (changes.length === 0) return { outcome: "no-changes" };
  const blocked = blockedPaths(config, fix.repo, changes);
  if (blocked.paths.length) return { outcome: "protected-paths", ...blocked };
  try {
    return await pushAgentPr(env, config, fix, changes, store);
  } catch (error) {
    if (retryable(error) && fix.failures + 1 < AGENT_PR_ATTEMPTS) throw error;
    const reason = errorMessage(error);
    console.warn(`Agent PR for ${repoName(fix.repo)} failed: ${reason}`);
    return { outcome: "failed", reason: truncate(reason, 300) };
  }
}

/**
 * Pushes the agent's edits and opens (or updates) the draft Agent PR. Every outward step looks before it acts and
 * is recorded in `store`, so a replay converges on one branch and one PR. Before anything is written it refuses a
 * drifted fix and a branch holding someone else's commits. Mints a token for the one repo with contents:write and
 * pull_requests:write only, kept in memory for this call. Throws a `GitHubError` or network error, never carrying
 * the token.
 */
async function pushAgentPr(
  env: Env,
  config: OncallConfig,
  fix: ProposedFix,
  changes: FileChange[],
  store: AgentPrStore,
): Promise<AgentPrRecord> {
  const { alert, repo } = fix;
  const branch = await agentBranch(alert);
  const installationId = fix.installationId ?? (await appInstallationFor(env, config, repo));
  if (installationId === undefined) throw new GitHubError(404, "the GitHub App is no longer installed on the repo");
  const token = await installationToken(env, config, installationId, repo, { contents: "write", pull_requests: "write" });
  try {
    const github = new RepoClient(repo, token);
    let commit = await store.get<{ sha: string }>("commit");
    if (!commit) {
      const main = await github.branchHead(BASE_BRANCH);
      const changedOnMain = new Set(await github.changedFiles(fix.deployedSha, main.sha));
      const drifted = changes.map((c) => c.path).filter((p) => changedOnMain.has(p));
      if (drifted.length) return { outcome: "drifted", paths: drifted };
      const head = await github.branchSha(branch);
      const ours = await store.branchState();
      const lastPushed = ours && repoName(ours.repo).toLowerCase() === repoName(repo).toLowerCase() ? ours.sha : undefined;
      if (head !== undefined && head !== lastPushed) return await leaveBranchAlone(github, fix, branch);
      const message = `Proposed fix for monitor ${alert.monitorId} (${alert.org}) by the oncall agent`;
      commit = { sha: await github.commit(main, changes, message) };
      await store.put("commit", commit);
    }
    if (!(await store.get("branch"))) {
      await github.pushAgentBranch(branch, commit.sha);
      const previous = await store.branchState();
      await store.setBranchState({ ...previous, repo, branch, sha: commit.sha });
      await store.put("branch", { branch, sha: commit.sha });
    }
    let pr = await store.get<{ outcome: "opened" | "updated"; number: number; url: string }>("pr");
    if (!pr) {
      const content = {
        title: `Agent PR: proposed fix for monitor ${alert.monitorId} (${alert.org})`,
        body: agentPrBody(alert, fix.report, { deployedSha: fix.deployedSha, changedPaths: changes.map((c) => c.path) }),
      };
      const open = await github.openPull(branch);
      // Which PR was open before this push decides opened vs updated, also when a replay finds the one it opened.
      let before = await store.get<{ number: number | null }>("pr-before");
      if (!before) {
        before = { number: open?.number ?? null };
        await store.put("pr-before", before);
      }
      const answer = open
        ? await github.updatePull(open.number, content)
        : await github.createDraftPull({ branch, base: BASE_BRANCH, ...content });
      pr = { outcome: before.number === answer.number ? "updated" : "opened", number: answer.number, url: answer.html_url };
      await store.setBranchState({ repo, branch, sha: commit.sha, number: pr.number, url: pr.url });
      await store.put("pr", pr);
    }
    return { ...pr, repo, branch };
  } catch (error) {
    if (error instanceof Error) error.message = scrubSecret(error.message, token);
    throw error;
  }
}

/**
 * The branch holds commits the harness did not push: leaves it as it is and, when an Agent PR is open from it,
 * says so in a comment (once per Alert episode: the comment carries a marker the harness looks for first).
 */
async function leaveBranchAlone(github: RepoClient, fix: ProposedFix, branch: string): Promise<AgentPrRecord> {
  const open = await github.openPull(branch);
  if (open) {
    const marker = `<!-- oncall-agent: Alert episode ${fix.episodeNumber} -->`;
    if (!(await github.pullComments(open.number)).some((body) => body.includes(marker))) {
      await github.commentOnPull(
        open.number,
        `${marker}\nA new Alert episode of this monitor was investigated and the oncall agent proposed another fix, ` +
          "but the fix was not pushed because this branch has commits not made by the oncall agent. " +
          "The Investigation report was posted to the Owning team's Teams channel.",
      );
    }
  }
  return { outcome: "human-commits", repo: fix.repo, branch, number: open?.number, url: open?.html_url };
}

/**
 * The Agent PR an earlier Alert episode of this monitor group opened, when GitHub says it is still open; checked
 * with a token for the one repo with pull_requests:read only.
 */
export async function openAgentPrOf(
  env: Env,
  config: OncallConfig,
  state: AgentBranchState | undefined,
): Promise<{ number: number; url: string; branch: string } | undefined> {
  if (state?.number === undefined) return undefined;
  const installationId = await appInstallationFor(env, config, state.repo);
  if (installationId === undefined) return undefined;
  const token = await installationToken(env, config, installationId, state.repo, { pull_requests: "read" });
  try {
    const open = await new RepoClient(state.repo, token).openPull(state.branch);
    return open && { number: open.number, url: open.html_url, branch: state.branch };
  } catch (error) {
    if (error instanceof Error) error.message = scrubSecret(error.message, token);
    throw error;
  }
}

/** Whether a failed Agent PR push is worth retrying: GitHub down or throttled, or the network; not a refusal. */
export function retryable(error: unknown): boolean {
  return !(error instanceof GitHubError) || error.status >= 500 || error.status === 429;
}

