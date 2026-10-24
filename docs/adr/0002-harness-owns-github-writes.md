# The harness, not the agent, writes to GitHub

Status: accepted

A GitHub App held by the harness clones the repo, pushes an `oncall-agent/*` branch and opens the draft Agent PR; the agent only edits the checkout and has no GitHub credentials, and GitHub MCP is not used in v1. Alert text and logs are untrusted input, so keeping write access out of the model's reach means a prompt-injected agent can at worst produce a bad draft PR that a human must review. This replaces the original plan of having the agent write through GitHub MCP, which also may not accept App installation tokens; revisit if the agent needs cross-repo search.

Amendment (2026-10-25): a same-repo `oncall-agent/*` branch runs the repo's CI with its secrets, so "at worst a bad draft PR" understates the risk: model-written code reaches CI before any human looks. The protected-paths deny-list narrows that risk but does not close it, since any source file may be run by a test or build; whether Agent PRs come from a fork, whose CI gets no secrets, is pending and is decided before the global Report-only switch is turned off.
