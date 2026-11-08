import { describe, expect, it } from "vitest";
import { CHINESE_SOCIAL_PLATFORMS } from "../server/monitor/sources/chinese-social-source";
import {
  chineseSocialSearchUrl,
  decryptSocialState,
  encryptSocialState,
  extractBilibiliPageState,
  extractWeChatUrlFromSogouHtml,
  isSogouWeChatSearchPage,
  isXiaohongshuIpRiskUrl,
  allocateWeChatQueryQuotas,
  mapBrowserScrapeResults,
  mapNativeSearchPayload,
  parseChinesePublishedAt,
  planWeChatQueries,
  toWeChatBrowserPost,
  xiaohongshuStorageState,
  type BrowserScrapeElement,
} from "./chinese-social-browser-helpers";

const TEST_STATE_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index + 1)));

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
  it("encrypts persisted login state", async () => {
    const encrypted = await encryptSocialState('{"cookies":[{"name":"SUB"}]}', TEST_STATE_KEY);
    expect(new TextDecoder().decode(encrypted.slice(0, 4))).toBe("CSS1");
    expect(await decryptSocialState(encrypted.buffer, TEST_STATE_KEY)).toBe('{"cookies":[{"name":"SUB"}]}');
  });

  it("imports a complete Xiaohongshu Cookie header", () => {
    const state = xiaohongshuStorageState("a1=alpha; web_session=session=value; webId=id");
    expect(state.cookies.map(cookie => cookie.name)).toEqual(["a1", "web_session", "webId"]);
    expect(state.cookies.find(cookie => cookie.name === "web_session")?.value).toBe("session=value");
    expect(() => xiaohongshuStorageState("a1=alpha")).toThrow("web_session");
    expect(isXiaohongshuIpRiskUrl("https://www.xiaohongshu.com/website-login/error?error_code=300012")).toBe(true);
  });

  it("imports a bare Xiaohongshu web_session value", () => {
    const state = xiaohongshuStorageState("0123456789abcdef0123456789abcdef");
    expect(state.cookies).toEqual([expect.objectContaining({
      name: "web_session",
      value: "0123456789abcdef0123456789abcdef",
    })]);
  });

  for (const platform of CHINESE_SOCIAL_PLATFORMS) {
    it(`builds and filters ${platform.label} search results`, () => {
      const searchUrl = chineseSocialSearchUrl(platform.key, "孙宇晨 TRON");
      const posts = mapBrowserScrapeResults(platform, searchUrl, "孙宇晨 TRON", [
        anchor(canonicalUrls[platform.key], `${platform.label}孙宇晨最新有效内容`),
        anchor("https://www.google.com/search?q=redirect", "搜索中转"),
        anchor(canonicalUrls[platform.key], "短"),
      ]);
      expect(new URL(searchUrl).protocol).toBe("https:");
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({
        url: canonicalUrls[platform.key],
        title: `${platform.label}孙宇晨最新有效内容`,
        sourceName: `${platform.key}_browser`,
        sourcePlatform: platform.key,
        fetchEngineHint: "social_browser",
      });
      expect(mapBrowserScrapeResults(platform, searchUrl, "孙宇晨", [
        anchor(canonicalUrls[platform.key], "完全无关的娱乐内容"),
      ])).toEqual([]);
    });
  }

  it("keeps the longest anchor text and obeys the result cap", () => {
    const platform = CHINESE_SOCIAL_PLATFORMS.find(item => item.key === "bilibili")!;
    const posts = mapBrowserScrapeResults(
      platform,
      chineseSocialSearchUrl("bilibili", "TRON"),
      "TRON",
      [
        anchor("//www.bilibili.com/video/BV1ab411c7de", "短 TRON 区块链"),
        anchor("//www.bilibili.com/video/BV1ab411c7de", "更完整的 TRON 区块链标题内容"),
        anchor("//www.bilibili.com/video/BV2ab411c7df", "第二条 TRON 区块链"),
      ],
      1
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]?.title).toBe("更完整的 TRON 区块链标题内容");
  });

  it("rejects a keyword leaked from the surrounding search page", () => {
    const platform = CHINESE_SOCIAL_PLATFORMS.find(item => item.key === "weibo")!;
    const polluted = anchor(canonicalUrls.weibo, "无关娱乐内容 波场");
    polluted.anchorText = "无关娱乐内容";
    expect(mapBrowserScrapeResults(
      platform,
      chineseSocialSearchUrl("weibo", "波场"),
      "波场",
      [polluted],
    )).toEqual([]);
  });

  it("uses card text when an anchor has no visible text", () => {
    const platform = CHINESE_SOCIAL_PLATFORMS.find(item => item.key === "weibo")!;
    const element = anchor(canonicalUrls.weibo, "孙宇晨发布波场生态更新");
    element.anchorText = "";
    expect(mapBrowserScrapeResults(
      platform,
      chineseSocialSearchUrl("weibo", "孙宇晨"),
      "孙宇晨",
      [element],
    )).toHaveLength(1);
  });

  it("accepts native Zhihu video URLs", () => {
    const platform = CHINESE_SOCIAL_PLATFORMS.find(item => item.key === "zhihu")!;
    expect(mapNativeSearchPayload(platform, "孙宇晨", {
      data: [{ object: { type: "zvideo", id: 22, title: "孙宇晨谈波场", created_time: 1787443200 } }],
    })[0]?.url).toBe("https://www.zhihu.com/zvideo/22");
  });

  it("requires crypto context for ambiguous bare TRON results", () => {
    const platform = CHINESE_SOCIAL_PLATFORMS.find(item => item.key === "bilibili")!;
    expect(mapNativeSearchPayload(platform, "TRON", {
      data: { result: [
        { bvid: "BV1ab411c7de", title: "奥迪 Q6 e-tron 试驾", pubdate: 1787443200 },
        { bvid: "BV2ab411c7df", title: "TRON 区块链生态更新", pubdate: 1787443200 },
      ] },
    }).map(post => post.title)).toEqual(["TRON 区块链生态更新"]);
  });

  it("keeps an authoritative structured publication time", () => {
    const platform = CHINESE_SOCIAL_PLATFORMS.find(item => item.key === "bilibili")!;
    const element = anchor(canonicalUrls.bilibili, "TRON 区块链带发布时间的内容");
    element.html = '<span>TRON 区块链带发布时间的内容</span><time datetime="2026-08-13T01:00:00Z">今天</time>';
    const [post] = mapBrowserScrapeResults(
      platform,
      chineseSocialSearchUrl("bilibili", "TRON"),
      "TRON",
      [element]
    );
    expect(post?.publishedAt).toBe(Date.parse("2026-08-13T01:00:00Z"));
  });

  it("maps native Bilibili, Zhihu and Tieba results with publication times", () => {
    const bili = CHINESE_SOCIAL_PLATFORMS.find(item => item.key === "bilibili")!;
    const zhihu = CHINESE_SOCIAL_PLATFORMS.find(item => item.key === "zhihu")!;
    const tieba = CHINESE_SOCIAL_PLATFORMS.find(item => item.key === "tieba")!;
    expect(mapNativeSearchPayload(bili, "TRON", {
      data: { result: [{ bvid: "BV1ab411c7de", title: "<em>TRON</em> 区块链最新", author: "UP", pubdate: 1787443200 }] },
    })[0]).toMatchObject({ publishedAt: 1787443200000, sourcePlatform: "bilibili" });
    expect(mapNativeSearchPayload(zhihu, "孙宇晨", {
      data: [{ object: { type: "answer", id: 22, question: { id: 11 }, title: "孙宇晨", created_time: 1787443200 } }],
    })[0]).toMatchObject({ url: "https://www.zhihu.com/question/11/answer/22", publishedAt: 1787443200000 });
    expect(mapNativeSearchPayload(tieba, "波场", {
      data: { card_list: [{ data: { tid: "9123456789", title: "波场动态", time: 1787443200 } }] },
    })[0]).toMatchObject({ url: "https://tieba.baidu.com/p/9123456789", publishedAt: 1787443200000 });
    expect(parseChinesePublishedAt("发布于 2小时前", Date.parse("2026-08-25T10:00:00Z")))
      .toBe(Date.parse("2026-08-25T08:00:00Z"));
    expect(parseChinesePublishedAt("作者 · 08-23", Date.parse("2026-08-25T10:00:00Z")))
      .toBe(Date.parse("2026-08-22T16:00:00Z"));
    expect(mapNativeSearchPayload(bili, "TRON", extractBilibiliPageState(
      'author:"UP主",bvid:"BV1ab411c7de",title:"\\u003Cem\\u003ETRON\\u003C/em\\u003E 区块链最新",pubdate:1787443200,pubstr:"2026-08-23"',
    ))[0]).toMatchObject({ publishedAt: 1787443200000, title: "TRON 区块链最新" });
  });

  it("maps native Xiaohongshu, Douyin, Kuaishou and Weibo results", () => {
    const cases = [
      ["xiaohongshu", { note_id: "abc123", title: "孙宇晨动态", desc: "波场", time: 1_787_400_000_000, user: { nickname: "甲" } }],
      ["douyin", { aweme_id: "7521234567890123456", desc: "孙宇晨动态", create_time: 1_787_400_000, author: { nickname: "乙" } }],
      ["kuaishou", { photo: { id: "3xabcdef1234567", caption: "孙宇晨动态", timestamp: 1_787_400_000_000 }, author: { name: "丙" } }],
      ["weibo", { mblog: { id: "AbCdEfG12", text: "孙宇晨动态", created_at: "Tue, 25 Aug 2026 08:00:00 GMT", user: { screen_name: "丁" } } }],
    ] as const;
    for (const [key, payload] of cases) {
      const platform = CHINESE_SOCIAL_PLATFORMS.find(item => item.key === key)!;
      const posts = mapNativeSearchPayload(platform, "孙宇晨", payload, 3);
      expect(posts).toHaveLength(1);
      expect(posts[0].publishedAt).not.toBeNull();
      expect(posts[0].author).toBeTruthy();
    }
  });

  it("resolves a Sogou redirect into a direct WeChat article", () => {
    expect(isSogouWeChatSearchPage("https://weixin.sogou.com/weixin?type=2&query=%E5%AD%99%E5%AE%87%E6%99%A8")).toBe(true);
    expect(isSogouWeChatSearchPage("https://weixin.sogou.com/")).toBe(false);
    const url = extractWeChatUrlFromSogouHtml(
      "<script>url += 'weixin.qq.com/s?__biz=abc@'; url += '&mid=123';</script>",
    );
    expect(url).toBe("https://mp.weixin.qq.com/s?__biz=abc&mid=123");
    expect(toWeChatBrowserPost({
      title: "孙宇晨与波场最新进展",
      snippet: "TRON 生态更新",
      author: "测试公众号",
      publishedAt: Date.parse("2026-08-23T01:00:00Z"),
      redirectUrl: "https://weixin.sogou.com/link?url=test",
    }, url!)).toMatchObject({
      sourceName: "wechat_search",
      sourcePlatform: "wechat",
      fetchEngineHint: "sogou_browser",
    });
  });

  it("always schedules two WeChat core queries plus one rotating long-tail fairly", () => {
    const requested = ["孙宇晨", "波场", "TRON", "Justin Sun", "孙哥", "孙割"];
    const first = planWeChatQueries(requested, Date.parse("2026-08-31T00:00:00Z"));
    const next = planWeChatQueries(requested, Date.parse("2026-08-31T02:00:00Z"));
    expect(first.executed.slice(0, 2)).toEqual(["孙宇晨", "波场 OR TRON"]);
    expect(first.executed).toHaveLength(3);
    expect(next.executed[2]).not.toBe(first.executed[2]);
    expect(first.truncated).not.toContain(first.executed[2]);
    expect(allocateWeChatQueryQuotas(20, 3)).toEqual([7, 7, 6]);
  });

  it("parses second, day-before-yesterday and Chinese month-day publication times", () => {
    const now = Date.parse("2026-08-25T10:00:00Z");
    expect(parseChinesePublishedAt("30秒前", now)).toBe(now - 30_000);
    expect(parseChinesePublishedAt("前天 09:30", now)).not.toBeNull();
    expect(parseChinesePublishedAt("8月23日 09:30", now)).toBe(Date.parse("2026-08-23T01:30:00Z"));
  });
});
