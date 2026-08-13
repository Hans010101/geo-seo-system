import { describe, expect, it } from "vitest";
import {
  binanceBrowserNeedsFallback,
  isBinanceSearchResponse,
  isBinanceSquarePayload,
  parseBinanceSquareResponse,
} from "./binance-square-browser";

it("falls back when Binance Browser returns an empty successful payload", () => {
  expect(binanceBrowserNeedsFallback({
    ok: true,
    posts: [],
    durationMs: 1,
    sessionId: "test",
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

describe("isBinanceSearchResponse", () => {
  it("accepts only Binance bapi search-list responses", () => {
    expect(isBinanceSearchResponse(
      "https://www.binance.com/bapi/composite/v2/friendly/pgc/feed/search/list",
    )).toBe(true);
    expect(isBinanceSearchResponse("https://example.com/bapi/feed/search/list")).toBe(false);
  });
});
