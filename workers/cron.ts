import { getSysConfig, withHyperdriveDatabase } from "../server/db";
import { withCloudflareEnv } from "../server/_core/cloudflare-env";
import { MonitorCoordinator } from "./monitor-coordinator";
import {
  enqueueScheduledMonitor,
  getCoordinatorStatus,
  processMonitorQueue,
  type QueueEnv,
} from "./monitor-queue";

export { MonitorCoordinator };

type Env = QueueEnv & {
  CLOUDFLARE_GEO_WEEKLY_ENABLED?: string;
};

const STATUS_KEYS = {
  mode: "cf_cron_mode",
  task: "cf_cron_last_task",
  status: "cf_cron_last_status",
  startedAt: "cf_cron_last_started_at",
  finishedAt: "cf_cron_last_finished_at",
  summary: "cf_cron_last_summary",
  error: "cf_cron_last_error",
} as const;

const WEEKLY_KEYS = {
  mode: "cf_geo_weekly_mode",
  task: "cf_geo_weekly_last_task",
  status: "cf_geo_weekly_last_status",
  startedAt: "cf_geo_weekly_last_started_at",
  finishedAt: "cf_geo_weekly_last_finished_at",
  summary: "cf_geo_weekly_last_summary",
  error: "cf_geo_weekly_last_error",
} as const;

async function readKeys(keys: Record<string, string>) {
  return Object.fromEntries(await Promise.all(
    Object.entries(keys).map(async ([name, key]) => [name, await getSysConfig(key)]),
  ));
}

async function status(env: Env) {
  const [legacy, weeklyGeo, news, social] = await Promise.all([
    readKeys(STATUS_KEYS),
    readKeys(WEEKLY_KEYS),
    getCoordinatorStatus(env, "monitor_primary_news"),
    getCoordinatorStatus(env, "monitor_primary_social"),
  ]);
  return {
    ...legacy,
    weeklyGeo: {
      ...weeklyGeo,
      enabled: env.CLOUDFLARE_GEO_WEEKLY_ENABLED === "true",
    },
    profiles: {
      monitor_primary_news: news,
      monitor_primary_social: social,
    },
  };
}

export default {
  async fetch(_request: Request, env: Env) {
    const base = {
      ok: true,
      service: "geo-seo-system-cron",
      standby: env.ENABLE_CLOUDFLARE_CRON !== "true",
      mode: env.CLOUDFLARE_CRON_MODE || "primary",
      execution: "queue_sharded",
    };
    if (!env.HYPERDRIVE) return Response.json(base);
    try {
      const result = await withCloudflareEnv(env, () =>
        withHyperdriveDatabase(env.HYPERDRIVE!, () => status(env)),
      );
      return Response.json({ ...base, status: result });
    } catch (error) {
      return Response.json({
        ...base,
        statusError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    if (env.ENABLE_CLOUDFLARE_CRON !== "true") return;
    // Free-plan Cron invocations get 10ms CPU. They now do only one native
    // Queue send; database reads, discovery, AI and persistence run as separate
    // queue invocations.
    ctx.waitUntil(enqueueScheduledMonitor(event.scheduledTime, env));
  },

  async queue(batch: any, env: Env) {
    await processMonitorQueue(batch, env);
  },
};
