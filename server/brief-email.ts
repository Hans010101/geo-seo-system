// Email version of a 早报/晚报, laid out like the approved sample (晚报_20261109): title + date,
// verdict, four KPI cards, TRX 24h chart beside four coin sparklines, event cards, other news,
// 7-day trend charts and the outlook. Mail clients need tables + inline styles and PNG images,
// so charts are QuickChart URLs (prices and daily aggregate counts only, no content).
// A plain-text part rides along for clients that prefer it.
import type { BriefData } from "./brief";

const RED = "#c8202a";
const INK = "#1d2230";
const MUTED = "#6b7180";
const LINE = "#e4e2de";
const BG = "#f6f5f3";
const GOOD = "#1f8a4c";
const BLUE = "#2f6db3";
const MONO = "Menlo,Consolas,'Courier New',monospace";

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const safeUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : "");
const signed = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
const price = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v >= 0.01 ? `$${v.toFixed(4)}` : `$${v.toExponential(3)}`);
const tone = (v: number | null | undefined) => (v === null || v === undefined ? MUTED : v >= 0 ? GOOD : RED);
const hhmm = (ms: number) => new Date(ms + 8 * 3_600_000).toISOString().slice(11, 16);

const LIGHT: Record<string, [string, string]> = { 平稳: ["🟢", GOOD], 关注: ["🟡", "#b7791f"], 警戒: ["🟠", "#c2410c"], 危机: ["🔴", "#991b1b"] };
const TREND: Record<string, [string, string]> = {
  up: ["▲ 升温", RED], down: ["▼ 缓和", GOOD], flat: ["● 持平", MUTED], new: ["◆ 新增", BLUE], closed: ["✓ 结案", MUTED],
};
const LEVEL: Record<string, string> = { P1: RED, P2: "#b7791f", P3: BLUE };
const SOURCE: Record<string, string> = { 媒体: BLUE, 公众号: GOOD, 网帖: MUTED };

function chartUrl(config: unknown, w: number, h: number) {
  return `https://quickchart.io/chart?w=${w}&h=${h}&devicePixelRatio=2&bkg=white&c=${encodeURIComponent(JSON.stringify(config))}`;
}

const AXIS = { fontColor: MUTED, fontSize: 10 };
const GRID = { color: "#ecebe8", zeroLineColor: "#ecebe8" };

/** TRX 24h line with 高 / 低 / 最新 labelled, like the sample. */
function trxChart(series: [number, number][]) {
  const vals = series.map(p => Number(p[1].toFixed(5)));
  const hi = vals.indexOf(Math.max(...vals));
  const lo = vals.indexOf(Math.min(...vals));
  const last = vals.length - 1;
  const names: Record<number, string> = { [hi]: "高", [lo]: "低", [last]: "最新" };
  return chartUrl({
    type: "line",
    data: {
      labels: series.map(p => hhmm(p[0])),
      datasets: [
        { data: vals, borderColor: RED, backgroundColor: "rgba(200,32,42,0.08)", fill: true, pointRadius: 0, borderWidth: 2.2, lineTension: 0 },
        {
          data: vals.map((v, i) => (i in names ? v : null)), showLine: false, pointRadius: 4, pointBackgroundColor: "#fff",
          pointBorderColor: RED, pointBorderWidth: 2,
          datalabels: {
            display: true, align: "top", color: INK, font: { size: 11, weight: "bold" },
            formatter: `__FMT__`,
          },
        },
      ],
    },
    options: {
      legend: { display: false },
      layout: { padding: { top: 18, right: 40, left: 4 } },
      plugins: { datalabels: { display: false } },
      scales: {
        xAxes: [{ ticks: { ...AXIS, maxTicksLimit: 7 }, gridLines: { display: false } }],
        yAxes: [{ ticks: { ...AXIS, maxTicksLimit: 5 }, gridLines: GRID }],
      },
    },
  }, 560, 230)
    // QuickChart evaluates function strings; inject the label formatter after JSON encoding.
    .replace(encodeURIComponent('"__FMT__"'), encodeURIComponent(
      `function(v,ctx){var n=${JSON.stringify(names)};return v===null?'':(n[ctx.dataIndex]+' '+v.toFixed(4));}`));
}

