import type { CreatePiToolsOptions } from "@cloudflare/computer/tools/pi-ai";
import type { CheckoutInput, CodeWorkspace, FileChange } from "../../src/workspace/code-workspace";
import { WORKSPACE_ROOT, workspaceTools } from "../../src/workspace/tools";

type WorkspaceLike = CreatePiToolsOptions["workspace"];

/** One checkout the harness asked for, with the token it presented. */
export interface Checkout {
  investigation: string;
  owner: string;
  repo: string;
  sha: string;
  token: string;
}

/**
 * In-memory code workspaces, one per Investigation (by Durable Object id), in place of Computer and its git.
 * Repos are fixtures by `owner/repo@sha`; a repo without a fixture checks out as a one-file tree. The agent's
 * tools are the production ones (`src/workspace/tools.ts`) over a Map-backed filesystem.
 */
export function fakeWorkspaces() {
  const fixtures = new Map<string, Record<string, string>>();
  const unavailable = new Set<string>();
  const workspaces = new Map<string, FakeWorkspace>();
  const checkouts: Checkout[] = [];

  const of = (investigation: string): FakeWorkspace => {
    let ws = workspaces.get(investigation);
    if (!ws) {
      ws = new FakeWorkspace((input) => {
        const name = `${input.owner}/${input.repo}`.toLowerCase();
        checkouts.push({ investigation, ...input });
        if (unavailable.has(name)) throw new Error(`clone of https://github.com/${name}.git failed: HTTP 404`);
        return fixtures.get(`${name}@${input.sha}`) ?? { "README.md": `# ${input.repo}\n` };
      });
      workspaces.set(investigation, ws);
    }
    return ws;
  };

  return {
    checkouts,
    /** The workspace of an Investigation (`investigationOf(payload).id.toString()`). */
    of,
    /** Adds a repo fixture: the files of `owner/repo` at commit `sha`. */
    repo(name: string, sha: string, files: Record<string, string>) {
      fixtures.set(`${name.toLowerCase()}@${sha}`, files);
    },
    /** Makes every clone of `owner/repo` fail. */
    unavailable(name: string) {
      unavailable.add(name.toLowerCase());
    },
    /** Everything in every workspace, as one string (to scan for leaked secrets). */
    text(): string {
      return [...workspaces.values()].map((ws) => ws.text()).join("\n");
    },
  };
}
export type FakeWorkspaces = ReturnType<typeof fakeWorkspaces>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class FakeWorkspace implements CodeWorkspace {
  readonly #files = new Map<string, { data: Uint8Array; mtime: number }>();
  #seed: Record<string, string> = {};
  #checkedOut?: string;

  constructor(private readonly clone: (input: CheckoutInput) => Record<string, string>) {}

  async checkout(input: CheckoutInput): Promise<void> {
    const key = `${input.owner}/${input.repo}@${input.sha}`;
    if (this.#checkedOut === key && (await this.changes()).length === 0) return;
    const seed = this.clone(input);
    this.#files.clear();
    // What a clone writes besides the tree: repository metadata, with the remote URL and no credential.
    const metadata = {
      ".git/HEAD": `${input.sha}\n`,
      ".git/config": `[remote "origin"]\n\turl = https://github.com/${input.owner}/${input.repo}.git\n`,
    };
    for (const [path, content] of Object.entries({ ...seed, ...metadata })) {
      this.#files.set(`${WORKSPACE_ROOT}/${path}`, { data: encoder.encode(content), mtime: Date.now() });
    }
    this.#seed = seed;
    this.#checkedOut = key;
  }

  tools() {
    return workspaceTools(this.#workspaceLike());
  }

  async changes(): Promise<FileChange[]> {
    const out: FileChange[] = [];
    const current = new Map(
      [...this.#files]
        .map(([p, f]) => [p.slice(WORKSPACE_ROOT.length + 1), decoder.decode(f.data)] as const)
        .filter(([p]) => !p.startsWith(".git/")),
    );
    for (const [path, content] of current) if (this.#seed[path] !== content) out.push({ path, content });
    for (const path of Object.keys(this.#seed)) if (!current.has(path)) out.push({ path, content: null });
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  text(): string {
    return [...this.#files].map(([p, f]) => `${p}\n${decoder.decode(f.data)}`).join("\n");
  }

  /** Computer's filesystem shape over the Map: absolute paths, files only, directories implied. */
  #workspaceLike(): WorkspaceLike {
    const files = this.#files;
    const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
    const isDir = (p: string) => p === "/" || [...files.keys()].some((k) => k.startsWith(`${norm(p)}/`));
    const enoent = (p: string) => Object.assign(new Error(`ENOENT: no such file or directory, ${p}`), { code: "ENOENT" });
    const under = (dir: string) => (k: string) => k.startsWith(`${norm(dir)}/`);
    const glob = (pattern: string) =>
      new RegExp(
        `^${pattern
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*\//g, "\u0001")
          .replace(/\*\*/g, "\u0000")
          .replace(/\*/g, "[^/]*")
          .replace(/\?/g, "[^/]")
          .replace(/\u0001/g, "(?:.*/)?")
          .replace(/\u0000/g, ".*")}$`,
      );
    return {
      fs: {
        async stat(p) {
          const f = files.get(norm(p));
          if (f) return { size: f.data.length, mtime: f.mtime, mode: 0o644, isFile: true, isDirectory: false };
          if (isDir(p)) return { size: 0, mtime: 0, mode: 0o755, isFile: false, isDirectory: true };
          throw enoent(p);
        },
        async readFile(p, o = {}) {
          const f = files.get(norm(p));
          if (!f) throw enoent(p);
          const start = o.byteOffset ?? 0;
          const bytes = f.data.slice(start, o.byteLength ? start + o.byteLength : undefined);
          return new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(bytes);
              c.close();
            },
          });
        },
        async writeFile(p, content) {
          files.set(norm(p), { data: content, mtime: Date.now() });
        },
        async mkdir() {},
        async rm(p, o = {}) {
          if (files.delete(norm(p))) return;
          const inside = [...files.keys()].filter(under(p));
          if (inside.length && o.recursive) inside.forEach((k) => files.delete(k));
          else if (!o.force) throw enoent(p);
        },
        async find(dir, pattern) {
          const re = pattern ? glob(pattern) : undefined;
          return [...files.keys()]
            .filter(under(dir))
            .filter((k) => !re || re.test(k.slice(norm(dir).length + 1)))
            .sort()
            .map((path) => ({ path, type: "file" as const }));
        },
        async grep(query, dir, o = {}) {
          const re = o.regex ? new RegExp(query, o.ignoreCase ? "i" : "") : undefined;
          const match = (t: string) =>
            re ? re.test(t) : o.ignoreCase ? t.toLowerCase().includes(query.toLowerCase()) : t.includes(query);
          const out: Array<{ path: string; line: number; text: string }> = [];
          const start = files.has(norm(dir)) ? [norm(dir)] : [...files.keys()].filter(under(dir)).sort();
          for (const path of start) {
            decoder
              .decode(files.get(path)!.data)
              .split("\n")
              .forEach((text, i) => {
                if (match(text)) out.push({ path, line: i + 1, text });
              });
          }
          return out;
        },
        async readdir(dir) {
          if (!isDir(dir)) throw enoent(dir);
          const prefix = `${norm(dir)}/`.replace(/^\/\/$/, "/");
          const entries = new Map<string, { data: Uint8Array; mtime: number } | null>();
          for (const [k, f] of files) {
            if (!k.startsWith(prefix)) continue;
            const rest = k.slice(prefix.length);
            const name = rest.split("/")[0]!;
            entries.set(name, rest.includes("/") ? null : f);
          }
          return [...entries].sort(([a], [b]) => a.localeCompare(b)).map(([name, f]) => ({
            name,
            size: f?.data.length ?? 0,
            mtime: f?.mtime ?? 0,
            isFile: f !== null,
            isDirectory: f === null,
            isSymbolicLink: false,
          }));
        },
      },
    };
  }
}
