import { describe, expect, it } from "vitest";
import { CHINESE_SOCIAL_PLATFORMS } from "../server/monitor/sources/chinese-social-source";
import {
  chineseSocialSearchUrl,
  mapBrowserScrapeResults,
  type BrowserScrapeElement,
} from "./chinese-social-browser-helpers";

const canonicalUrls: Record<string, string> = {
  xiaohongshu: "https://www.xiaohongshu.com/explore/66aa11bb22cc33dd44ee55ff",
  douyin: "https://www.douyin.com/video/7521234567890123456",
  kuaishou: "https://www.kuaishou.com/short-video/3xabcdef1234567",
  bilibili: "https://www.bilibili.com/video/BV1ab411c7de",
  weibo: "https://weibo.com/1234567890/AbCdEfG12",
  tieba: "https://tieba.baidu.com/p/9123456789",
  zhihu: "https://www.zhihu.com/question/123456789/answer/987654321",
};

function anchor(href: string, text: string): BrowserScrapeElement {
  return {
    text,
    html: text,
    attributes: [{ name: "href", value: href }],
  };
}

describe("Chinese social Browser Run discovery", () => {
  for (const platform of CHINESE_SOCIAL_PLATFORMS) {
    it(`builds and filters ${platform.label} search results`, () => {
      const searchUrl = chineseSocialSearchUrl(platform.key, "孙宇晨 TRON");
      const posts = mapBrowserScrapeResults(platform, searchUrl, "孙宇晨 TRON", [
        anchor(canonicalUrls[platform.key], `${platform.label}最新有效内容`),
        anchor("https://www.google.com/search?q=redirect", "搜索中转"),
        anchor(canonicalUrls[platform.key], "短"),
      ]);
      expect(new URL(searchUrl).protocol).toBe("https:");
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({
        url: canonicalUrls[platform.key],
        title: `${platform.label}最新有效内容`,
        sourceName: `${platform.key}_browser`,
        sourcePlatform: platform.key,
        fetchEngineHint: "social_browser",
      });
    });
  }

  it("keeps the longest anchor text and obeys the result cap", () => {
    const platform = CHINESE_SOCIAL_PLATFORMS.find(item => item.key === "bilibili")!;
    const posts = mapBrowserScrapeResults(
      platform,
      chineseSocialSearchUrl("bilibili", "TRON"),
      "TRON",
      [
        anchor("//www.bilibili.com/video/BV1ab411c7de", "短"),
        anchor("//www.bilibili.com/video/BV1ab411c7de", "更完整的标题内容"),
        anchor("//www.bilibili.com/video/BV2ab411c7df", "第二条"),
      ],
      1
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]?.title).toBe("更完整的标题内容");
  });
});