function spark(series: [number, number][], up: boolean) {
  const c = up ? GOOD : RED;
  return chartUrl({
    type: "line",
    data: { labels: series.map((_, i) => i), datasets: [{ data: series.map(p => p[1]), borderColor: c, backgroundColor: up ? "rgba(31,138,76,0.10)" : "rgba(200,32,42,0.08)", fill: true, pointRadius: 0, borderWidth: 2, lineTension: 0 }] },
    options: { legend: { display: false }, plugins: { datalabels: { display: false } }, scales: { xAxes: [{ display: false }], yAxes: [{ display: false }] }, layout: { padding: 3 } },
  }, 220, 64);
}

function trendChart(kind: "bar" | "line", days: string[], sets: { name: string; values: number[]; color: string }[], unit = "") {
  return chartUrl({
    type: kind,
    data: {
      labels: days.map(d => d.slice(3)),
      datasets: sets.map((s, n) => kind === "bar"
        ? { label: s.name, data: s.values, backgroundColor: s.values.map((_, i) => (i === s.values.length - 1 ? "rgba(200,32,42,0.4)" : "rgba(200,32,42,0.85)")) }
        : { label: s.name, data: s.values, borderColor: s.color, backgroundColor: s.color, fill: false, pointRadius: 2, borderWidth: 2, lineTension: 0 }),
    },
    options: {
      legend: { display: sets.length > 1, position: "top", labels: { boxWidth: 10, fontSize: 10, fontColor: MUTED } },
      plugins: { datalabels: kind === "bar" ? { anchor: "end", align: "top", color: INK, font: { size: 9 } } : { display: false } },
      layout: { padding: { top: 14 } },
      scales: {
        xAxes: [{ ticks: AXIS, gridLines: { display: false } }],
        yAxes: [{ ticks: { ...AXIS, beginAtZero: true, maxTicksLimit: 4, callback: unit ? `__UNIT__` : undefined }, gridLines: GRID }],
      },
    },
  }, 260, 140).replace(encodeURIComponent('"__UNIT__"'), encodeURIComponent(`function(v){return v+'${unit}';}`));
}

const heading = (text: string) =>
  `<tr><td style="padding:22px 0 10px;font-size:17px;font-weight:700;color:${INK}"><span style="display:inline-block;width:4px;height:17px;background:${RED};vertical-align:-3px;margin-right:8px"></span>${esc(text)}</td></tr>`;
const card = (inner: string, extra = "") =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${LINE};background:#ffffff;border-collapse:collapse;${extra}">${inner}</table>`;

