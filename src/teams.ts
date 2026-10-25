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
  /** Fact rows ("Org", "gap"). Untrusted like all text: rendered by `plain()`. */
  facts?: Array<[string, string]>;
  /**
   * Fact rows the harness computes from numbers ("Model cost", "$0.03"): markdown-escaped but not defanged, so
   * they stay readable. Never put text from an alert, Datadog or the model here.
   */
  measures?: Array<[string, string]>;
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
/**
 * Every dot between label characters of any script (`evil.support`, `пример.рф`), so no bare domain survives
 * whatever its TLD. It runs after markdown escaping, so it also matches across an escape backslash (`a\_.b`). No
 * TLD allowlist: version numbers and dotted identifiers read `1[.]2[.]3`, an accepted cost.
 */
const LABEL_DOT = /(?<=[\p{L}\p{N}\p{M}_-]\\?)\.(?=\\?[\p{L}\p{N}\p{M}_-])/gu;
/** Format and default-ignorable characters: invisible, and dropped by some renderers and by IDNA. */
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
/**
 * Characters a linkifier or IDNA may read as a dot, left after NFKC folding (which already maps the fullwidth,
 * small and one-dot-leader forms to `.`): ideographic and halfwidth ideographic full stops, and other lookalikes.
 */
const DOT_LOOKALIKES = /[\u3002\uFF0E\uFF61\u2024\uFE52\u2E3C\u0589\u06D4\u0701\u0702\u1362\uA4F8\uA60E]/g;

/** Escapes markdown in one line: emphasis, code, links and images, autolinks/HTML; headings, lists, quotes. */
function escapeMarkdownLine(line: string): string {
  return line
    .replace(/[\\`*_~[\]()<>|]/g, (c) => `\\${c}`)
    .replace(/^(\s*)([#+\-=])/, "$1\\$2")
    .replace(/^(\s*\d+)([.)])/, "$1\\$2");
}

/** Defangs URLs so no renderer finds one: `https[:]//evil[.]example/x`, `www[.]evil[.]example`, `evil[.]support`. */
function defang(text: string): string {
  return text
    .replace(SCHEME_URL, (url) => url.replace(":", "[:]").replace(/\./g, "[.]"))
    .replace(LABEL_DOT, "[.]");
}

/**
 * Renders untrusted text (alert text, model-written report lines, anything echoed from logs) as plain text in
 * an Adaptive Card, whose TextBlocks render a markdown subset and Teams autolinks URLs. Markdown is escaped
 * first (parentheses too); then URLs are defanged, inserting `[:]`/`[.]`, which form no markdown: never at a
 * line start, and never followed by an unescaped `(`. The only links in a message are the card's own actions, built by the harness from trusted URLs.
 */
export function plain(text: string): string {
  // NFKC first: fullwidth and other compatibility forms (`ｅｖｉｌ．ｃｏｍ`) become the ASCII a linkifier would see.
  // Then drop invisible characters (zero-width spaces and joiners, soft hyphens, BOM): a renderer may strip them,
  // so one next to a dot (`evil​.com`) must not hide the dot from the defanging below.
  const visible = text.normalize("NFKC").replace(INVISIBLE, "");
  return defang(escapeMarkdown(visible.replace(DOT_LOOKALIKES, ".")));
}

function escapeMarkdown(text: string): string {
  return text.split(/\r?\n/).map(escapeMarkdownLine).join("\n");
}

function adaptiveCard(message: TeamsMessage) {
  const body: unknown[] = [
    { type: "TextBlock", text: plain(message.title), weight: "Bolder", size: "Medium", wrap: true },
    ...message.lines.map((text) => ({ type: "TextBlock", text: plain(text), wrap: true })),
  ];
  const facts = [
    ...(message.facts ?? []).map(([title, value]) => ({ title: plain(title), value: plain(value) })),
    ...(message.measures ?? []).map(([title, value]) => ({ title: escapeMarkdown(title), value: escapeMarkdown(value) })),
  ];
  if (facts.length) body.push({ type: "FactSet", facts });
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
