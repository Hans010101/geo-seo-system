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

const stringField = (item: Record<string, unknown>, names: string[]) =>
  names.map((name) => item[name]).find((value): value is string => typeof value === "string" && value.trim() !== "")?.trim() || "";

function articleRecords(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 5 || value == null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => articleRecords(item, depth + 1));
  if (typeof value !== "object") return [];
  const item = value as Record<string, unknown>;
  if (
    stringField(item, ["title", "article_title", "name"]) &&
    stringField(item, ["url", "doc_url", "article_url", "content_url", "web_url", "link"])
  ) return [item];
  return Object.values(item).flatMap((child) => articleRecords(child, depth + 1));
}

export function mapAidataWeChatResponse(payload: unknown): DiscoveredPost[] {
  return articleRecords(payload).flatMap((item) => {
    const rawUrl = stringField(item, ["url", "doc_url", "article_url", "content_url", "web_url", "link"]);
    const title = stripHtml(stringField(item, ["title", "article_title", "name"]).replace(/<[^>]+>/g, ""));
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return [];
    }
    if (url.hostname !== "mp.weixin.qq.com") return [];
    url.protocol = "https:";
    const rawTime = item.publish_time ?? item.date_text ?? item.publishTime ?? item.open_timestamp ?? item.create_time ?? item.timestamp;
    const numericTime = Number(rawTime);
    const publishedAt = Number.isFinite(numericTime) && numericTime > 0
      ? numericTime < 1e12 ? numericTime * 1000 : numericTime
      : Date.parse(String(rawTime || ""));
    const snippet = stripHtml(stringField(item, ["abstract", "digest", "description", "summary", "desc"]));
    const source = item.source as Record<string, unknown> | undefined;
    return [{
      url: url.toString(),
      title,
      ...(snippet ? { contentSnippet: snippet } : {}),
      author: stringField(item, ["author", "author_name", "nickname", "account_name", "source"]) ||
        (source ? stringField(source, ["title", "name"]) : null),
      publishedAt: Number.isFinite(publishedAt) ? publishedAt : null,
      sourceName: "wechat_search",
      sourcePlatform: "wechat",
      fetchEngineHint: "aidata_wechat_search",
      fetchCostUsdHint: 0,
    } satisfies DiscoveredPost];
  });
}
