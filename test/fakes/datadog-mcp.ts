import type { FakeService } from "./router";

export interface CannedTool {
  name: string;
  description?: string;
  annotations?: Record<string, unknown>;
  /** The tool's answer; may be async (e.g. to block until the test releases it). */
  result: (args: any) => unknown;
}

/** One request the fake received, whether or not it was authorized. */
export interface DatadogRequest {
  token: string;
  path: string;
  method: string;
}

/** Source code integration git tags of a service, as its spans carry them. */
export interface GitTags {
  repositoryUrl: string;
  commitSha: string;
}

/** The deployed commit every service reports unless a test says otherwise. */
export const DEFAULT_COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";

/** Default git tags: every service lives in `github.com/acme/<service>`, which the fake GitHub App covers. */
export const defaultGitTags = (service: string): GitTags => ({
  repositoryUrl: `github.com/acme/${service}`,
  commitSha: DEFAULT_COMMIT_SHA,
});

/** The span search the harness uses for repo resolution; served even when an Org's canned tools omit it. */
const SPANS_TOOL = "search_datadog_spans";

/** Datadog MCP endpoint path (host mcp.datadoghq.eu). */
const MCP_PATH = "/v1/mcp";

/**
 * In-test Datadog MCP server (Streamable HTTP, JSON responses only) at mcp.datadoghq.eu/v1/mcp.
 * Each Org is identified by the Bearer token (its Service Access Token) and has its own canned tools.
 * Span searches an Org's canned tools do not cover are answered from a per-Org source code store (services and
 * their git tags), recorded in `spanSearches` rather than `calls`.
 */
export function fakeDatadogMcp() {
  const orgs = new Map<string, CannedTool[]>();
  const calls: Array<{ token: string; tool: string; args: unknown }> = [];
  const spanSearches: Array<{ token: string; args: any }> = [];
  /** Per Org token, per service: git tags, or null for a service whose spans carry none. */
  const sourceCode = new Map<string, Map<string, GitTags | null>>();
  /** Spans of the queried service, newest first, with the service's git tags (if any) among the span tags. */
  const spans = (token: string, args: any) => {
    const service = String(args?.query ?? "").match(/(?:^|\s)service:(\S+)/)?.[1];
    if (!service) return { data: [] };
    const known = sourceCode.get(token)?.get(service);
    const git = known === undefined ? defaultGitTags(service) : known;
    const gitTags = git ? [`git.repository_url:${git.repositoryUrl}`, `git.commit.sha:${git.commitSha}`] : [];
    return { data: [{ service, resource_name: "GET /checkout", tags: [`service:${service}`, "env:prod", ...gitTags] }] };
  };
  const requests: DatadogRequest[] = [];
  let down = false;
  const service: FakeService = {
    async handle(request) {
      const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      const path = new URL(request.url).pathname;
      requests.push({ token, path, method: request.method });
      if (down) return new Response("service unavailable", { status: 503 });
      if (path !== MCP_PATH) return new Response("not found", { status: 404 });
      const tools = orgs.get(token);
      if (!tools) return new Response("unauthorized", { status: 401 });
      if (request.method === "GET") return new Response(null, { status: 405 });
      if (request.method === "DELETE") return new Response(null, { status: 200 });
      const msg = (await request.json()) as any;
      if (msg.id === undefined) return new Response(null, { status: 202 }); // notification
      const reply = (result: unknown) =>
        Response.json({ jsonrpc: "2.0", id: msg.id, result }, { headers: { "mcp-session-id": `session-${token}` } });
      switch (msg.method) {
        case "initialize":
          return reply({
            protocolVersion: msg.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "fake-datadog-mcp", version: "0" },
          });
        case "tools/list":
          return reply({
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description ?? t.name,
              inputSchema: { type: "object", properties: { query: { type: "string" } } },
              ...(t.annotations ? { annotations: t.annotations } : {}),
            })),
          });
        case "tools/call": {
          const tool = tools.find((t) => t.name === msg.params.name);
          if (!tool && msg.params.name === SPANS_TOOL) {
            spanSearches.push({ token, args: msg.params.arguments });
            return reply({ content: [{ type: "text", text: JSON.stringify(spans(token, msg.params.arguments)) }] });
          }
          calls.push({ token, tool: msg.params.name, args: msg.params.arguments });
          if (!tool) return reply({ isError: true, content: [{ type: "text", text: "unknown tool" }] });
          const result = await tool.result(msg.params.arguments);
          return reply({ content: [{ type: "text", text: JSON.stringify(result) }] });
        }
        default:
          return Response.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
      }
    },
  };
  return {
    ...service,
    calls,
    spanSearches,
    requests,
    /** Sets a service's source code integration git tags in one Org (by token); null: its spans carry none. */
    gitTags(token: string, service: string, tags: GitTags | null) {
      if (!sourceCode.has(token)) sourceCode.set(token, new Map());
      sourceCode.get(token)!.set(service, tags);
    },
    /** Register an Org by its Service Access Token, with its canned tools (replacing any before). */
    org(token: string, tools: CannedTool[]) {
      orgs.set(token, tools);
    },
    /** Takes the whole Datadog MCP endpoint down (503 to everything) or brings it back. */
    setDown(value: boolean) {
      down = value;
    },
  };
}
export type FakeDatadogMcp = ReturnType<typeof fakeDatadogMcp>;

/** Write tools the real Datadog MCP server offers; the agent must never be able to call them. */
export const DATADOG_WRITE_TOOLS = ["create_datadog_monitor", "update_datadog_monitor", "delete_datadog_dashboard"];

/** A plausible Org: read tools with Org-specific canned answers, plus write tools. */
export function defaultDatadogTools(org: string): CannedTool[] {
  return [
    {
      name: "search_datadog_logs",
      description: "Search Datadog logs",
      result: () => ({ org, logs: [`${org}: NullPointerException in CheckoutController.placeOrder`] }),
    },
    { name: "get_datadog_metric", description: "Query a metric", result: () => ({ org, series: [0.01, 0.07, 0.09] }) },
    { name: "search_datadog_monitors", description: "Search monitors", result: () => ({ org, monitors: [] }) },
    ...DATADOG_WRITE_TOOLS.map((name) => ({ name, description: name, result: () => ({ org, written: true }) })),
  ];
}
