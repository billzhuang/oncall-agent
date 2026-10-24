# Oncall Agent: Design

Terms in **bold** are defined in [GLOSSARY.md](../GLOSSARY.md). Key decisions: [ADR 0001](adr/0001-pi-durable-on-cloudflare-agents.md), [ADR 0002](adr/0002-harness-owns-github-writes.md).

## Flow

1. An **Opted-in monitor** (tag `oncall-agent:enabled`, added by its **Owning team**) in an EU1 **Org** enters Triggered and notifies `@webhook-oncall-agent`.
2. The Worker checks the per-Org secret header and that `$ORG_ID` is in the **Org registry**, then routes to the **Investigation** for that **Alert episode** `(org, monitor, group)`. Re-triggers join it; Recovered stops it. Only Triggered starts an Investigation.
   - One Durable Object per monitor group `(org, monitor, group)` hosts its successive Alert episodes, one at a time, each with its own Investigation and outbox. A later episode therefore finds the group's Agent PR branch and open Agent PR, to update or link it.
3. The Investigation runs as pi-durable in the Cloudflare Agents SDK `PiHarness`, in a Durable Object with `jurisdiction: "eu"`. LLM: Workers AI `@cf/deepseek-ai/deepseek-v4.1-flash-1017` via the `env.AI` binding (model ID in config, no escalation in v1). `createAI({ binding })` routes through the account's AI Gateway named `default` (Cloudflare creates it on first use); verified in `agents@0.30.1` source (`resolveOptions` sets `gateway.id ?? "default"`), not yet in production.
4. The agent reads Datadog through the Datadog MCP at `https://mcp.datadoghq.eu/v1/mcp`, one connection per Org, each with a read-only service account Service Access Token (90-day expiry).
5. The repo comes only from Datadog source code integration tags (`git.repository_url`, `git.commit.sha`), read from a span's reserved tag list only (never attribute maps, which application code can set).
   - **Unmapped service** (no tags, the service's spans disagree on repo or commit, or the monitor names no service): the Investigation report still goes out, and the Owning team gets a reminder saying what to fix, at most once per Org and service per 7 days (per Org and monitor when there is no service). No PR.
   - Repo not enabled (not on GitHub, GitHub App not installed, or an owner the Org does not allow): same, with a "repo not enabled" reminder at most once per repo per 7 days (per Org and repo for a disallowed owner). No PR.
   - An Org may list `allowedRepoOwners` (GitHub owners). A repo of any other owner is repo not enabled, decided before any GitHub call: nothing is looked up, cloned or minted for it, even if the GitHub App is installed there.
6. The harness clones the repo with the GitHub App into a native `@cloudflare/computer` workspace (no container). The agent reads code at the deployed commit and edits it there; the harness commits the edits on a branch cut from `main`. If any file the agent changed differs between the deployed commit and `main`, no Agent PR is opened or updated (the edits would undo `main`'s changes); the report lists the drifted files.
7. Outputs:
   - **Investigation report** to the Owning team's Teams channel (mapped from the monitor's `team` tag, falling back to a default channel), always. It links the monitor group's open Agent PR whenever one exists, also from a later Alert episode that proposed no fix.
   - **Agent PR**: a draft PR on an `oncall-agent/*` branch, only when the cause is traced to specific code. The harness pushes it; **Code owners** review it via CODEOWNERS; the repo's CI runs the tests. The agent never merges.
8. Crashes post a "failed: reason" message. Timeouts and the cost cap post a partial Investigation report in the normal format: what fired, the evidence gathered so far (newest first, bounded) and "cause not determined (stopped: reason)". The daily budget posts a "budget exhausted, not investigated" notice.
9. Teams posting is at-least-once. Teams webhooks take no idempotency key, so the outbox records the intent before the send and marks it sent after; a crash or lost answer in between re-sends on replay. A duplicate message is possible, a lost one is not.

## Guardrails

- Per Investigation: 30 minutes wall-clock and $3 (enforced by the harness from pi's cost tracking). Max 5 concurrent, extras queued.
- Daily budget $30; once reached, new Alert episodes get only a "budget exhausted, not investigated" notice until 00:00 UTC. The budget fails closed: each running Investigation holds the full $3 cap against the day up front, replaced by its recorded spend when it finishes, so a day near its budget skips new episodes a little early rather than overspend. An Investigation that never finishes stays charged the cap. Kept as is by decision.
- Every outward action (branch push, PR, PR comment, Teams message) checks for an existing result first, because pi-durable may replay steps after resuming. Teams messages are at-least-once (Flow 9).
- No Datadog writes (MCP write access is disabled anyway).
- The agent has no GitHub credentials (ADR 0002). For an Agent PR the harness mints a token for the one repo with `contents:write` and `pull_requests:write` only, and writes only `oncall-agent/*` branches (one per monitor group, so a later Alert episode updates the open Agent PR). Linking an earlier episode's Agent PR uses a `pull_requests:read` token.
- The harness never forces over commits it did not push. It keeps the commit it last pushed to the group's branch; right before every push (replays included) the branch must still point there or not exist, and the move is a compare-and-swap (GraphQL `updateRefs` with `beforeOid`), so a commit pushed in between makes GitHub refuse it. Otherwise the branch is left alone, the open Agent PR gets one comment per Alert episode ("fix not pushed: the branch has commits not made by the oncall agent"), and the report says so.
- An Agent PR never changes protected paths: CI config, build entry points, scripts, dependency manifests and lockfiles, CODEOWNERS (default list in `src/config.ts`, `github.protectedPaths`). A pushed branch runs the repo's CI with its secrets, so a fix touching any of them gets no PR; the report lists the paths. A repo may also set `github.repos["owner/name"].allowedPathPrefixes`, outside which nothing is pushed. This narrows but cannot close the CI-secrets risk (ADR 0002).
- Fork or same-repo Agent PRs: decision pending. v1 keeps same-repo `oncall-agent/*` branches plus the protected-paths deny-list. The repo, and likely the target repos' GitHub App, will soon move to an enterprise GitHub organization; the fork decision is taken with that move (the enterprise's fork policy for private repos may decide it), and before the global Report-only switch is turned off for any team.
- The PR description renders everything the model wrote as code, so it cannot add links, @mentions, #references or HTML.
- **Report-only mode**: a global kill switch plus an allowlist of Owning teams (`agentPrTeams`). An Agent PR is opened only when the global switch is off and the monitor's Owning team is listed. Every other team stays in Report-only mode, including one that opts a monitor in later just by tagging it, and a monitor with no team tag. Turning the global switch on stops Agent PRs for everyone at once.
- This repo is public: all secrets (Datadog tokens, GitHub App private key, Teams webhook URLs, per-Org webhook secrets) live in Worker secrets; the Org registry references them by name only.
- A daily scheduled check posts to the default Teams channel 14 days before any Datadog token expires. Rotation is a manual runbook until Datadog supports generic OIDC.

## Hardening kept beyond the v1 spec

Found in review and kept, because each closes a concrete risk:

- Teams text is plain: markdown escaped, URLs and every dot between letters of any script defanged (after NFKC folding and dropping invisible characters), so model or log text cannot add links. The only links are the harness's own actions.
- The PR body renders model text as code (no links, mentions, references or HTML).
- Datadog MCP tool allowlist (read-only tools only, and never one the server marks as not read-only).
- Abbreviated deployed commits are refused before any token is minted; non-GitHub repos are repo not enabled, shown as host and path only.
- Coordinator run-slot leases with a hard cap that stops a stuck Investigation; Investigations that cannot start their agent (e.g. Datadog MCP down) end Failed; the run fails if the configured model is not available.
- Repo resolution has an "unresolved" outcome (lookup failed: the report says code was not read, no reminder) and a "checkout failed" outcome.
- A Triggered that arrives while a recovered episode's run is still stopping is held and opens the next episode afterwards; "Re-Triggered" counts as Triggered.
- One nudge to call `submit_report` when the agent answers in plain text; daily token-expiry warnings continue after a token expired.

## Rollout

1. Pilot: SRE/infra team, `gap` Org, **Report-only mode**, about 2 weeks. Pilot services get source code integration tags (`DD_GIT_REPOSITORY_URL`, `DD_GIT_COMMIT_SHA`).
2. Add the pilot team to `agentPrTeams` and turn the global switch off.
3. Onboard further teams (opt-in tag on monitors, GitHub App installed on their repos): new teams get Investigation reports; Agent PRs only once added to `agentPrTeams`.

## Cost (estimate)

About $0.20 per typical Investigation (~40 turns, ~85% cache hits), up to the $3 cap. Roughly $22/month at 100 Investigations, $115/month at 500, including the $5 Workers Paid base.

## Out of scope for v1

- Backup polling for lost webhooks (Datadog retries 5xx five times).
- GitHub MCP.
- Computer Container backend (planned upgrade if too many Agent PRs fail CI).
- A service-to-repo mapping file or monitor-tag repo override.
- Model escalation.
