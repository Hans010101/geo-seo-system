// 行业动态 · 宏观仪表 + 竞品看板: daily numbers (DefiLlama stablecoins/TVL/fees, Binance reserves,
// Fear & Greed) in industryMetrics, the Polymarket Fed snapshot in sysConfigs, hourly macro prices
// (NASDAQ, SPX, DXY, US10Y, GOLD) in marketPrices. All fetched by the Mac collector.
import { getDb, getSysConfig, setSysConfig } from "./db";
import { dispatchNotification } from "./_core/notification";
import { MACRO_SERIES, priceAt, sparkline, toSeries } from "./market-calc";
import { DAY, HOUR, ENTITIES, fedLabel } from "./industry-calc";
import { listIndustry } from "./industry";

type D1Stmt = { bind(...values: unknown[]): D1Stmt; all<T = unknown>(): Promise<{ results: T[] }>; first<T = unknown>(): Promise<T | null> };
type D1Like = { prepare(sql: string): D1Stmt };
async function d1(): Promise<D1Like> {
  const database = await getDb();
  if (!database) throw new Error("Database unavailable");
  return (database as unknown as { $client: D1Like }).$client;
}

export type MetricRow = { day: string; entity: string; metric: string; value: number };
const NAME = /^[a-z0-9_]{2,24}$/;

export function parseIndustryMetrics(value: unknown): MetricRow[] {
  const rows = (value as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 5000) throw new Error("Expected 1-5000 rows");
  return rows.map(raw => {
    const r = (raw || {}) as Record<string, unknown>;
    if (typeof r.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.day)) throw new Error("Invalid day");
    if (typeof r.entity !== "string" || !NAME.test(r.entity) || typeof r.metric !== "string" || !NAME.test(r.metric)) throw new Error("Invalid name");
    const v = Number(r.value);
    if (typeof r.value !== "number" || !Number.isFinite(v)) throw new Error("Invalid value");
    return { day: r.day, entity: r.entity, metric: r.metric, value: v };
  });
}

const SNAPSHOT_KINDS = new Set(["fed"]);
export function parseIndustrySnapshot(value: unknown): { kind: string; data: string } {
  const body = value as { kind?: unknown; data?: unknown } | null;
  if (typeof body?.kind !== "string" || !SNAPSHOT_KINDS.has(body.kind)) throw new Error("Unsupported kind");
  if (!body.data || typeof body.data !== "object") throw new Error("Invalid data");
  const data = JSON.stringify(body.data);
  if (data.length > 60_000) throw new Error("Snapshot too large");
  return { kind: body.kind, data };
}

/** Polymarket Fed decision snapshot written by the Mac collector. */
export type FedSnapshot = {
  at: number;
  events: { title: string; endDate: string; url: string; outcomes: { label: string; prob: number }[] }[];
};

const bjDay = (ms: number) => new Date(ms + 8 * HOUR).toISOString().slice(0, 10);

// ------------------------------------------------------------------ 宏观仪表
export async function getMacroDashboard(now = Date.now()) {
  const client = await d1();
  const symbols = ["BTC", ...MACRO_SERIES.map(m => m.symbol)];
  const rows = await client.prepare(`SELECT symbol, ts, price FROM marketPrices WHERE ts >= ? AND symbol IN (${symbols.map(() => "?").join(",")}) ORDER BY ts`)
    .bind(now - 32 * DAY, ...symbols).all<{ symbol: string; ts: number; price: number }>();
  const series = toSeries(rows.results);
  const series_ = (symbol: string, name: string, unit?: string) => {
    const points = series[symbol] || [];
    const last = points[points.length - 1];
    if (!last) return { symbol, name, unit: unit || null, price: null, at: null, change1d: null, change7d: null, change30d: null, spark: [] as (number | null)[] };
    // Markets close: compare with the last value at least N days before the latest print.
    const change = (span: number) => {
      const before = priceAt(points, last[0] - span, 4 * DAY);
      if (before === null) return null;
      // A yield moves in percentage points (+0.12%), a price in percent of itself.
      return unit === "%" ? Math.round((last[1] - before) * 100) / 100 : Math.round(((last[1] - before) / before) * 10000) / 100;
    };
    return {
      symbol, name, unit: unit || null, price: last[1], at: last[0],
      change1d: change(DAY), change7d: change(7 * DAY), change30d: change(30 * DAY),
      spark: sparkline(points, last[0] - 30 * DAY, last[0], 12 * HOUR),
    };
  };
  const macro = [series_("BTC", "比特币"), ...MACRO_SERIES.map(m => series_(m.symbol, m.name, "unit" in m ? m.unit : undefined))];
  const fng = await client.prepare(`SELECT day, value FROM industryMetrics WHERE entity = 'macro' AND metric = 'fng' AND day >= ? ORDER BY day`)
    .bind(bjDay(now - 30 * DAY)).all<{ day: string; value: number }>();
  let fed: FedSnapshot | null = null;
  try { fed = JSON.parse((await getSysConfig("industry_snapshot_fed")) || "null"); } catch { fed = null; }
  if (fed) fed = { ...fed, events: fed.events.map(e => ({ ...e, outcomes: e.outcomes.map(o => ({ ...o, label: fedLabel(o.label) })) })) };
  const news = await listIndustry({ days: 7, category: "macro", minImportance: 3, limit: 12 }, now);
  return { macro, fng: fng.results, fed, news: news.items };
}

