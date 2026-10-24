import { Type, type Static } from "@earendil-works/pi-ai";
import type { Alert } from "../intake";
import { owningTeam, type TeamsMessage } from "../teams";

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
): TeamsMessage {
  return {
    title: `Investigation report: ${alertName(alert)}`,
    lines: [
      `What fired: ${report.whatFired}`,
      "Evidence:",
      ...(report.evidence.length ? report.evidence.map((e) => `• ${e}`) : ["• (none gathered)"]),
      `Suspected cause: ${report.suspectedCause}`,
      ...(code ? [code] : []),
    ],
    facts: episodeFacts(alert),
    measures: recordFacts(record),
    links: monitorLinks(alert),
  };
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
function monitorLinks(alert: Alert): TeamsMessage["links"] {
  return alert.link ? [{ title: "Open monitor", url: alert.link }] : [];
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
