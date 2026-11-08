import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetRssCache, RSS_FEEDS, rssSource } from "./rss-source";
import { __resetTelegramCache, telegramSource } from "./telegram-source";

const fetchMock = vi.fn();
const now = "2026-10-15T12:00:00Z";
const rssItem = (id: number, title = "孙宇晨与波场 TRON", date = now) =>
  `<item><title>${title}</title><link>https://example.com/${id}</link><pubDate>${date}</pubDate><description>公开新闻内容</description></item>`;
const feed = (items: string) => `<rss version="2.0"><channel><title>News</title>${items}</channel></rss>`;
const message = (id: number, text = "孙宇晨与波场 TRON 的最新新闻内容", date = now) =>
  `<div class="tgme_widget_message_wrap"><div class="tgme_widget_message_text">${text}</div><a class="tgme_widget_message_date" href="https://t.me/theblockbeats/${id}"><time datetime="${date}"></time></a></div>`;
const page = (messages: string, before?: string) => `${before ? `<a data-before="${before}">More</a>` : ""}${messages}`;
const tgOpts = { shard: "theblockbeats" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  __resetRssCache();
  __resetTelegramCache();
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("free RSS discovery", () => {
  it("includes the verified Chinese feed and catches relevant posts beyond the old 40-item cutoff", async () => {
    expect(RSS_FEEDS).toContain("https://www.panewslab.com/rss.xml?lang=zh");
    const items = Array.from({ length: 101 }, (_, i) => rssItem(i, i < 40 ? "无关新闻" : "孙宇晨与波场 TRON"));
    fetchMock.mockResolvedValue(new Response(feed(items.join(""))));
    const result = await rssSource.search("孙宇晨", { shard: RSS_FEEDS[0] });
    expect(result).toHaveLength(60);
    expect(result.at(-1)?.url).toBe("https://example.com/99");
    await rssSource.search("TRON", { shard: RSS_FEEDS[0] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects stale, missing-date, and unrelated entries, and deduplicates links", async () => {
    fetchMock.mockResolvedValue(new Response(feed(rssItem(1) + rssItem(1) + rssItem(2, "孙宇晨", "2026-09-01") + rssItem(3, "孙宇晨", "") + rssItem(4, "天气预报"))));
    expect(await rssSource.search("孙宇晨", { shard: RSS_FEEDS[0] })).toHaveLength(1);
  });

  it("reports upstream failures, caches them across keywords, and retries next cycle", async () => {
    fetchMock.mockResolvedValue(new Response("unavailable", { status: 503 }));
    await expect(rssSource.search("孙宇晨", { shard: RSS_FEEDS[0] })).rejects.toThrow("HTTP 503");
    await expect(rssSource.search("TRON", { shard: RSS_FEEDS[0] })).rejects.toThrow("HTTP 503");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(8 * 60 * 1000 + 1);
    fetchMock.mockResolvedValue(new Response(feed(rssItem(1))));
    await expect(rssSource.search("孙宇晨", { shard: RSS_FEEDS[0] })).resolves.toHaveLength(1);
  });
});

describe("free Telegram discovery", () => {
  it("finds a match on the second page, uses only the channel's numeric cursor, and shares the cache", async () => {
    fetchMock.mockResolvedValueOnce(new Response(page(message(20, "今天的天气预报没有相关内容"), "20")))
      .mockResolvedValueOnce(new Response(page(message(19), "19")));
    const result = await telegramSource.search("孙宇晨", tgOpts);
    expect(result.map(post => post.url)).toEqual(["https://t.me/theblockbeats/19"]);
    expect(result[0].fetchCostUsdHint).toBe(0);
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(["https://t.me/s/theblockbeats", "https://t.me/s/theblockbeats?before=20"]);
    await telegramSource.search("TRON", tgOpts);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("deduplicates pages and never fetches more than two pages or keeps more than 40 messages", async () => {
    fetchMock.mockResolvedValueOnce(new Response(page(Array.from({ length: 20 }, (_, i) => message(i + 20)).join(""), "20")))
      .mockResolvedValueOnce(new Response(page(Array.from({ length: 25 }, (_, i) => message(i)).join(""), "1")));
    const result = await telegramSource.search("孙宇晨", tgOpts);
    expect(result).toHaveLength(40);
    expect(new Set(result.map(post => post.url)).size).toBe(result.length);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops on old pages and filters old or undated messages", async () => {
    fetchMock.mockResolvedValue(new Response(page(message(1, undefined, "2026-09-01"), "1")));
    await expect(telegramSource.search("孙宇晨", tgOpts)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    __resetTelegramCache();
    fetchMock.mockResolvedValue(new Response(page(message(2, undefined, ""))));
    await expect(telegramSource.search("孙宇晨", tgOpts)).resolves.toEqual([]);
  });

  it.each([503, 200])("reports HTTP/invalid-preview failure (%s) without repeating it for every keyword", async status => {
    fetchMock.mockResolvedValue(new Response("no channel preview", { status }));
    await expect(telegramSource.search("孙宇晨", tgOpts)).rejects.toThrow("telegram:");
    await expect(telegramSource.search("TRON", tgOpts)).rejects.toThrow("telegram:");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves first-page results if the optional second page fails", async () => {
    fetchMock.mockResolvedValueOnce(new Response(page(message(20), "20")))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    await expect(telegramSource.search("孙宇晨", tgOpts)).resolves.toHaveLength(1);
  });
});
