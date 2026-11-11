import { describe, expect, it } from "vitest";
import {
  DAY, HOUR, bigrams, findDuplicate, itemId, parseIndustryBatch, parseTriage, pickTop, similarity, triagePrompt,
  type IndustryRow,
} from "./industry-calc";
import { parseIndustryMetrics, parseIndustrySnapshot } from "./industry-metrics";

const NOW = Date.UTC(2026, 10, 11, 4, 0);

describe("行业动态 ingest", () => {
  it("keeps valid feed items and drops stale, future or broken ones", () => {
    const items = parseIndustryBatch({
      items: [
        { source: "chaincatcher", url: "https://www.chaincatcher.com/article/1", title: " <b>Tether</b> 冻结 USDT ", excerpt: "x", publishedAt: NOW - HOUR },
        { source: "odaily", url: "ftp://bad", title: "t", publishedAt: NOW },
        { source: "odaily", url: "https://a.test/old", title: "old", publishedAt: NOW - 8 * DAY },
        { source: "odaily", url: "https://a.test/future", title: "future", publishedAt: NOW + 2 * HOUR },
      ],
    }, NOW);
    expect(items).toEqual([{ source: "chaincatcher", url: "https://www.chaincatcher.com/article/1", title: "Tether 冻结 USDT", excerpt: "x", publishedAt: NOW - HOUR }]);
    expect(() => parseIndustryBatch({ items: [{ source: "evil", url: "https://x", title: "t", publishedAt: NOW }] }, NOW)).toThrow("Unknown source");
  });

  it("gives every URL a stable id", () => {
    expect(itemId("https://a.test/1")).toBe(itemId("https://a.test/1"));
    expect(itemId("https://a.test/1")).not.toBe(itemId("https://a.test/2"));
  });
});

describe("near-duplicate detection", () => {
  it("matches reposts of the same newsflash across Chinese outlets", () => {
    const a = "Tether 联合 Anchorage、Kraken 等成立 FASE 基金会，试点稳定币人道援助";
    const b = "消息：Tether 联合 Anchorage 与 Kraken 成立 FASE 基金会，试点稳定币人道主义援助";
    const c = "Strategy 上周增持 250 枚比特币，累计持有 848,250 枚";
    expect(similarity(bigrams(a), bigrams(b))).toBeGreaterThan(0.55);
    expect(findDuplicate(b, [bigrams(c), bigrams(a)])).toBe(1);
    expect(findDuplicate(c, [bigrams(a)])).toBe(-1);
    expect(findDuplicate("短讯", [bigrams("短讯")])).toBe(-1); // too short to judge
  });
});

describe("LLM triage", () => {
  it("builds a prompt that lists every item with its index", () => {
    const p = triagePrompt([{ i: 0, source: "Odaily", title: "美联储维持利率不变", excerpt: "" }]);
    expect(p.user).toBe("[0] (Odaily) 美联储维持利率不变");
    expect(p.system).toContain("importance");
  });

  it("parses, clamps and normalizes the model output", () => {
    const text = `好的：[
      {"i":0,"keep":true,"category":"macro","importance":7,"entities":["Tether","binance","nope"],"tron":1,"tronNote":"USDT 主要在 TRON","summary":"美联储维持利率"},
      {"i":1,"keep":false,"category":"weird","importance":0,"entities":[],"tron":5,"tronNote":"x","summary":""},
      {"i":2,"keep":true,"category":"chain","importance":3,"entities":[],"tron":2,"tronNote":"波场","summary":"TRON 升级"},
      {"i":9,"keep":true}
    ]`;
    const out = parseTriage(text, new Set([0, 1, 2]));
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ importance: 5, entities: ["tether", "binance"], tron: 1, category: "macro" });
    expect(out[1]).toMatchObject({ keep: false, category: "other", importance: 1, tron: 0, tronNote: "" });
    expect(out[2].entities).toEqual(["tron"]);
    expect(() => parseTriage("抱歉", new Set([0]))).toThrow();
  });
});

