import { z } from "zod";
import { orgByDatadogId, secret, type Org } from "./config";
import { investigationStub } from "./durable";
import { ports } from "./ports";

/** The one HTTP endpoint every Org's Datadog webhook posts to. */
export const WEBHOOK_PATH = "/webhook/datadog";
/** Custom header carrying the per-Org webhook secret (set in the Org's Datadog webhook configuration). */
export const SECRET_HEADER = "x-oncall-agent-secret";
/** The tag that makes a monitor an Opted-in monitor. */
export const OPT_IN_TAG = "oncall-agent:enabled";

export const TRANSITIONS = ["Triggered", "Recovered", "Warn", "No Data"] as const;
export type Transition = (typeof TRANSITIONS)[number];

/**
 * Datadog's $ALERT_TRANSITION, case-insensitive. A leading "Re-" (Re-Triggered, Re-Warn: renotifications)
 * maps to the base transition, so a re-trigger joins its open Alert episode.
 */
function normalizeTransition(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const base = raw.trim().toLowerCase().replace(/^re-/, "").replace(/[\s_]+/g, " ");
  return TRANSITIONS.find((t) => t.toLowerCase() === base) ?? raw;
}

const Id = z.union([z.string(), z.number()]).transform(String);

/**
 * The fixed JSON contract each Org's Datadog webhook is configured to send (Datadog template variables):
 *
 *   { "orgId": "$ORG_ID", "alertId": "$ID", "transition": "$ALERT_TRANSITION", "monitorId": "$ALERT_ID",
 *     "group": "$ALERT_SCOPE", "tags": "$TAGS", "link": "$LINK", "title": "$EVENT_TITLE", "date": "$DATE" }
 *
 * `alertId` is the Datadog event ID: unique per notification and resent unchanged on Datadog's retries, so it
 * identifies a delivery. `tags` may arrive as an array or a comma-separated string.
 */
const PayloadSchema = z.object({
  orgId: Id,
  alertId: Id.pipe(z.string().min(1).max(256)),
  transition: z.preprocess(normalizeTransition, z.enum(TRANSITIONS)),
  /** Datadog monitor IDs are numeric. */
  monitorId: Id.pipe(z.string().regex(/^\d{1,20}$/)),
  group: z.string().max(1024).default(""),
  tags: z
    .union([z.array(z.string()), z.string()])
    .default([])
    .transform((t) => (Array.isArray(t) ? t : t.split(",")).map((s) => s.trim()).filter(Boolean)),
  link: z.string().default(""),
  title: z.string().max(1024).default(""),
  date: Id.default(""),
});

/** The identity of an Alert episode: Org, monitor and group. */
export interface AlertEpisodeKey {
  org: string;
  monitorId: string;
  group: string;
}

/** A validated, authenticated alert notification from an Opted-in monitor. */
export interface Alert extends AlertEpisodeKey {
  alertId: string;
  transition: Transition;
  tags: string[];
  /** Monitor link on the Org's Datadog site (never an arbitrary URL from the payload). */
  link: string;
  title: string;
  date: string;
}

export async function handleWebhook(request: Request, env: Env): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return reply(400, "malformed JSON");
  }
  const parsed = PayloadSchema.safeParse(raw);
  if (!parsed.success) return reply(400, "payload does not match the webhook contract");
  const payload = parsed.data;

  // Authenticate before anything touches state: a rejected webhook must have no effect.
  const config = ports().config(env);
  const org = orgByDatadogId(config, payload.orgId);
  const expected = org ? secret(env, org.webhookSecret) : undefined;
  if (!org || !expected || !(await sameSecret(request.headers.get(SECRET_HEADER), expected))) {
    return reply(401, "unauthorized"); // same answer for unknown Org, unset secret and wrong secret
  }

  // Ignored notifications still answer 2xx, or Datadog would retry them. None of them touches a Durable Object.
  if (!payload.tags.includes(OPT_IN_TAG)) return reply(202, "ignored: not an Opted-in monitor");
  // Triggered starts (or joins) an Investigation; Recovered closes its Alert episode. Warn and No Data are ignored.
  if (payload.transition !== "Triggered" && payload.transition !== "Recovered") {
    return reply(202, `ignored: ${payload.transition} transition`);
  }

  const alert: Alert = {
    org: org.name,
    monitorId: payload.monitorId,
    group: payload.group,
    alertId: payload.alertId,
    transition: payload.transition,
    tags: payload.tags,
    link: monitorLink(org, payload.monitorId, payload.link),
    title: payload.title,
    date: payload.date,
  };
  const investigation = investigationStub(env, alert);
  const outcome = alert.transition === "Recovered" ? await investigation.recovered(alert) : await investigation.triggered(alert);
  return reply(202, outcome);
}

/**
 * The monitor link for messages: the webhook's link only when it is https on the Org's Datadog app host
 * (it may carry useful group/time parameters), else built from the monitor ID. Payload text is untrusted.
 */
function monitorLink(org: Org, monitorId: string, supplied: string): string {
  const host = `app.${org.site}`;
  try {
    const url = new URL(supplied);
    if (url.protocol === "https:" && url.host === host && !url.username && !url.password) return url.toString();
  } catch {
    // not a URL: fall through
  }
  return `https://${host}/monitors/${monitorId}`;
}

/** Constant-time comparison of the presented secret with the expected one (digests have equal length). */
async function sameSecret(presented: string | null, expected: string): Promise<boolean> {
  if (presented === null) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function reply(status: number, outcome: string): Response {
  return Response.json({ outcome }, { status });
}
