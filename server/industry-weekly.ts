// 行业动态 · 行业周报: every Friday 19:15 (Beijing) an LLM digest of the week's major industry events,
// macro moves and competitor numbers, stored in industryWeekly (id = Beijing end day).
import { getDb } from "./db";
import { getCloudflareEnv } from "./_core/cloudflare-env";
import { ENV } from "./_core/env";
import { invokeLLM } from "./_core/llm";
import { CATEGORIES, DAY, HOUR, INDUSTRY_SOURCES, pickTop, type IndustryRow } from "./industry-calc";
import { topIndustry } from "./industry";
import { getCompetitorDashboard, getMacroDashboard } from "./industry-metrics";
import { getBriefSettings } from "./brief";

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

export async function generateIndustryWeekly(now = Date.now()): Promise<IndustryWeekly> {
  const from = now - 7 * DAY;
  const rows = await topIndustry(from, now, 400);
  const top = pickTop(rows as IndustryRow[], 30, 6, 4);
  if (top.length < 3) throw new Error("本周重要行业事件不足，暂不生成周报");
  const [macro, comp] = await Promise.all([getMacroDashboard(now), getCompetitorDashboard(now)]);

  const numbers: IndustryWeekly["numbers"] = [
    ...macro.macro.filter(m => m.price !== null).map(m => ({
      label: m.name,
      value: m.unit === "%" ? `${m.price!.toFixed(2)}%` : m.price! >= 1000 ? Math.round(m.price!).toLocaleString("en-US") : m.price!.toFixed(2),
      change: m.unit === "%" ? signed(m.change7d, "bp") : signed(m.change7d),
    })),
    ...comp.issuers.filter(i => i.value !== null).map(i => ({ label: i.label, value: fmtUsd(i.value), change: signed(i.change7d) })),
    ...comp.chains.filter(c => c.stablecoins !== null).slice(0, 5).map(c => ({
      label: `${c.label} 稳定币`, value: fmtUsd(c.stablecoins), change: signed(c.stable7d),
    })),
  ];
  const fng = macro.fng[macro.fng.length - 1];
  const facts = [
    ...numbers.map(n => `${n.label}：${n.value}（周变化 ${n.change}）`),
    fng ? `恐慌贪婪指数：${fng.value}` : "",
    ...(macro.fed?.events || []).slice(0, 1).map(e => `Polymarket「${e.title}」：${e.outcomes.map(o => `${o.label} ${Math.round(o.prob)}%`).join("，")}`),
  ].filter(Boolean);

  const list = top.map((r, i) => `[${i}] (${catLabel(r.category)}·${r.importance}级${r.tron ? "·TRON相关" : ""}) ${r.summary || r.title}${r.tronNote ? `（与TRON：${r.tronNote}）` : ""}`).join("\n");
  const system = `你是 TRON（波场）团队的行业研究员，写一份「行业周报」给管理层，风格简洁、只讲事实与判断，不写空话，不给投资建议。输出 JSON：
{"headline":"一句话本周主线（≤30字）","overview":"3-4 句本周行业综述","sections":[{"category":"分类key","points":["要点（≤50字，可合并同类事件）"]}],"competitors":[{"key":"binance|solana|tether|circle|ethereum","text":"本周动向与对 TRON 的含义（1-2句）"}],"tron":["对 TRON 的影响或机会/风险（3条以内）"],"watch":["下周关注（3条以内）"]}
sections 只写本周有事件的分类，分类 key 取自：${CATEGORIES.map(c => `${c.key}(${c.label})`).join("、")}。competitors 只写本周有动向的。`;
  const user = `本周（${bjDay(from)} 至 ${bjDay(now)}）重要事件：\n${list}\n\n本周数据：\n${facts.join("\n")}`;

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
  if (!parsed) throw new Error(`行业周报生成失败：${lastError}`);

  const labels: Record<string, string> = { binance: "Binance", solana: "Solana", tether: "Tether", circle: "Circle", ethereum: "以太坊" };
  const data: IndustryWeekly = {
    id: bjDay(now), from, to: now, generatedAt: Date.now(), model,
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
    events: top.slice(0, 20).map(r => ({
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
  const rows = await client.prepare("SELECT id, generatedAt, data FROM industryWeekly ORDER BY id DESC LIMIT 30")
    .all<{ id: string; generatedAt: number; data: string }>();
  return rows.results.map(r => {
    const d = JSON.parse(r.data) as IndustryWeekly;
    return { id: r.id, generatedAt: Number(r.generatedAt), headline: d.headline, from: d.from, to: d.to };
  });
}

export async function getIndustryWeekly(id: string) {
  const client = await d1();
  const row = await client.prepare("SELECT data FROM industryWeekly WHERE id = ?").bind(id).first<{ data: string }>();
  return row ? (JSON.parse(row.data) as IndustryWeekly) : null;
}
