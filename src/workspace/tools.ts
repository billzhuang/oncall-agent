import { createPiTools, type CreatePiToolsOptions } from "@cloudflare/computer/tools/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";

/** Where the repo is checked out; the agent's tool paths are relative to it. Computer's tools default here. */
export const WORKSPACE_ROOT = "/workspace";

/** The only workspace tools the agent gets: no exec, no git, no delete (spec: Code workspace). */
export const WORKSPACE_TOOLS = ["read", "ls", "find", "grep", "edit", "write"] as const;

/** `edit` applies a diff to whatever is there, so rerunning it after a restart could apply it twice. */
const REPLAY_SAFE = new Set(["read", "ls", "find", "grep", "write"]);

type WorkspaceLike = CreatePiToolsOptions["workspace"];

/**
 * Computer's pi tools over `workspace`, rooted at `WORKSPACE_ROOT`, as pi-durable tools. Shared by the real
 * workspace and the test one, so the model sees the same tools and the same refusals in both.
 *
 * Two layers keep the agent inside the checkout and out of any `.git` directory (the agent edits a checkout,
 * never the repository's metadata): each call's path-like arguments are checked in canonical form first, and the
 * tools run over a filesystem view (`guarded`) that refuses every target outside the root or under a `.git`, and
 * leaves `.git` entries and symbolic links out of listings, find and grep.
 */
export function workspaceTools(workspace: WorkspaceLike): ToolRegistration[] {
  const allowed = new Set<string>(WORKSPACE_TOOLS);
  const { tools, execute } = createPiTools({ workspace: guarded(workspace), root: WORKSPACE_ROOT, exec: {}, assets: false });
  return tools
    .filter((tool) => allowed.has(tool.name))
    .map(
      (tool): ToolRegistration => ({
        name: tool.name,
        description: tool.description,
        parameters: Type.Unsafe(tool.parameters),
        replay: REPLAY_SAFE.has(tool.name) ? "safe" : "unsafe",
        async execute(args, api, context) {
          const refused = refusedArguments(args);
          if (refused) return { output: [{ type: "text", text: refused }], isError: true };
          const result = await execute({ id: api.callId, name: tool.name, arguments: args }, { abortSignal: context.abortSignal });
          return { output: result.content, isError: result.isError };
        },
      }),
    );
}

/** The path segments of `path` relative to the workspace root, resolved; undefined when it leaves the root. */
function segments(path: string): string[] | undefined {
  let relative = path;
  if (path.startsWith("/")) {
    if (path !== WORKSPACE_ROOT && !path.startsWith(`${WORKSPACE_ROOT}/`)) return undefined;
    relative = path.slice(WORKSPACE_ROOT.length);
  }
  const parts: string[] = [];
  for (const part of relative.split(/[\\/]+/)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.pop() === undefined) return undefined;
      continue;
    }
    parts.push(part);
  }
  return parts;
}

const isGitSegment = (part: string) => part.toLowerCase() === ".git";

/** Why a target is refused, or undefined when it is inside the root and under no `.git`. */
function refusedTarget(path: string): string | undefined {
  const parts = segments(path);
  if (!parts) return `Path is outside the workspace: ${path}`;
  if (parts.some(isGitSegment)) return `Path is inside .git, which the agent may not use: ${path}`;
  return undefined;
}

/** Why a tool call's path-like arguments are refused (path, find's pattern, grep's include/exclude globs). */
function refusedArguments(args: unknown): string | undefined {
  const fields = (args ?? {}) as Record<string, unknown>;
  if (fields.path !== undefined) {
    if (typeof fields.path !== "string") return "path must be a string";
    const refused = refusedTarget(fields.path);
    if (refused) return refused;
  }
  for (const key of ["pattern", "include", "exclude"]) {
    const globs = ([] as unknown[]).concat(fields[key] ?? []);
    for (const glob of globs) {
      if (typeof glob !== "string") continue;
      const parts = glob.split(/[\\/]+/);
      if (parts.includes("..")) return `${key} may not climb out of the workspace: ${glob}`;
      if (parts.some(isGitSegment)) return `${key} may not reach into .git: ${glob}`;
    }
  }
  return undefined;
}

function refusal(path: string, reason: string): Error {
  return Object.assign(new Error(reason), { code: "EACCES", path });
}

/**
 * `workspace`'s filesystem as the agent's tools may see it: every operation on a target outside the root or under
 * a `.git` fails, and `.git` entries and symbolic links never appear in readdir, find or grep results, so nothing
 * in the repository metadata (or reached through a link) is ever shown to the model.
 */
function guarded(workspace: WorkspaceLike): WorkspaceLike {
  const fs = workspace.fs;
  const check = (path: string) => {
    const refused = refusedTarget(path);
    if (refused) throw refusal(path, refused);
  };
  const visible = (path: string) => refusedTarget(path) === undefined;
  return {
    ...workspace,
    fs: {
      stat: async (path) => (check(path), fs.stat(path)),
      readFile: async (path, options) => (check(path), fs.readFile(path, options)),
      writeFile: async (path, content, options) => (check(path), fs.writeFile(path, content, options)),
      mkdir: async (path, options) => (check(path), fs.mkdir(path, options)),
      rm: async (path, options) => (check(path), fs.rm(path, options)),
      readdir: async (path, options) => {
        check(path);
        return (await fs.readdir(path, options)).filter((e) => !isGitSegment(e.name) && !e.isSymbolicLink);
      },
      find: async (directory, pattern, options) => {
        check(directory);
        return (await fs.find(directory, pattern, options)).filter((e) => visible(e.path));
      },
      grep: async (pattern, path, options) => {
        check(path);
        return (await fs.grep(pattern, path, options)).filter((m) => visible(m.path));
      },
    },
  };
}
