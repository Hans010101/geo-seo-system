// Daily 早报 / 晚报: assembled from D1 (sentiment, vendors, prices), events and wording by one LLM
// call, stored in D1 dailyBriefs, pushed to Telegram as the 5-line decision summary.
// Scheduled from the cron queue (早报 09:20, 晚报 17:45) and runnable by an admin from the page.
import { getDb, getSysConfig, setSysConfig } from "./db";
import { getCloudflareEnv } from "./_core/cloudflare-env";
import { ENV } from "./_core/env";
import { invokeLLM } from "./_core/llm";
import { dispatchNotification } from "./_core/notification";
import { sendEmailAlert } from "./monitor/email-alert";
import { buildBriefEmail } from "./brief-email";
import { excessReturn, priceAt, toSeries } from "./market-calc";
import {
  BRIEF_LABEL, bjDay, bjDayStart, bjHHMM, bjMMDD, briefWindow, buildPrompt, parseDraft, platformCn, pushText,
  toSource, weekday, type BriefDraft, type BriefItem, type BriefKind, type BriefSource, type PreviousEvent,
} from "./brief-calc";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NEG = "relevance IN ('high','medium') AND sentimentScore <= 2";
const POS = "relevance IN ('high','medium') AND sentimentScore >= 4";
const SITE = "https://trongeo.asia";
const KEYS = {
  enabled: "daily_brief_enabled", push: "daily_brief_push_enabled", email: "daily_brief_email_enabled",
  model: "daily_brief_model", request: "daily_brief_request",
} as const;
const DEFAULT_MODEL = "anthropic/claude-sonnet-5.5";
const COINS: [string, string][] = [["JST", "JUST"], ["BTT", "BitTorrent"], ["NFT", "APENFT"], ["WIN", "WINkLink"]];

type D1Stmt = { bind(...v: unknown[]): D1Stmt; all<T = unknown>(): Promise<{ results: T[] }>; first<T = unknown>(): Promise<T | null>; run(): Promise<unknown> };
type D1Like = { prepare(sql: string): D1Stmt; batch(s: D1Stmt[]): Promise<{ results: unknown[] }[]> };

async function d1(): Promise<D1Like> {
  const database = await getDb();
  if (!database) throw new Error("Database unavailable");
  return (database as unknown as { $client: D1Like }).$client;
}

export type BriefEvent = {
  key: string; short: string; level: string; title: string; trend: string; count: number; prevCount: number | null;
  state: string; escalate: string; happened: string; view: string; unconfirmed: string; next: string;
  ids: number[]; sources: BriefSource[];
};

export type BriefData = {
  id: string; kind: BriefKind; title: string; dateLabel: string;
  windowStart: number; windowEnd: number; generatedAt: number; nextLabel: string;
  verdict: { level: string; change: string; lead: string; points: string[] };
  kpis: {
    high: number; highPrev: number; medium: number; mediumPrev: number; negative: number; negativePrev: number;
    relevant: number; published: number; publishedPrev: number; positive: number; positivePrev: number;
  };
  market: {
    trx: { price: number | null; change24h: number | null; series: [number, number][] };
    benchmark24h: number | null; excess24h: number | null; note: string;
    coins: { symbol: string; name: string; price: number | null; change24h: number | null; series: [number, number][] }[];
    coinsNote: string;
  } | null;
  events: BriefEvent[];
  others: { label: string; text: string }[];
  trends: { days: string[]; published: number[]; negativeShare: number[]; medium: number[]; geoDoubao: number[]; geoDeepseek: number[] };
  outlook: string;
  asks: string[];
  model: string; usage?: { prompt: number; completion: number };
};

export async function getBriefSettings() {
  const [enabled, push, email, model] = await Promise.all([
    getSysConfig(KEYS.enabled), getSysConfig(KEYS.push), getSysConfig(KEYS.email), getSysConfig(KEYS.model),
  ]);
  return { enabled: enabled !== "false", push: push !== "false", email: email !== "false", model: model?.trim() || DEFAULT_MODEL };
}

export async function setBriefSettings(s: { enabled: boolean; push: boolean; email: boolean }) {
  await setSysConfig(KEYS.enabled, String(s.enabled));
  await setSysConfig(KEYS.push, String(s.push));
  await setSysConfig(KEYS.email, String(s.email));
}

