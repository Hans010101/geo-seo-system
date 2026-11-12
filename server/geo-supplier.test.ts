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

describe("主题对照", () => {
  it("aggregates 智推 questions by topic and self-test by the matching questions", async () => {
    const { buildTopicComparison } = await import("./external");
    const r = buildTopicComparison(
      [
        { question: "关于孙宇晨的争议是真的吗 ？", platform: "doubao", total: 10, positive: 2, negative: 8 },
        { question: "外界对孙宇晨的争议是否属实 ？", platform: "kimi", total: 10, positive: 5, negative: 5 },
        { question: "波场TRON安全吗？", platform: "qianwen", total: 4, positive: 4, negative: 0 },
        { question: "以太坊好用吗？", platform: "kimi", total: 3, positive: 3, negative: 0 },
      ],
      [
        { questionId: "SYC-EMO-15", platform: "doubao", total: 2, positive: 0, negative: 1 },
        { questionId: "SYC-EMO-15", platform: "chatgpt", total: 2, positive: 1, negative: 0 },
        { questionId: "TRON-EMO-02", platform: "tongyi", total: 1, positive: 1, negative: 0 },
        { questionId: "SYC-REC-01", platform: "doubao", total: 5, positive: 5, negative: 0 },
      ],
      14,
    );
    const controversy = r.topics.find(t => t.id === "sun_controversy")!;
    expect(controversy.vendor).toEqual({ total: 20, positive: 7, negative: 13 });
    expect(controversy.selfMatched).toEqual({ total: 2, positive: 0, negative: 1 });
    expect(controversy.selfAll).toEqual({ total: 4, positive: 1, negative: 1 });
    expect(controversy.platforms.find(p => p.platform === "doubao")).toMatchObject({ vendor: { total: 10, negative: 8 }, self: { total: 2, negative: 1 } });
    expect(controversy.selfOtherPlatforms).toEqual([{ platform: "chatgpt", total: 2, positive: 1, negative: 0 }]);
    expect(controversy.questions[0]).toEqual({ question: "关于孙宇晨的争议是真的吗 ？", total: 10, negative: 8 });
    expect(r.topics.find(t => t.id === "tron_security")!.platforms.find(p => p.platform === "qianwen")!.self.total).toBe(1);
    expect(r.unmapped).toEqual([{ question: "以太坊好用吗？", total: 3 }]);
    expect(r.byLine.find(l => l.line === "sun")).toMatchObject({ total: 20, negative: 13 });
    expect(r.byLine.find(l => l.line === "tron")).toMatchObject({ total: 4, negative: 0 });
  });
});
