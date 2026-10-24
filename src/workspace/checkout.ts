import type { OncallConfig } from "../config";
import { appInstallationFor, installationToken, isFullSha, repoName, type RepoRef } from "../github";
import type { RepoResolution } from "../repo-resolution";
import { errorMessage, scrubSecret, truncate } from "../text";
import type { CodeWorkspace } from "./code-workspace";

/** What the harness made of the Investigation's code workspace. Never holds the token. */
export type WorkspaceState =
  /** The repo is checked out at the deployed commit; the agent has the workspace tools. */
  | { outcome: "ready"; repo: RepoRef; sha: string }
  /** The checkout failed; the Investigation goes on without code. */
  | { outcome: "failed"; repo: RepoRef; sha: string; reason: string };

/**
 * Checks out the resolved repo at the deployed commit, with an installation token the harness mints for this one
 * repo, read-only, and drops right after the clone (ADR 0002). Never throws: a failure is the `failed` state, its
 * reason scrubbed of the token.
 */
export async function checkOutDeployedCommit(
  env: Env,
  config: OncallConfig,
  workspace: CodeWorkspace,
  resolution: Extract<RepoResolution, { outcome: "resolved" }>,
): Promise<WorkspaceState> {
  const { repo, sha } = resolution;
  let token: string | undefined;
  try {
    // A clone can only be pinned to a full SHA; an abbreviated one would need resolving on GitHub first.
    if (!isFullSha(sha)) throw new Error(`the deployed commit ${sha} is not a full commit SHA`);
    const installationId = resolution.installationId ?? (await appInstallationFor(env, config, repo));
    if (installationId === undefined) throw new Error(`the GitHub App is no longer installed on ${repoName(repo)}`);
    token = await installationToken(env, config, installationId, repo, { contents: "read" });
    await workspace.checkout({ owner: repo.owner, repo: repo.name, sha, token });
    return { outcome: "ready", repo, sha };
  } catch (error) {
    return { outcome: "failed", repo, sha, reason: truncate(scrubSecret(errorMessage(error), token), 300) };
  }
}

/** The Investigation report's line about a checkout that failed. */
export function checkoutFailedLine(state: Extract<WorkspaceState, { outcome: "failed" }>): string {
  return `Code: ${repoName(state.repo)} at deployed commit ${state.sha} could not be checked out (${state.reason}), so its code was not read.`;
}