/**
 * One-off generation requested through sysConfigs `daily_brief_request` = {"kind":"pm","push":false,"email":true}
 * (lets an operator without an admin login trigger a brief); picked up by the cron queue at :15 / :40.
 */
export async function runRequestedBrief(): Promise<BriefData | null> {
  const raw = await getSysConfig(KEYS.request);
  if (!raw?.trim()) return null;
  await setSysConfig(KEYS.request, ""); // consume first so a failure cannot loop every firing
  let req: { kind?: string; push?: boolean; email?: boolean } = {};
  try { req = JSON.parse(raw); } catch { return null; }
  const kind: BriefKind | undefined = req.kind === "am" || req.kind === "pm" ? req.kind : undefined;
  return generateBrief({ kind, push: req.push === true, email: req.email !== false });
}

const pct2 = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const fmtPrice = (v: number | null) => (v === null ? "—" : v >= 0.01 ? `$${v.toFixed(4)}` : `$${v.toExponential(3)}`);
const signed = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);

async function counts(client: D1Like, start: number, end: number) {
  const r = await client.prepare(`SELECT COUNT(*) total, SUM(relevance IN ('high','medium')) rel,
      SUM(${NEG}) neg, SUM(${POS}) pos, SUM(threatLevel = 'high') hi, SUM(threatLevel = 'medium') med
    FROM monitor_articles WHERE publishedAt >= ? AND publishedAt < ?`).bind(start, end)
    .first<Record<string, number | null>>();
  const n = (k: string) => Number(r?.[k] || 0);
  return { total: n("total"), rel: n("rel"), neg: n("neg"), pos: n("pos"), hi: n("hi"), med: n("med") };
}

async function marketBlock(client: D1Like, now: number): Promise<BriefData["market"]> {
  const rows = await client.prepare("SELECT symbol, ts, price FROM marketPrices WHERE ts >= ? ORDER BY ts")
    .bind(now - 2 * DAY).all<{ symbol: string; ts: number; price: number }>();
  const series = toSeries(rows.results);
  const last = (series.TRX || [])[series.TRX?.length - 1]?.[0];
  if (!last) return null;
  const from = last - DAY;
  const window = (sym: string) => (series[sym] || []).filter(p => p[0] >= from && p[0] <= last) as [number, number][];
  const change = (sym: string) => {
    const a = priceAt(series[sym], from, 3 * HOUR);
    const b = priceAt(series[sym], last, 3 * HOUR);
    return a && b ? pct2((b / a - 1) * 100) : null;
  };
  const move = excessReturn(series, from, last);
  const trxSeries = window("TRX");
  const trxPrices = trxSeries.map(p => p[1]);
  const trx24 = change("TRX");
  const note = trxPrices.length
    ? `24 小时在 ${fmtPrice(Math.min(...trxPrices))}–${fmtPrice(Math.max(...trxPrices))} 之间，较 ${bjMMDD(from)} ${bjHHMM(from)} ${trx24 !== null && trx24 < 0 ? "跌" : "涨"} ${Math.abs(trx24 ?? 0).toFixed(2)}%；同期大盘（BTC/ETH/BNB/SOL/XRP/HYPE）${signed(move.benchmark)}，TRX ${(move.excess ?? 0) >= 0 ? "相对抗跌" : "跑输大盘"}（超额 ${signed(move.excess)}）。`
    : "";
  const coins = COINS.map(([symbol, name]) => {
    const s = window(symbol);
    return { symbol, name, price: s.length ? s[s.length - 1][1] : null, change24h: change(symbol), series: s };
  });
  const ranked = coins.filter(c => c.change24h !== null).sort((a, b) => (a.change24h as number) - (b.change24h as number));
  const coinsNote = ranked.length
    ? `生态币 24 小时${ranked.every(c => (c.change24h as number) < 0) ? "全部下跌" : ranked.every(c => (c.change24h as number) >= 0) ? "全部上涨" : "涨跌互现"}，${ranked[0].symbol} ${signed(ranked[0].change24h)} 最弱，${ranked[ranked.length - 1].symbol} ${signed(ranked[ranked.length - 1].change24h)} 最强。`
    : "";
  return {
    trx: { price: trxPrices.length ? trxPrices[trxPrices.length - 1] : null, change24h: trx24, series: trxSeries },
    benchmark24h: move.benchmark, excess24h: move.excess, note, coins, coinsNote,
  };
}

