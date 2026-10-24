import { z } from "zod";

/**
 * The NAME of a Worker secret, never its value: this repo is public. Secrets are set with
 * `wrangler secret put <NAME>` and looked up with `secret(env, name)`.
 */
const SecretName = z.string().regex(/^[A-Z][A-Z0-9_]*$/, "must be a Worker-secret name (UPPER_SNAKE_CASE)");

/** One Org in the Org registry. */
const OrgSchema = z.object({
  /** Our name for the Org; part of every Alert episode key, so no ':' allowed. */
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  /** Datadog site. v1 watches EU1 only. */
  site: z.literal("datadoghq.eu").default("datadoghq.eu"),
  /** Datadog's org ID: the `orgId` ($ORG_ID) the Org's webhook sends. */
  datadogOrgId: z.string().min(1),
  /** Worker secret holding the Org's read-only Service Access Token for Datadog MCP. */
  tokenSecret: SecretName,
  /** Expiry date (UTC, YYYY-MM-DD) of that token, for the token expiry warning. */
  tokenExpiresOn: z.iso.date(),
  /** Worker secret holding the per-Org webhook secret Datadog sends in the secret header. */
  webhookSecret: SecretName,
  /** Worker secret holding the Org's default Teams Workflows webhook URL. */
  defaultTeamsSecret: SecretName,
});

/**
 * Datadog MCP tools the agent may use: read-only tools only. Datadog's own MCP write access is disabled for the
 * Orgs' service accounts too; this allowlist is the agent-side guarantee. A tool the server marks as not
 * read-only is never exposed, even when listed here.
 */
export const DEFAULT_DATADOG_TOOLS = [
  "search_datadog_logs",
  "analyze_datadog_logs",
  "search_datadog_spans",
  "aggregate_spans",
  "get_datadog_trace",
  "search_datadog_metrics",
  "get_datadog_metric",
  "get_datadog_metric_context",
  "search_datadog_monitors",
  "search_datadog_events",
  "aggregate_events",
  "search_datadog_incidents",
  "get_datadog_incident",
  "search_datadog_dashboards",
  "get_datadog_dashboard",
  "search_datadog_hosts",
  "search_datadog_entities",
  "search_datadog_rum_events",
  "aggregate_rum_events",
  "get_change_stories",
  "search_datadog_error_tracking_issues",
  "get_datadog_error_tracking_issue",
  "analyze_datadog_error_tracking_errors",
  "search_watchdog_stories",
  "get_watchdog_story",
];

const ConfigSchema = z
  .object({
    orgs: z.array(OrgSchema).min(1),
    /** Owning team (the monitor's `team` tag value) -> Worker secret holding its Teams Workflows webhook URL. */
    teams: z.record(z.string().min(1), SecretName).default({}),
    /** Report-only mode: `global`, overridden per Owning team where `teams` names it. */
    reportOnly: z
      .object({
        global: z.boolean().default(true),
        teams: z.record(z.string().min(1), z.boolean()).default({}),
      })
      .prefault({}),
    /** Workers AI model ID. */
    modelId: z.string().min(1).default("@cf/deepseek-ai/deepseek-v4.1-flash-1017"),
    datadog: z
      .object({
        /** Allowlist of read-only Datadog MCP tool names offered to the agent. */
        tools: z.array(z.string().min(1)).default(DEFAULT_DATADOG_TOOLS),
      })
      .prefault({}),
    budgets: z
      .object({
        investigationUsd: z.number().positive().default(3),
        investigationMinutes: z.number().positive().default(30),
        dailyUsd: z.number().positive().default(30),
        maxConcurrent: z.number().int().positive().default(5),
      })
      .prefault({}),
  })
  .superRefine((config, ctx) => {
    const names = new Set<string>();
    const ids = new Set<string>();
    for (const org of config.orgs) {
      if (names.has(org.name)) ctx.addIssue({ code: "custom", message: `duplicate Org name ${org.name}` });
      if (ids.has(org.datadogOrgId)) ctx.addIssue({ code: "custom", message: `duplicate Datadog org ID ${org.datadogOrgId}` });
      names.add(org.name);
      ids.add(org.datadogOrgId);
    }
  });

export type OncallConfig = z.infer<typeof ConfigSchema>;
export type Org = OncallConfig["orgs"][number];

/** Validates ONCALL_CONFIG. Throws on an invalid config: better to fail loudly than to drop alerts silently. */
export function parseConfig(raw: unknown): OncallConfig {
  return ConfigSchema.parse(raw);
}

/** The Org whose webhook carries this Datadog org ID, if it is in the Org registry. */
export function orgByDatadogId(config: OncallConfig, datadogOrgId: string): Org | undefined {
  return config.orgs.find((o) => o.datadogOrgId === datadogOrgId);
}

export function orgByName(config: OncallConfig, name: string): Org | undefined {
  return config.orgs.find((o) => o.name === name);
}

/** Reads a Worker secret by name. Undefined when the secret is not set. */
export function secret(env: Env, name: string): string | undefined {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}
