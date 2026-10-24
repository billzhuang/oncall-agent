import type { OncallConfig } from "../config";
import { appInstallationFor, installationToken, type RepoRef } from "../github";
import type { RepoResolution } from "../repo-resolution";
import type { CodeWorkspace } from "./code-workspace";

/** What the harness made of the Investigation's code workspace. Never holds the token. */
export type WorkspaceState =
  /** The repo is checked out at the deployed commit; the agent has the workspace tools. */
  | { outcome: "ready"; repo: string; sha: string }
  /** The checkout failed; the Investigation goes on without code. */
  | { outcome: "failed"; repo: string; sha: string; reason: string };

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
  const { repo: name, sha } = resolution;
  const [owner = "", repoName = ""] = name.split("/");
  const repo: RepoRef = { owner, name: repoName };
  let token: string | undefined;
  try {
    // A clone can only be pinned to a full SHA; an abbreviated one would need resolving on GitHub first.
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`the deployed commit ${sha} is not a full commit SHA`);
    const installationId = resolution.installationId ?? (await appInstallationFor(env, config, repo));
    if (installationId === undefined) throw new Error(`the GitHub App is no longer installed on ${name}`);
    token = await installationToken(env, config, installationId, repo, { contents: "read" });
    await workspace.checkout({ owner, repo: repoName, sha, token });
    return { outcome: "ready", repo: name, sha };
  } catch (error) {
    let reason = error instanceof Error ? error.message : String(error);
    if (token) reason = reason.split(token).join("[token]");
    return { outcome: "failed", repo: name, sha, reason: reason.length > 300 ? `${reason.slice(0, 299)}…` : reason };
  }
}

/** The Investigation report's line about a checkout that failed. */
export function checkoutFailedLine(state: Extract<WorkspaceState, { outcome: "failed" }>): string {
  return `Code: ${state.repo} at deployed commit ${state.sha} could not be checked out (${state.reason}), so its code was not read.`;
}
