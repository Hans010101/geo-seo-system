import { describe, expect, it } from "vitest";
import { mapGateSerperFallback } from "./monitor-queue";

describe("Gate Square Serper fallback", () => {
  it("keeps only matching Gate status posts", () => {
    const found = mapGateSerperFallback([
      {
        url: "https://www.gate.com/post/status/123456?ref=search",
        title: "TRON market update",
        snippet: "TRX liquidity is improving",
        date: "2 hours ago",
        source: "Gate Square",
      },
      {
        url: "https://www.gate.com/learn/articles/tron-guide/1",
        title: "TRON guide",
        snippet: "Not a Square status post",
        date: null,
        source: "Gate",
      },
      {
        url: "https://example.com/post/status/999",
        title: "TRON",
        snippet: "Wrong domain",
        date: null,
        source: null,
      },
    ], [{ keyword: "TRON" }, { keyword: "TRX" }]);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      normalizedUrl: "https://gate.com/post/status/123456",
      matchedKeywords: ["TRON", "TRX"],
      post: {
        sourceName: "gate_square",
        sourcePlatform: "gate_square",
      },
    });
  });

  it("deduplicates normalized URLs and merges keyword matches", () => {
    const found = mapGateSerperFallback([
      {
        url: "https://gate.com/post/status/777?utm_source=one",
        title: "TRON update",
        snippet: "",
        date: null,
        source: null,
      },
      {
        url: "https://gate.com/post/status/777?utm_source=two",
        title: "TRX update",
        snippet: "",
        date: null,
        source: null,
      },
    ], [{ keyword: "TRON" }, { keyword: "TRX" }]);

    expect(found).toHaveLength(1);
    expect(found[0].matchedKeywords).toEqual(["TRON", "TRX"]);
  });
});
