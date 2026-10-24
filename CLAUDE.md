# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

A single Cloudflare Worker (`src/index.ts`) with Investigation and Coordinator Durable Objects. Node 22, npm 11, exact pins (`.npmrc` `save-exact=true`).

- `npm test`: Vitest with `@cloudflare/vitest-plugin`; runs the real Worker in workerd.
- `npm run typecheck`: `tsc --noEmit`.
- `npm run types`: regenerates `worker-configuration.d.ts`; rerun and commit after any `wrangler.jsonc` change.

Testing: drive only the Worker's outer edge (webhook, scheduled event, Durable Object alarms) and assert only outward effects. External systems are reached only through `src/ports.ts`; tests swap them for the fakes in `test/fakes/`, wired by `installFakes()` in `test/harness.ts`. Test secrets and the test Org registry are in `test/config.ts`.

## Where the design lives

- `GLOSSARY.md`: the domain language (Org, Alert episode, Investigation, Agent PR, Unmapped service…). Name code, logs and messages with these terms and keep the glossary free of implementation detail.
- `docs/design.md`: the agreed v1 flow, guardrails, rollout and scope. Read before implementing any part of the agent.
- `docs/adr/`: decisions with their reasons. Read before changing the runtime, execution environment or GitHub access; record a reversal as a new ADR that supersedes the old one.

## Invariants (from the ADRs and design)

- The harness holds the GitHub App and does every clone, push and PR; the agent edits a credential-free checkout (ADR 0002).
- Every outward action (branch push, PR, Teams message) checks for an existing result first, since pi-durable replays steps after resuming (ADR 0001).
- `agents`, `@earendil-works/pi-durable`, `@earendil-works/pi-ai` and `@cloudflare/computer` are pinned to exact versions.
- Durable Objects use `jurisdiction: "eu"`. Datadog MCP is `https://mcp.datadoghq.eu/v1/mcp`, one connection per Org.
- The GitHub repo is public: config references secrets by Worker-secret name only.

## Agent skills

### Issue tracker

GitHub Issues on `billzhuang/oncall-agent`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` and `docs/adr/`. See `docs/agents/domain.md`.
