import {
  runCloudflareScheduledTasks,
  type Env,
} from "./index";

export default {
  fetch(_request: Request, env: Env) {
    return Response.json({
      ok: true,
      service: "geo-seo-system-cron",
      standby: env.ENABLE_CLOUDFLARE_CRON !== "true",
    });
  },

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ) {
    if (env.ENABLE_CLOUDFLARE_CRON !== "true") return;
    ctx.waitUntil(
      runCloudflareScheduledTasks(event, env).catch((error) => {
        console.error(
          `[Cloudflare Cron] ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }),
    );
  },
};
