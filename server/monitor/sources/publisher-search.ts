import { fetchWithTimeout, monitorArticleMatchesKeywords } from "../util";
import type { DiscoveredPost } from "./types";

const PUBLISHERS = ["https://www.newsbtc.com", "https://crypto.news"];
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const plainText = (value: unknown) => typeof value === "string"
  ? value.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim()
  : "";

// shortcut: two public publisher indexes provide partial coverage, not a replacement for global search.
export async function searchPublishers(keyword: string): Promise<DiscoveredPost[]> {
  const now = Date.now();
  const results = await Promise.allSettled(PUBLISHERS.map(async (origin) => {
    const url = new URL("/wp-json/wp/v2/posts", origin);
    url.search = new URLSearchParams({
      search: keyword,
      after: new Date(now - WEEK_MS).toISOString().replace(/Z$/, ""),
      per_page: "10",
      _fields: "link,title,excerpt,date_gmt",
    }).toString();
    const response = await fetchWithTimeout(url.toString(), {}, 15_000);
    if (!response.ok) throw new Error(`${new URL(origin).hostname}: HTTP ${response.status}`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error(`${new URL(origin).hostname}: invalid article list`);
    return rows.flatMap((row): DiscoveredPost[] => {
      if (!row || typeof row.link !== "string" || typeof row.date_gmt !== "string") return [];
      let articleUrl: URL;
      try { articleUrl = new URL(row.link); } catch { return []; }
      if (articleUrl.origin !== origin || articleUrl.username || articleUrl.password) return [];
      const publishedAt = Date.parse(`${row.date_gmt.replace(/Z$/, "")}Z`);
      if (!Number.isFinite(publishedAt) || publishedAt < now - WEEK_MS || publishedAt > now + 300_000) return [];
      const title = plainText(row.title?.rendered);
      const contentSnippet = plainText(row.excerpt?.rendered);
      if (!monitorArticleMatchesKeywords([keyword], title, contentSnippet)) return [];
      return [{
        url: articleUrl.href, title, contentSnippet, publishedAt,
        author: articleUrl.hostname, sourceName: "publisher_search", sourcePlatform: "web",
      }];
    });
  }));
  const successes = results.filter(result => result.status === "fulfilled");
  if (!successes.length) throw new Error("Public news search unavailable: " + results.map(result =>
    result.status === "rejected" ? String(result.reason) : "").join("; "));
  return successes.flatMap(result => result.value);
}
