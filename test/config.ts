// Test Org registry and the Worker-secret values behind it. Imported by vitest.config.ts (Node) to set
// miniflare bindings, and by tests. Keep it free of workerd-only imports.

/** Worker secrets as the tests see them. Teams URLs use https://teams.test/<channel> so posts can be attributed. */
export const TEST_SECRETS = {
  GAP_WEBHOOK_SECRET: "gap-webhook-secret",
  GAP_DATADOG_TOKEN: "gap-datadog-token",
  GAP_DEFAULT_TEAMS_URL: "https://teams.test/gap-default",
  WK_WEBHOOK_SECRET: "wk-webhook-secret",
  WK_DATADOG_TOKEN: "wk-datadog-token",
  WK_DEFAULT_TEAMS_URL: "https://teams.test/wk-default",
  TEAMS_SRE_URL: "https://teams.test/sre",
  TEAMS_PAYMENTS_URL: "https://teams.test/payments",
} as const;

/** Datadog org IDs ($ORG_ID) of the two test Orgs. */
export const GAP_ORG_ID = "1001";
export const WK_ORG_ID = "2002";

export const MODEL_ID = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";

/** The test GitHub App. Its key pair is generated per run in vitest.config.ts (private key as a Worker secret). */
export const GITHUB_APP_ID = "123456";

/** Raw ONCALL_CONFIG for tests; goes through the real parser. Shallow overrides per top-level key. */
export function testConfig(overrides: Record<string, unknown> = {}) {
  return {
    orgs: [
      {
        name: "gap",
        site: "datadoghq.eu",
        datadogOrgId: GAP_ORG_ID,
        tokenSecret: "GAP_DATADOG_TOKEN",
        tokenExpiresOn: "2027-06-01",
        webhookSecret: "GAP_WEBHOOK_SECRET",
        defaultTeamsSecret: "GAP_DEFAULT_TEAMS_URL",
      },
      {
        name: "wk",
        site: "datadoghq.eu",
        datadogOrgId: WK_ORG_ID,
        tokenSecret: "WK_DATADOG_TOKEN",
        tokenExpiresOn: "2027-06-01",
        webhookSecret: "WK_WEBHOOK_SECRET",
        defaultTeamsSecret: "WK_DEFAULT_TEAMS_URL",
      },
    ],
    teams: { sre: "TEAMS_SRE_URL", payments: "TEAMS_PAYMENTS_URL" },
    github: { appId: GITHUB_APP_ID, privateKeySecret: "GITHUB_APP_PRIVATE_KEY" },
    reportOnly: true,
    agentPrTeams: [],
    modelId: MODEL_ID,
    budgets: { investigationUsd: 3, investigationMinutes: 30, dailyUsd: 30, maxConcurrent: 5 },
    ...overrides,
  };
}
