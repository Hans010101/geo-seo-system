import { searchWeb } from "../search";
import { parseSerperDate } from "../util";
import type { DiscoveredPost, SearchOpts, SocialSource } from "./types";

export type ChineseSocialPlatform = {
  key:
    | "xiaohongshu"
    | "douyin"
    | "kuaishou"
    | "bilibili"
    | "weibo"
    | "tieba"
    | "zhihu";
  label: string;
  queryScope: string;
  matches(url: URL): boolean;
};

const hostIs = (url: URL, domain: string) =>
  url.hostname === domain || url.hostname.endsWith(`.${domain}`);

export const CHINESE_SOCIAL_PLATFORMS: ChineseSocialPlatform[] = [
  {
    key: "xiaohongshu",
    label: "小红书",
    queryScope: "site:xiaohongshu.com/explore",
    matches: url =>
      hostIs(url, "xiaohongshu.com") &&
      /^\/(?:explore|discovery\/item)\/[A-Za-z0-9_-]+/.test(url.pathname),
  },
  {
    key: "douyin",
    label: "抖音",
    queryScope: "site:douyin.com/video OR site:douyin.com/note",
    matches: url =>
      hostIs(url, "douyin.com") && /^\/(?:video|note)\/\d+/.test(url.pathname),
  },
  {
    key: "kuaishou",
    label: "快手",
    queryScope: "site:kuaishou.com/short-video",
    matches: url =>
      hostIs(url, "kuaishou.com") &&
      /^\/short-video\/[A-Za-z0-9_-]+/.test(url.pathname),
  },
  {
    key: "bilibili",
    label: "B站",
    queryScope: "site:bilibili.com/video",
    matches: url =>
      hostIs(url, "bilibili.com") &&
      /^\/video\/(?:BV|av)[A-Za-z0-9]+/i.test(url.pathname),
  },
  {
    key: "weibo",
    label: "微博",
    queryScope: "site:weibo.com OR site:m.weibo.cn/detail",
    matches: url =>
      (hostIs(url, "weibo.com") && /^\/\d+\/[A-Za-z0-9]+/.test(url.pathname)) ||
      (hostIs(url, "m.weibo.cn") &&
        /^\/detail\/[A-Za-z0-9]+/.test(url.pathname)),
  },
  {
    key: "tieba",
    label: "百度贴吧",
    queryScope: "site:tieba.baidu.com/p",
    matches: url =>
      hostIs(url, "tieba.baidu.com") && /^\/p\/\d+/.test(url.pathname),
  },
  {
    key: "zhihu",
    label: "知乎",
    queryScope: "site:zhihu.com/question OR site:zhuanlan.zhihu.com/p",
    matches: url =>
      (hostIs(url, "zhihu.com") &&
        /^\/question\/\d+(?:\/answer\/\d+)?/.test(url.pathname)) ||
      (hostIs(url, "zhuanlan.zhihu.com") && /^\/p\/\d+/.test(url.pathname)),
  },
];

export const CHINESE_SOCIAL_SOURCE_NAMES = CHINESE_SOCIAL_PLATFORMS.map(
  platform => `${platform.key}_serper`
);

export function mapChineseSocialSearchItems(
  platform: ChineseSocialPlatform,
  items: Array<{
    url: string;
    title: string;
    snippet: string;
    date: string | null;
    source: string | null;
  }>
): DiscoveredPost[] {
  const posts: DiscoveredPost[] = [];
  for (const item of items) {
    let url: URL;
    try {
      url = new URL(item.url);
    } catch {
      continue;
    }
    if (!platform.matches(url)) continue;
    posts.push({
      url: url.toString(),
      title: (item.title || item.snippet || `${platform.label}帖子`).slice(
        0,
        512
      ),
      contentSnippet: (item.snippet || item.title || "").slice(0, 4000),
      author: item.source || null,
      publishedAt: parseSerperDate(item.date),
      sourceName: `${platform.key}_serper`,
      sourcePlatform: platform.key,
      fetchEngineHint: "social_search",
    });
  }
  return posts;
}

function createChineseSocialSource(
  platform: ChineseSocialPlatform
): SocialSource {
  return {
    name: `${platform.key}_serper`,
    platform: platform.key,
    enabled: true,
    async search(
      keyword: string,
      opts?: SearchOpts
    ): Promise<DiscoveredPost[]> {
      const items = await searchWeb(`${platform.queryScope} ${keyword}`, {
        tbs: opts?.tbs || "qdr:w",
        num: Math.min(10, opts?.num || 10),
        gl: "cn",
        hl: "zh-cn",
      });
      return mapChineseSocialSearchItems(platform, items);
    },
  };
}

export const chineseSocialSources = CHINESE_SOCIAL_PLATFORMS.map(
  createChineseSocialSource
);
