import Parser from "rss-parser";
import type { SerperWebItem } from "../search";
import { keywordMatchesText, monitorPublishedAtFreshness, parseSerperDate } from "../util";
import type { DiscoveredPost } from "./types";

const parser = new Parser();

const stripHtml = (value: string) =>
  value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();

export async function parseWeChatRss(xml: string): Promise<DiscoveredPost[]> {
  const feed = await parser.parseString(xml);
  return (feed.items || []).flatMap((item) => {
    const url = String(item.link || item.guid || "").trim();
    const title = String(item.title || "").trim();
    if (!url || !title) return [];
    const content = stripHtml(String(
      (item as Record<string, unknown>)["content:encoded"] ||
      item.content ||
      item.contentSnippet ||
      item.summary ||
      "",
    ));
    const publishedAt = item.isoDate
      ? Date.parse(item.isoDate)
      : item.pubDate
        ? Date.parse(item.pubDate)
        : null;
    return [{
      url,
      title,
      ...(content.length >= 200 ? { fullContent: content } : { contentSnippet: content }),
      author: item.creator || null,
      publishedAt: Number.isFinite(publishedAt) ? publishedAt : null,
      sourceName: "wechat",
      sourcePlatform: "wechat",
      fetchEngineHint: "wechat_rss",
      fetchCostUsdHint: 0,
    } satisfies DiscoveredPost];
  });
}

export function mapWeChatSearchItems(
  items: SerperWebItem[],
  keywords: string[],
  now = Date.now(),
): DiscoveredPost[] {
  return items.flatMap((item) => {
    let url: URL;
    try {
      url = new URL(item.url);
    } catch {
      return [];
    }
    const publishedAt = parseSerperDate(item.date, now);
    const content = `${item.title} ${item.snippet}`;
    if (
      url.hostname !== "mp.weixin.qq.com" ||
      url.pathname !== "/s" ||
      monitorPublishedAtFreshness(publishedAt, now) !== "fresh" ||
      !keywords.some((keyword) => keywordMatchesText(keyword, content))
    ) return [];
    return [{
      url: url.toString(),
      title: item.title,
      contentSnippet: item.snippet,
      author: item.source,
      publishedAt,
      sourceName: "wechat_search",
      sourcePlatform: "wechat",
      fetchEngineHint: "serper_site_search",
      fetchCostUsdHint: 0,
    } satisfies DiscoveredPost];
  });
}
