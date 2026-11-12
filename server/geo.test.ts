import { describe, expect, it, vi, beforeEach } from "vitest";
import { appRouter } from "./routers";
import * as db from "./db";
import * as claims from "./collection-claims";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAdminContext(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 1,
    openId: "admin-user",
    email: "admin@example.com",
    name: "Admin User",
    loginMethod: "manus",
    role: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };

  return {
    user,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: () => {},
    } as TrpcContext["res"],
  };
}

function createUserContext(): TrpcContext {
  const user: AuthenticatedUser = {
    id: 2,
    openId: "regular-user",
    email: "user@example.com",
    name: "Regular User",
    loginMethod: "manus",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };

  return {
    user,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: () => {},
    } as TrpcContext["res"],
  };
}

function createDeveloperContext(email: string): TrpcContext {
  const ctx = createAdminContext();
  return { ...ctx, user: { ...ctx.user!, email, role: "developer" } };
}

function createUnauthContext(): TrpcContext {
  return {
    user: null,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: () => {},
    } as TrpcContext["res"],
  };
}

describe("GEO Platform API", () => {
  // ==================== Auth Tests ====================
  describe("auth.me", () => {
    it("returns user when authenticated", async () => {
      const ctx = createAdminContext();
      const caller = appRouter.createCaller(ctx);
      const result = await caller.auth.me();
      expect(result).toBeDefined();
      expect(result?.openId).toBe("admin-user");
      expect(result?.role).toBe("admin");
    });

    it("returns null when unauthenticated", async () => {
      const ctx = createUnauthContext();
      const caller = appRouter.createCaller(ctx);
      const result = await caller.auth.me();
      expect(result).toBeNull();
    });
  });

  // ==================== Questions Tests ====================
  describe("questions", () => {
    it("lists questions for authenticated user", async () => {
      const ctx = createUserContext();
      const caller = appRouter.createCaller(ctx);
      const result = await caller.questions.list({});
      expect(Array.isArray(result)).toBe(true);
    });

    it("filters questions by brandLine", async () => {
      const ctx = createUserContext();
      const caller = appRouter.createCaller(ctx);
      const result = await caller.questions.list({ brandLine: "tron" });
      expect(Array.isArray(result)).toBe(true);
      result.forEach((q) => {
        expect(q.brandLine).toBe("tron");
      });
    });

    it("rejects unauthenticated access to questions list", async () => {
      const ctx = createUnauthContext();
      const caller = appRouter.createCaller(ctx);
      await expect(caller.questions.list({})).rejects.toThrow();
    });

    it("rejects non-admin from creating questions", async () => {
      const ctx = createUserContext();
      const caller = appRouter.createCaller(ctx);
      await expect(
        caller.questions.create({
          questionId: "TEST-01",
          text: "Test question",
          brandLine: "tron",
          dimension: "awareness",
          language: "zh-CN",
        })
      ).rejects.toThrow();
    });

    it("admin can get a specific question", async () => {
      const ctx = createAdminContext();
      const caller = appRouter.createCaller(ctx);
      const result = await caller.questions.get({ questionId: "SYC-CN-01" });
      if (result) {
        expect(result.questionId).toBe("SYC-CN-01");
        expect(result.brandLine).toBe("sun_yuchen");
      }
    });
  });

  // ==================== Platform Configs Tests ====================
  describe("platformConfigs", () => {
    it("lists platform configs", async () => {
      const ctx = createUserContext();
      const caller = appRouter.createCaller(ctx);
      const result = await caller.platformConfigs.list();
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThanOrEqual(0);
    });

    it("rejects non-admin from upserting platform config", async () => {
      const ctx = createUserContext();
      const caller = appRouter.createCaller(ctx);
      await expect(
        caller.platformConfigs.upsert({
          platform: "chatgpt",
          displayName: "ChatGPT",
          isEnabled: false,
        })
      ).rejects.toThrow();
    });
  });

  // ==================== Target Facts Tests ====================
  describe("targetFacts", () => {
    it("lists target facts", async () => {
      const ctx = createUserContext();
      const caller = appRouter.createCaller(ctx);
      const result = await caller.targetFacts.list({});
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThanOrEqual(0);
    });

    it("rejects non-admin from creating target facts", async () => {
      const ctx = createUserContext();
      const caller = appRouter.createCaller(ctx);
      await expect(
        caller.targetFacts.create({
          factKey: "test_fact",
          factDescription: "Test fact",
        })
      ).rejects.toThrow();
    });
  });

  // ==================== Dashboard Tests ====================
  describe("dashboard", () => {
    it("returns dashboard summary", async () => {
      const ctx = createUserContext();
      const caller = appRouter.createCaller(ctx);
      const now = Date.now();
      const result = await caller.dashboard.summary({
        startTime: now - 7 * 24 * 60 * 60 * 1000,
        endTime: now,
      });
      expect(result).toBeDefined();
      expect(result).toHaveProperty("totalCollections");
      expect(result).toHaveProperty("overallSentimentAvg");
    });

    it("returns heatmap data", async () => {
      const ctx = createUserContext();
      const caller = appRouter.createCaller(ctx);
      const now = Date.now();
      const result = await caller.dashboard.heatmap({
        startTime: now - 7 * 24 * 60 * 60 * 1000,
        endTime: now,
      });
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // ==================== Alerts Tests ====================
  describe("alerts", () => {
    it("lists alerts", async () => {
      const ctx = createUserContext();
      const caller = appRouter.createCaller(ctx);
      const result = await caller.alerts.list({});
      expect(Array.isArray(result.data)).toBe(true);
    });
  });

  // ==================== Our Content Tests ====================
  describe("ourContent", () => {
    it("lists our content URLs", async () => {
      const ctx = createUserContext();
      const caller = appRouter.createCaller(ctx);
      const result = await caller.ourContent.list({});
      expect(Array.isArray(result)).toBe(true);
    });

    it("rejects non-admin from creating content URLs", async () => {
      const ctx = createUserContext();
      const caller = appRouter.createCaller(ctx);
      await expect(
        caller.ourContent.create({
          url: "https://test.com",
          title: "Test",
        })
      ).rejects.toThrow();
    });
  });

  // ==================== Collections Tests ====================
  describe("collections", () => {
    it("lists collections", async () => {
      const ctx = createUserContext();
      const caller = appRouter.createCaller(ctx);
      const result = await caller.collections.list({});
      expect(result).toBeDefined();
      expect(result).toHaveProperty("data");
      expect(Array.isArray(result.data)).toBe(true);
    });

    it("rejects non-admin from triggering collection", async () => {
      const ctx = createUserContext();
      const caller = appRouter.createCaller(ctx);
      await expect(
        caller.collections.trigger({
          questionId: "SYC-CN-01",
          platform: "chatgpt",
        })
      ).rejects.toThrow();
    });

    it("restricts batch collection to the 007 developer account", async () => {
      const caller = appRouter.createCaller(createDeveloperContext("other@example.com"));
      await expect(caller.collections.batchTrigger()).rejects.toThrow("批量采集仅限 007 开发者账户");
    });

    it("rejects Wenxin collection and re-enabling before any database write", async () => {
      const caller = appRouter.createCaller(createDeveloperContext("hans.pan007@gmail.com"));
      await expect(caller.collections.trigger({ questionId: "SYC-CN-01", platform: "wenxin" })).rejects.toThrow("文心一言已停用");
      await expect(caller.collections.triggerAllQuestions({ platform: "wenxin" })).rejects.toThrow("文心一言已停用");
      await expect(caller.platformConfigs.upsert({ platform: "wenxin", displayName: "文心一言", isEnabled: true })).rejects.toThrow("文心一言已停用");
    });

    it("preserves historical Wenxin rows when retry is requested", async () => {
      const caller = appRouter.createCaller(createDeveloperContext("hans.pan007@gmail.com"));
      vi.spyOn(db, "getCollectionsByIds").mockResolvedValue([{ id: 7, platform: "wenxin", status: "failed" }] as any);
      const update = vi.spyOn(db, "updateCollection").mockResolvedValue(undefined);
      try {
        await expect(caller.collections.batchRetry({ ids: [7] })).rejects.toThrow("文心一言已停用");
        expect(update).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("blocks old pending Wenxin work without calling any model provider", async () => {
      const caller = appRouter.createCaller(createDeveloperContext("hans.pan007@gmail.com"));
      vi.spyOn(db, "getBatchProgress").mockResolvedValue({ total: 1, completed: 0, failed: 0, pending: 1 } as any);
      vi.spyOn(claims, "claimClient").mockResolvedValue({} as any);
      vi.spyOn(claims, "expireExhaustedRows").mockResolvedValue(0);
      vi.spyOn(claims, "claimPendingRows")
        .mockResolvedValueOnce([{ id: 7, questionId: "Q1", platform: "wenxin", attempts: 1 }])
        .mockResolvedValue([]);
      vi.spyOn(db, "getQuestionById").mockResolvedValue({ questionId: "Q1", text: "Test", language: "zh-CN" } as any);
      const update = vi.spyOn(db, "updateCollection").mockResolvedValue(undefined);
      const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected paid request"));
      try {
        const result = await caller.collections.executeNextBatch({ batchId: "old-batch" });
        expect(result.failed).toBe(1);
        expect(update).toHaveBeenCalledWith(7, { status: "failed", errorMessage: "文心一言已停用，不再采集" });
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
      }
    });
  });

  // ==================== URL Match Rules Tests ====================
  describe("urlMatchRules", () => {
    it("lists URL match rules", async () => {
      const ctx = createUserContext();
      const caller = appRouter.createCaller(ctx);
      const result = await caller.urlMatchRules.list();
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThanOrEqual(0);
    });
  });

  // ==================== Scheduler Tests ====================
  describe("scheduler", () => {
    it("returns scheduler config for authenticated user", async () => {
      const ctx = createUserContext();
      const caller = appRouter.createCaller(ctx);
      const result = await caller.scheduler.getConfig();
      expect(result).toBeDefined();
      expect(result).toHaveProperty("enabled");
      expect(result).toHaveProperty("cronExpression");
      expect(result).toHaveProperty("concurrency");
      expect(typeof result.enabled).toBe("boolean");
    });

    it("rejects unauthenticated access to scheduler config", async () => {
      const ctx = createUnauthContext();
      const caller = appRouter.createCaller(ctx);
      await expect(caller.scheduler.getConfig()).rejects.toThrow();
    });

    it("rejects non-admin from updating scheduler config", async () => {
      const ctx = createUserContext();
      const caller = appRouter.createCaller(ctx);
      await expect(
        caller.scheduler.updateConfig({ enabled: true, cronExpression: "0 9 * * *" })
      ).rejects.toThrow();
    });

    it("admin can update scheduler config", async () => {
      const ctx = createAdminContext();
      const caller = appRouter.createCaller(ctx);
      const result = await caller.scheduler.updateConfig({
        enabled: false,
        cronExpression: "0 12 * * *",
        concurrency: 8,
      });
      expect(result.success).toBe(true);
    });
  });

  // ==================== Global API Keys Tests ====================
  describe("globalApiKeys", () => {
    it("lists global API keys with masked values", async () => {
      const ctx = createUserContext();
      const caller = appRouter.createCaller(ctx);
      const result = await caller.globalApiKeys.list();
      expect(Array.isArray(result)).toBe(true);
      // Each item should have apiKeyMasked field
      result.forEach((k) => {
        expect(k).toHaveProperty("apiKeyMasked");
      });
    });

    it("rejects non-admin from upserting global API keys", async () => {
      const ctx = createUserContext();
      const caller = appRouter.createCaller(ctx);
      await expect(
        caller.globalApiKeys.upsert({
          name: "Test Key",
          apiKey: "sk-test-key",
        })
      ).rejects.toThrow();
    });

    it("rejects unauthenticated access to global API keys", async () => {
      const ctx = createUnauthContext();
      const caller = appRouter.createCaller(ctx);
      await expect(caller.globalApiKeys.list()).rejects.toThrow();
    });
  });

  // ==================== Collections Export Tests ====================
  describe("collections.exportCsv", () => {
    it("returns collection data for export", async () => {
      const ctx = createUserContext();
      const caller = appRouter.createCaller(ctx);
      const result = await caller.collections.exportCsv({});
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // ==================== Weekly Reports Tests ====================
  describe("weeklyReports", () => {
    it("lists weekly reports", async () => {
      const ctx = createUserContext();
      const caller = appRouter.createCaller(ctx);
      const result = await caller.weeklyReports.list({});
      expect(Array.isArray(result)).toBe(true);
    });

    it("rejects non-admin from generating reports", async () => {
      const ctx = createUserContext();
      const caller = appRouter.createCaller(ctx);
      await expect(
        caller.weeklyReports.generate({ reportWeek: "2026-W15" })
      ).rejects.toThrow();
    });

    it("lets admins generate a weekly report", async () => {
      const caller = appRouter.createCaller(createAdminContext());
      await expect(caller.weeklyReports.generate({ reportWeek: "2026-W34" }))
        .resolves.toEqual({ success: true, reportWeek: "2026082120260827", reportPeriod: "2026-08-21 ~ 2026-08-27" });
    });

    it("uses the selected dates for every GEO report aggregate and rejects invalid ranges", async () => {
      const caller = appRouter.createCaller(createAdminContext());
      const summary = vi.spyOn(db, "getDashboardSummary");
      const heatmap = vi.spyOn(db, "getHeatmapData");
      const citations = vi.spyOn(db, "getTopCitedUrls");
      const alerts = vi.spyOn(db, "getReportAlerts");
      const save = vi.spyOn(db, "upsertWeeklyReport");
      try {
        await expect(caller.weeklyReports.generate({ dateRange: { startDate: "2026-09-25", endDate: "2026-10-01" } }))
          .resolves.toEqual({ success: true, reportWeek: "2026092520261001", reportPeriod: "2026-09-25 ~ 2026-10-01" });
        const start = Date.parse("2026-09-25T00:00:00+08:00");
        const end = Date.parse("2026-10-01T23:59:59.999+08:00");
        expect(summary).toHaveBeenCalledWith(start, end);
        expect(heatmap).toHaveBeenCalledWith(start, end);
        expect(citations).toHaveBeenCalledWith(20, start, end);
        expect(alerts).toHaveBeenCalledWith(start, end);
        expect(save).toHaveBeenCalledWith(expect.objectContaining({ reportPeriod: "2026-09-25 ~ 2026-10-01" }));
        await expect(caller.weeklyReports.generate({ dateRange: { startDate: "2026-10-02", endDate: "2026-10-01" } })).rejects.toThrow();
        await expect(caller.monitor.generateReport({ reportType: "monthly", dateRange: { startDate: "2026-09-25", endDate: "2026-10-01" } })).rejects.toThrow();
      } finally {
        vi.restoreAllMocks();
      }
    });

    it("generates a calendar-month GEO report with a month-over-month comparison", async () => {
      const caller = appRouter.createCaller(createAdminContext());
      const summary = vi.spyOn(db, "getDashboardSummary");
      const save = vi.spyOn(db, "upsertWeeklyReport");
      try {
        await expect(caller.weeklyReports.generate({ reportType: "monthly", month: "2026-10" }))
          .resolves.toEqual({ success: true, reportWeek: "202610", reportPeriod: "2026-10" });
        const start = Date.parse("2026-10-01T00:00:00+08:00");
        const end = Date.parse("2026-11-01T00:00:00+08:00") - 1;
        expect(summary).toHaveBeenCalledWith(start, end);
        expect(summary).toHaveBeenCalledWith(Date.parse("2026-09-01T00:00:00+08:00"), start - 1);
        expect(save).toHaveBeenCalledWith(expect.objectContaining({
          reportWeek: "202610", reportPeriod: "2026-10",
          summaryMetrics: expect.objectContaining({ previousPeriod: "2026-09-01 ~ 2026-09-30" }),
        }));
        await expect(caller.weeklyReports.generate({ reportType: "monthly", month: "2026-13" })).rejects.toThrow();
      } finally {
        vi.restoreAllMocks();
      }
    });
  });
});
