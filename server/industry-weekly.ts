// 行业报告（周报 / 月报 / 自定义）: an LLM digest of a period's major industry events, macro moves and
// competitor numbers. Periods match the sentiment and GEO reports (Friday–Thursday weeks, calendar
// months, or a chosen date range, Beijing time); stored in industryWeekly keyed by geoReportKey.
import { getDb } from "./db";
import { getCloudflareEnv } from "./_core/cloudflare-env";
import { ENV } from "./_core/env";
import { invokeLLM } from "./_core/llm";
import { CATEGORIES, DAY, HOUR, INDUSTRY_SOURCES, pickTop, type IndustryRow } from "./industry-calc";
import { topIndustry } from "./industry";
import { getCompetitorDashboard, getMacroDashboard } from "./industry-metrics";
import { getBriefSettings } from "./brief";
import { geoReportKey, reportKindLabel, type ReportPeriod } from "../shared/report-period";

type D1Stmt = { bind(...values: unknown[]): D1Stmt; all<T = unknown>(): Promise<{ results: T[] }>; first<T = unknown>(): Promise<T | null>; run(): Promise<unknown> };
type D1Like = { prepare(sql: string): D1Stmt };
async function d1(): Promise<D1Like> {
  const database = await getDb();
  if (!database) throw new Error("Database unavailable");
  return (database as unknown as { $client: D1Like }).$client;
}

const bjDay = (ms: number) => new Date(ms + 8 * HOUR).toISOString().slice(0, 10);
const catLabel = (key: string | null) => CATEGORIES.find(c => c.key === key)?.label || "其他";
const fmtUsd = (v: number | null) =>
  v === null ? "—" : v >= 1e8 ? `${(v / 1e8).toFixed(v >= 1e10 ? 0 : 1)} 亿美元` : `${Math.round(v / 1e4)} 万美元`;
const signed = (v: number | null, unit = "%") => (v === null ? "—" : `${v > 0 ? "+" : ""}${v}${unit}`);

export type WeeklyEvent = { id: string; summary: string; category: string; importance: number; url: string; source: string; publishedAt: number; tronNote: string };
export type IndustryWeekly = {
  id: string; from: number; to: number; generatedAt: number; model: string;
  reportType?: "weekly" | "monthly";
  reportPeriod?: string;
  kind?: "周报" | "月报" | "自定义";
  partial?: boolean; // the period was still running when the report was generated
  headline: string;
  overview: string;
  sections: { category: string; label: string; points: string[] }[];
  competitors: { key: string; label: string; text: string }[];
  tron: string[];
  watch: string[];
  events: WeeklyEvent[];
  numbers: { label: string; value: string; change: string }[];
};

function extractJson(text: string) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object");
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
}
const strs = (v: unknown, max = 12) => (Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean).slice(0, max) : []);

