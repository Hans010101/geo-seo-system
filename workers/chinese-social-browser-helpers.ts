import {
  type ChineseSocialPlatform,
} from "../server/monitor/sources/chinese-social-source";
import type { DiscoveredPost } from "../server/monitor/sources/types";

type PlatformKey = ChineseSocialPlatform["key"];

export type BrowserScrapeElement = {
  text: string;
  html: string;
  attributes: Array<{ name: string; value: string }>;
};

const SEARCH_URLS: Record<PlatformKey, (keyword: string) => string> = {
  xiaohongshu: keyword =>
    `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&source=web_search_result_notes`,
  douyin: keyword =>
    `https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=video`,
  kuaishou: keyword =>
    `https://www.kuaishou.com/search/video?searchKey=${encodeURIComponent(keyword)}`,
  bilibili: keyword =>
    `https://search.bilibili.com/all?keyword=${encodeURIComponent(keyword)}&order=pubdate`,
  weibo: keyword =>
    `https://s.weibo.com/weibo?q=${encodeURIComponent(keyword)}&Refer=SWeibo_box`,
  tieba: keyword =>
    `https://tieba.baidu.com/f/search/res?ie=utf-8&qw=${encodeURIComponent(keyword)}`,
  zhihu: keyword =>
    `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(keyword)}`,
};

export function chineseSocialSearchUrl(
  platform: PlatformKey,
  keyword: string
): string {
  return SEARCH_URLS[platform](keyword);
}

function hrefOf(element: BrowserScrapeElement): string | null {
  return element.attributes.find(attribute => attribute.name.toLowerCase() === "href")?.value || null;
}

function publishedAtOf(element: BrowserScrapeElement): number | null {
  const value = element.attributes.find(attribute =>
    ["datetime", "data-time", "data-timestamp"].includes(attribute.name.toLowerCase())
  )?.value || element.html.match(/<time\b[^>]*\bdatetime=["']([^"']+)["']/i)?.[1];
  if (!value) return null;
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric)
    ? numeric * (numeric < 1e12 ? 1000 : 1)
    : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function mapBrowserScrapeResults(
  platform: ChineseSocialPlatform,
  searchUrl: string,
  keyword: string,
  elements: BrowserScrapeElement[],
  maxResults = 3
): DiscoveredPost[] {
  const byUrl = new Map<string, DiscoveredPost>();
  for (const element of elements) {
    const href = hrefOf(element);
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(href, searchUrl);
    } catch {
      continue;
    }
    if (!platform.matches(url)) continue;
    url.hash = "";
    const canonicalUrl = url.toString();
    const text = element.text.replace(/\s+/g, " ").trim().slice(0, 4000);
    const current = byUrl.get(canonicalUrl);
    if (current && (current.contentSnippet?.length || 0) >= text.length) continue;
    byUrl.set(canonicalUrl, {
      url: canonicalUrl,
      title: (text || `${platform.label}：${keyword}`).slice(0, 512),
      contentSnippet: text || keyword,
      author: null,
      publishedAt: publishedAtOf(element),
      sourceName: `${platform.key}_browser`,
      sourcePlatform: platform.key,
      fetchEngineHint: "social_browser",
    });
  }
  const limit = Math.max(1, Math.min(5, Math.trunc(maxResults) || 3));
  return Array.from(byUrl.values()).slice(0, limit);
}
