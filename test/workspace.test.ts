import { abortAllDurableObjects, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  alertPayload,
  cleanUp,
  gate,
  installFakes,
  investigationOf,
  sendWebhook,
  settle,
  uniqueMonitorId,
  type Fakes,
} from "./harness";
import { TEST_SECRETS } from "./config";
import { defaultDatadogTools } from "./fakes/datadog-mcp";
import { toolCall, type Script, type Transcript } from "./fakes/model";

let fakes: Fakes;
beforeEach(() => {
  fakes = installFakes();
});
afterEach(cleanUp);

const DEPLOYED = "4f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39";
const CONTROLLER = [
  "export function checkout(customer) {",
  "  const total = cart.total;",
  "  return customer.id + total; // customer may be null",
  "}",
  "",
].join("\n");

/** A service whose spans carry git tags for `acme/<service>` at DEPLOYED, with that commit as a repo fixture. */
function deployedService(files: Record<string, string> = { "src/checkout.ts": CONTROLLER, "README.md": "# checkout\n" }) {
  const service = `svc-${uniqueMonitorId()}`;
  fakes.datadog.gitTags(TEST_SECRETS.GAP_DATADOG_TOKEN, service, {
    repositoryUrl: `https://github.com/acme/${service}.git`,
    commitSha: DEPLOYED,
  });
  fakes.workspace.repo(`acme/${service}`, DEPLOYED, files);
  return service;
}

function alertFor(service: string) {
  return alertPayload({
    group: `service:${service},env:prod`,
    tags: ["oncall-agent:enabled", "team:sre", `service:${service}`],
  });
}

const reports = () => fakes.teams.posts.filter((p) => p.text.startsWith("Investigation report:"));
/** Teams text with escapes and dot defanging read past. */
const shown = (text: string) => text.replace(/\\(.)/g, "$1").replace(/\[\.\]/g, ".");

/**
 * Runs `calls` against the workspace one per model turn (stateless: counts the tool results so far), then submits
 * a report whose evidence is every tool result the agent saw.
 */
function workspaceScript(calls: Array<[string, Record<string, unknown>]>): Script {
  return (t: Transcript) => {
    const results = t.messages.filter((m) => m.role === "toolResult");
    if (results.length < calls.length) {
      const [name, args] = calls[results.length]!;
      return toolCall(name, args);
    }
    return toolCall("submit_report", {
      whatFired: "Error rate on checkout above 5%",
      evidence: results.map((r) => `${r.toolName}: ${textOfResult(r.content)}`),
      suspectedCause: "src/checkout.ts:3 dereferences a null customer",
    });
  };
}
function textOfResult(content: unknown): string {
  return Array.isArray(content) ? content.map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : "")).join("") : String(content);
}
/** Every tool result the model was shown, by tool name. */
function toolResults(name: string): Array<{ text: string; isError: boolean }> {
  const seen = new Map<string, { text: string; isError: boolean }>();
  for (const request of fakes.model.requests) {
    for (const m of request.messages) {
      if (m.role === "toolResult" && m.toolName === name) seen.set(m.toolCallId, { text: textOfResult(m.content), isError: m.isError });
    }
  }
  return [...seen.values()];
}

