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

/** A URL with a scheme (`https://…`, `ftp://…`), or a scheme Teams opens without `//` (`mailto:…`). */
const SCHEME_URL = /\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s<>"']*|\b(?:mailto|tel|sms|sip|callto|skype|msteams|javascript|vbscript|data|file):[^\s<>"']*/gi;
/** `www.` hosts, which markdown autolinks without a scheme. */
const WWW_URL = /\bwww\.[^\s<>"']*/gi;
/** Top-level domains a linkifier treats as links without a scheme: common generic ones and every 2-letter ccTLD. */
const TLD = "com|net|org|edu|gov|mil|int|info|biz|pro|name|aero|asia|coop|museum|mobi|jobs|travel|app|dev|xyz|online|site|top|club|shop|cloud|[a-z]{2}";
/** A bare domain (`evil-login.com`, `ops.evil.io`). */
const BARE_DOMAIN = new RegExp(`\\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${TLD})\\b`, "gi");

/** Escapes markdown in one line: emphasis, code, links and images, autolinks/HTML; headings, lists, quotes. */
function escapeMarkdownLine(line: string): string {
  return line
    .replace(/[\\`*_~[\]()<>|]/g, (c) => `\\${c}`)
    .replace(/^(\s*)([#+\-=])/, "$1\\$2")
    .replace(/^(\s*\d+)([.)])/, "$1\\$2");
}

/** Defangs URLs so no renderer finds one: `https[:]//evil[.]example/x`, `www[.]evil[.]example`, `evil-login[.]com`. */
function defang(text: string): string {
  const dots = (s: string) => s.replace(/\./g, "[.]");
  return text
    .replace(SCHEME_URL, (url) => dots(url.replace(":", "[:]")))
    .replace(WWW_URL, dots)
    .replace(BARE_DOMAIN, dots);
}

/**
 * Renders untrusted text (alert text, model-written report lines, anything echoed from logs) as plain text in
 * an Adaptive Card, whose TextBlocks render a markdown subset and Teams autolinks URLs. Markdown is escaped
 * first (parentheses too); then URLs are defanged, inserting `[:]`/`[.]`, which form no markdown: never at a
 * line start, and never followed by an unescaped `(`. The only links in a message are the card's own actions, built by the harness from trusted URLs.
 */
export function plain(text: string): string {
  return defang(text.split(/\r?\n/).map(escapeMarkdownLine).join("\n"));
}

function adaptiveCard(message: TeamsMessage) {
  const body: unknown[] = [
    { type: "TextBlock", text: plain(message.title), weight: "Bolder", size: "Medium", wrap: true },
    ...message.lines.map((text) => ({ type: "TextBlock", text: plain(text), wrap: true })),
  ];
  if (message.facts?.length) {
    body.push({ type: "FactSet", facts: message.facts.map(([title, value]) => ({ title: plain(title), value: plain(value) })) });
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
