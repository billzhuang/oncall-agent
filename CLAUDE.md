# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

Design only: no code, build, lint or test commands exist yet. When the Worker is scaffolded, add its commands here.

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
