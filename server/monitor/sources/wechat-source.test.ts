import { describe, expect, it } from "vitest";
import { parseWeChatRss } from "./wechat-source";

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