describe("selection", () => {
  const row = (id: string, category: string, importance: number, extra: Partial<IndustryRow> = {}): IndustryRow => ({
    id, source: "odaily", url: `https://a.test/${id}`, title: id, summary: id, publishedAt: NOW, category, importance,
    entities: "[]", tron: 0, tronNote: null, sourceCount: 1, ...extra,
  });
  it("ranks by importance, corroboration and TRON relevance, capped per category", () => {
    const rows = [
      row("a", "macro", 4), row("b", "macro", 4, { sourceCount: 4 }), row("c", "macro", 5), row("d", "macro", 4),
      row("e", "exchange", 3, { tron: 2 }), row("f", "exchange", 2),
    ];
    expect(pickTop(rows, 5, 2).map(r => r.id)).toEqual(["c", "b", "e"]);
  });
});

describe("metrics ingest", () => {
  it("validates daily rows and snapshots", () => {
    expect(parseIndustryMetrics({ rows: [{ day: "2026-11-11", entity: "tron", metric: "usdt", value: 9.2e10 }] }))
      .toEqual([{ day: "2026-11-11", entity: "tron", metric: "usdt", value: 9.2e10 }]);
    expect(() => parseIndustryMetrics({ rows: [{ day: "2026-11-11", entity: "Tron!", metric: "usdt", value: 1 }] })).toThrow();
    expect(() => parseIndustryMetrics({ rows: [{ day: "2026-11-11", entity: "tron", metric: "usdt", value: "1" }] })).toThrow();
    expect(parseIndustrySnapshot({ kind: "fed", data: { at: 1, events: [] } }).kind).toBe("fed");
    expect(() => parseIndustrySnapshot({ kind: "other", data: {} })).toThrow();
  });
});

describe("早晚报行业动态板块", () => {
  it("picks the top items and builds the macro strip", async () => {
    const { briefIndustrySection } = await import("./industry-calc");
    const rows: IndustryRow[] = [
      { id: "a", source: "odaily", url: "https://a.test/a", title: "a", summary: "美联储维持利率", publishedAt: NOW, category: "macro", importance: 5, entities: "[]", tron: 0, tronNote: null, sourceCount: 3 },
      { id: "b", source: "theblock", url: "https://a.test/b", title: "b", summary: "Tether 增发", publishedAt: NOW, category: "stablecoin", importance: 4, entities: "[\"tether\"]", tron: 1, tronNote: "USDT 主要在 TRON", sourceCount: 1 },
      { id: "c", source: "odaily", url: "https://a.test/c", title: "c", summary: "小项目", publishedAt: NOW, category: "chain", importance: 2, entities: "[]", tron: 0, tronNote: null, sourceCount: 1 },
    ];
    const macro = [
      { symbol: "NASDAQ", name: "纳斯达克", unit: null, price: 25066.2, change1d: -0.73 },
      { symbol: "US10Y", name: "10 年期美债收益率", unit: "%", price: 4.983, change1d: 12 },
    ];
    const fed = { events: [{ title: "Fed Decision in December?", outcomes: [{ label: "25 bps increase", prob: 85.5 }] }] };
    const s = briefIndustrySection(rows, macro, fed, 29);
    expect(s.items.map(i => i.summary)).toEqual(["美联储维持利率", "Tether 增发"]);
    expect(s.items[1]).toMatchObject({ tron: 1, categoryLabel: "稳定币与支付", source: "The Block" });
    expect(s.macro).toEqual([
      { label: "纳斯达克", value: "25,066", change: "-0.73%", dir: "down" },
      { label: "10Y 美债", value: "4.98%", change: "+12bp", dir: "up" },
      { label: "12 月议息", value: "加息 25bp 86%", change: "", dir: "flat" },
      { label: "恐慌贪婪", value: "29", change: "", dir: "flat" },
    ]);
    expect(s.total).toBe(3);
  });
});