export async function generateIndustryReport(period: ReportPeriod, now = Date.now()): Promise<IndustryWeekly> {
  const from = period.startMs;
  const to = Math.min(period.endMs, now);
  if (to <= from) throw new Error("所选周期还没开始");
  const kind = reportKindLabel(period.reportType, period.reportPeriod);
  const long = period.endMs - period.startMs > 10 * DAY; // months and long custom ranges
  const term = kind === "月报" ? "本月" : kind === "周报" ? "本周" : "本期";
  const next = kind === "月报" ? "下月" : kind === "周报" ? "下周" : "下一阶段";
  const changeLabel = long ? "近 30 天变化" : "近 7 天变化";

  const rows = await topIndustry(from, to, long ? 1500 : 400);
  const top = pickTop(rows as IndustryRow[], long ? 40 : 30, long ? 8 : 6, 4);
  if (top.length < 3) throw new Error(`${term}重要行业事件不足，暂不生成报告`);
  const [macro, comp] = await Promise.all([getMacroDashboard(to), getCompetitorDashboard(to)]);

  const numbers: IndustryWeekly["numbers"] = [
    ...macro.macro.filter(m => m.price !== null).map(m => ({
      label: m.name,
      value: m.unit === "%" ? `${m.price!.toFixed(2)}%` : m.price! >= 1000 ? Math.round(m.price!).toLocaleString("en-US") : m.price!.toFixed(2),
      change: signed(long ? m.change30d : m.change7d),
    })),
    ...comp.issuers.filter(i => i.value !== null).map(i => ({ label: i.label, value: fmtUsd(i.value), change: signed(long ? i.change30d : i.change7d) })),
    ...comp.chains.filter(c => c.stablecoins !== null).slice(0, 5).map(c => ({
      label: `${c.label} 稳定币`, value: fmtUsd(c.stablecoins), change: signed(long ? c.stable30d : c.stable7d),
    })),
  ];
  const fng = macro.fng[macro.fng.length - 1];
  const facts = [
    ...numbers.map(n => `${n.label}：${n.value}（${changeLabel} ${n.change}）`),
    fng ? `恐慌贪婪指数：${fng.value}` : "",
    ...(macro.fed?.events || []).slice(0, 1).map(e => `Polymarket「${e.title}」：${e.outcomes.map(o => `${o.label} ${Math.round(o.prob)}%`).join("，")}`),
  ].filter(Boolean);

  const list = top.map((r, i) => `[${i}] (${catLabel(r.category)}·${r.importance}级${r.tron ? "·TRON相关" : ""}) ${r.summary || r.title}${r.tronNote ? `（与TRON：${r.tronNote}）` : ""}`).join("\n");
  const system = `你是 TRON（波场）团队的行业研究员，写一份「行业${kind}」给管理层，风格简洁、只讲事实与判断，不写空话，不给投资建议。涨跌幅、利率变化一律用 %，不用 bp/基点。输出 JSON：
{"headline":"一句话${term}主线（≤30字）","overview":"3-4 句${term}行业综述","sections":[{"category":"分类key","points":["要点（≤50字，可合并同类事件）"]}],"competitors":[{"key":"binance|solana|tether|circle|ethereum","text":"${term}动向与对 TRON 的含义（1-2句）"}],"tron":["对 TRON 的影响或机会/风险（3条以内）"],"watch":["${next}关注（3条以内）"]}
sections 只写${term}有事件的分类，分类 key 取自：${CATEGORIES.map(c => `${c.key}(${c.label})`).join("、")}。competitors 只写${term}有动向的。`;
  const user = `${term}（${bjDay(from)} 至 ${bjDay(to - 1)}）重要事件：\n${list}\n\n${term}数据：\n${facts.join("\n")}`;

  const env = getCloudflareEnv();
  const apiKey = env?.OPENROUTER_API_KEY?.trim() || ENV.openrouterApiKey;
  const model = (await getBriefSettings()).model;
  let parsed: Record<string, unknown> | null = null;
  let lastError = "";
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    const result = await invokeLLM({
      apiKey, baseUrl: "https://openrouter.ai/api/v1", model, maxTokens: 5000, timeoutMs: 150_000,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    });
    const content = result.choices?.[0]?.message?.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.map(c => ("text" in c ? c.text : "")).join("") : "";
    try { parsed = extractJson(text); } catch (error) { lastError = String((error as Error).message); }
  }
  if (!parsed) throw new Error(`行业${kind}生成失败：${lastError}`);

  const labels: Record<string, string> = { binance: "Binance", solana: "Solana", tether: "Tether", circle: "Circle", ethereum: "以太坊" };
  const data: IndustryWeekly = {
    id: geoReportKey(period), from, to, generatedAt: Date.now(), model,
    reportType: period.reportType, reportPeriod: period.reportPeriod, kind, partial: to < period.endMs,
    headline: String(parsed.headline || "").slice(0, 80),
    overview: String(parsed.overview || ""),
    sections: (Array.isArray(parsed.sections) ? parsed.sections : []).map(s => {
      const r = (s || {}) as Record<string, unknown>;
      return { category: String(r.category), label: catLabel(String(r.category)), points: strs(r.points, 6) };
    }).filter(s => s.points.length),
    competitors: (Array.isArray(parsed.competitors) ? parsed.competitors : []).map(c => {
      const r = (c || {}) as Record<string, unknown>;
      return { key: String(r.key), label: labels[String(r.key)] || String(r.key), text: String(r.text || "") };
    }).filter(c => c.text && labels[c.key]),
    tron: strs(parsed.tron, 4),
    watch: strs(parsed.watch, 4),
    events: top.slice(0, long ? 30 : 20).map(r => ({
      id: r.id, summary: r.summary || r.title, category: catLabel(r.category), importance: r.importance ?? 3, url: r.url,
      source: INDUSTRY_SOURCES[r.source]?.label || r.source, publishedAt: Number(r.publishedAt), tronNote: r.tronNote || "",
    })),
    numbers,
  };
  const client = await d1();
  await client.prepare(`INSERT INTO industryWeekly (id, generatedAt, data) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET generatedAt = excluded.generatedAt, data = excluded.data`)
    .bind(data.id, data.generatedAt, JSON.stringify(data)).run();
  return data;
}

export async function listIndustryWeekly() {
  const client = await d1();
  const rows = await client.prepare("SELECT id, generatedAt, data FROM industryWeekly ORDER BY generatedAt DESC LIMIT 60")
    .all<{ id: string; generatedAt: number; data: string }>();
  return rows.results.map(r => {
    const d = JSON.parse(r.data) as IndustryWeekly;
    const reportPeriod = d.reportPeriod || `${bjDay(d.from)} ~ ${bjDay(d.to - 1)}`;
    return {
      id: r.id, generatedAt: Number(r.generatedAt), headline: d.headline, from: d.from, to: d.to,
      reportPeriod, kind: d.kind || reportKindLabel(d.reportType || "weekly", reportPeriod),
    };
  });
}

export async function getIndustryWeekly(id: string) {
  const client = await d1();
  const row = await client.prepare("SELECT data FROM industryWeekly WHERE id = ?").bind(id).first<{ data: string }>();
  return row ? (JSON.parse(row.data) as IndustryWeekly) : null;
}