async function trendBlock(client: D1Like, now: number) {
  const first = bjDayStart(now) - 6 * DAY;
  const days = Array.from({ length: 7 }, (_, i) => bjDay(first + i * DAY));
  const [art, geo] = await client.batch([
    client.prepare(`SELECT date(publishedAt / 1000, 'unixepoch', '+8 hours') d, COUNT(*) n, SUM(${NEG}) neg, SUM(threatLevel = 'medium') med
      FROM monitor_articles WHERE publishedAt >= ? AND publishedAt < ? GROUP BY d`).bind(first, now),
    client.prepare(`SELECT queryDay d, platform, COUNT(*) n, SUM(sentiment = 'negative') neg FROM externalGeoAnswers
      WHERE queryDay >= ? AND platform IN ('doubao', 'deepseek') GROUP BY queryDay, platform`).bind(days[0]),
  ]);
  const a = new Map((art.results as { d: string; n: number; neg: number; med: number }[]).map(r => [r.d, r]));
  const g = new Map((geo.results as { d: string; platform: string; n: number; neg: number }[]).map(r => [`${r.d}:${r.platform}`, r]));
  const rate = (d: string, p: string) => { const r = g.get(`${d}:${p}`); return r && r.n ? Math.round((r.neg / r.n) * 1000) / 10 : 0; };
  return {
    days: days.map(d => d.slice(5)),
    published: days.map(d => Number(a.get(d)?.n || 0)),
    negativeShare: days.map(d => { const r = a.get(d); return r && r.n ? Math.round((Number(r.neg) / r.n) * 1000) / 10 : 0; }),
    medium: days.map(d => Number(a.get(d)?.med || 0)),
    geoDoubao: days.map(d => rate(d, "doubao")),
    geoDeepseek: days.map(d => rate(d, "deepseek")),
  };
}

async function geoLine(client: D1Like, now: number): Promise<string> {
  const today = bjDay(now);
  const yesterday = bjDay(now - DAY);
  const [byDay, byPlatform, questions] = await client.batch([
    client.prepare(`SELECT queryDay d, COUNT(*) n, SUM(sentiment = 'negative') neg FROM externalGeoAnswers WHERE queryDay IN (?, ?) GROUP BY queryDay`).bind(today, yesterday),
    client.prepare(`SELECT platform, COUNT(*) n, SUM(sentiment = 'negative') neg FROM externalGeoAnswers WHERE queryDay = ? GROUP BY platform`).bind(today),
    client.prepare(`SELECT question, COUNT(*) n, SUM(sentiment = 'negative') neg FROM externalGeoAnswers WHERE queryDay = ?
      GROUP BY question HAVING neg > 0 ORDER BY neg DESC LIMIT 3`).bind(today),
  ]);
  const d = new Map((byDay.results as { d: string; n: number; neg: number }[]).map(r => [r.d, r]));
  const t = d.get(today);
  if (!t || !t.n) return "";
  const y = d.get(yesterday);
  const rate = (r?: { n: number; neg: number }) => (r && r.n ? ((r.neg / r.n) * 100).toFixed(1) : "—");
  const top = (byPlatform.results as { platform: string; n: number; neg: number }[]).sort((a, b) => b.neg / b.n - a.neg / a.n)[0];
  const names: Record<string, string> = { doubao: "豆包", deepseek: "DeepSeek", yuanbao: "元宝", qianwen: "千问", kimi: "Kimi", wenxin: "文心" };
  const qs = (questions.results as { question: string; n: number; neg: number }[]).map(q => `“${q.question.trim()}”（${q.neg}/${q.n}）`).join("、");
  return `智推时代 6 个 AI 平台今日负面率 ${rate(t)}%（昨日 ${rate(y)}%）${top ? `；${names[top.platform] || top.platform} ${rate(top)}% 最高` : ""}${qs ? `。负面集中在 ${qs}` : ""}。`;
}

