import { describe, expect, it } from "vitest";
import {
  binanceQueryBatches,
  binanceBrowserNeedsFallback,
  isBinanceSearchResponse,
  isBinanceSquarePayload,
  binanceSearchUrl,
  isBinancePostSearch,
  parseBinanceSquareResponse,
} from "./binance-square-browser";

it("falls back when Binance Browser returns an empty successful payload", () => {
  expect(binanceBrowserNeedsFallback({
    ok: true,
    posts: [],
    durationMs: 1,
    sessionId: "test",
    queriesRequested: 1,
    queriesExecuted: 1,
    queriesTruncated: 0,
    queriesAttempted: 1,
    queriesSucceeded: 1,
    diagnostics: [],
  })).toBe(true);
});

describe("parseBinanceSquareResponse", () => {
  it("turns Binance post cards into discovered posts", () => {
    const posts = parseBinanceSquareResponse({
      code: "000000",
      data: {
        vos: [
          {
            id: "123",
            cardType: "BUZZ_LONG",
            content: "孙宇晨发布了关于 TRON 生态的新进展，内容足够长。",
            authorName: "alice",
            date: 1_700_000_000,
          },
          {
            id: "widget",
            cardType: "KOL_GROUP",
            content: "This is not a post card.",
          },
        ],
      },
    });

    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      url: "https://www.binance.com/zh-CN/square/post/123",
      author: "alice",
      publishedAt: 1_700_000_000_000,
      sourcePlatform: "binance_square",
      fetchEngineHint: "cloudflare_browser",
    });
  });

  it.each([
    ["publishTime", 1_700_000_001, 1_700_000_001_000],
    ["publish_time", 1_700_000_002_000, 1_700_000_002_000],
    ["createTime", 1_700_000_003, 1_700_000_003_000],
    ["create_time", 1_700_000_004_000, 1_700_000_004_000],
    ["postTime", 1_700_000_005, 1_700_000_005_000],
  ])("reads the %s publication field", (field, value, expected) => {
    const posts = parseBinanceSquareResponse({
      code: "000000",
      data: { vos: [{
        id: field,
        cardType: "BUZZ_LONG",
        content: "孙宇晨发布了关于 TRON 生态的新进展，内容足够长。",
        [field]: value,
      }] },
    });
    expect(posts[0]?.publishedAt).toBe(expected);
  });

  it("rejects unsuccessful API envelopes", () => {
    expect(parseBinanceSquareResponse({
      code: "100001",
      data: { vos: [{ cardType: "BUZZ_LONG", content: "ignored content", id: "1" }] },
    })).toEqual([]);
  });

  it("recognizes empty successful search payloads", () => {
    expect(isBinanceSquarePayload({ code: "000000", data: { vos: [] } })).toBe(true);
    expect(isBinanceSquarePayload({ code: "100001", data: { vos: [] } })).toBe(false);
  });
});

it("groups eight one-query requests into four concurrency-two waves", () => {
  expect(binanceQueryBatches(
    ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8"],
    2,
  )).toEqual([
    ["q1", "q2"],
    ["q3", "q4"],
    ["q5", "q6"],
    ["q7", "q8"],
  ]);
});

describe("isBinanceSearchResponse", () => {
  it("uses the live search parameter and only accepts post results for the requested keyword", () => {
    expect(new URL(binanceSearchUrl("孙宇晨 TRON")).searchParams.get("s")).toBe("孙宇晨 TRON");
    const url = "https://www.binance.com/bapi/composite/v2/friendly/pgc/feed/search/list";
    expect(isBinancePostSearch(url, JSON.stringify({type:1,searchContent:"TRON"}), "TRON")).toBe(true);
    for (const request of [{type:2,searchContent:"TRON"},{type:3,searchContent:"TRON"},{type:1},{type:1,searchContent:"BTC"}]) {
      expect(isBinancePostSearch(url, JSON.stringify(request), "TRON")).toBe(false);
    }
    expect(isBinancePostSearch(url, "not json", "TRON")).toBe(false);
    expect(isBinancePostSearch("https://www.binance.com/bapi/other/list", '{"type":1,"searchContent":"TRON"}', "TRON")).toBe(false);
  });
  it("accepts only Binance bapi search-list responses", () => {
    expect(isBinanceSearchResponse(
      "https://www.binance.com/bapi/composite/v2/friendly/pgc/feed/search/list",
    )).toBe(true);
    expect(isBinanceSearchResponse("https://example.com/bapi/feed/search/list")).toBe(false);
  });
});