export function buildBriefEmail(b: BriefData, link: string): { subject: string; html: string; text: string } {
  const [icon, lightColor] = LIGHT[b.verdict.level] || LIGHT["关注"];
  const subject = `${icon} ${b.title}｜${b.id.slice(5, 10)} ${b.dateLabel.slice(-2)}｜${b.verdict.level}（${b.verdict.change}）`;
  const k = b.kpis;
  const m = b.market;
  const next = b.kind === "pm" ? "明天看什么" : "今天看什么";

  const points = b.verdict.points.map(p => {
    const [head, ...rest] = p.split("：");
    return `<li style="margin:3px 0">${rest.length ? `<b>${esc(head)}：</b>${esc(rest.join("："))}` : esc(p)}</li>`;
  }).join("");

  const kpi = (label: string, value: string, sub: string, color = INK) =>
    `<td width="25%" valign="top" style="padding:0 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${LINE};background:#fff"><tr><td style="padding:12px 14px">
      <div style="font-size:12.5px;color:${MUTED}">${esc(label)}</div>
      <div style="font-size:24px;font-weight:700;color:${color};font-family:${MONO};line-height:1.3">${esc(value)}</div>
      <div style="font-size:12px;color:${MUTED}">${esc(sub)}</div></td></tr></table></td>`;

  const coinCell = (c: NonNullable<BriefData["market"]>["coins"][number]) => `<td width="50%" valign="top" style="padding:10px 10px 12px">
      <div style="font-size:14px;white-space:nowrap"><b>${esc(c.symbol)}</b> <span style="font-size:11.5px;color:${MUTED}">${esc(c.name)}</span>
        <span style="float:right;color:${tone(c.change24h)};font-weight:700;font-family:${MONO};font-size:12.5px">${signed(c.change24h)}</span></div>
      <div style="font-size:14px;font-weight:700;font-family:${MONO};white-space:nowrap">${price(c.price)}</div>
      ${c.series.length > 1 ? `<img src="${spark(c.series as [number, number][], (c.change24h ?? 0) >= 0)}" width="150" height="44" alt="${esc(c.symbol)} 近 24 小时" style="display:block;margin-top:6px;border:0;width:100%;max-width:150px;height:auto">` : ""}</td>`;
  const coins = m ? m.coins : [];
  const coinRows = [coins.slice(0, 2), coins.slice(2, 4)].filter(r => r.length)
    .map(r => `<tr>${r.map(coinCell).join("")}</tr>`).join("");

  const events = b.events.map(e => {
    const [trendText, trendColor] = TREND[e.trend] || TREND.flat;
    const rows = ([["发生了什么", e.happened], ["怎么看", e.view], ["还没确认", e.unconfirmed], [next, e.next]] as const)
      .filter(([, v]) => v)
      .map(([label, v]) => `<tr><td width="92" valign="top" style="padding:3px 0 3px 14px;color:${MUTED};font-size:13.5px">${label}</td><td style="padding:3px 14px 3px 6px;font-size:14px">${esc(v)}</td></tr>`).join("");
    const sources = e.sources.filter(s => safeUrl(s.url)).map(s =>
      `<div style="margin:3px 0;font-size:13px"><span style="color:${SOURCE[s.kind] || MUTED};border:1px solid ${SOURCE[s.kind] || MUTED};font-size:11px;padding:0 5px;margin-right:6px">${esc(s.kind)}</span><a href="${esc(s.url)}" style="color:${BLUE};text-decoration:none">${esc(s.label)}</a></div>`).join("");
    return `<tr><td style="padding:0 0 12px">${card(`
      <tr><td colspan="2" style="padding:10px 14px;border-bottom:1px solid ${LINE}">
        <span style="background:${LEVEL[e.level] || BLUE};color:#fff;font-size:12px;font-weight:700;padding:1px 7px;font-family:${MONO}">${esc(e.level)}</span>
        <b style="font-size:16px;margin:0 8px">${esc(e.title)}</b>
        <span style="color:${MUTED};font-size:12px">${e.count} 条${e.prevCount !== null ? `（上期 ${e.prevCount}）` : ""}</span>
        <span style="color:${trendColor};font-size:13px;font-weight:700;margin-left:6px">${trendText}</span></td></tr>
      <tr><td width="50%" valign="top" style="padding:9px 14px;font-size:13.5px"><div style="color:${MUTED};font-size:12px;font-weight:600">当前状态</div>${esc(e.state)}</td>
        <td width="50%" valign="top" style="padding:9px 14px;font-size:13.5px;background:#fdf3e1"><div style="color:${MUTED};font-size:12px;font-weight:600">升级条件</div>${esc(e.escalate)}</td></tr>
      <tr><td colspan="2" style="padding:6px 0 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr>
      ${sources ? `<tr><td colspan="2" style="padding:4px 14px 12px">${sources}</td></tr>` : ""}`)}</td></tr>`;
  }).join("");

  const others = b.others.map((o, i) => `<tr><td width="80" valign="top" style="padding:8px 0 8px 14px;color:${MUTED};font-size:13.5px;font-weight:600;${i ? `border-top:1px solid ${LINE}` : ""}">${esc(o.label)}</td>
    <td style="padding:8px 14px 8px 6px;font-size:14px;${i ? `border-top:1px solid ${LINE}` : ""}">${esc(o.text)}</td></tr>`).join("");

  const ind = b.industry;
  const macroStrip = ind?.macro.map(x => `<span style="white-space:nowrap;margin-right:14px"><span style="color:${MUTED}">${esc(x.label)}</span> <b style="font-family:${MONO}">${esc(x.value)}</b>${x.change ? ` <span style="font-family:${MONO};color:${x.dir === "up" ? GOOD : x.dir === "down" ? RED : MUTED}">${esc(x.change)}</span>` : ""}</span>`).join("") || "";
  const industryRows = (ind?.items || []).map((it, i) => `<tr><td style="padding:8px 14px;${i ? `border-top:1px solid ${LINE};` : ""}${it.tron ? "background:#fff7d6;" : ""}font-size:14px">
      <span style="color:${MUTED};font-size:11.5px;border:1px solid ${LINE};padding:0 5px;margin-right:6px;white-space:nowrap">${esc(it.categoryLabel)}</span>${safeUrl(it.url) ? `<a href="${esc(it.url)}" style="color:${INK};text-decoration:none">${esc(it.summary)}</a>` : esc(it.summary)}</td></tr>`).join("");
  const industry = ind && ind.items.length ? `${heading("行业动态")}
  <tr><td>${card(`${macroStrip ? `<tr><td style="padding:9px 14px;font-size:13px;background:#f8f6f1;border-bottom:1px solid ${LINE}">${macroStrip}</td></tr>` : ""}${industryRows}`)}</td></tr>` : "";

  const t = b.trends;
  const trendCell = (title: string, url: string, note = "") => `<td width="50%" valign="top" style="padding:0 4px 8px">${card(`<tr><td style="padding:10px 12px">
      <div style="font-size:13px;font-weight:600;margin-bottom:4px">${esc(title)}</div>
      <img src="${url}" width="300" alt="${esc(title)}" style="display:block;width:100%;max-width:300px;height:auto;border:0">
      ${note ? `<div style="font-size:12px;color:${MUTED};margin-top:4px">${esc(note)}</div>` : ""}</td></tr>`)}</td>`;
  const trends = t.days.length ? `${heading("舆情趋势（近 7 日）")}
  <tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 -4px"><tr>
    ${trendCell("每日新发表条数", trendChart("bar", t.days, [{ name: "新发表", values: t.published, color: RED }]), "最后一天截至本期（浅色）")}
    ${trendCell("负面内容占比", trendChart("line", t.days, [{ name: "负面占比", values: t.negativeShare, color: RED }], "%"))}
  </tr><tr>
    ${trendCell("中威胁条数", trendChart("bar", t.days, [{ name: "中威胁", values: t.medium, color: RED }]))}
    ${trendCell("AI 回答负面率", trendChart("line", t.days, [{ name: "豆包", values: t.geoDoubao, color: RED }, { name: "DeepSeek", values: t.geoDeepseek, color: BLUE }], "%"), "智推时代 · 每日约 195 条回答 / 平台")}
  </tr></table></td></tr>` : "";

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(subject)}</title></head>
<body style="margin:0;background:${BG};color:${INK};font-family:-apple-system,'PingFang SC','Microsoft YaHei','Noto Sans SC',sans-serif;line-height:1.7">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="760" cellpadding="0" cellspacing="0" style="max-width:760px;width:100%">
  <tr><td style="border-bottom:3px solid ${RED};padding-bottom:10px">
    <span style="font-size:27px;font-weight:800;font-family:'Songti SC','Noto Serif SC',serif">${esc(b.title)}</span>
    <span style="font-size:14px;color:${MUTED};margin-left:8px">${esc(b.dateLabel)}</span></td></tr>
  <tr><td style="padding-top:18px">${card(`<tr>
    <td width="110" align="center" valign="middle" style="background:${lightColor};color:#fff;padding:14px 10px">
      <div style="font-size:21px;font-weight:800">${icon} ${esc(b.verdict.level)}</div><div style="font-size:12px">较上期 ${esc(b.verdict.change)}</div></td>
    <td valign="top" style="padding:14px 18px"><div style="font-size:16.5px;font-weight:700">${esc(b.verdict.lead)}</div>
      ${points ? `<ol style="margin:8px 0 0;padding-left:20px;font-size:14.5px">${points}</ol>` : ""}</td></tr>`)}</td></tr>
  <tr><td style="padding-top:14px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 -4px"><tr>
    ${kpi("高威胁舆情", String(k.high), `中威胁 ${k.medium}（昨同时段 ${k.mediumPrev}）`)}
    ${kpi("负面舆情", String(k.negative), `昨同时段 ${k.negativePrev} · 相关 ${k.relevant} 条`)}
    ${kpi("新发表舆情", String(k.published), `昨同时段 ${k.publishedPrev} · 正面 ${k.positive} 条`)}
    ${kpi("TRX 相对大盘", signed(m?.excess24h), `24h 超额；同期大盘 ${signed(m?.benchmark24h)}`, tone(m?.excess24h))}
  </tr></table></td></tr>
  ${m ? `${heading("市场走势")}
  <tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 -4px"><tr>
    <td width="60%" valign="top" style="padding:0 4px">${card(`<tr><td style="padding:12px 14px">
      <div style="font-size:13.5px;font-weight:600;margin-bottom:6px">TRX 近 24 小时（小时价，USD）</div>
      ${m.trx.series.length > 1 ? `<img src="${trxChart(m.trx.series as [number, number][])}" width="440" alt="TRX 近 24 小时走势" style="display:block;width:100%;max-width:440px;height:auto;border:0">` : ""}</td></tr>`)}</td>
    <td width="40%" valign="top" style="padding:0 4px">${card(`<tr><td style="padding:6px 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${coinRows}</table></td></tr>`)}</td>
  </tr></table></td></tr>` : ""}
  ${industry}
  ${heading("事件追踪")}
  ${events || `<tr><td style="font-size:14px;color:${MUTED}">本时段没有需要追踪的事件。</td></tr>`}
  ${others ? `${heading("其他动态")}<tr><td>${card(others)}</td></tr>` : ""}
  ${trends}
  ${b.outlook ? `<tr><td style="padding-top:20px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fbe9ea;border-left:4px solid ${RED}"><tr><td style="padding:12px 16px;font-size:14.5px">
    <b>${b.kind === "pm" ? "明日预判" : "今日预判"}</b><br>${esc(b.outlook)}</td></tr></table></td></tr>` : ""}
  <tr><td style="padding:18px 0 4px;font-size:12px;color:${MUTED}">在线查看：<a href="${esc(link)}" style="color:${MUTED}">${esc(link)}</a></td></tr>
</table></td></tr></table></body></html>`;

  const figures = [
    `负面舆情 ${k.negative} 条（昨同时段 ${k.negativePrev}），高威胁 ${k.high}，中威胁 ${k.medium}（昨同时段 ${k.mediumPrev}）`,
    `新发表 ${k.published} 条（昨同时段 ${k.publishedPrev}），正面 ${k.positive} 条`,
    ...(m ? [`TRX ${price(m.trx.price)}，24h ${signed(m.trx.change24h)}；同期大盘 ${signed(m.benchmark24h)}，TRX 相对大盘 ${signed(m.excess24h)}`,
      `生态币 24h：${m.coins.map(c => `${c.symbol} ${signed(c.change24h)}`).join("，")}`] : []),
  ];
  const text = [
    `${b.title}　${b.dateLabel}`, "",
    `${icon} 态势：${b.verdict.level}（较上期${b.verdict.change}）`, b.verdict.lead,
    ...b.verdict.points.map((x, i) => `${i + 1}. ${x}`), "",
    "【数据】", ...figures.map(x => `- ${x}`), "",
    ...(ind && ind.items.length ? [
      "【行业动态】", ind.macro.map(x => `${x.label} ${x.value}${x.change ? ` ${x.change}` : ""}`).join("　"),
      ...ind.items.map(it => `- [${it.categoryLabel}] ${it.summary}`), "",
    ] : []),
    "【事件追踪】",
    ...b.events.flatMap(e => [
      `【${e.level}】${e.title}　${(TREND[e.trend] || TREND.flat)[0]}　${e.count} 条${e.prevCount !== null ? `（上期 ${e.prevCount}）` : ""}`,
      ...([["当前状态", e.state], ["升级条件", e.escalate], ["发生了什么", e.happened], ["怎么看", e.view], ["还没确认", e.unconfirmed], [next, e.next]] as const)
        .filter(([, v]) => v).map(([label, v]) => `- ${label}：${v}`),
      ...e.sources.filter(s => safeUrl(s.url)).map(s => `- 来源：${s.label} ${s.url}`), "",
    ]),
    ...(b.others.length ? ["【其他动态】", ...b.others.map(o => `- ${o.label}：${o.text}`), ""] : []),
    ...(b.outlook ? [`【${b.kind === "pm" ? "明日预判" : "今日预判"}】`, b.outlook, ""] : []),
    `在线查看：${link}`,
  ].join("\n");
  return { subject, html, text };
}
