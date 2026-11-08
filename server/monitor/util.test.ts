import { describe, expect, it } from "vitest";
import {
  MONITOR_RETENTION_DAYS,
  keywordMatchesText,
  monitorArticleMatchesKeywords,
  monitorContentHash,
  monitorPublishedAtFreshness,
  parseSerperDate,
} from "./util";

describe("monitor freshness", () => {
  const now = Date.UTC(2026, 7, 4, 4, 0, 0);

  it("accepts only verifiable publication dates inside seven days", () => {
    expect(monitorPublishedAtFreshness(now - 7 * 86_400_000, now)).toBe("fresh");
    expect(monitorPublishedAtFreshness(now - 7 * 86_400_000 - 1, now)).toBe("stale");
    expect(monitorPublishedAtFreshness(null, now)).toBe("missing");
    expect(monitorPublishedAtFreshness(now + 86_400_000 + 1, now)).toBe("future");
  });

  it("retains verified monitor records for one hundred days", () => {
    expect(MONITOR_RETENTION_DAYS).toBe(100);
  });

  it("parses English and Chinese relative source timestamps", () => {
    expect(parseSerperDate("3 hours ago", now)).toBe(now - 3 * 3_600_000);
    expect(parseSerperDate("2天前", now)).toBe(now - 2 * 86_400_000);
    expect(parseSerperDate("刚刚", now)).toBe(now);
  });

  it("produces the same duplicate fingerprint for harmless text differences", () => {
    expect(monitorContentHash("TRON  Weekly\nReport")).toBe(
      monitorContentHash("tron weekly report"),
    );
    expect(monitorContentHash("ＴＲＯＮ")).toBe(monitorContentHash("tron"));
  });

  it("requires the monitored core entity instead of a loose qualifier", () => {
    expect(keywordMatchesText("Justin Sun", "Staring At The Sun")).toBe(false);
    expect(keywordMatchesText("Justin Sun", "Justin Sun discusses TRON")).toBe(true);
    expect(keywordMatchesText("孙宇晨 HTX", "PENGU 突破，HTX 行情数据")).toBe(false);
    expect(keywordMatchesText("孙宇晨 火币", "孙宇晨发表最新观点")).toBe(false);
    expect(keywordMatchesText("孙宇晨 HTX", "孙宇晨谈 HTX 新进展")).toBe(true);
    expect(keywordMatchesText("HTX", "HTX 上线新资产")).toBe(false);
    expect(keywordMatchesText("HTX", "孙宇晨回应 HTX 新进展")).toBe(true);
    expect(keywordMatchesText("孙哥", "隔壁孙哥今天发新歌")).toBe(false);
    expect(keywordMatchesText("孙哥", "孙哥继续建设波场生态")).toBe(true);
    expect(keywordMatchesText("TRON", "electron microscopy")).toBe(false);
  });

  it("ignores keyword hits leaked from recommendation sections", () => {
    expect(monitorArticleMatchesKeywords(
      ["孙宇晨"],
      "山东各城市专属饮品盘点",
      "青岛啤酒与崂山可乐。 相关推荐. 孙宇晨谈波场生态",
    )).toBe(false);
    expect(monitorArticleMatchesKeywords(["孙宇晨"], "孙宇晨谈波场", "最新行业动态")).toBe(true);
    expect(monitorArticleMatchesKeywords(["TRON"], "奥迪 e-tron 试驾", "新车体验")).toBe(false);
    expect(monitorArticleMatchesKeywords(["TRON"], "TRON network activity rises", "crypto market")).toBe(true);
  });
});
