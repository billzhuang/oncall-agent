import type { Org } from "./config";
import { coordinatorStub } from "./durable";
import { ports } from "./ports";
import { postToTeams } from "./teams";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Warn this many days (or fewer) before a Datadog token expires. */
const WARNING_DAYS = 14;

/**
 * Daily scheduled check: warns each Org's default Teams channel when its Datadog Service Access Token
 * expires within 14 days, based on the expiry date in the Org registry. At most one warning per Org per
 * UTC day, however often the cron fires. One Org's failure does not stop the others' warnings.
 */
export async function runDailyCheck(env: Env): Promise<void> {
  const config = ports().config(env);
  const today = utcDay(ports().now());
  const expiring = config.orgs.filter((org) => daysBetween(today, org.tokenExpiresOn) <= WARNING_DAYS);
  const results = await Promise.allSettled(expiring.map((org) => warnOnce(env, org, today)));
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failures.length) {
    throw new AggregateError(failures.map((f) => f.reason), `token expiry warning failed for ${failures.length} Org(s)`);
  }
}

async function warnOnce(env: Env, org: Org, today: string): Promise<void> {
  const coordinator = coordinatorStub(env);
  const key = `token-expiry:${org.name}`;
  if (!(await coordinator.claimDailyNotice(key, today))) return;
  const verb = daysBetween(today, org.tokenExpiresOn) < 0 ? "expired" : "expires";
  try {
    await postToTeams(env, org.defaultTeamsSecret, {
      title: `Datadog token for Org ${org.name} ${verb} on ${org.tokenExpiresOn}`,
      lines: [`Rotate the Service Access Token in Worker secret ${org.tokenSecret} and update its expiry date in the Org registry.`],
      facts: [
        ["Org", org.name],
        ["Expires on", org.tokenExpiresOn],
      ],
    });
  } catch (error) {
    await coordinator.releaseDailyNotice(key, today);
    throw error;
  }
}

/** UTC calendar day (YYYY-MM-DD) of a business-clock time. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Whole days from one UTC date (YYYY-MM-DD) to another; negative once `to` has passed. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
}
