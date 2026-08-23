import { z } from "zod";
import { dispatchNotification } from "./notification";
import { adminProcedure, protectedProcedure, publicProcedure, router } from "./trpc";

const cloudflareStatusSchema = z.object({
  ok: z.boolean().optional(),
  mode: z.string().optional(),
  execution: z.string().optional(),
  status: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const systemRouter = router({
  health: publicProcedure
    .input(
      z.object({
        timestamp: z.number().min(0, "timestamp cannot be negative"),
      })
    )
    .query(() => ({
      ok: true,
    })),

  cloudflareStatus: protectedProcedure.query(async () => {
    try {
      const response = await fetch("https://geo-seo-system-cron.hans-pan007.workers.dev", {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const payload = cloudflareStatusSchema.parse(await response.json());
      const status = payload.status ?? {};
      return {
        ok: payload.ok !== false,
        mode: payload.mode ?? null,
        execution: payload.execution ?? null,
        fetchedAt: Date.now(),
        task: status.task ?? null,
        taskStatus: status.status ?? null,
        finishedAt: status.finishedAt ?? null,
        profiles: status.profiles ?? {},
        binance: status.binance ?? null,
        wechat: status.wechat ?? null,
        dailyGeo: status.dailyGeo ?? null,
        weeklyGeo: status.weeklyGeo ?? null,
        browserFulltext: status.browserFulltext ?? null,
        chineseSocial: status.chineseSocial ?? null,
        migrationAcceptance: status.migrationAcceptance ?? null,
        error: null,
      };
    } catch (error) {
      return {
        ok: false,
        mode: null,
        execution: null,
        fetchedAt: Date.now(),
        task: null,
        taskStatus: null,
        finishedAt: null,
        profiles: {},
        binance: null,
        wechat: null,
        dailyGeo: null,
        weeklyGeo: null,
        browserFulltext: null,
        chineseSocial: null,
        migrationAcceptance: null,
        error: error instanceof Error ? error.message : "Cloudflare 状态读取失败",
      };
    }
  }),

  notifyOwner: adminProcedure
    .input(
      z.object({
        title: z.string().min(1, "title is required"),
        content: z.string().min(1, "content is required"),
      })
    )
    .mutation(async ({ input }) => {
      await dispatchNotification({
        messageType: "alert",
        title: input.title,
        content: input.content,
        severity: "high",
      });
      return { success: true } as const;
    }),
});
