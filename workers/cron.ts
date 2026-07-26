import {
  getCloudflareCronStatus,
  runCloudflareScheduledTasks,
  type Env,
} from "./index";
import { withHyperdriveDatabase } from "../server/db";

export default {
  async fetch(_request: Request, env: Env) {
    (globalThis as any).__CF_ENV__ = env;
    const base = {
      ok: true,
      service: "geo-seo-system-cron",
      standby: env.ENABLE_CLOUDFLARE_CRON !== "true",
      mode: env.CLOUDFLARE_CRON_MODE || "canary",
    };
    if (!env.HYPERDRIVE) return Response.json(base);
    try {
      const status = await withHyperdriveDatabase(env.HYPERDRIVE, getCloudflareCronStatus);
      return Response.json({ ...base, status });
    } catch (error) {
      return Response.json({
        ...base,
        statusError: error instanceof Error ? error.message : String(error),
      });
    }
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
