import { orgByName, secret, type OncallConfig } from "./config";
import { ports } from "./ports";

/**
 * Kinds of Teams message the agent sends. Each is sent at most once per Investigation (Alert episode) and kind:
 * the Investigation keeps an outbox keyed by kind (see Investigation#notify).
 */
export type TeamsMessageKind =
  | "report"
  | "failed"
  | "partial"
  | "stopped"
  | "budget"
  | "unmapped-reminder"
  | "repo-reminder"
  | "token-expiry";

export interface TeamsMessage {
  title: string;
  /** Paragraphs, rendered as wrapped text blocks. */
  lines: string[];
  /** Fact rows ("Org", "gap"). */
  facts?: Array<[string, string]>;
  /** Action links ("Open monitor"). */
  links?: Array<{ title: string; url: string }>;
}

/** The Owning team named by a monitor's `team:<name>` tag, if any. */
export function owningTeam(tags: readonly string[]): string | undefined {
  const tag = tags.find((t) => t.startsWith("team:") && t.length > "team:".length);
  return tag?.slice("team:".length);
}

/**
 * Worker-secret name of the Teams channel for an alert: the Owning team's channel when its `team` tag is
 * mapped, else the Org's default channel.
 */
export function teamsChannelSecret(config: OncallConfig, orgName: string, tags: readonly string[]): string {
  const team = owningTeam(tags);
  const mapped = team === undefined ? undefined : config.teams[team];
  if (mapped) return mapped;
  const org = orgByName(config, orgName);
  if (!org) throw new Error(`Org ${orgName} is not in the Org registry`);
  return org.defaultTeamsSecret;
}

/** Posts a message to a Teams Workflows webhook. Throws unless Teams accepts it (2xx). */
export async function postToTeams(env: Env, channelSecret: string, message: TeamsMessage): Promise<void> {
  const url = secret(env, channelSecret);
  if (!url) throw new Error(`Worker secret ${channelSecret} (Teams webhook URL) is not set`);
  const res = await ports().fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(adaptiveCard(message)),
  });
  if (!res.ok) throw new Error(`Teams webhook ${channelSecret} answered ${res.status}`);
}

function adaptiveCard(message: TeamsMessage) {
  const body: unknown[] = [
    { type: "TextBlock", text: message.title, weight: "Bolder", size: "Medium", wrap: true },
    ...message.lines.map((text) => ({ type: "TextBlock", text, wrap: true })),
  ];
  if (message.facts?.length) {
    body.push({ type: "FactSet", facts: message.facts.map(([title, value]) => ({ title, value })) });
  }
  const content: Record<string, unknown> = {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    body,
  };
  if (message.links?.length) {
    content.actions = message.links.map((l) => ({ type: "Action.OpenUrl", title: l.title, url: l.url }));
  }
  return { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content }] };
}