/** Things the owner must act on: logins and stalled collectors (shown in the summary only). */
async function findAsks(now: number): Promise<string[]> {
  const asks: string[] = [];
  const labels: Record<string, string> = {
    weibo: "微博", xiaohongshu: "小红书", tieba: "贴吧", bilibili: "B站", percent: "百分点", genoptima: "智推时代", market: "币价",
  };
  try {
    const local = JSON.parse((await getSysConfig("cf_local_source_health")) || "{}") as Record<string, { lastRunAt?: number; lastDiscoveredAt?: number; lastError?: string }>;
    const runs = Object.values(local).map(e => e.lastRunAt || 0);
    if (runs.length && now - Math.max(...runs) > 12 * HOUR) asks.push(`Mac 采集器已 ${Math.floor((now - Math.max(...runs)) / HOUR)} 小时未运行，请确认 Mac 未睡眠`);
    for (const [name, e] of Object.entries(local)) {
      if (e.lastError && /登录|扫码|验证码|会话失效/.test(e.lastError) && now - (e.lastDiscoveredAt || 0) > 6 * HOUR) {
        asks.push(`${labels[name] || name}需要重新登录`);
      }
    }
  } catch {
    // heartbeat missing or corrupt: nothing to ask
  }
  return asks;
}

export async function getLatestBrief(before?: number) {
  const client = await d1();
  const row = await client.prepare(`SELECT data FROM dailyBriefs WHERE generatedAt < ? ORDER BY generatedAt DESC LIMIT 1`)
    .bind(before ?? Date.now() + DAY).first<{ data: string }>();
  return row ? (JSON.parse(row.data) as BriefData) : null;
}

export async function listBriefs(limit = 30) {
  const client = await d1();
  const rows = await client.prepare(`SELECT id, kind, day, generatedAt, json_extract(data, '$.verdict.level') AS level,
      json_extract(data, '$.verdict.lead') AS lead FROM dailyBriefs ORDER BY generatedAt DESC LIMIT ?`).bind(limit)
    .all<{ id: string; kind: BriefKind; day: string; generatedAt: number; level: string; lead: string }>();
  return rows.results;
}

export async function getBrief(id: string) {
  const client = await d1();
  const row = await client.prepare("SELECT data FROM dailyBriefs WHERE id = ?").bind(id).first<{ data: string }>();
  return row ? (JSON.parse(row.data) as BriefData) : null;
}

