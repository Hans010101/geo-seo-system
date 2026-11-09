// Email version of a 早报/晚报: table layout + inline styles for mail clients. Price charts are
// QuickChart PNG URLs (public market data only); the 7-day trends stay on the web page.
import type { BriefData } from "./brief";

const RED = "#c8202a";
const MUTED = "#6b7180";
const LINE = "#e4e2de";
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const safeUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : "#");
const signed = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
const price = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v >= 0.01 ? `$${v.toFixed(4)}` : `$${v.toExponential(3)}`);
const color = (v: number | null | undefined) => (v === null || v === undefined ? MUTED : v >= 0 ? "#1f8a4c" : RED);
const hhmm = (ms: number) => new Date(ms + 8 * 3_600_000).toISOString().slice(11, 16);

const LIGHT: Record<string, [string, string]> = { 平稳: ["🟢", "#1f8a4c"], 关注: ["🟡", "#b7791f"], 警戒: ["🟠", "#c2410c"], 危机: ["🔴", "#991b1b"] };
const TREND: Record<string, [string, string]> = {
  up: ["▲ 升温", RED], down: ["▼ 缓和", "#1f8a4c"], flat: ["● 持平", MUTED], new: ["◆ 新增", "#2f6db3"], closed: ["✓ 结案", MUTED],
};
const LEVEL: Record<string, string> = { P1: RED, P2: "#b7791f", P3: "#2f6db3" };

/** QuickChart image URL (GET, config in the query string). */
function chartUrl(config: unknown, w: number, h: number) {
  return `https://quickchart.io/chart?w=${w}&h=${h}&devicePixelRatio=2&bkg=white&c=${encodeURIComponent(JSON.stringify(config))}`;
}

function trxChart(series: [number, number][]) {
  const prices = series.map(p => Number(p[1].toFixed(5)));
  return chartUrl({
    type: "line",
    data: { labels: series.map(p => hhmm(p[0])), datasets: [{ data: prices, borderColor: RED, backgroundColor: "rgba(200,32,42,0.08)", fill: true, pointRadius: 0, borderWidth: 2, lineTension: 0.2 }] },
    options: {
      legend: { display: false },
      scales: {
        xAxes: [{ ticks: { maxTicksLimit: 7, fontColor: MUTED, fontSize: 10 }, gridLines: { display: false } }],
        yAxes: [{ ticks: { maxTicksLimit: 5, fontColor: MUTED, fontSize: 10 }, gridLines: { color: "#eeece9" } }],
      },
    },
  }, 560, 220);
}

function spark(series: [number, number][], up: boolean) {
  const c = up ? "#1f8a4c" : RED;
  return chartUrl({
    type: "line",
    data: { labels: series.map((_, i) => i), datasets: [{ data: series.map(p => p[1]), borderColor: c, backgroundColor: up ? "rgba(31,138,76,0.10)" : "rgba(200,32,42,0.08)", fill: true, pointRadius: 0, borderWidth: 2 }] },
    options: { legend: { display: false }, scales: { xAxes: [{ display: false }], yAxes: [{ display: false }] }, layout: { padding: 2 } },
  }, 220, 60);
}

const h2 = (text: string) =>
  `<tr><td style="padding:22px 0 8px;font-size:16px;font-weight:700;color:#1d2230"><span style="display:inline-block;width:4px;height:16px;background:${RED};vertical-align:-2px;margin-right:8px"></span>${esc(text)}</td></tr>`;
const box = (inner: string, extra = "") => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${LINE};background:#ffffff;${extra}">${inner}</table>`;

