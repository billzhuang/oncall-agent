# Oncall Agent

An autonomous agent that picks up Datadog monitor alerts across several Datadog orgs, investigates them, and proposes code fixes as draft pull requests for human review.

## Language

### Alerts

**Org**:
One Datadog organization the agent watches, identified by name and Datadog site.
_Avoid_: Account, tenant, workspace

**Org registry**:
The list of Orgs the agent watches, with how to reach each one.
_Avoid_: Org list, org config

**Opted-in monitor**:
A Datadog monitor tagged to allow the agent to act on it; all other monitors are ignored.
_Avoid_: Enabled monitor, watched monitor

**Owning team**:
The team named on an Opted-in monitor; it opts the monitor in and receives the agent's notifications.
_Avoid_: Owner, on-call team (and not to be confused with Code owners)

**Code owners**:
The people responsible for the files an Agent PR changes; they review it.
_Avoid_: Reviewers, maintainers

**Unmapped service**:
A service whose alerts carry no Datadog link to its source repository, so the agent cannot find its code.
_Avoid_: Unknown repo, orphan service

**Alert episode**:
The span from an Opted-in monitor group entering Triggered until it Recovers, identified by Org, monitor and group.
_Avoid_: Alert, incident, event

### Work

**Investigation**:
The agent's single unit of work for one Alert episode; re-triggers within the episode join the same Investigation.
_Avoid_: Job, run, task, ticket

**Investigation report**:
The written outcome of every Investigation: what fired, the evidence gathered, and the suspected cause.
_Avoid_: Summary, RCA, postmortem

**Agent PR**:
A draft pull request the agent opens when an Investigation traces the cause to specific code; always merged by a human, never by the agent.
_Avoid_: Fix PR, auto-PR

**Report-only mode**:
A setting under which Investigations still produce Investigation reports but never open Agent PRs.
_Avoid_: Dry run, shadow mode
