import type { Alert } from "../intake";
import { owningTeam, type TeamsMessage } from "../teams";

/**
 * Placeholder Investigation report, built from the alert payload alone. #2 replaces it with the report the
 * agent submits through its finishing tool.
 */
export function placeholderReport(alert: Alert, startedAt: number): TeamsMessage {
  const facts: Array<[string, string]> = [
    ["Org", alert.org],
    ["Monitor", alert.monitorId],
    ["Group", alert.group || "(none)"],
    ["Owning team", owningTeam(alert.tags) ?? "(no team tag)"],
    ["Investigation started", new Date(startedAt).toISOString()],
  ];
  return {
    title: `Investigation report: ${alert.title || `monitor ${alert.monitorId}`}`,
    lines: [
      `What fired: ${alert.title || `monitor ${alert.monitorId}`} (${alert.transition}).`,
      "Evidence and suspected cause: not investigated yet. This is a placeholder report built from the alert alone.",
    ],
    facts,
    links: alert.link ? [{ title: "Open monitor", url: alert.link }] : [],
  };
}
