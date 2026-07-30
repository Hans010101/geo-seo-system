import { describe, expect, it } from "vitest";
import { summarizeMigrationAcceptance } from "./migration-acceptance-types";

const WINDOW_START = Date.UTC(2026, 6, 30, 2, 12, 35);

describe("migration acceptance summary", () => {
  it("keeps the seven-day time gate closed even with successful early runs", () => {
    const result = summarizeMigrationAcceptance({
      windowStart: WINDOW_START,
      now: WINDOW_START + 2 * 86_400_000,
      cycles: [],
      browser: [],
      notifications: [],
      binance: [{
        runId: "probe:1",
        mode: "shadow",
        provider: "serper",
        status: "partial",
        startedAt: WINDOW_START,
        finishedAt: WINDOW_START + 1_000,
        rawPosts: 10,
        matchedPosts: 10,
        enqueued: 0,
        queriesAttempted: 3,
        queriesSucceeded: 1,
        validSampleUrls: 3,
        invalidSampleUrls: 0,
        errors: ["browser unavailable"],
      }],
    });
    expect(result.stage3Binance.verdict).toBe("observing");
    expect(result.stage3Binance.operationalSuccessRatePct).toBe(100);
  });

  it("passes after seven days at or above 90 percent with valid samples", () => {
    const binance = Array.from({ length: 10 }, (_, index) => ({
      runId: `run:${index}`,
      mode: "write" as const,
      provider: "serper" as const,
      status: (index === 9 ? "failed" : "success") as "success" | "failed",
      startedAt: WINDOW_START + index * 1_000,
      finishedAt: WINDOW_START + index * 1_000 + 500,
      rawPosts: index === 9 ? 0 : 4,
      matchedPosts: index === 9 ? 0 : 3,
      enqueued: index === 9 ? 0 : 2,
      queriesAttempted: 2,
      queriesSucceeded: index === 9 ? 0 : 1,
      validSampleUrls: index === 9 ? 0 : 2,
      invalidSampleUrls: 0,
      errors: index === 9 ? ["failed"] : [],
    }));
    const result = summarizeMigrationAcceptance({
      windowStart: WINDOW_START,
      now: WINDOW_START + 7 * 86_400_000,
      cycles: [],
      binance,
      browser: [],
      notifications: [],
    });
    expect(result.stage3Binance.operationalSuccessRatePct).toBe(90);
    expect(result.stage3Binance.verdict).toBe("pass");
  });
});
