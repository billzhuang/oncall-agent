# Run the agent on pi-durable via Cloudflare Agents PiHarness and Computer (native)

Status: accepted

Each Investigation runs as a pi-durable session hosted by the Cloudflare Agents SDK `PiHarness` in a Durable Object (EU jurisdiction), so turns and tool calls are checkpointed and an Investigation survives eviction and resumes across the 15-minute alarm limit. Code is checked out and edited in a `@cloudflare/computer` Workspace using only its Worker-native backends (SQLite virtual filesystem, just-bash, isomorphic-git), wired in as pi tools the way Cloudflare's own Pi harness example does. No container: the agent cannot run tests, and the repo's CI on the Agent PR is the test runner. We accept that pi-durable and just-bash are experimental, PiHarness is beta and the Agents SDK is 0.x, and pin all of them to exact versions.

## Considered Options

- Stock pi coding agent in a container, Durable Object for state only: fewer pre-1.0 dependencies, but loses mid-run durability.
- Computer's Container backend: lets the agent run tests before opening a PR, at the cost of a container image, cold starts and ~$0.03 per Investigation. The planned upgrade if too many Agent PRs fail CI.
- `@cloudflare/sandbox` 1.0 (GA): more mature container option, but we would write the pi tool wrappers and clone/push plumbing ourselves.

## Consequences

- A resumed Investigation may repeat steps, so every outward action (branch push, PR, Teams message) checks for an existing result before acting.
- Upgrades of pi-durable / PiHarness / agents / computer are deliberate, tested bumps, never ranges.
