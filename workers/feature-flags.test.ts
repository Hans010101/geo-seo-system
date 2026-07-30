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
});
