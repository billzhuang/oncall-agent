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

/** Datadog MCP endpoint path (host mcp.datadoghq.eu). */
const MCP_PATH = "/v1/mcp";

/**
 * In-test Datadog MCP server (Streamable HTTP, JSON responses only) at mcp.datadoghq.eu/v1/mcp.
 * Each Org is identified by the Bearer token (its Service Access Token) and has its own canned tools.
 */
export function fakeDatadogMcp() {
  const orgs = new Map<string, CannedTool[]>();
  const calls: Array<{ token: string; tool: string; args: unknown }> = [];
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
          calls.push({ token, tool: msg.params.name, args: msg.params.arguments });
          const tool = tools.find((t) => t.name === msg.params.name);
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
    requests,
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
