# Oncall Agent: Design

Terms in **bold** are defined in [GLOSSARY.md](../GLOSSARY.md). Key decisions: [ADR 0001](adr/0001-pi-durable-on-cloudflare-agents.md), [ADR 0002](adr/0002-harness-owns-github-writes.md).

## Flow

1. An **Opted-in monitor** (tag `oncall-agent:enabled`, added by its **Owning team**) in an EU1 **Org** enters Triggered and notifies `@webhook-oncall-agent`.
2. The Worker checks the per-Org secret header and that `$ORG_ID` is in the **Org registry**, then routes to the **Investigation** for that **Alert episode** `(org, monitor, group)`. Re-triggers join it; Recovered stops it. Only Triggered starts an Investigation.
3. The Investigation runs as pi-durable in the Cloudflare Agents SDK `PiHarness`, in a Durable Object with `jurisdiction: "eu"`. LLM: Workers AI `@cf/deepseek-ai/deepseek-v4.1-flash-1017` via the `env.AI` binding (model ID in config, no escalation in v1).
4. The agent reads Datadog through the Datadog MCP at `https://mcp.datadoghq.eu/v1/mcp`, one connection per Org, each with a read-only service account Service Access Token (90-day expiry).
5. The repo comes only from Datadog source code integration tags (`git.repository_url`, `git.commit.sha`).
   - No tags: **Unmapped service**. The Investigation report still goes out; the Owning team gets a "add git tags" reminder at most once per Org and service per 7 days. No PR.
   - GitHub App not installed on the repo: same, with a "repo not enabled" reminder at most once per repo per 7 days. No PR.
6. The harness clones the repo with the GitHub App into a native `@cloudflare/computer` workspace (no container). The agent reads code at the deployed commit and edits a branch cut from `main`; the PR notes any drift between the deployed commit and `main` in the files involved.
7. Outputs:
   - **Investigation report** to the Owning team's Teams channel (mapped from the monitor's `team` tag, falling back to a default channel), always.
   - **Agent PR**: a draft PR on an `oncall-agent/*` branch, only when the cause is traced to specific code. The harness pushes it; **Code owners** review it via CODEOWNERS; the repo's CI runs the tests. The agent never merges.
8. Crashes, timeouts and budget stops always post a "failed / partial: reason" Teams message.

## Guardrails

- Per Investigation: 30 minutes wall-clock and $3 (enforced by the harness from pi's cost tracking). Max 5 concurrent, extras queued.
- Daily budget $30; once reached, new Alert episodes get only a "budget exhausted, not investigated" notice until 00:00 UTC.
- Every outward action (branch push, PR, Teams message) is idempotent: it checks for an existing result first, because pi-durable may replay steps after resuming.
- No Datadog writes (MCP write access is disabled anyway).
- The agent has no GitHub credentials (ADR 0002).
- This repo is public: all secrets (Datadog tokens, GitHub App private key, Teams webhook URLs, per-Org webhook secrets) live in Worker secrets; the Org registry references them by name only.
- A daily scheduled check posts to the default Teams channel 14 days before any Datadog token expires. Rotation is a manual runbook until Datadog supports generic OIDC.

## Rollout

1. Pilot: SRE/infra team, `gap` Org, **Report-only mode**, about 2 weeks. Pilot services get source code integration tags (`DD_GIT_REPOSITORY_URL`, `DD_GIT_COMMIT_SHA`).
2. Enable Agent PRs for the pilot team.
3. Onboard further teams (opt-in tag on monitors, GitHub App installed on their repos).

## Cost (estimate)

About $0.20 per typical Investigation (~40 turns, ~85% cache hits), up to the $3 cap. Roughly $22/month at 100 Investigations, $115/month at 500, including the $5 Workers Paid base.

## Out of scope for v1

- Backup polling for lost webhooks (Datadog retries 5xx five times).
- GitHub MCP.
- Computer Container backend (planned upgrade if too many Agent PRs fail CI).
- A service-to-repo mapping file or monitor-tag repo override.
- Model escalation.