/** Build, store and (optionally) push one brief. `kind` defaults from the Beijing hour. */
export async function generateBrief(opts: { kind?: BriefKind; now?: number; push?: boolean; email?: boolean } = {}): Promise<BriefData & { emailed?: boolean; emailError?: string }> {
  const now = opts.now ?? Date.now();
  const kind: BriefKind = opts.kind ?? (new Date(now + 8 * HOUR).getUTCHours() < 13 ? "am" : "pm");
  const client = await d1();
  const settings = await getBriefSettings();
  const previous = await getLatestBrief(now);
  const win = briefWindow(kind, now, previous?.windowEnd);
  const [cur, cmp] = await Promise.all([counts(client, win.start, win.end), counts(client, win.compareStart, win.compareEnd)]);
  const itemRows = await client.prepare(`SELECT id, publishedAt, sourcePlatform, domain, threatLevel, sentimentScore, title,
      analysisSummary AS summary, url FROM monitor_articles WHERE publishedAt >= ? AND publishedAt < ? AND ${NEG}
    ORDER BY (threatLevel = 'high') DESC, (threatLevel = 'medium') DESC, publishedAt DESC LIMIT 180`)
    .bind(win.start, win.end).all<BriefItem>();
  const items = itemRows.results.map(i => ({ ...i, publishedAt: Number(i.publishedAt) }));
  const byId = new Map(items.map(i => [i.id, i]));
  const [market, trends, geo, asks] = await Promise.all([marketBlock(client, now), trendBlock(client, now), geoLine(client, now), findAsks(now)]);

  const windowLabel = `${bjMMDD(win.start)} ${bjHHMM(win.start)} → ${bjMMDD(win.end)} ${bjHHMM(win.end)}`;
  const facts = [
    `本时段新发表 ${cur.total} 条（上一日同时段 ${cmp.total}），相关 ${cur.rel} 条；负面 ${cur.neg} 条（同时段 ${cmp.neg}）；正面 ${cur.pos} 条（同时段 ${cmp.pos}）`,
    `高威胁 ${cur.hi} 条（同时段 ${cmp.hi}）；中威胁 ${cur.med} 条（同时段 ${cmp.med}）`,
    market ? `TRX ${fmtPrice(market.trx.price)}，24h ${signed(market.trx.change24h)}；大盘 24h ${signed(market.benchmark24h)}；TRX 超额 ${signed(market.excess24h)}` : "币价暂无数据",
    geo || "AI 回答数据暂无",
  ];
  const prevEvents: PreviousEvent[] = (previous?.events || []).filter(e => e.trend !== "closed")
    .map(e => ({ key: e.key, title: e.title, count: e.count, level: e.level }));
  const prompt = buildPrompt({ kind, windowLabel, facts, items, previous: prevEvents, asks });

  const env = getCloudflareEnv();
  const apiKey = env?.OPENROUTER_API_KEY?.trim() || ENV.openrouterApiKey;
  let draft: BriefDraft | null = null;
  let usage: BriefData["usage"];
  let lastError = "";
  for (let attempt = 0; attempt < 2 && !draft; attempt++) {
    const result = await invokeLLM({
      apiKey, baseUrl: "https://openrouter.ai/api/v1", model: settings.model, maxTokens: 6000, timeoutMs: 150_000,
      messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }],
    });
    const content = result.choices?.[0]?.message?.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.map(c => ("text" in c ? c.text : "")).join("") : "";
    usage = { prompt: result.usage?.prompt_tokens ?? 0, completion: result.usage?.completion_tokens ?? 0 };
    try { draft = parseDraft(text, new Set(byId.keys())); } catch (error) { lastError = String((error as Error).message); }
  }
  if (!draft) throw new Error(`早晚报生成失败：${lastError}`);

  const prevCount = new Map((previous?.events || []).map(e => [e.key, e.count]));
  const events: BriefEvent[] = draft.events.map(e => ({
    key: e.key, short: e.short, level: e.level, title: e.title, trend: e.trend,
    count: e.ids.length, prevCount: prevCount.has(e.key) ? prevCount.get(e.key)! : null,
    state: e.state, escalate: e.escalate, happened: e.happened, view: e.view, unconfirmed: e.unconfirmed, next: e.next,
    ids: e.ids,
    sources: (e.sourceIds.length ? e.sourceIds : e.ids.slice(0, 2)).map(id => byId.get(id)).filter((i): i is BriefItem => !!i).map(toSource),
  }));
  const others = [
    { label: "正面", text: draft.others.positive },
    { label: "负面叙事", text: draft.others.narrative },
    { label: "观察", text: draft.others.watch },
    { label: "资金线索", text: draft.others.funds },
    ...(geo ? [{ label: "AI 回答", text: geo }] : []),
  ].filter(o => o.text && o.text !== "无");

  const day = bjDay(now);
  const data: BriefData = {
    id: `${day}-${kind}`, kind, title: `TRON 舆情${BRIEF_LABEL[kind]}`,
    dateLabel: `${day.slice(0, 4)}年${day.slice(5, 7)}月${day.slice(8, 10)}日 ${weekday(now)}`,
    windowStart: win.start, windowEnd: win.end, generatedAt: Date.now(),
    nextLabel: kind === "am" ? "今日 17:45 晚报" : "明日 09:20 早报",
    verdict: { level: draft.level, change: draft.change, lead: draft.lead, points: draft.points },
    kpis: {
      high: cur.hi, highPrev: cmp.hi, medium: cur.med, mediumPrev: cmp.med, negative: cur.neg, negativePrev: cmp.neg,
      relevant: cur.rel, published: cur.total, publishedPrev: cmp.total, positive: cur.pos, positivePrev: cmp.pos,
    },
    market, events, others, trends, outlook: draft.outlook, asks, model: settings.model, usage,
  };
  await client.prepare(`INSERT INTO dailyBriefs (id, kind, day, generatedAt, data) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET generatedAt = excluded.generatedAt, data = excluded.data`)
    .bind(data.id, kind, day, data.generatedAt, JSON.stringify(data)).run();

  if (opts.push ?? settings.push) {
    const msg = pushText({
      kind, at: now, level: draft.level, change: draft.change, lead: draft.lead,
      events: events.map(e => ({ short: e.short, title: e.title, trend: e.trend })),
      trxPrice: market?.trx.price ?? null, trx24h: market?.trx.change24h ?? null, excess24h: market?.excess24h ?? null,
      asks, link: `${SITE}/briefs/${data.id}`,
    });
    await dispatchNotification({ messageType: "batch_summary", title: msg.title, content: msg.content });
  }
  if (opts.email ?? settings.email) {
    // Locked recipient (alert_email_recipient, else the login allow-list address); never throws.
    const mail = buildBriefEmail(data, `${SITE}/briefs/${data.id}`);
    const sent = await sendEmailAlert(mail.subject, mail.html);
    return { ...data, emailed: sent.sent, emailError: sent.error };
  }
  return data;
}

export { platformCn };
