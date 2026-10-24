import { Type, type Static } from "@earendil-works/pi-ai";
import type { Alert } from "../intake";
import { owningTeam, type TeamsMessage } from "../teams";
import type { AgentPrRecord } from "./agent-pr";

/** The structured Investigation report the agent submits through its finishing tool, `submit_report`. */
export const ReportSchema = Type.Object({
  whatFired: Type.String({ description: "What fired: the monitor, the symptom and its scope, in one or two sentences." }),
  evidence: Type.Array(Type.String(), {
    description: "The evidence gathered: short factual lines, each naming the Datadog data it comes from.",
  }),
  suspectedCause: Type.String({
    description: "The suspected cause, or 'unknown' with what is missing to tell.",
  }),
  fixProposed: Type.Optional(
    Type.Boolean({ description: "True only when your workspace edits are a proposed fix for the suspected cause." }),
  ),
});
export type InvestigationReport = Static<typeof ReportSchema>;

const LIMITS = { text: 2_000, evidenceLines: 20, evidenceLine: 1_000 };

/** Bounds what the model submitted, so a runaway answer cannot break the Teams card. */
export function boundedReport(report: InvestigationReport): InvestigationReport {
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  return {
    whatFired: cut(report.whatFired.trim(), LIMITS.text),
    evidence: report.evidence
      .map((e) => e.trim())
      .filter(Boolean)
      .slice(0, LIMITS.evidenceLines)
      .map((e) => cut(e, LIMITS.evidenceLine)),
    suspectedCause: cut(report.suspectedCause.trim(), LIMITS.text),
    fixProposed: report.fixProposed === true,
  };
}

/** How an Investigation went: recorded for every Investigation and shown on its messages. */
export interface InvestigationRecord {
  costUsd: number;
  durationMs: number;
}

/**
 * The Investigation report as a Teams message. All text is untrusted; teams.ts renders it as plain text.
 * `code`: the line repo resolution contributes (what code was read, or why none), when it ran.
 */
export function reportMessage(
  alert: Alert,
  report: InvestigationReport,
  record: InvestigationRecord,
  code?: string,
  agentPr?: AgentPrRecord,
): TeamsMessage {
  const pr = agentPr && agentPrLine(agentPr);
  return {
    title: `Investigation report: ${alertName(alert)}`,
    lines: [
      `What fired: ${report.whatFired}`,
      "Evidence:",
      ...(report.evidence.length ? report.evidence.map((e) => `• ${e}`) : ["• (none gathered)"]),
      `Suspected cause: ${report.suspectedCause}`,
      ...(code ? [code] : []),
      ...(pr ? [pr] : []),
    ],
    facts: episodeFacts(alert),
    measures: recordFacts(record),
    links: [
      ...monitorLinks(alert),
      ...(agentPr?.outcome === "opened" || agentPr?.outcome === "updated" ? [{ title: "Open Agent PR", url: agentPr.url }] : []),
    ],
  };
}

/** The report's line about the Agent PR. */
function agentPrLine(pr: AgentPrRecord): string {
  switch (pr.outcome) {
    case "opened":
    case "updated": {
      const what = pr.outcome === "opened" ? "opened draft Agent PR" : "updated the open Agent PR";
      const drift = pr.drift.length ? " Files it changes also changed on main since the deployed commit: see the PR." : "";
      return `Agent PR: ${what} #${pr.number} from branch ${pr.branch} for Code owners to review.${drift}`;
    }
    case "report-only":
      return "Agent PR: none, Report-only mode is on; the agent's proposed fix was not opened as a PR.";
    case "no-changes":
      return "Agent PR: none, the agent declared a fix but changed no file.";
    case "failed":
      return `Agent PR: could not be opened (${pr.reason}).`;
  }
}

/**
 * The Agent PR description, in GitHub markdown. Harness facts (monitor link, Owning team, drift warning) are built
 * here; everything the model wrote, and every name from the alert or the workspace, is rendered as code, where
 * GitHub makes no links, @mentions, #references or HTML.
 */
export function agentPrBody(
  alert: Alert,
  report: InvestigationReport,
  input: { deployedSha: string; changedPaths: string[]; drift: string[] },
): string {
  const lines = [
    `Draft Agent PR from the oncall agent for an Alert episode of monitor ${alert.monitorId} in Org ${codeSpan(alert.org)}. ` +
      "Code owners: please review; the agent never merges.",
    "",
    `- Monitor: [Open monitor](<${alert.link}>)`,
    `- Owning team: ${codeSpan(owningTeam(alert.tags) ?? "(no team tag)")}`,
    `- Group: ${codeSpan(alert.group || "(none)")}`,
    `- Deployed commit read: ${codeSpan(input.deployedSha)}; this branch is cut from \`main\`.`,
    "",
  ];
  if (input.drift.length) {
    lines.push(
      "> [!WARNING]",
      `> Drift: these files changed on \`main\` since the deployed commit: ${input.drift.map(codeSpan).join(", ")}. ` +
        "The bug may already be fixed on `main`, and this PR's version of them is based on the deployed commit, so it may undo those changes.",
      "",
    );
  }
  lines.push(
    "### Investigation report",
    "",
    "Written by the agent; shown as plain text.",
    "",
    codeBlock(
      [
        `What fired: ${report.whatFired}`,
        "Evidence:",
        ...(report.evidence.length ? report.evidence.map((e) => `- ${e}`) : ["- (none gathered)"]),
        `Suspected cause: ${report.suspectedCause}`,
      ].join("\n"),
    ),
    "",
    `Files changed: ${input.changedPaths.map(codeSpan).join(", ")}`,
    "",
    "The Investigation report was also posted to the Owning team's Teams channel.",
  );
  return lines.join("\n");
}