describe("Code workspace", () => {
  it("checks out the deployed commit and lets the agent read it; the report cites the file and line", async () => {
    const service = deployedService();
    fakes.model.script(workspaceScript([["read", { path: "src/checkout.ts" }]]));

    await sendWebhook(alertFor(service));

    await vi.waitFor(() => expect(reports()).toHaveLength(1));
    expect(fakes.workspace.checkouts).toMatchObject([{ owner: "acme", repo: service, sha: DEPLOYED }]);
    const [read] = toolResults("read");
    expect(read!.isError).toBe(false);
    expect(read!.text).toContain("return customer.id + total; // customer may be null");
    const report = shown(reports()[0]!.text);
    expect(report).toContain("src/checkout.ts:3");
    expect(report).toContain("customer may be null");
  });

  it("mints an installation token scoped to the one repo, read-only, and uses it only to clone", async () => {
    const service = deployedService();
    fakes.model.script(workspaceScript([["read", { path: "src/checkout.ts" }], ["ls", { path: "." }]]));

    await sendWebhook(alertFor(service));

    await vi.waitFor(() => expect(reports()).toHaveLength(1));
    expect(fakes.github.tokens).toHaveLength(1);
    const [issued] = fakes.github.tokens;
    expect(issued).toMatchObject({ repositories: [service], permissions: { contents: "read" } });
    expect(Object.keys(issued!.permissions)).toEqual(["contents"]);
    expect(fakes.github.jwtErrors).toEqual([]);
    expect(fakes.workspace.checkouts.map((c) => c.token)).toEqual([issued!.token]);

    // The token never reaches the model, Teams or Datadog.
    expect(JSON.stringify(fakes.model.requests)).not.toContain(issued!.token);
    expect(JSON.stringify(fakes.teams.posts)).not.toContain(issued!.token);
    expect(JSON.stringify(fakes.datadog.calls)).not.toContain(issued!.token);
    expect(fakes.workspace.text()).not.toContain(issued!.token);
  });

  it("gives the agent only read, ls, find, grep, edit and write on the workspace: no exec, no git, no delete", async () => {
    const service = deployedService();
    fakes.model.script(workspaceScript([["ls", { path: "." }]]));

    await sendWebhook(alertFor(service));

    await vi.waitFor(() => expect(reports()).toHaveLength(1));
    const offered = new Set(fakes.model.requests.flatMap((r) => r.tools));
    const workspaceTools = [...offered].filter((t) => !t.startsWith("datadog_") && t !== "submit_report").sort();
    expect(workspaceTools).toEqual(["edit", "find", "grep", "ls", "read", "write"]);
  });

  it("refuses paths outside the workspace and inside .git", async () => {
    const service = deployedService();
    fakes.model.script(
      workspaceScript([
        ["read", { path: "../../etc/passwd" }],
        ["read", { path: "/etc/passwd" }],
        ["write", { path: "../outside.txt", content: "x" }],
        ["read", { path: ".git/config" }],
        ["read", { path: "./.git/config" }],
        ["read", { path: "src/../.git/config" }],
        ["read", { path: ".GIT/config" }],
        ["read", { path: "/workspace/.git/HEAD" }],
        ["write", { path: ".git/hooks/post-checkout", content: "#!/bin/sh\necho pwned\n" }],
        ["edit", { path: "src/../.git/config", edits: [{ oldText: "url", newText: "pushurl" }] }],
        ["ls", { path: ".git" }],
        ["grep", { query: "token", path: "../" }],
        ["grep", { query: "remote", path: ".git" }],
        ["find", { pattern: ".git/**" }],
        ["find", { path: "src", pattern: "../.git/*" }],
      ]),
    );
    const alert = alertFor(service);

    await sendWebhook(alert);

    await vi.waitFor(() => expect(reports()).toHaveLength(1));
    const results = ["read", "write", "edit", "ls", "grep", "find"].flatMap(toolResults);
    expect(results).toHaveLength(15);
    for (const result of results) expect(result.isError).toBe(true);
    expect(await fakes.workspace.of(investigationOf(alert).id.toString()).changes()).toEqual([]);
    expect(fakes.workspace.text()).not.toContain("pwned");
    expect(fakes.workspace.text()).not.toContain("pushurl");
  });

  it("never shows .git in listings, find or grep, and the token is in no file or tool output", async () => {
    const service = deployedService();
    const token = () => fakes.github.tokens[0]?.token ?? "no token minted";
    const script = workspaceScript([
      ["ls", { path: "." }],
      ["find", { pattern: "**/*" }],
      ["find", { pattern: "**/config" }],
      ["grep", { query: "remote" }],
      ["grep", { query: "github.com" }],
      ["grep", { query: "x-access-token" }],
    ]);
    // Last, the agent greps for the token itself (the test knows it; the agent never could).
    fakes.model.script((t) => {
      const seen = t.messages.filter((m) => m.role === "toolResult").length;
      return seen === 6 ? toolCall("grep", { query: token() }) : script(t);
    });
    const alert = alertFor(service);

    await sendWebhook(alert);

    await vi.waitFor(() => expect(reports()).toHaveLength(1));
    expect(fakes.workspace.text()).toContain("[remote"); // the clone did write repository metadata
    const outputs = ["ls", "find", "grep"].flatMap(toolResults);
    expect(outputs).toHaveLength(7);
    for (const output of outputs) {
      expect(output.isError).toBe(false);
      expect(output.text).not.toMatch(/\.git\b(?!hub)/i);
    }
    const tokenSearch = outputs.pop()!; // echoes its query, and finds nothing
    expect(JSON.parse(tokenSearch.text)).toMatchObject({ count: 0, matches: [] });
    for (const output of outputs) expect(output.text).not.toContain(token());
    expect(toolResults("find")[0]!.text).toContain("src/checkout.ts");
    expect(fakes.workspace.text()).not.toContain(token());
  });

  it("keeps the agent's edits in the workspace as changes against the deployed commit", async () => {
    const service = deployedService();
    fakes.model.script(
      workspaceScript([
        ["edit", { path: "src/checkout.ts", edits: [{ oldText: "return customer.id + total;", newText: "return (customer?.id ?? 0) + total;" }] }],
        ["write", { path: "src/guard.ts", content: "export const guard = true;\n" }],
        ["find", { pattern: "**/*.ts" }],
        ["grep", { query: "customer?.id" }],
      ]),
    );
    const alert = alertFor(service);

    await sendWebhook(alert);

    await vi.waitFor(() => expect(reports()).toHaveLength(1));
    expect(toolResults("find")[0]!.text).toContain("src/guard.ts");
    expect(toolResults("grep")[0]!.text).toContain("src/checkout.ts");
    const changes = await fakes.workspace.of(investigationOf(alert).id.toString()).changes();
    expect(changes).toEqual([
      { path: "src/checkout.ts", content: CONTROLLER.replace("return customer.id + total;", "return (customer?.id ?? 0) + total;") },
      { path: "src/guard.ts", content: "export const guard = true;\n" },
    ]);
  });

  it("checks out no code and mints no token for an Unmapped service or a repo not enabled", async () => {
    const unmapped = `svc-${uniqueMonitorId()}`;
    fakes.datadog.gitTags(TEST_SECRETS.GAP_DATADOG_TOKEN, unmapped, null);
    const notEnabled = `svc-${uniqueMonitorId()}`;
    fakes.datadog.gitTags(TEST_SECRETS.GAP_DATADOG_TOKEN, notEnabled, {
      repositoryUrl: `https://github.com/someone-else/${notEnabled}`,
      commitSha: DEPLOYED,
    });

    await sendWebhook(alertFor(unmapped));
    await sendWebhook(alertFor(notEnabled));

    await vi.waitFor(() => expect(reports()).toHaveLength(2));
    expect(fakes.github.tokens).toEqual([]);
    expect(fakes.workspace.checkouts).toEqual([]);
    const offered = new Set(fakes.model.requests.flatMap((r) => r.tools));
    expect(offered.has("read")).toBe(false);
  });

  it("reports that the code could not be read when the checkout fails, and still investigates", async () => {
    const service = `svc-${uniqueMonitorId()}`;
    fakes.datadog.gitTags(TEST_SECRETS.GAP_DATADOG_TOKEN, service, {
      repositoryUrl: `https://github.com/acme/${service}`,
      commitSha: DEPLOYED,
    });
    fakes.workspace.unavailable(`acme/${service}`);

    await sendWebhook(alertFor(service));

    await vi.waitFor(() => expect(reports()).toHaveLength(1));
    const [issued] = fakes.github.tokens;
    const report = reports()[0]!.text;
    expect(report).toContain("could not be checked out");
    expect(report).not.toContain(issued!.token);
    expect(new Set(fakes.model.requests.flatMap((r) => r.tools)).has("read")).toBe(false);
  });

  it("keeps the workspace and its tools after eviction, without a second checkout or token", async () => {
    const service = deployedService();
    const held = gate();
    let searches = 0;
    fakes.datadog.org(TEST_SECRETS.GAP_DATADOG_TOKEN, [
      ...defaultDatadogTools("gap").filter((t) => t.name !== "search_datadog_logs"),
      {
        name: "search_datadog_logs",
        result: async () => {
          searches++;
          await held.opened;
          return { logs: ["NullPointerException in checkout"] };
        },
      },
    ]);
    fakes.model.script(
      workspaceScript([
        ["datadog_search_datadog_logs", { query: `service:${service}` }],
        ["read", { path: "src/checkout.ts" }],
      ]),
    );
    const alert = alertFor(service);
    await sendWebhook(alert);
    await vi.waitFor(() => expect(searches).toBe(1));

    await abortAllDurableObjects(); // evicted while the Datadog call is in flight
    held.open();
    await vi.waitFor(
      async () => {
        await runDurableObjectAlarm(investigationOf(alert));
        expect(reports()).toHaveLength(1);
      },
      { timeout: 15_000, interval: 200 },
    );

    expect(toolResults("read").at(-1)!.text).toContain("customer may be null");
    expect(fakes.workspace.checkouts).toHaveLength(1);
    expect(fakes.github.tokens).toHaveLength(1);
    await settle();
    expect(reports()).toHaveLength(1);
  });
});
