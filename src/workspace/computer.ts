import type { DurableObjectStorageLike, Workspace } from "@cloudflare/computer";
import type { CreatePiToolsOptions } from "@cloudflare/computer/tools/pi-ai";
import type { CheckoutInput, CodeWorkspace, FileChange } from "./code-workspace";
import { WORKSPACE_ROOT, workspaceTools } from "./tools";

/**
 * The real code workspace: a native `@cloudflare/computer` Workspace (SQLite filesystem in the Investigation's own
 * Durable Object storage, isomorphic-git) with no exec backend, so the agent cannot run anything (ADR 0001).
 * Computer and its git are loaded on first use, so Investigations without code never pay for them.
 *
 * The clone is the one outbound HTTP that does not go through `ports().fetch`: isomorphic-git uses the global
 * `fetch`. Tests never reach it, because they replace this whole adapter through `ports().workspace`.
 */
export class ComputerWorkspace implements CodeWorkspace {
  #ws?: Promise<Workspace>;

  constructor(private readonly ctx: DurableObjectState) {}

  async checkout({ owner, repo, sha, token }: CheckoutInput): Promise<void> {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`the deployed commit ${sha} is not a full commit SHA`);
    if ((await this.#head()) === sha && (await this.changes()).length === 0) return;
    const ws = await this.#open();
    await ws.fs.rm(WORKSPACE_ROOT, { recursive: true, force: true });
    await ws.fs.mkdir(WORKSPACE_ROOT, { recursive: true });
    // The token goes in a header only, never in the URL, so it is not written to .git/config.
    await ws.git.clone({
      url: `https://github.com/${owner}/${repo}.git`,
      dir: WORKSPACE_ROOT,
      ref: sha,
      depth: 1,
      headers: { Authorization: `Basic ${btoa(`x-access-token:${token}`)}` },
    });
    const head = await this.#head();
    if (head !== sha) throw new Error(`the checkout is at ${head ?? "no commit"}, not the deployed commit ${sha}`);
    // Belt and braces: nothing the clone wrote may hold the token (isomorphic-git keeps only the URL).
    const config = await ws.fs.readFile(`${WORKSPACE_ROOT}/.git/config`, "utf8").catch(() => "");
    if (config.includes(token)) {
      await ws.fs.rm(WORKSPACE_ROOT, { recursive: true, force: true });
      throw new Error("the clone stored the installation token; the checkout was discarded");
    }
    // Symbolic links could lead the agent's tools out of the checkout or into .git: they are not materialised.
    for (const link of await this.#files(WORKSPACE_ROOT, "links")) await ws.fs.rm(`${WORKSPACE_ROOT}/${link}`);
  }

  tools() {
    const open = () => this.#open();
    const fs: CreatePiToolsOptions["workspace"]["fs"] = {
      stat: async (...a) => (await open()).fs.stat(...a),
      readFile: async (path, options) => (await open()).fs.readFile(path, options ?? {}),
      writeFile: async (...a) => (await open()).fs.writeFile(...a),
      mkdir: async (...a) => (await open()).fs.mkdir(...a),
      rm: async (...a) => (await open()).fs.rm(...a),
      find: async (...a) => (await open()).fs.find(...a),
      grep: async (...a) => (await open()).fs.grep(...a),
      readdir: async (...a) => (await open()).fs.readdir(...a),
    };
    return workspaceTools({ fs });
  }

  /**
   * By content hash against the checked-out commit, not `git status`: isomorphic-git's stat cache misses a
   * same-size edit made within the same second as the checkout.
   */
  async changes(): Promise<FileChange[]> {
    const head = await this.#head();
    if (!head) return [];
    const ws = await this.#open();
    const git = ws.git;
    const tracked = new Set(await git.lsFiles({ dir: WORKSPACE_ROOT, ref: head }));
    const present = await this.#files(WORKSPACE_ROOT);
    const out: FileChange[] = [];
    for (const path of present) {
      const bytes = new Uint8Array(await new Response(await ws.fs.readFile(`${WORKSPACE_ROOT}/${path}`)).arrayBuffer());
      if (tracked.has(path)) {
        const committed = (await git.catFile({ dir: WORKSPACE_ROOT, oid: head, filepath: path })).oid;
        if ((await git.hashObject({ dir: WORKSPACE_ROOT, content: bytes })) === committed) continue;
      }
      out.push({ path, content: new TextDecoder().decode(bytes) });
    }
    for (const path of tracked) {
      if (present.includes(path) || (await this.#isSymlink(head, path))) continue; // links were removed at checkout
      out.push({ path, content: null });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  #open(): Promise<Workspace> {
    this.#ws ??= (async () => {
      const [{ Workspace }, { createGitClient }] = await Promise.all([
        import("@cloudflare/computer"),
        import("@cloudflare/computer/git"),
      ]);
      return new Workspace({
        storage: this.ctx.storage as unknown as DurableObjectStorageLike,
        git: createGitClient(),
        defaultGitIdentity: { name: "oncall-agent", email: "oncall-agent@users.noreply.github.com" },
      });
    })();
    return this.#ws;
  }

  /** Whether `path` is a symbolic link in the commit's tree. */
  async #isSymlink(commit: string, path: string): Promise<boolean> {
    const slash = path.lastIndexOf("/");
    const dir = slash < 0 ? undefined : path.slice(0, slash);
    const entries = await (await this.#open()).git.lsTree({ dir: WORKSPACE_ROOT, ref: commit, ...(dir ? { path: dir } : {}) });
    return entries.some((e) => e.path === path.slice(slash + 1) && e.mode === "120000");
  }

  async #head(): Promise<string | undefined> {
    try {
      return await (await this.#open()).git.revParse({ dir: WORKSPACE_ROOT, ref: "HEAD" });
    } catch {
      return undefined;
    }
  }

  /** Every file (or symbolic link) under `dir`, relative to the workspace root, skipping `.git`. */
  async #files(dir: string, kind: "files" | "links" = "files"): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await (await this.#open()).fs.readdir(dir)) {
      const path = `${dir}/${entry.name}`;
      if (dir === WORKSPACE_ROOT && entry.name === ".git") continue;
      const relative = path.slice(WORKSPACE_ROOT.length + 1);
      if (entry.isSymbolicLink) {
        if (kind === "links") out.push(relative);
      } else if (entry.isDirectory) out.push(...(await this.#files(path, kind)));
      else if (entry.isFile && kind === "files") out.push(relative);
    }
    return out;
  }
}