/** Longest run of backticks in a text. */
const longestBacktickRun = (text: string) => Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));

/** Inline code no text can close early: a fence longer than any backtick run inside (CommonMark code span). */
function codeSpan(text: string): string {
  const flat = text.replace(/[\r\n]+/g, " ");
  const fence = "`".repeat(longestBacktickRun(flat) + 1);
  return `${fence} ${flat} ${fence}`;
}

/** A fenced code block no line can close early: the fence is longer than any backtick run inside. */
function codeBlock(text: string): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${fence}text\n${text.replace(/\r\n?/g, "\n")}\n${fence}`;
}

/** The message when an Investigation ends without an Investigation report. */
export function failedMessage(alert: Alert, reason: string, record: InvestigationRecord, code?: string): TeamsMessage {
  return {
    title: `Investigation failed: ${alertName(alert)}`,
    lines: [`Failed: ${reason}. Nothing was found or concluded; please investigate this alert yourself.`, ...(code ? [code] : [])],
    facts: episodeFacts(alert),
    measures: recordFacts(record),
    links: monitorLinks(alert),
  };
}

/** The message when the monitor recovers while its Investigation is running: the Investigation stops there. */
export function stoppedMessage(alert: Alert, record: InvestigationRecord): TeamsMessage {
  return {
    title: `Investigation stopped on recovery: ${alertName(alert)}`,
    lines: [
      "Stopped: the monitor recovered while the Investigation was running, so it was stopped without an Investigation report. An Agent PR already opened for this monitor group stays open for review.",
    ],
    facts: [...episodeFacts(alert), ...recordFacts(record)],
    links: monitorLinks(alert),
  };
}

/** The one notice for an Alert episode not investigated because the daily budget is exhausted. */
export function budgetExhaustedMessage(alert: Alert): TeamsMessage {
  return {
    title: `Budget exhausted, not investigated: ${alertName(alert)}`,
    lines: [
      "The oncall agent's daily spend budget is exhausted, so this alert was not investigated. " +
        "Please investigate it yourself. The budget resets at 00:00 UTC.",
    ],
    facts: episodeFacts(alert),
    links: monitorLinks(alert),
  };
}

/**
 * The message when a guardrail (cost cap, time limit) stopped an Investigation before it submitted its report:
 * the reason, and the evidence the agent had gathered so far (Datadog tool results, untrusted).
 */
export function partialMessage(
  alert: Alert,
  reason: string,
  evidence: readonly string[],
  record: InvestigationRecord,
): TeamsMessage {
  return {
    title: `Investigation partial: ${alertName(alert)}`,
    lines: [
      `Partial: ${reason}. The Investigation stopped before it finished; below is what it gathered so far. Please check this alert yourself.`,
      "Evidence gathered so far:",
      ...(evidence.length ? evidence.map((e) => `• ${e}`) : ["• (none gathered)"]),
    ],
    facts: episodeFacts(alert),
    measures: recordFacts(record),
    links: monitorLinks(alert),
  };
}

/** One line of evidence from a tool result, bounded so a partial message stays readable. */
export function evidenceLine(tool: string, text: string): string {
  const line = `${tool}: ${text.replace(/\s+/g, " ").trim()}`;
  return line.length > LIMITS.evidenceLine ? `${line.slice(0, LIMITS.evidenceLine - 1)}…` : line;
}

/** At most this many evidence lines go on a partial message. */
export const MAX_EVIDENCE_LINES = LIMITS.evidenceLines;

function alertName(alert: Alert): string {
  return alert.title || `monitor ${alert.monitorId}`;
}

function episodeFacts(alert: Alert): Array<[string, string]> {
  return [
    ["Org", alert.org],
    ["Monitor", alert.monitorId],
    ["Group", alert.group || "(none)"],
    ["Owning team", owningTeam(alert.tags) ?? "(no team tag)"],
  ];
}

function recordFacts(record: InvestigationRecord): Array<[string, string]> {
  return [
    ["Duration", formatDuration(record.durationMs)],
    ["Model cost", `$${record.costUsd.toFixed(2)}`],
  ];
}

/** The only link on Investigation messages: the monitor, a URL intake built from the Org's Datadog site. */
function monitorLinks(alert: Alert): NonNullable<TeamsMessage["links"]> {
  return alert.link ? [{ title: "Open monitor", url: alert.link }] : [];
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
