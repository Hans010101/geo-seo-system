import Parser from "rss-parser";
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
