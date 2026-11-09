import { describe, expect, it } from "vitest";
import { buildBriefEmail } from "./brief-email";
import type { BriefData } from "./brief";

const H = 3_600_000;
const t0 = Date.UTC(2026, 10, 8, 9);
const series = Array.from({ length: 25 }, (_, i) => [t0 + i * H, 0.32 - i * 0.0001] as [number, number]);

const sampleBrief: BriefData = {
  id: "2026-11-09-pm", kind: "pm", title: "TRON 舆情晚报", dateLabel: "2026年11月09日 周一",
  windowStart: t0, windowEnd: t0 + 24 * H, generatedAt: t0 + 24 * H, nextLabel: "明日 09:20 早报",
  verdict: { level: "关注", change: "持平", lead: "无高威胁事件，今天不需要你决定。", points: ["景甜纠纷：回落约三成", "<script>注入</script>"] },
  kpis: { high: 0, highPrev: 0, medium: 99, mediumPrev: 108, negative: 157, negativePrev: 151, relevant: 228, published: 286, publishedPrev: 270, positive: 35, positivePrev: 19 },
  market: {
    trx: { price: 0.3172, change24h: -0.99, series }, benchmark24h: -4.24, excess24h: 3.25, note: "", coinsNote: "",
    coins: [{ symbol: "JST", name: "JUST", price: 0.1433, change24h: -0.15, series }, { symbol: "BTT", name: "BitTorrent", price: 3.577e-7, change24h: -0.59, series }],
  },
  events: [{
    key: "jingtian", short: "景甜纠纷", level: "P2", title: "孙宇晨与景甜彩礼纠纷", trend: "down", count: 63, prevCount: 91,
    state: "回落", escalate: "法院公告", happened: "63 条", view: "娱乐化", unconfirmed: "", next: "看法院",
    ids: [1], sources: [{ kind: "网帖", label: "头条：标题", url: "https://toutiao.com/x" }, { kind: "媒体", label: "坏链接", url: "javascript:alert(1)" }],
  }],
  others: [{ label: "正面", text: "语录扩散" }],
  trends: { days: [], published: [], negativeShare: [], medium: [], geoDoubao: [], geoDeepseek: [] },
  outlook: "明天继续降温。", asks: [], model: "m",
};

describe("brief email", () => {
  it("renders a text-first email with escaped content, sources and the web link", () => {
    const { subject, html, text } = buildBriefEmail(sampleBrief, "https://trongeo.asia/briefs/2026-11-09-pm");
    expect(subject).toBe("🟡 TRON 舆情晚报｜11-09 周一｜关注（持平）");
    expect(html).toContain("&lt;script&gt;注入&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:alert");
    expect(html).not.toMatch(/<img|<table/);
    expect(html).toContain('<a href="https://toutiao.com/x">头条：标题</a>');
    expect(text).toContain("【P2】孙宇晨与景甜彩礼纠纷　▼缓和　63 条（上期 91）");
    expect(text).toContain("TRX $0.3172，24 小时 -0.99%");
    expect(text).toContain("完整版：https://trongeo.asia/briefs/2026-11-09-pm");
    expect(html).toContain("63 条（上期 91）");
    expect(html).toContain("https://trongeo.asia/briefs/2026-11-09-pm");
    expect(html).toContain("明日预判");
  });
});
