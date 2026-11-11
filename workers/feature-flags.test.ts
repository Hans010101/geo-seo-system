import { describe, expect, it, vi } from "vitest";
import { getCloudflareFeatureFlags } from "./feature-flags";
import {
  enqueueScheduledMonitor,
  type QueueEnv,
  type QueueTask,
} from "./monitor-queue";

function envWith(overrides: Record<string, string> = {}) {
  const sendBatch = vi.fn(async (_messages: Array<{ body: QueueTask }>) => undefined);
  const allBatches: Array<Array<{ body: QueueTask }>> = [];
  return {
    env: {
      MONITOR_QUEUE: {
        // Every firing also queues the one-off brief-request check and the 行业动态 triage; they
        // are asserted in their own tests, so the schedule assertions below see the batch without them.
        sendBatch: async (messages: Array<{ body: QueueTask }>) => {
          allBatches.push(messages);
          const rest = messages.filter(m => m.body.kind !== "brief_request" && m.body.kind !== "industry_triage");
          if (rest.length) await sendBatch(rest);
        },
      },
      ...overrides,
    } as unknown as QueueEnv,
    sendBatch,
    allBatches,
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
      chineseSocial: false,
      openRouterPreflight: false,
    });
  });

  it("gates news and social schedules independently", async () => {
    const news = envWith({ CLOUDFLARE_MONITOR_NEWS_ENABLED: "false" });
    await enqueueScheduledMonitor(Date.UTC(2026, 6, 29, 19, 15), news.env);
    // News off: only the market-price task (independent of the monitor flags) is queued at :15.
    expect(news.sendBatch).toHaveBeenCalledWith([{ body: expect.objectContaining({ kind: "market_prices" }) }]);

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

  it("schedules sentiment weekly reports on Friday, not Monday, without enabling GEO collection", async () => {
    const friday = envWith({ CLOUDFLARE_MONITOR_SOCIAL_ENABLED: "false", CLOUDFLARE_CLEANUP_ENABLED: "false" });
    // 2026-10-02 03:40 Asia/Shanghai.
    await enqueueScheduledMonitor(Date.UTC(2026, 9, 1, 19, 40), friday.env);
    expect(friday.sendBatch).toHaveBeenCalledWith([
      { body: expect.objectContaining({ kind: "maintenance", task: "weekly_report" }) },
      { body: expect.objectContaining({ kind: "industry_weekly", report: "weekly" }), delaySeconds: 300 },
    ]);
    const monday = envWith({ CLOUDFLARE_MONITOR_SOCIAL_ENABLED: "false", CLOUDFLARE_CLEANUP_ENABLED: "false" });
    await enqueueScheduledMonitor(Date.UTC(2026, 9, 4, 19, 40), monday.env);
    expect(monday.sendBatch).not.toHaveBeenCalled();
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

  it("prepares the 早报 / 晚报 at :18 and sends them at 09:30 / 17:30", async () => {
    const off = { CLOUDFLARE_MONITOR_NEWS_ENABLED: "false", CLOUDFLARE_MONITOR_SOCIAL_ENABLED: "false" };
    const am = envWith(off);
    await enqueueScheduledMonitor(Date.UTC(2026, 10, 9, 1, 15), am.env); // 09:15 Beijing
    expect(am.sendBatch.mock.calls[0][0]).toContainEqual({ body: expect.objectContaining({ kind: "daily_brief", brief: "am" }), delaySeconds: 180 });
    expect(am.sendBatch.mock.calls[0][0]).toContainEqual({ body: expect.objectContaining({ kind: "brief_send", brief: "am" }), delaySeconds: 900 });
    const pm = envWith(off);
    await enqueueScheduledMonitor(Date.UTC(2026, 10, 9, 9, 15), pm.env); // 17:15 Beijing
    expect(pm.sendBatch.mock.calls[0][0]).toContainEqual({ body: expect.objectContaining({ kind: "daily_brief", brief: "pm" }), delaySeconds: 180 });
    expect(pm.sendBatch.mock.calls[0][0]).toContainEqual({ body: expect.objectContaining({ kind: "brief_send", brief: "pm" }), delaySeconds: 900 });
    const late = envWith(off);
    await enqueueScheduledMonitor(Date.UTC(2026, 10, 9, 9, 40), late.env); // 17:40: nothing brief-related any more
    expect(JSON.stringify(late.sendBatch.mock.calls)).not.toContain("daily_brief");
    const other = envWith(off);
    await enqueueScheduledMonitor(Date.UTC(2026, 10, 9, 3, 15), other.env); // 11:15
    expect(JSON.stringify(other.sendBatch.mock.calls)).not.toContain("daily_brief");
  });

  it("triages 行业动态 on every firing and queues 行业报告 on the 舆情 report calendar", async () => {
    for (const minute of [15, 40]) {
      const env = envWith();
      await enqueueScheduledMonitor(Date.UTC(2026, 10, 9, 5, minute), env.env);
      expect(env.allBatches[0]).toContainEqual({ body: expect.objectContaining({ kind: "industry_triage" }) });
    }
    const friday = envWith();
    await enqueueScheduledMonitor(Date.UTC(2026, 10, 12, 19, 40), friday.env); // Fri 11-13 03:40 Beijing
    expect(friday.allBatches[0]).toContainEqual({ body: expect.objectContaining({ kind: "industry_weekly", report: "weekly" }), delaySeconds: 300 });
    expect(JSON.stringify(friday.allBatches)).not.toContain('"monthly"');
    const fridayEvening = envWith();
    await enqueueScheduledMonitor(Date.UTC(2026, 10, 13, 11, 15), fridayEvening.env); // Fri 19:15, the old slot
    expect(JSON.stringify(fridayEvening.allBatches)).not.toContain("industry_weekly");
    const firstOfMonth = envWith();
    await enqueueScheduledMonitor(Date.UTC(2026, 10, 30, 19, 40), firstOfMonth.env); // Tue 12-01 03:40 Beijing
    expect(firstOfMonth.allBatches[0]).toContainEqual({ body: expect.objectContaining({ kind: "industry_weekly", report: "monthly" }), delaySeconds: 420 });
    expect(JSON.stringify(firstOfMonth.allBatches)).not.toContain('"report":"weekly"');
  });

  it("checks for a one-off brief request on every firing", async () => {
    for (const minute of [15, 40]) {
      const env = envWith();
      await enqueueScheduledMonitor(Date.UTC(2026, 10, 9, 5, minute), env.env);
      expect(env.allBatches[0]).toContainEqual({ body: expect.objectContaining({ kind: "brief_request" }) });
    }
  });
});
