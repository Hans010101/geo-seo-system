import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getSysConfig: vi.fn(),
  setSysConfig: vi.fn(),
  incrementSysConfig: vi.fn(),
  resetMonitorBudgetMonth: vi.fn(),
  reserveSysConfigCredit: vi.fn(),
}));

vi.mock("../db", () => dbMocks);

import { recordSerperUsage, reserveQueuedBudget } from "./budget";

describe("Serper usage accounting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T00:00:00Z"));
    vi.clearAllMocks();
    dbMocks.getSysConfig.mockImplementation(async (key: string) => ({
      monitor_counters_month: "2026-08",
      monitor_firecrawl_used_this_month: "0",
      monitor_serper_used_this_month: "8225",
      monitor_x_used_this_month: "0",
      monitor_firecrawl_monthly_limit: "800",
      monitor_serper_monthly_limit: "30000",
      monitor_x_monthly_limit: "60000",
      monitor_max_articles_per_cycle: "80",
    })[key] ?? null);
  });

  afterEach(() => vi.useRealTimers());

  it("does not count queued capacity as provider usage", async () => {
    await expect(reserveQueuedBudget({ serper: 10 })).resolves.toMatchObject({ serper: 10 });
    expect(dbMocks.setSysConfig).not.toHaveBeenCalledWith(
      "monitor_serper_used_this_month",
      expect.any(String),
    );

    await recordSerperUsage();
    expect(dbMocks.incrementSysConfig).toHaveBeenCalledWith("monitor_serper_used_this_month");
  });

  it("reserves every paid Gate credit through the atomic shared guard", async () => {
    dbMocks.reserveSysConfigCredit.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await reserveQueuedBudget({ firecrawl: 2 })).toMatchObject({ firecrawl: 1 });
    expect(dbMocks.reserveSysConfigCredit).toHaveBeenCalledTimes(2);
    expect(dbMocks.setSysConfig).not.toHaveBeenCalled();
  });
});
