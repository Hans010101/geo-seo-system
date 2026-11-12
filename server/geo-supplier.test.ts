import { describe, expect, it } from "vitest";
import { median, missingDaysBetween } from "./external";
import { factLine, summarizeFactCoverage } from "./fact-coverage";

describe("智推时代 supplier evaluation", () => {
  it("median of daily volumes", () => {
    expect(median([])).toBe(0);
    expect(median([1170, 2729, 1165])).toBe(1170);
    expect(median([1168, 1170])).toBe(1169);
  });

  it("lists days without delivery, excluding today", () => {
    const delivered = new Set(["2026-11-08", "2026-11-10", "2026-11-12"]);
    expect(missingDaysBetween("2026-11-08", "2026-11-12", delivered)).toEqual(["2026-11-09", "2026-11-11"]);
    expect(missingDaysBetween("2026-11-12", "2026-11-12", delivered)).toEqual([]);
  });
});

describe("事实与口径 coverage", () => {
  it("maps fact keys to brand lines", () => {
    expect(factLine("sun_forbes_recognized")).toBe("sun");
    expect(factLine("tron_low_fee")).toBe("tron");
    expect(factLine("legacy_fact")).toBeNull();
  });

  it("counts a fact only on its own brand line's answers", () => {
    const rows = summarizeFactCoverage([
      { factKey: "tron_low_fee", platform: "kimi", line: "tron", total: 10, hit: 4 },
      { factKey: "tron_low_fee", platform: "kimi", line: "sun", total: 30, hit: 1 },
      { factKey: "tron_low_fee", platform: "doubao", line: "tron", total: 10, hit: 0 },
      { factKey: "sun_forbes_recognized", platform: "kimi", line: "sun", total: 5, hit: 5 },
      { factKey: "legacy_fact", platform: "kimi", line: "other", total: 2, hit: 1 },
      { factKey: "legacy_fact", platform: "kimi", line: "tron", total: 3, hit: 0 },
    ]);
    const by = new Map(rows.map(r => [r.factKey, r]));
    expect(by.get("tron_low_fee")).toMatchObject({ total: 20, hit: 4 });
    expect(by.get("tron_low_fee")!.platforms).toEqual([
      { platform: "doubao", total: 10, hit: 0 },
      { platform: "kimi", total: 10, hit: 4 },
    ]);
    expect(by.get("sun_forbes_recognized")).toMatchObject({ total: 5, hit: 5 });
    expect(by.get("legacy_fact")).toMatchObject({ total: 5, hit: 1 });
  });
});
