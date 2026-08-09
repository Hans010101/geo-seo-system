import { getSysConfig, withHyperdriveDatabase } from "../server/db";
import { withCloudflareEnv } from "../server/_core/cloudflare-env";
import { MonitorCoordinator } from "./monitor-coordinator";
import { BrowserShadowBudget } from "./browser-shadow-budget";
import { MigrationAcceptanceLedger } from "./migration-acceptance-ledger";
import { getCloudflareFeatureFlags } from "./feature-flags";
import {
  enqueueScheduledMonitor,
  getBinanceProbeStatus,
  getBrowserShadowStatus,
  getCleanupStatus,
  getCoordinatorStatus,
  getFreshnessAuditStatus,
  getGeoQueueStatus,
  getMigrationAcceptanceStatus,
  getOpenRouterPreflightStatus,
  processMonitorQueue,
  type QueueEnv,
  type QueueTask,
} from "./monitor-queue";

export { BrowserShadowBudget, MigrationAcceptanceLedger, MonitorCoordinator };

type Env = QueueEnv & {
  CLOUDFLARE_GEO_WEEKLY_ENABLED?: string;
  CLOUDFLARE_OPERATOR_TOKEN?: string;
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
  const [
    legacy,
    weeklyGeo,
    binance,
    browserFulltext,
    migrationAcceptance,
    news,
    social,
    geoQueue,
    openRouter,
    cleanup,
    freshnessAudit,
  ] = await Promise.all([
    readKeys(STATUS_KEYS),
    readKeys(WEEKLY_KEYS),
    getBinanceProbeStatus(),
    getBrowserShadowStatus(env),
    getMigrationAcceptanceStatus(env),
    getCoordinatorStatus(env, "monitor_primary_news"),
    getCoordinatorStatus(env, "monitor_primary_social"),
    getGeoQueueStatus(),
    getOpenRouterPreflightStatus(),
    getCleanupStatus(),
    getFreshnessAuditStatus(),
  ]);
  const features = getCloudflareFeatureFlags(env);
  return {
    ...legacy,
    features,
    weeklyGeo: {
      ...weeklyGeo,
      ...geoQueue.weekly,
      enabled: features.geoWeekly,
    },
    dailyGeo: {
      ...geoQueue.daily,
      enabled: features.geoDaily,
    },
    binance: {
      ...binance,
      enabled: features.binanceShadow || features.binanceWrite,
      configuredMode:
        features.binanceWrite ? "write" : "shadow",
      intervalHours: Number(env.CLOUDFLARE_BINANCE_INTERVAL_HOURS || 6),
    },
    gate: {
      firecrawlEnabled: env.CLOUDFLARE_GATE_FIRECRAWL_ENABLED !== "false",
      fallbackProvider: "serper",
    },
    chineseSocial: {
      enabled: features.chineseSocial,
      mode: "write",
      provider: "serper_verified_origin",
      intervalHours: Number(env.CLOUDFLARE_CHINESE_SOCIAL_INTERVAL_HOURS || 12),
      maxKeywords: Number(env.CLOUDFLARE_CHINESE_SOCIAL_MAX_KEYWORDS || 1),
      platforms: (env.CLOUDFLARE_CHINESE_SOCIAL_PLATFORMS ||
        "xiaohongshu,douyin,kuaishou,bilibili,weibo,tieba,zhihu")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    },
    openRouter: {
      ...openRouter,
      preflightEnabled: features.openRouterPreflight,
      weeklyGateHealthy:
        openRouter.status === "healthy" &&
        Date.now() - Number(openRouter.checkedAt || 0) <=
          Number(env.CLOUDFLARE_OPENROUTER_PREFLIGHT_MAX_AGE_HOURS || 26) * 3_600_000,
    },
    cleanup,
    freshnessAudit,
    browserFulltext: {
      ...browserFulltext,
      enabled: features.browserFullTextShadow,
      configuredMaxPagesPerDay: Number(env.CLOUDFLARE_BROWSER_FULLTEXT_MAX_PAGES_PER_DAY || 4),
      configuredMaxBrowserMsPerDay: Number(env.CLOUDFLARE_BROWSER_FULLTEXT_MAX_MS_PER_DAY || 480_000),
      configuredCooldownSeconds: Number(env.CLOUDFLARE_BROWSER_FULLTEXT_COOLDOWN_SECONDS || 75),
    },
    migrationAcceptance,
    profiles: {
      monitor_primary_news: news,
      monitor_primary_social: social,
    },
  };
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname.startsWith("/operator/")) {
      const token =
        request.headers.get("x-operator-token") ||
        request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
      if (!env.CLOUDFLARE_OPERATOR_TOKEN || token !== env.CLOUDFLARE_OPERATOR_TOKEN) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const scheduledTime = Date.now();
      if (url.pathname === "/operator/catch-up/daily") {
        await env.MONITOR_QUEUE.send({
          kind: "geo_daily_shard",
          scheduledTime,
          catchUp: true,
        });
        return Response.json({ ok: true, queued: "daily", scheduledTime });
      }
      if (url.pathname === "/operator/catch-up/weekly") {
        await env.MONITOR_QUEUE.send({
          kind: "geo_weekly_shard",
          scheduledTime,
          catchUp: true,
        });
        return Response.json({ ok: true, queued: "weekly", scheduledTime });
      }
      if (url.pathname === "/operator/validation-cycles") {
        await env.MONITOR_QUEUE.sendBatch([
          {
            body: {
              kind: "bootstrap",
              cycleId: `operator_validation_news:${scheduledTime}`,
              profile: "monitor_primary_news",
              scheduledTime,
            },
          },
          {
            body: {
              kind: "bootstrap",
              cycleId: `operator_validation_social:${scheduledTime}`,
              profile: "monitor_primary_social",
              scheduledTime,
            },
          },
        ]);
        return Response.json({ ok: true, queued: "validation_cycles", scheduledTime });
      }
      if (url.pathname === "/operator/chinese-social") {
        await env.MONITOR_QUEUE.send({
          kind: "bootstrap",
          cycleId: `operator_chinese_social:${scheduledTime}`,
          profile: "monitor_primary_social",
          scheduledTime,
          forceChineseSocial: true,
        });
        return Response.json({
          ok: true,
          queued: "chinese_social",
          scheduledTime,
        });
      }
      if (url.pathname === "/operator/notification-probe") {
        await env.MONITOR_QUEUE.send({
          kind: "post_cycle",
          cycleId: `operator_notification_probe:${scheduledTime}`,
          profile: "monitor_primary_social",
          status: "partial_failure",
          keywords: 1,
          sourceCount: 1,
          inserted: 1,
          briefingItems: [{
            title: "Cloudflare 迁移验收通知测试",
            url: "https://geo-seo-system.pages.dev",
            sourcePlatform: "system",
            domain: "geo-seo-system.pages.dev",
            relevance: "high",
            sentimentScore: -1,
            threatLevel: "medium",
          }],
        });
        return Response.json({ ok: true, queued: "notification_probe", scheduledTime });
      }
      if (url.pathname === "/operator/maintenance/cleanup") {
        await env.MONITOR_QUEUE.send({
          kind: "maintenance",
          task: "cleanup",
          scheduledTime,
        });
        return Response.json({ ok: true, queued: "cleanup", scheduledTime });
      }
      if (url.pathname === "/operator/maintenance/freshness-audit") {
        await env.MONITOR_QUEUE.send({
          kind: "freshness_audit",
          auditId: `operator_freshness_audit:${scheduledTime}`,
          scheduledTime,
        });
        return Response.json({
          ok: true,
          queued: "freshness_audit",
          scheduledTime,
        });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    }
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

  async queue(batch: MessageBatch<QueueTask>, env: Env) {
    await processMonitorQueue(batch, env);
  },
};
