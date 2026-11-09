import { describe, expect, it } from "vitest";
import { briefWindow, buildPrompt, parseDraft, pushText, toSource, type BriefItem } from "./brief-calc";

const H = 3_600_000;
const at = (d: number, h: number, m = 0) => Date.UTC(2026, 10, d, h - 8, m); // Beijing time

const item = (id: number, over: Partial<BriefItem> = {}): BriefItem => ({
  id, publishedAt: at(9, 10), sourcePlatform: "web", domain: "toutiao.com", threatLevel: "medium",
  sentimentScore: 1, title: `标题${id}`, summary: "摘要", url: `https://example.org/${id}`, ...over,
});

describe("daily brief", () => {
  it("covers today for 晚报 and the night since the last cutoff for 早报", () => {
    const pm = briefWindow("pm", at(9, 17, 45));
    expect([pm.start, pm.end]).toEqual([at(9, 0), at(9, 17, 45)]);
    expect(pm.compareStart).toBe(at(8, 0));
    expect(briefWindow("am", at(10, 9, 20), at(9, 17, 45)).start).toBe(at(9, 17, 45));
    // No usable previous cutoff: fall back to 17:45 the day before.
    expect(briefWindow("am", at(10, 9, 20), null).start).toBe(at(9, 17, 45));
    expect(briefWindow("am", at(10, 9, 20), at(7, 17, 45)).start).toBe(at(9, 17, 45));
  });

  it("puts numbers, asks, previous events and numbered items in the prompt", () => {
    const { user } = buildPrompt({
      kind: "pm", windowLabel: "11-09 00:00 → 11-09 17:45", facts: ["负面 157 条"],
      items: [item(7)], previous: [{ key: "jingtian-lawsuit", title: "景甜纠纷", count: 91, level: "P2" }], asks: ["百分点需要重新登录"],
      positives: [item(8, { title: "正面标题", sourcePlatform: "bilibili" })],
    });
    expect(user).toContain("- B站：正面标题");
    expect(user).toContain("负面 157 条");
    expect(user).toContain("百分点需要重新登录");
    expect(user).toContain("key=jingtian-lawsuit");
    expect(user).toContain("#7 | 10:00 | 网页 | medium | 标题7");
    expect(user).toContain("明日预判");
  });

  it("sanitizes the model's JSON and drops ids outside the window", () => {
    const text = `好的：{"level":"关注","change":"降","lead":"无需决定","points":["景甜纠纷：回落"],
      "events":[{"key":"Jingtian Lawsuit","short":"景甜纠纷","level":"P2","title":"景甜彩礼纠纷","trend":"down",
        "state":"s","escalate":"e","happened":"h","view":"v","unconfirmed":"","next":"n","ids":[1,2,999],"sourceIds":[2,999]},
        {"key":"empty","level":"P9","title":"无条目","trend":"weird","ids":[]}],
      "others":{"positive":"p","narrative":"n","watch":"w","funds":"无"},"outlook":"o"}`;
    const draft = parseDraft(text, new Set([1, 2, 3]));
    expect(draft.events).toHaveLength(1);
    expect(draft.events[0]).toMatchObject({ key: "jingtian-lawsuit", ids: [1, 2], sourceIds: [2], trend: "down" });
    expect(parseDraft('{"level":"x","events":[]}', new Set()).level).toBe("关注");
    expect(() => parseDraft("没有 JSON", new Set())).toThrow();
  });

  it("labels sources by kind and formats the 5-line push", () => {
    expect(toSource(item(1, { sourcePlatform: "wechat", domain: "mp.weixin.qq.com" })).kind).toBe("公众号");
    expect(toSource(item(2, { domain: "c.m.163.com" })).kind).toBe("媒体");
    expect(toSource(item(3)).label).toBe("网页：标题3");
    const msg = pushText({
      kind: "pm", at: at(9, 17, 45), level: "关注", change: "持平", lead: "无需决定",
      events: [{ short: "景甜纠纷", title: "x", trend: "down" }, { short: "资金链", title: "y", trend: "up" }],
      trxPrice: 0.31723, trx24h: -0.99, excess24h: 3.25, asks: [], link: "https://trongeo.asia/briefs/2026-11-09-pm",
    });
    expect(msg.title).toBe("🟡 TRON 舆情晚报｜11-09 周一｜态势：关注（持平）");
    expect(msg.content.split("\n")).toEqual([
      "结论：无需决定",
      "▼景甜纠纷 ▲资金链｜TRX $0.3172（24h -0.99%，相对大盘 +3.25%）",
      "📄 https://trongeo.asia/briefs/2026-11-09-pm",
    ]);
  });
});
