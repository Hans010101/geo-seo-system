import { describe, expect, it, vi } from "vitest";
import { getCloudflareFeatureFlags } from "./feature-flags";
import {
  enqueueScheduledMonitor,
  type QueueEnv,
  type QueueTask,
} from "./monitor-queue";

function envWith(overrides: Record<string, string> = {}) {
  const sendBatch = vi.fn(async (_messages: Array<{ body: QueueTask }>) => undefined);
  return {
    env: {
      MONITOR_QUEUE: { sendBatch },
      ...overrides,
    } as unknown as QueueEnv,
    sendBatch,
  };
}

describe("Cloudflare migration feature flags", () => {
  it("keeps current jobs on and future migration stages off by default", () => {
    expect(getCloudflareFeatureFlags({ ENABLE_CLOUDFLARE_CRON: "true" })).toEqual({
      scheduler: true,
      monitorNews: true,
      monitorSocial: true,
      binanceShadow: false,
      binanceWrite: false,
      cleanup: true,
      weeklyReport: true,
      monthlyReport: true,
      geoDaily: false,
      geoWeekly: false,
      realtimeAlerts: false,
      briefing: false,
      failureNotifications: false,
      fetchObservability: false,
      browserFullTextShadow: false,
      openRouterFallback: false,
      openRouterPreflight: false,
    });
  });

  it("gates news and social schedules independently", async () => {
    const news = envWith({ CLOUDFLARE_MONITOR_NEWS_ENABLED: "false" });
    await enqueueScheduledMonitor(Date.UTC(2026, 6, 29, 19, 15), news.env);
    expect(news.sendBatch).not.toHaveBeenCalled();

    const social = envWith({ CLOUDFLARE_MONITOR_SOCIAL_ENABLED: "true" });
    await enqueueScheduledMonitor(Date.UTC(2026, 6, 29, 19, 40), social.env);
    expect(social.sendBatch).toHaveBeenCalledWith([
      {
        body: expect.objectContaining({
          kind: "bootstrap",
          profile: "monitor_primary_social",
        }),
      },
      { body: expect.objectContaining({ kind: "maintenance", task: "cleanup" }) },
    ]);
  });

  it("gates cleanup and reports independently without changing the monitor batch", async () => {
    const monday = envWith({
      CLOUDFLARE_MONITOR_SOCIAL_ENABLED: "true",
      CLOUDFLARE_CLEANUP_ENABLED: "false",
      CLOUDFLARE_WEEKLY_REPORT_ENABLED: "false",
      CLOUDFLARE_MONTHLY_REPORT_ENABLED: "false",
    });
    // 2026-08-03 03:40 Asia/Shanghai.
    await enqueueScheduledMonitor(Date.UTC(2026, 7, 2, 19, 40), monday.env);
    expect(monday.sendBatch).toHaveBeenCalledWith([
      {
        body: expect.objectContaining({
          kind: "bootstrap",
          profile: "monitor_primary_social",
        }),
      },
    ]);
  });

  it("keeps GEO Queue shards off by default and gates daily start time", async () => {
    const beforeStart = envWith({
      CLOUDFLARE_MONITOR_SOCIAL_ENABLED: "false",
      CLOUDFLARE_GEO_DAILY_ENABLED: "true",
      CLOUDFLARE_GEO_WEEKLY_ENABLED: "true",
      CLOUDFLARE_GEO_DAILY_START_HOUR: "9",
    });
    // 2026-07-30 07:40 Asia/Shanghai.
    await enqueueScheduledMonitor(Date.UTC(2026, 6, 29, 23, 40), beforeStart.env);
    expect(beforeStart.sendBatch).toHaveBeenCalledWith([
      { body: expect.objectContaining({ kind: "geo_weekly_shard" }) },
    ]);

    const afterStart = envWith({
      CLOUDFLARE_MONITOR_SOCIAL_ENABLED: "false",
      CLOUDFLARE_GEO_DAILY_ENABLED: "true",
      CLOUDFLARE_GEO_WEEKLY_ENABLED: "true",
      CLOUDFLARE_GEO_DAILY_START_HOUR: "9",
    });
    // 2026-07-30 09:40 Asia/Shanghai.
    await enqueueScheduledMonitor(Date.UTC(2026, 6, 30, 1, 40), afterStart.env);
    expect(afterStart.sendBatch).toHaveBeenCalledWith([
      { body: expect.objectContaining({ kind: "geo_daily_shard" }) },
      { body: expect.objectContaining({ kind: "geo_weekly_shard" }) },
    ]);
  });

  it("runs the OpenRouter preflight before the first weekly GEO window", async () => {
    const preflight = envWith({
      CLOUDFLARE_MONITOR_SOCIAL_ENABLED: "false",
      CLOUDFLARE_OPENROUTER_PREFLIGHT_ENABLED: "true",
      CLOUDFLARE_GEO_WEEKLY_ENABLED: "true",
      CLOUDFLARE_GEO_WEEKLY_START_HOUR: "3",
    });
    // 2026-07-30 01:40 Asia/Shanghai.
    await enqueueScheduledMonitor(Date.UTC(2026, 6, 29, 17, 40), preflight.env);
    expect(preflight.sendBatch).toHaveBeenCalledWith([
      { body: expect.objectContaining({ kind: "openrouter_preflight" }) },
    ]);
  });
});