// ------------------------------------------------------------------ 竞品看板
/** Chains compared on stablecoin rails (DefiLlama names → our keys, mapped by the collector). */
export const CHAINS = [
  { key: "tron", label: "TRON" },
  { key: "ethereum", label: "以太坊" },
  { key: "solana", label: "Solana" },
  { key: "bsc", label: "BNB Chain" },
  { key: "plasma", label: "Plasma" },
  { key: "stable", label: "Stable" },
  { key: "arc", label: "Arc（Circle）" },
] as const;
const CHAIN_TOKEN: Record<string, string> = { tron: "TRX", ethereum: "ETH", solana: "SOL", bsc: "BNB" };

export async function getCompetitorDashboard(now = Date.now()) {
  const client = await d1();
  const since = bjDay(now - 95 * DAY);
  const rows = await client.prepare("SELECT day, entity, metric, value FROM industryMetrics WHERE day >= ? AND entity != 'macro' ORDER BY day")
    .bind(since).all<MetricRow>();
  const map = new Map<string, [string, number][]>(); // entity:metric → [[day, value]]
  for (const r of rows.results) {
    const key = `${r.entity}:${r.metric}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push([r.day, Number(r.value)]);
  }
  const at = (entity: string, metric: string, daysAgo = 0) => {
    const points = map.get(`${entity}:${metric}`);
    if (!points?.length) return null;
    if (!daysAgo) return points[points.length - 1][1];
    const target = bjDay(Date.parse(points[points.length - 1][0] + "T00:00:00Z") - daysAgo * DAY);
    for (let i = points.length - 1; i >= 0; i--) if (points[i][0] <= target) return points[i][1];
    return null;
  };
  const pct = (a: number | null, b: number | null) => (a === null || b === null || !b ? null : Math.round(((a - b) / b) * 10000) / 100);
  const latestDay = rows.results.length ? rows.results[rows.results.length - 1].day : null;

  const prices = await client.prepare(`SELECT symbol, ts, price FROM marketPrices WHERE ts >= ? AND symbol IN ('TRX','ETH','SOL','BNB') ORDER BY ts`)
    .bind(now - 32 * DAY).all<{ symbol: string; ts: number; price: number }>();
  const priceSeries = toSeries(prices.results);
  const tokenChange = (symbol: string, span: number) => {
    const points = priceSeries[symbol] || [];
    const last = points[points.length - 1];
    const before = last ? priceAt(points, last[0] - span, 6 * HOUR) : null;
    return last && before ? Math.round(((last[1] - before) / before) * 10000) / 100 : null;
  };

  const usdtTotal = at("tether", "supply");
  const usdcTotal = at("circle", "supply");
  const stableTotal = at("all", "stablecoins");
  const chains = CHAINS.map(c => {
    const stable = at(c.key, "stablecoins");
    const usdt = at(c.key, "usdt");
    return {
      ...c,
      stablecoins: stable, stableShare: stable !== null && stableTotal ? Math.round((stable / stableTotal) * 1000) / 10 : null,
      stable7d: pct(stable, at(c.key, "stablecoins", 7)), stable30d: pct(stable, at(c.key, "stablecoins", 30)),
      usdt, usdtShare: usdt !== null && usdtTotal ? Math.round((usdt / usdtTotal) * 1000) / 10 : null,
      usdc: at(c.key, "usdc"),
      tvl: at(c.key, "tvl"), tvl30d: pct(at(c.key, "tvl"), at(c.key, "tvl", 30)),
      fees24h: at(c.key, "fees24h"), fees30d: at(c.key, "fees30d"),
      token: CHAIN_TOKEN[c.key] || null,
      token7d: CHAIN_TOKEN[c.key] ? tokenChange(CHAIN_TOKEN[c.key], 7 * DAY) : null,
      token30d: CHAIN_TOKEN[c.key] ? tokenChange(CHAIN_TOKEN[c.key], 30 * DAY) : null,
    };
  }).filter(c => c.stablecoins !== null || c.tvl !== null);

  // 90-day trend lines for the chart: stablecoins per chain and USDT per chain.
  const days = Array.from(new Set(rows.results.map(r => r.day))).sort();
  const trend = (metric: string) => days.map(day => {
    const row: Record<string, number | string | null> = { day };
    for (const c of CHAINS) row[c.key] = map.get(`${c.key}:${metric}`)?.find(p => p[0] === day)?.[1] ?? null;
    return row;
  });

  const issuers = [
    { key: "tether", label: "Tether · USDT 总量", value: usdtTotal, change7d: pct(usdtTotal, at("tether", "supply", 7)), change30d: pct(usdtTotal, at("tether", "supply", 30)) },
    { key: "circle", label: "Circle · USDC 总量", value: usdcTotal, change7d: pct(usdcTotal, at("circle", "supply", 7)), change30d: pct(usdcTotal, at("circle", "supply", 30)) },
    { key: "binance", label: "Binance · 交易所储备", value: at("binance", "reserves"), change7d: pct(at("binance", "reserves"), at("binance", "reserves", 7)), change30d: pct(at("binance", "reserves"), at("binance", "reserves", 30)) },
    { key: "all", label: "稳定币总市值", value: stableTotal, change7d: pct(stableTotal, at("all", "stablecoins", 7)), change30d: pct(stableTotal, at("all", "stablecoins", 30)) },
  ];

  // Event timeline per tracked player (last 30 days, importance ≥ 3).
  const timelines = await Promise.all(ENTITIES.map(async e => {
    const list = await listIndustry({ days: 30, entity: e.key, minImportance: 3, limit: 8 }, now);
    return { key: e.key, label: e.label, total: list.total, items: list.items };
  }));
  return { latestDay, chains, issuers, stableTrend: trend("stablecoins"), usdtTrend: trend("usdt"), timelines };
}

// ------------------------------------------------------------------ macro alerts
const MACRO_ALERT_STATE = "industry_macro_alert_state";
export const MACRO_THRESHOLDS = { nasdaqDropPct: 3, btcMovePct: 8, us10yBp: 15 };

/** Big-move alerts on stored macro/BTC prices; once per kind per Beijing day. Returns alerts sent. */
export async function checkMacroAlerts(now = Date.now()) {
  const client = await d1();
  const rows = await client.prepare(`SELECT symbol, ts, price FROM marketPrices WHERE ts >= ? AND symbol IN ('BTC','NASDAQ','US10Y') ORDER BY ts`)
    .bind(now - 6 * DAY).all<{ symbol: string; ts: number; price: number }>();
  const series = toSeries(rows.results);
  const candidates: { kind: string; title: string; content: string }[] = [];
  const move = (symbol: string, maxAge: number) => {
    const points = series[symbol] || [];
    const last = points[points.length - 1];
    if (!last || now - last[0] > maxAge) return null;
    const before = priceAt(points, last[0] - DAY, 4 * DAY);
    return before === null ? null : { last: last[1], before };
  };
  const btc = move("BTC", 3 * HOUR);
  if (btc) {
    const change = ((btc.last - btc.before) / btc.before) * 100;
    if (Math.abs(change) >= MACRO_THRESHOLDS.btcMovePct) candidates.push({
      kind: "btc", title: `BTC 24 小时${change > 0 ? "大涨" : "大跌"} ${change.toFixed(1)}%`,
      content: `BTC 现价约 $${Math.round(btc.last).toLocaleString("en-US")}，24 小时 ${change > 0 ? "+" : ""}${change.toFixed(2)}%。`,
    });
  }
  const ndx = move("NASDAQ", 20 * HOUR);
  if (ndx) {
    const change = ((ndx.last - ndx.before) / ndx.before) * 100;
    if (change <= -MACRO_THRESHOLDS.nasdaqDropPct) candidates.push({
      kind: "nasdaq", title: `纳斯达克单日下跌 ${change.toFixed(1)}%`,
      content: `纳指 ${Math.round(ndx.last).toLocaleString("en-US")}，较前一交易日 ${change.toFixed(2)}%，关注科技股抛压向加密市场传导。`,
    });
  }
  const tnx = move("US10Y", 20 * HOUR);
  if (tnx) {
    const move = tnx.last - tnx.before;
    if (Math.abs(move) * 100 >= MACRO_THRESHOLDS.us10yBp) candidates.push({
      kind: "us10y", title: `10 年期美债收益率单日${move > 0 ? "上行" : "下行"} ${Math.abs(move).toFixed(2)}%`,
      content: `10 年期美债收益率 ${tnx.last.toFixed(2)}%（前一交易日 ${tnx.before.toFixed(2)}%）。`,
    });
  }
  if (!candidates.length) return 0;
  let state: Record<string, string> = {};
  try { state = JSON.parse((await getSysConfig(MACRO_ALERT_STATE)) || "{}"); } catch { state = {}; }
  const today = bjDay(now);
  let sent = 0;
  for (const c of candidates) {
    if (state[c.kind] === today) continue;
    const result = await dispatchNotification({ messageType: "alert", severity: "high", title: `宏观异动｜${c.title}`, content: c.content, dedupKey: `macro:${c.kind}:${today}` });
    if (result.sent > 0) { state[c.kind] = today; sent++; }
  }
  await setSysConfig(MACRO_ALERT_STATE, JSON.stringify(state));
  return sent;
}

/** Important industry events as markers for the 币价联动 chart. */
export async function getIndustryMarkers(days: number, now = Date.now()) {
  const list = await listIndustry({ days, minImportance: days > 14 ? 5 : 4, limit: 60 }, now);
  return list.items.map(i => ({ t: i.publishedAt, label: i.summary, importance: i.importance, category: i.categoryLabel, url: i.url }));
}
