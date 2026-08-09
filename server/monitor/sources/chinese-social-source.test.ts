import { describe, expect, it } from "vitest";
import {
  CHINESE_SOCIAL_PLATFORMS,
  mapChineseSocialSearchItems,
} from "./chinese-social-source";

const canonicalUrls: Record<string, string> = {
  xiaohongshu: "https://www.xiaohongshu.com/explore/66aa11bb22cc33dd44ee55ff",
  douyin: "https://www.douyin.com/video/7521234567890123456",
  kuaishou: "https://www.kuaishou.com/short-video/3xabcdef1234567",
  bilibili: "https://www.bilibili.com/video/BV1ab411c7de",
  weibo: "https://weibo.com/1234567890/AbCdEfG12",
  tieba: "https://tieba.baidu.com/p/9123456789",
  zhihu: "https://www.zhihu.com/question/123456789/answer/987654321",
};

const nonPostUrls: Record<string, string> = {
  xiaohongshu: "https://www.xiaohongshu.com/user/profile/abc",
  douyin: "https://www.douyin.com/search/%E8%88%86%E6%83%85",
  kuaishou: "https://www.kuaishou.com/profile/abc",
  bilibili: "https://search.bilibili.com/all?keyword=%E8%88%86%E6%83%85",
  weibo: "https://s.weibo.com/weibo?q=%E8%88%86%E6%83%85",
  tieba: "https://tieba.baidu.com/f?kw=%E8%88%86%E6%83%85",
  zhihu: "https://www.zhihu.com/search?q=%E8%88%86%E6%83%85",
};

describe("Chinese social discovery URL filtering", () => {
  for (const platform of CHINESE_SOCIAL_PLATFORMS) {
    it(`keeps only a canonical ${platform.label} post URL`, () => {
      const posts = mapChineseSocialSearchItems(platform, [
        {
          url: canonicalUrls[platform.key],
          title: `${platform.label}有效帖子`,
          snippet: "原始平台内容摘要",
          date: "2 hours ago",
          source: "测试作者",
        },
        {
          url: nonPostUrls[platform.key],
          title: "搜索页或账号页",
          snippet: "不应进入系统",
          date: "1 hour ago",
          source: null,
        },
        {
          url: "https://www.google.com/search?q=redirect",
          title: "搜索中转页",
          snippet: "不应进入系统",
          date: "1 hour ago",
          source: null,
        },
      ]);

      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({
        url: canonicalUrls[platform.key],
        sourceName: `${platform.key}_serper`,
        sourcePlatform: platform.key,
        fetchEngineHint: "social_search",
        author: "测试作者",
      });
      expect(posts[0]?.publishedAt).toEqual(expect.any(Number));
    });
  }

  it("drops malformed URLs", () => {
    const posts = mapChineseSocialSearchItems(CHINESE_SOCIAL_PLATFORMS[0]!, [
      {
        url: "not-a-url",
        title: "bad",
        snippet: "bad",
        date: null,
        source: null,
      },
    ]);
    expect(posts).toEqual([]);
  });
});
