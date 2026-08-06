import { describe, expect, it, vi } from "vitest";
import {
  extractSourcePublishedAt,
  isSearchIntermediaryUrl,
  sourceDateFreshness,
  verifySourcePublishedAt,
} from "./source-date";

describe("source publication date verification", () => {
  it("prefers OKX Orbit app-state publishTime over misleading generated JSON-LD", () => {
    const actual = Date.parse("2026-04-23T02:40:27.326Z");
    const html = `
      <script id="appState" type="application/json">
        {"detail":{"publishTime":"${actual}"}}
      </script>
      <script type="application/ld+json">
        {"datePublished":"2026-08-05T23:54:04.391Z"}
      </script>`;
    expect(
      extractSourcePublishedAt(
        "https://www.okx.com/en-au/orbit/insight/74593103152832",
        html,
      ),
    ).toEqual({ publishedAt: actual, evidence: "okx_app_state" });
  });

  it("extracts standard article metadata and dated URL paths", () => {
    expect(
      extractSourcePublishedAt(
        "https://example.com/story",
        `<meta content="2026-08-05T10:20:30Z" property="article:published_time">`,
      ),
    ).toEqual({
      publishedAt: Date.parse("2026-08-05T10:20:30Z"),
      evidence: "article_meta",
    });
    expect(
      extractSourcePublishedAt("https://example.com/2026/08/04/story", "<html></html>"),
    ).toEqual({
      publishedAt: Date.parse("2026-08-04T00:00:00Z"),
      evidence: "url_path",
    });
    expect(
      extractSourcePublishedAt(
        "https://example.com/story",
        `<meta name="date" content="2026-08-06T10:00:00Z">
         <time datetime="2026-08-06T10:00:00Z">live clock</time>`,
      ),
    ).toBeNull();
    expect(
      extractSourcePublishedAt(
        "https://example.com/story",
        `<time itemprop="datePublished" datetime="2026-08-05T10:00:00Z"></time>`,
      ),
    ).toEqual({
      publishedAt: Date.parse("2026-08-05T10:00:00Z"),
      evidence: "time_element",
    });
  });

  it("rejects private destinations and reports stale verified dates", () => {
    expect(() =>
      extractSourcePublishedAt(
        "http://127.0.0.1/internal",
        `<meta property="article:published_time" content="2026-08-05">`,
      ),
    ).toThrow(/private or local/);
    expect(
      sourceDateFreshness(
        {
          status: "verified",
          publishedAt: Date.parse("2026-04-23T02:40:27.326Z"),
          evidence: "okx_app_state",
        },
        Date.parse("2026-08-06T00:00:00Z"),
      ),
    ).toBe("stale");
  });

  it("does not treat search intermediaries as original publishers", async () => {
    expect(isSearchIntermediaryUrl("https://www.google.com/search?q=tron")).toBe(true);
    expect(isSearchIntermediaryUrl("https://example.com/2026/08/06/tron")).toBe(false);
    await expect(
      verifySourcePublishedAt("https://news.google.com/articles/example"),
    ).resolves.toMatchObject({
      status: "unverifiable",
      publishedAt: null,
      error: "search intermediary is not an original source",
    });
  });

  it("uses an immutable origin URL date when the publisher blocks Cloudflare", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("blocked", { status: 403 }),
    );
    try {
      await expect(
        verifySourcePublishedAt(
          "https://www.binance.com/zh-CN/square/post/08-06-2026-tron-update-123",
        ),
      ).resolves.toEqual({
        status: "verified",
        publishedAt: Date.parse("2026-08-06T00:00:00Z"),
        evidence: "url_path",
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("holds generic render-time metadata until it is stable", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(
      `<script type="application/ld+json">{"datePublished":"${new Date().toISOString()}"}</script>`,
      { headers: { "content-type": "text/html" } },
    );
    try {
      await expect(
        verifySourcePublishedAt("https://example.com/old-page-reindexed-now"),
      ).resolves.toMatchObject({
        status: "unverifiable",
        publishedAt: null,
        error: "publication metadata is too close to render time to be stable",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
