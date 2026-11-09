// Email version of a 早报/晚报, written like an ordinary email (text-first: headings, paragraphs,
// lists, a few links, plus a plain-text part). Image-heavy, table-and-button layouts get filed
// under Gmail's 更新 tab; the owner wants these in the main inbox (2026-11-09).
import type { BriefData } from "./brief";

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const safeUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : "");
const signed = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
const price = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v >= 0.01 ? `$${v.toFixed(4)}` : `$${v.toExponential(3)}`);

const TREND: Record<string, string> = { up: "▲升温", down: "▼缓和", flat: "●持平", new: "◆新增", closed: "✓结案" };
const LIGHT: Record<string, string> = { 平稳: "🟢", 关注: "🟡", 警戒: "🟠", 危机: "🔴" };

export function buildBriefEmail(b: BriefData, link: string): { subject: string; html: string; text: string } {
  const icon = LIGHT[b.verdict.level] || "🟡";
  const subject = `${icon} ${b.title}｜${b.id.slice(5, 10)} ${b.dateLabel.slice(-2)}｜${b.verdict.level}（${b.verdict.change}）`;
  const k = b.kpis;
  const m = b.market;
  const next = b.kind === "pm" ? "明天看什么" : "今天看什么";

  // ---- structured content shared by both parts
  const figures = [
    `负面舆情 ${k.negative} 条（上一日同时段 ${k.negativePrev}），高威胁 ${k.high} 条，中威胁 ${k.medium} 条（同时段 ${k.mediumPrev}）`,
    `新发表 ${k.published} 条（同时段 ${k.publishedPrev}），正面 ${k.positive} 条`,
    ...(m ? [
      `TRX ${price(m.trx.price)}，24 小时 ${signed(m.trx.change24h)}；同期大盘 ${signed(m.benchmark24h)}，TRX 相对大盘 ${signed(m.excess24h)}`,
      `生态币 24 小时：${m.coins.map(c => `${c.symbol} ${signed(c.change24h)}`).join("，")}`,
    ] : []),
  ];
  const events = b.events.map(e => ({
    head: `【${e.level}】${e.title}　${TREND[e.trend] || ""}　${e.count} 条${e.prevCount !== null ? `（上期 ${e.prevCount}）` : ""}`,
    rows: ([["当前状态", e.state], ["升级条件", e.escalate], ["发生了什么", e.happened], ["怎么看", e.view], ["还没确认", e.unconfirmed], [next, e.next]] as const)
      .filter(([, v]) => v),
    sources: e.sources.slice(0, 2).filter(s => safeUrl(s.url)),
  }));

  // ---- HTML: plain document flow, default fonts, no tables/images/buttons
  const p = (s: string) => `<p style="margin:0 0 10px">${s}</p>`;
  const h = (s: string) => `<p style="margin:18px 0 6px"><b>${esc(s)}</b></p>`;
  const html = `<div style="font-size:14px;line-height:1.7">
${p(`<b>${esc(b.title)}　${esc(b.dateLabel)}</b>`)}
${p(`${icon} 态势：${esc(b.verdict.level)}（较上期${esc(b.verdict.change)}）<br>${esc(b.verdict.lead)}`)}
${b.verdict.points.length ? `<ol style="margin:0 0 10px;padding-left:22px">${b.verdict.points.map(x => `<li>${esc(x)}</li>`).join("")}</ol>` : ""}
${h("数据")}<ul style="margin:0 0 10px;padding-left:22px">${figures.map(x => `<li>${esc(x)}</li>`).join("")}</ul>
${h("事件追踪")}
${events.map(e => `${p(`<b>${esc(e.head)}</b>`)}<ul style="margin:0 0 6px;padding-left:22px">${e.rows.map(([label, v]) => `<li>${esc(label)}：${esc(v)}</li>`).join("")}</ul>
${e.sources.length ? p(`来源：${e.sources.map(s => `<a href="${esc(s.url)}">${esc(s.label)}</a>`).join("；")}`) : ""}`).join("\n") || p("本时段没有需要追踪的事件。")}
${b.others.length ? `${h("其他动态")}<ul style="margin:0 0 10px;padding-left:22px">${b.others.map(o => `<li>${esc(o.label)}：${esc(o.text)}</li>`).join("")}</ul>` : ""}
${b.outlook ? `${h(b.kind === "pm" ? "明日预判" : "今日预判")}${p(esc(b.outlook))}` : ""}
${p(`完整版（含走势图和 7 日趋势）：<a href="${esc(link)}">${esc(link)}</a>`)}
</div>`;

  // ---- plain-text part
  const lines = [
    `${b.title}　${b.dateLabel}`, "",
    `${icon} 态势：${b.verdict.level}（较上期${b.verdict.change}）`, b.verdict.lead,
    ...b.verdict.points.map((x, i) => `${i + 1}. ${x}`), "",
    "【数据】", ...figures.map(x => `- ${x}`), "",
    "【事件追踪】",
    ...events.flatMap(e => [e.head, ...e.rows.map(([label, v]) => `- ${label}：${v}`), ...e.sources.map(s => `- 来源：${s.label} ${s.url}`), ""]),
    ...(b.others.length ? ["【其他动态】", ...b.others.map(o => `- ${o.label}：${o.text}`), ""] : []),
    ...(b.outlook ? [`【${b.kind === "pm" ? "明日预判" : "今日预判"}】`, b.outlook, ""] : []),
    `完整版：${link}`,
  ];
  return { subject, html, text: lines.join("\n") };
}