export function buildBriefEmail(b: BriefData, link: string): { subject: string; html: string } {
  const [icon, lightColor] = LIGHT[b.verdict.level] || LIGHT["关注"];
  const mmdd = b.id.slice(5, 10);
  const subject = `${icon} ${b.title}｜${mmdd} ${b.dateLabel.slice(-2)}｜${b.verdict.level}（${b.verdict.change}）`;
  const k = b.kpis;
  const m = b.market;

  const points = b.verdict.points.map(p => {
    const [head, ...rest] = p.split("：");
    return `<li style="margin:3px 0">${rest.length ? `<b>${esc(head)}：</b>${esc(rest.join("："))}` : esc(p)}</li>`;
  }).join("");

  const kpi = (label: string, value: string, sub: string, valueColor = "#1d2230") =>
    `<td width="25%" valign="top" style="border:1px solid ${LINE};background:#fff;padding:10px 12px">
      <div style="font-size:12px;color:${MUTED}">${esc(label)}</div>
      <div style="font-size:22px;font-weight:700;color:${valueColor};font-family:Menlo,Consolas,monospace">${esc(value)}</div>
      <div style="font-size:12px;color:${MUTED}">${esc(sub)}</div></td>`;

  const coins = m ? m.coins.map(c => `<td width="25%" valign="top" style="padding:6px 8px">
      <div style="font-size:13px"><b>${esc(c.symbol)}</b> <span style="color:${color(c.change24h)};font-weight:600">${signed(c.change24h)}</span></div>
      <div style="font-size:14px;font-weight:600;font-family:Menlo,Consolas,monospace">${price(c.price)}</div>
      ${c.series.length > 1 ? `<img src="${spark(c.series as [number, number][], (c.change24h ?? 0) >= 0)}" width="140" height="38" alt="${esc(c.symbol)} 24 小时走势" style="display:block;margin-top:4px;border:0">` : ""}</td>`).join("") : "";

  const events = b.events.map(e => {
    const [trendText, trendColor] = TREND[e.trend] || TREND.flat;
    const rows = ([["发生了什么", e.happened], ["怎么看", e.view], ["还没确认", e.unconfirmed], [b.kind === "pm" ? "明天看什么" : "今天看什么", e.next]] as const)
      .filter(([, v]) => v)
      .map(([label, v]) => `<tr><td width="88" valign="top" style="padding:3px 0 3px 14px;color:${MUTED};font-size:13px">${label}</td><td style="padding:3px 14px 3px 6px;font-size:13.5px">${esc(v)}</td></tr>`).join("");
    const sources = e.sources.map(s => `<div style="margin:2px 0;font-size:12.5px"><span style="color:${MUTED};border:1px solid ${LINE};padding:0 4px;margin-right:6px">${esc(s.kind)}</span><a href="${esc(safeUrl(s.url))}" style="color:#2f6db3;text-decoration:none">${esc(s.label)}</a></div>`).join("");
    return `<tr><td style="padding:0 0 12px">${box(`
      <tr><td colspan="2" style="padding:9px 14px;border-bottom:1px solid ${LINE}">
        <span style="background:${LEVEL[e.level] || "#2f6db3"};color:#fff;font-size:12px;font-weight:700;padding:1px 6px">${esc(e.level)}</span>
        <b style="font-size:15px;margin:0 8px">${esc(e.title)}</b>
        <span style="color:${MUTED};font-size:12px">${e.count} 条${e.prevCount !== null ? `（上期 ${e.prevCount}）` : ""}</span>
        <span style="color:${trendColor};font-size:13px;font-weight:700;margin-left:6px">${trendText}</span></td></tr>
      <tr><td width="50%" valign="top" style="padding:8px 14px;font-size:13px"><div style="color:${MUTED};font-size:12px">当前状态</div>${esc(e.state)}</td>
        <td width="50%" valign="top" style="padding:8px 14px;font-size:13px;background:#fdf3e1"><div style="color:${MUTED};font-size:12px">升级条件</div>${esc(e.escalate)}</td></tr>
      <tr><td colspan="2" style="padding:4px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr>
      ${sources ? `<tr><td colspan="2" style="padding:4px 14px 10px">${sources}</td></tr>` : ""}`)}</td></tr>`;
  }).join("");

  const others = b.others.map((o, i) => `<tr><td width="76" valign="top" style="padding:7px 0 7px 14px;color:${MUTED};font-size:13px;font-weight:600;${i ? `border-top:1px solid ${LINE}` : ""}">${esc(o.label)}</td>
    <td style="padding:7px 14px 7px 6px;font-size:13.5px;${i ? `border-top:1px solid ${LINE}` : ""}">${esc(o.text)}</td></tr>`).join("");

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;background:#f6f5f3;color:#1d2230;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;line-height:1.65">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f5f3"><tr><td align="center" style="padding:20px 12px">
<table role="presentation" width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%">
  <tr><td style="border-bottom:3px solid ${RED};padding-bottom:8px">
    <span style="font-size:24px;font-weight:800">${esc(b.title)}</span>
    <span style="font-size:13px;color:${MUTED};margin-left:8px">${esc(b.dateLabel)}</span></td></tr>
  <tr><td style="padding-top:16px">${box(`<tr>
    <td width="96" align="center" valign="middle" style="background:${lightColor};color:#fff;padding:12px 8px">
      <div style="font-size:19px;font-weight:800">${icon} ${esc(b.verdict.level)}</div><div style="font-size:12px">较上期 ${esc(b.verdict.change)}</div></td>
    <td valign="top" style="padding:12px 16px"><div style="font-size:15.5px;font-weight:700">${esc(b.verdict.lead)}</div>
      ${points ? `<ol style="margin:6px 0 0;padding-left:20px;font-size:14px">${points}</ol>` : ""}</td></tr>`)}</td></tr>
  <tr><td style="padding-top:12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="6" style="margin:0 -6px"><tr>
    ${kpi("高威胁舆情", String(k.high), `中威胁 ${k.medium}（上一日同时段 ${k.mediumPrev}）`)}
    ${kpi("负面舆情", String(k.negative), `上一日同时段 ${k.negativePrev} · 相关 ${k.relevant}`)}
    ${kpi("新发表舆情", String(k.published), `上一日同时段 ${k.publishedPrev} · 正面 ${k.positive}`)}
    ${kpi("TRX 相对大盘", signed(m?.excess24h), `24h 超额；大盘 ${signed(m?.benchmark24h)}`, color(m?.excess24h))}
  </tr></table></td></tr>
  ${m ? `${h2("市场走势")}
  <tr><td>${box(`<tr><td style="padding:10px 12px 4px;font-size:13px;font-weight:600">TRX 近 24 小时 <span style="font-family:Menlo,Consolas,monospace">${price(m.trx.price)}</span>
      <span style="color:${color(m.trx.change24h)}">${signed(m.trx.change24h)}</span></td></tr>
    ${m.trx.series.length > 1 ? `<tr><td style="padding:0 8px 8px"><img src="${trxChart(m.trx.series as [number, number][])}" width="640" alt="TRX 近 24 小时走势" style="display:block;width:100%;max-width:640px;height:auto;border:0"></td></tr>` : ""}
    <tr><td style="padding:0 4px 8px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${coins}</tr></table></td></tr>`)}</td></tr>` : ""}
  ${h2("事件追踪")}
  ${events || `<tr><td style="font-size:14px;color:${MUTED}">本时段没有需要追踪的事件。</td></tr>`}
  ${others ? `${h2("其他动态")}<tr><td>${box(others)}</td></tr>` : ""}
  ${b.outlook ? `<tr><td style="padding-top:18px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fbe9ea;border-left:4px solid ${RED}"><tr><td style="padding:10px 14px;font-size:14px">
    <b>${b.kind === "pm" ? "明日预判" : "今日预判"}</b><br>${esc(b.outlook)}</td></tr></table></td></tr>` : ""}
  <tr><td align="center" style="padding:22px 0 6px"><a href="${esc(link)}" style="display:inline-block;background:${RED};color:#fff;text-decoration:none;font-size:14px;padding:8px 18px">查看完整版（含 7 日趋势）</a></td></tr>
</table></td></tr></table></body></html>`;
  return { subject, html };
}
