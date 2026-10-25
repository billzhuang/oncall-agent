import type { ToolRegistration } from "@earendil-works/pi-durable";

/**
 * The code workspace port: one per Investigation (its Durable Object). The harness checks out the deployed commit
 * with a GitHub App installation token (ADR 0002); the agent gets only the workspace tools, which hold no
 * credential and cannot run commands or git. Production: native `@cloudflare/computer` (`computer.ts`); tests:
 * an in-memory workspace (`test/fakes/workspace.ts`).
 */
export interface CodeWorkspace {
  /**
   * Makes the workspace a clean checkout of `owner/repo` at `sha` (a full 40-hex commit SHA): no-op when it already
   * is one. `token` authenticates the clone only; it is never written into the workspace.
   */
  checkout(input: CheckoutInput): Promise<void>;
  /** The agent's tools on the workspace: read, ls, find, grep, edit, write (see `tools.ts`). */
  tools(): ToolRegistration[];
  /**
   * The files the agent changed against the checked-out commit, compared by content, sorted by path: what an
   * Agent PR (#8) commits. `content: null` means the file was deleted.
   */
  changes(): Promise<FileChange[]>;
}

export interface CheckoutInput {
  owner: string;
  repo: string;
  sha: string;
  token: string;
}

/** One file the agent changed, path relative to the repo root. */
export interface FileChange {
  path: string;
  /** The file's new content (UTF-8), or null when the agent deleted it. */
  content: string | null;
}
