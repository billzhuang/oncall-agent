import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { McpClient, StreamableHttpTransport, toLlmContent, type Tool } from "@earendil-works/pi-mcp";
import { secret, type Org } from "./config";
import { ports } from "./ports";

/** Prefix of the agent's Datadog tools, so they never collide with the harness's own tools. */
export const DATADOG_TOOL_PREFIX = "datadog_";

/** A Datadog MCP tool as listed by the server, kept so tools can be re-registered without a round trip. */
export interface DatadogToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The Org's Datadog MCP endpoint: one per Datadog site (EU1: https://mcp.datadoghq.eu/v1/mcp). */
export function datadogMcpUrl(org: Org): string {
  return `https://mcp.${org.site}/v1/mcp`;
}

/** Read-only: on the allowlist, and not marked by the server as a write or destructive tool. */
function readOnly(tool: Tool, allowlist: readonly string[]): boolean {
  return (
    allowlist.includes(tool.name) && tool.annotations?.readOnlyHint !== false && tool.annotations?.destructiveHint !== true
  );
}

/**
 * One Org's Datadog MCP connection, reached only with that Org's Service Access Token. Connects lazily and
 * reconnects after a failure. Belongs to one Investigation, so one Org.
 */
export class DatadogConnection {
  #client: Promise<McpClient> | undefined;

  constructor(
    private readonly env: Env,
    private readonly org: () => Promise<Org>,
  ) {}

  /** The Org's read-only tools, as listed by its Datadog MCP server and filtered by the allowlist. */
  async listReadOnlyTools(allowlist: readonly string[]): Promise<DatadogToolSpec[]> {
    const tools = await this.#use((client) => client.listTools());
    return tools
      .filter((tool) => readOnly(tool, allowlist))
      .map((tool) => ({ name: tool.name, description: tool.description ?? tool.name, inputSchema: tool.inputSchema }));
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    return this.#use((client) => client.callTool(name, args, { signal }));
  }

  async close(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    if (client) await client.then((c) => c.close()).catch(() => {});
  }

  async #use<T>(work: (client: McpClient) => Promise<T>): Promise<T> {
    this.#client ??= this.#connect();
    try {
      return await work(await this.#client);
    } catch (error) {
      await this.close(); // reconnect on the next use
      throw error;
    }
  }

  async #connect(): Promise<McpClient> {
    const org = await this.org();
    const token = secret(this.env, org.tokenSecret);
    if (!token) throw new Error(`Worker secret ${org.tokenSecret} (Datadog token of Org ${org.name}) is not set`);
    const client = new McpClient({ name: "oncall-agent", version: "1.0.0" });
    await client.connect(
      new StreamableHttpTransport({
        url: datadogMcpUrl(org),
        headers: { Authorization: `Bearer ${token}` },
        fetch: (input, init) => ports().fetch(input, init),
        openGetStream: false,
      }),
    );
    return client;
  }
}

/** Wraps the Org's Datadog MCP tools as pi tools. Read-only, so a replay after eviction may simply re-run them. */
export function datadogTools(specs: readonly DatadogToolSpec[], connection: DatadogConnection): ToolRegistration[] {
  return specs.map(
    (spec): ToolRegistration => ({
      name: `${DATADOG_TOOL_PREFIX}${spec.name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64),
      description: spec.description,
      parameters: Type.Unsafe({
        ...spec.inputSchema,
        type: "object",
        properties: (spec.inputSchema.properties as Record<string, unknown> | undefined) ?? {},
      }),
      replay: "safe",
      async execute(args, _api, context) {
        const result = await connection.callTool(spec.name, (args ?? {}) as Record<string, unknown>, context.abortSignal);
        return { output: toLlmContent(result), isError: result.isError === true };
      },
    }),
  );
}
