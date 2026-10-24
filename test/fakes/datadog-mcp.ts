import type { FakeService } from "./router";

// Skeleton (#11): nothing calls Datadog MCP yet. #2 registers canned tools per Org; #6 adds git-tag lookups.

export type CannedTool = { name: string; description?: string; result: (args: any) => unknown };

/**
 * In-test Datadog MCP server (Streamable HTTP, JSON responses only) at mcp.datadoghq.eu.
 * Each Org is identified by the Bearer token (its Service Access Token) and has its own canned tools.
 */
export function fakeDatadogMcp() {
  const orgs = new Map<string, CannedTool[]>();
  const calls: Array<{ token: string; tool: string; args: unknown }> = [];
  const service: FakeService = {
    async handle(request) {
      const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
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
              inputSchema: { type: "object", properties: {} },
            })),
          });
        case "tools/call": {
          calls.push({ token, tool: msg.params.name, args: msg.params.arguments });
          const tool = tools.find((t) => t.name === msg.params.name);
          if (!tool) return reply({ isError: true, content: [{ type: "text", text: "unknown tool" }] });
          return reply({ content: [{ type: "text", text: JSON.stringify(tool.result(msg.params.arguments)) }] });
        }
        default:
          return Response.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
      }
    },
  };
  return {
    ...service,
    calls,
    /** Register an Org by its Service Access Token, with its canned tools. */
    org(token: string, tools: CannedTool[]) {
      orgs.set(token, tools);
    },
  };
}
export type FakeDatadogMcp = ReturnType<typeof fakeDatadogMcp>;
