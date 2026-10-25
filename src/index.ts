import { WEBHOOK_PATH, handleWebhook } from "./intake";
import { runDailyCheck } from "./scheduled";

export { Coordinator } from "./coordinator";
export { Investigation } from "./investigation/investigation";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === WEBHOOK_PATH) {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
      return handleWebhook(request, env);
    }
    return new Response("Not found", { status: 404 });
  },

  /** Daily cron trigger (wrangler.jsonc `triggers.crons`): the token expiry check. */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await runDailyCheck(env);
  },
} satisfies ExportedHandler<Env>;
