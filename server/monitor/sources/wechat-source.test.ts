import { describe, expect, it } from "vitest";
import { mapWeChatSearchItems, parseWeChatRss } from "./wechat-source";

describe("parseWeChatRss", () => {
  it("parses articles without leaking HTML", async () => {
    const posts = await parseWeChatRss(`<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>波场新闻</title><link>https://mp.weixin.qq.com/s/abc</link>
      <pubDate>Fri, 21 Aug 2026 08:00:00 GMT</pubDate><description><![CDATA[<p>TRON &amp; 孙宇晨</p>]]></description></item>
    </channel></rss>`);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      url: "https://mp.weixin.qq.com/s/abc",
      sourcePlatform: "wechat",
      contentSnippet: "TRON & 孙宇晨",
    });
    expect(posts[0].publishedAt).toBe(Date.parse("Fri, 21 Aug 2026 08:00:00 GMT"));
  });
});

describe("mapWeChatSearchItems", () => {
  it("keeps only fresh, relevant official-account articles", () => {
    const now = Date.parse("2026-08-23T04:00:00Z");
    const posts = mapWeChatSearchItems([
      { url: "https://mp.weixin.qq.com/s?id=new", title: "孙宇晨谈 TRON", snippet: "波场最新进展", date: "2 hours ago", source: "公众号" },
      { url: "https://mp.weixin.qq.com/s?id=old", title: "孙宇晨旧闻", snippet: "", date: "Aug 1, 2026", source: "公众号" },
      { url: "https://example.com/s?id=no", title: "波场新闻", snippet: "", date: "1 hour ago", source: "网页" },
    ], ["孙宇晨", "波场", "TRON"], now);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      sourceName: "wechat_search",
      sourcePlatform: "wechat",
      fetchEngineHint: "serper_site_search",
    });
  });
});
