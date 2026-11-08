import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import AlertCenter, { getAlertSourceUrl } from "./AlertCenter";

const sourceUrl = "https://x.com/bx1818/status/2110340484505968701";

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({}),
    alerts: {
      list: { useQuery: () => ({ data: { total: 2, data: [
        { id: 1, title: "孙宇晨相关预警", description: "摘要\n原文: https://x.com/bx1818/status/2110340484505968701", severity: "high", createdAt: 0, isRead: false },
        { id: 2, title: "系统运行异常", description: "采集接口异常", severity: "medium", createdAt: 0, isRead: true },
      ] } }) },
      markRead: { useMutation: () => ({}) },
      markAllRead: { useMutation: () => ({}) },
      resolve: { useMutation: () => ({}) },
      dismiss: { useMutation: () => ({}) },
    },
  },
}));

describe("alert original source link", () => {
  it("uses the original-source field, not URLs quoted in the summary", () => {
    expect(getAlertSourceUrl(`摘要 https://example.com/quoted\n原文: ${sourceUrl}`)).toBe(sourceUrl);
    expect(getAlertSourceUrl("原文：https://mp.weixin.qq.com/s?__biz=abc&mid=123#wechat_redirect"))
      .toBe("https://mp.weixin.qq.com/s?__biz=abc&mid=123#wechat_redirect");
    expect(getAlertSourceUrl("摘要\r\n原文: http://example.com/article\r\n")).toBe("http://example.com/article");
  });

  it.each([
    null, undefined, "", "摘要 https://example.com/article", "原文: javascript:alert(1)",
    "原文: data:text/html,test", "原文: //example.com", "原文: https://",
    "原文: https://user:password@example.com/article", "原文: https://[bad-host]/article",
  ])("does not create an unsafe or fabricated link for %s", (description) => {
    expect(getAlertSourceUrl(description)).toBeNull();
  });

  it("renders an accessible new-tab button only for an alert with an original source", () => {
    const html = renderToStaticMarkup(createElement(AlertCenter));
    expect(html).toContain(`href="${sourceUrl}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('aria-label="查看原文：孙宇晨相关预警（新标签页）"');
    expect(html.match(/href=/g)).toHaveLength(1);
    expect(html).toContain('title="标记已读"');
    expect(html).toContain('title="解决"');
    expect(html).toContain('title="忽略"');
  });
});
