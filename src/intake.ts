import { z } from "zod";
import { orgByDatadogId } from "./config";
import { investigationStub } from "./durable";
import { ports } from "./ports";

/** The one HTTP endpoint every Org's Datadog webhook posts to. */
export const WEBHOOK_PATH = "/webhook/datadog";

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
  orgId: z.union([z.string(), z.number()]).transform(String),
  alertId: z.union([z.string(), z.number()]).transform(String).pipe(z.string().min(1)),
  transition: z.string(),
  monitorId: z.union([z.string(), z.number()]).transform(String).pipe(z.string().min(1)),
  group: z.string().default(""),
  tags: z
    .union([z.array(z.string()), z.string()])
    .default([])
    .transform((t) => (Array.isArray(t) ? t : t.split(",")).map((s) => s.trim()).filter(Boolean)),
  link: z.string().default(""),
  title: z.string().default(""),
  date: z.union([z.string(), z.number()]).transform(String).default(""),
});

export type Transition = "Triggered" | "Recovered" | "Warn" | "No Data";

/** The identity of an Alert episode: Org, monitor and group. */
export interface AlertEpisodeKey {
  org: string;
  monitorId: string;
  group: string;
}

/** A validated alert notification from an Opted-in monitor. */
export interface Alert extends AlertEpisodeKey {
  alertId: string;
  transition: Transition;
  tags: string[];
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

  const config = ports().config(env);
  const org = orgByDatadogId(config, payload.orgId);
  if (!org) return reply(401, "unauthorized");

  const alert: Alert = {
    org: org.name,
    monitorId: payload.monitorId,
    group: payload.group,
    alertId: payload.alertId,
    transition: payload.transition as Transition,
    tags: payload.tags,
    link: payload.link,
    title: payload.title,
    date: payload.date,
  };
  const outcome = await investigationStub(env, alert).triggered(alert);
  return reply(202, outcome);
}

function reply(status: number, outcome: string): Response {
  return Response.json({ outcome }, { status });
}
