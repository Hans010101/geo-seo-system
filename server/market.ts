// 币价联动: hourly prices of TRON-ecosystem tokens and four benchmark coins from CoinGecko's free
// API (stored in D1 marketPrices), linked to the sentiment monitor. Collection runs as a queue
// task on every cron firing (:15); each run re-reads the last 48h so missed runs self-heal.
import { getDb, getSysConfig, setSysConfig } from "./db";
import { dispatchNotification } from "./_core/notification";
import {
  BENCHMARK, DAY, HOUR, MARKET_TOKENS, TRON_INDEX,
  average, bjDay, bjDayStart, chartRows, correlation, dailyLinks, eventImpacts, evaluateMarketAlerts,
  excessReturn, hourlyRows, klineRows, pct, priceAt, snapshotRows, toSeries,
  type CoinGeckoChart, type MarketAlertSettings, type MarketAlertState, type MarketEvent, type PriceRow,
} from "./market-calc";

const COINGECKO = "https://api.coingecko.com/api/v3";
const BINANCE = "https://data-api.binance.vision/api/v3";
/** CoinGecko's keyless tier allows only a handful of calls per minute. */
const COINGECKO_SPACING_MS = 15_000;
const BACKFILL_DAYS = 90;
const RETENTION_DAYS = 400;
export const MARKET_STATUS_KEY = "market_last_fetch";
const ALERT_STATE_KEY = "market_alert_state";
const SETTINGS_KEYS = {
  enabled: "market_alerts_enabled",
  usddDepegPct: "market_usdd_depeg_pct",
  trxExcessDropPct: "market_trx_excess_drop_pct",
} as const;
const DEFAULT_SETTINGS: MarketAlertSettings = { enabled: false, usddDepegPct: 0.5, trxExcessDropPct: 5 };
/** Negative sentiment as used across the monitor: relevant and scored 1–2. */
const NEGATIVE_SQL = "relevance IN ('high','medium') AND sentimentScore <= 2";

type D1Stmt = { bind(...values: unknown[]): D1Stmt; all<T = unknown>(): Promise<{ results: T[] }>; run(): Promise<unknown> };
type D1Like = { prepare(sql: string): D1Stmt; batch(statements: D1Stmt[]): Promise<{ results: unknown[] }[]> };

async function d1(): Promise<D1Like> {
  const database = await getDb();
  if (!database) throw new Error("Database unavailable");
  return (database as unknown as { $client: D1Like }).$client;
}

const round2 = (value: number | null) => (value === null ? null : Math.round(value * 100) / 100);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function coinGecko(path: string, apiKey?: string): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`${COINGECKO}${path}`, {
      headers: { Accept: "application/json", ...(apiKey ? { "x-cg-demo-api-key": apiKey } : {}) },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 429 && attempt === 0) { await sleep(60_000); continue; }
    if (!response.ok) throw new Error(`CoinGecko ${path.split("?")[0]} HTTP ${response.status}`);
    return await response.json();
  }
  throw new Error(`CoinGecko ${path.split("?")[0]} rate limited`);
}

async function binanceKlines(pair: string, since: number): Promise<unknown[]> {
  const out: unknown[] = [];
  let start = since;
  for (let page = 0; page < 4; page++) {
    const response = await fetch(`${BINANCE}/klines?symbol=${pair}&interval=1h&startTime=${start}&limit=1000`, {
      headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Binance ${pair} HTTP ${response.status}`);
    const batch = await response.json() as unknown[];
    if (!Array.isArray(batch)) throw new Error(`Binance ${pair} bad payload`);
    out.push(...batch);
    if (batch.length < 1000) break;
    start = Number((batch[batch.length - 1] as unknown[])[0]) + HOUR;
  }
  return out;
}

async function upsertRows(client: D1Like, rows: PriceRow[]) {
  // D1 allows 100 bound parameters per statement: 20 rows × 5 columns.
  const statements: D1Stmt[] = [];
  for (let i = 0; i < rows.length; i += 20) {
    const chunk = rows.slice(i, i + 20);
    statements.push(client.prepare(`INSERT INTO marketPrices (symbol, ts, price, marketCap, volume) VALUES
      ${chunk.map(() => "(?, ?, ?, ?, ?)").join(", ")}
      ON CONFLICT(symbol, ts) DO UPDATE SET price = excluded.price,
        marketCap = COALESCE(excluded.marketCap, marketCap), volume = COALESCE(excluded.volume, volume)`)
      .bind(...chunk.flatMap(r => [r.symbol, r.ts, r.price, r.marketCap, r.volume])));
  }
  for (let i = 0; i < statements.length; i += 50) await client.batch(statements.slice(i, i + 50));
}

export async function getMarketAlertSettings(): Promise<MarketAlertSettings> {
  const [enabled, usdd, trx] = await Promise.all(Object.values(SETTINGS_KEYS).map(key => getSysConfig(key)));
  const num = (value: string | null, fallback: number) => {
    const parsed = Number(value);
    return value !== null && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    enabled: enabled === "true",
    usddDepegPct: num(usdd, DEFAULT_SETTINGS.usddDepegPct),
    trxExcessDropPct: num(trx, DEFAULT_SETTINGS.trxExcessDropPct),
  };
}

export async function setMarketAlertSettings(settings: MarketAlertSettings): Promise<void> {
  await setSysConfig(SETTINGS_KEYS.enabled, String(settings.enabled));
  await setSysConfig(SETTINGS_KEYS.usddDepegPct, String(settings.usddDepegPct));
  await setSysConfig(SETTINGS_KEYS.trxExcessDropPct, String(settings.trxExcessDropPct));
}

async function recentNegatives(client: D1Like, since: number) {
  const rows = await client.prepare(`SELECT title, sourcePlatform FROM monitor_articles
    WHERE publishedAt >= ? AND ${NEGATIVE_SQL} AND threatLevel IN ('high','medium')
    ORDER BY (threatLevel = 'high') DESC, publishedAt DESC LIMIT 5`).bind(since)
    .all<{ title: string | null; sourcePlatform: string | null }>();
  return rows.results;
}

/** Queue task body: fetch, store, prune, then evaluate alerts. Returns a small summary. */
export async function collectMarketPrices(opts: { apiKey?: string; now?: number } = {}) {
  const now = opts.now ?? Date.now();
  const client = await d1();
  const counts = await client.prepare(`SELECT symbol, COUNT(*) AS n FROM marketPrices WHERE ts >= ? GROUP BY symbol`)
    .bind(now - BACKFILL_DAYS * DAY).all<{ symbol: string; n: number }>();
  const have = new Map(counts.results.map(row => [row.symbol, Number(row.n)]));
  const fetched: PriceRow[] = [];
  const errors: string[] = [];
  const keep = async (rows: PriceRow[]) => {
    await upsertRows(client, rows);
    fetched.push(...rows.filter(row => row.ts >= now - 2 * DAY));
  };
  // Backfill 90 days once (≈2,160 hourly rows); afterwards 2 days covers any missed run.
  const daysFor = (symbol: string) => ((have.get(symbol) || 0) < (BACKFILL_DAYS - 5) * 24 ? BACKFILL_DAYS : 2);
  const viaCoinGecko = MARKET_TOKENS.filter(token => !token.binance);
  for (const token of MARKET_TOKENS.filter(t => t.binance)) {
    try {
      await keep(klineRows(token.symbol, await binanceKlines(token.binance!, now - daysFor(token.symbol) * DAY)));
    } catch (error) {
      errors.push(String((error as Error).message || error).slice(0, 160));
      viaCoinGecko.push(token); // fall back so the market basket stays complete
    }
  }
  let calls = 0;
  const pace = async () => { if (calls++ > 0) await sleep(COINGECKO_SPACING_MS); };
  for (const token of viaCoinGecko) {
    try {
      await pace();
      const chart = await coinGecko(`/coins/${token.id}/market_chart?vs_currency=usd&days=${daysFor(token.symbol)}`, opts.apiKey);
      await keep(hourlyRows(token.symbol, chart as CoinGeckoChart));
    } catch (error) {
      errors.push(String((error as Error).message || error).slice(0, 160));
    }
  }
  try {
    // One call for every token's market cap and 24h volume (also refreshes the current hour's price).
    await pace();
    await keep(snapshotRows(await coinGecko(`/coins/markets?vs_currency=usd&ids=${MARKET_TOKENS.map(t => t.id).join(",")}`, opts.apiKey)));
  } catch (error) {
    errors.push(String((error as Error).message || error).slice(0, 160));
  }
  await client.prepare("DELETE FROM marketPrices WHERE ts < ?").bind(now - RETENTION_DAYS * DAY).run();

  const series = toSeries(fetched);
  const settings = await getMarketAlertSettings();
  let alertsSent = 0;
  if (settings.enabled) {
    let state: MarketAlertState = {};
    try { state = JSON.parse((await getSysConfig(ALERT_STATE_KEY)) || "{}"); } catch { state = {}; }
    const result = evaluateMarketAlerts({ now, series, settings, state, negatives: await recentNegatives(client, now - DAY) });
    let nextState = { ...state };
    for (const alert of result.alerts) {
      const sent = await dispatchNotification({
        messageType: "alert", title: alert.title, content: alert.content, severity: "high",
        dedupKey: `market:${alert.kind}:${Math.floor(now / HOUR)}`,
      });
      // Advance the state only for alerts that actually went out, so a failed send retries.
      if (sent.sent > 0) {
        alertsSent++;
        if (alert.kind === "trx_drop") nextState.trxAlertedAt = result.state.trxAlertedAt;
        else nextState = { ...nextState, usddDepegged: result.state.usddDepegged, usddAlertedAt: result.state.usddAlertedAt };
      }
    }
    await setSysConfig(ALERT_STATE_KEY, JSON.stringify(nextState));
  }
  const summary = {
    at: now, ok: errors.length === 0, rows: fetched.length, errors: errors.slice(0, 5), alertsSent,
    trx24h: excessReturn(series, now - DAY, now),
  };
  await setSysConfig(MARKET_STATUS_KEY, JSON.stringify(summary));
  return summary;
}

// ---------------------------------------------------------------- reads (API and reports)
async function loadSeries(client: D1Like, from: number) {
  const rows = await client.prepare("SELECT symbol, ts, price FROM marketPrices WHERE ts >= ? ORDER BY ts")
    .bind(from).all<{ symbol: string; ts: number; price: number }>();
  return toSeries(rows.results);
}

export async function getMarketOverview(now = Date.now()) {
  const client = await d1();
  const series = await loadSeries(client, now - 31 * DAY);
  const latest = await client.prepare(`SELECT p.symbol, p.ts, p.price, p.marketCap, p.volume FROM marketPrices p
    JOIN (SELECT symbol, MAX(ts) AS ts FROM marketPrices GROUP BY symbol) m ON m.symbol = p.symbol AND m.ts = p.ts`)
    .all<{ symbol: string; ts: number; price: number; marketCap: number | null; volume: number | null }>();
  const bySymbol = new Map(latest.results.map(row => [row.symbol, row]));
  const latestTs = Math.max(0, ...latest.results.map(row => Number(row.ts)));
  const change = (symbol: string, span: number) => {
    const current = bySymbol.get(symbol);
    if (!current) return null;
    const before = priceAt(series[symbol], Number(current.ts) - span, 6 * HOUR);
    return before ? Math.round(((current.price - before) / before) * 10000) / 100 : null;
  };
  let status: unknown = null;
  try { status = JSON.parse((await getSysConfig(MARKET_STATUS_KEY)) || "null"); } catch { status = null; }
  return {
    updatedAt: latestTs || null,
    status,
    tokens: MARKET_TOKENS.map(token => {
      const row = bySymbol.get(token.symbol);
      return {
        ...token, price: row?.price ?? null, marketCap: row?.marketCap ?? null, volume: row?.volume ?? null,
        change24h: change(token.symbol, DAY), change7d: change(token.symbol, 7 * DAY), change30d: change(token.symbol, 30 * DAY),
      };
    }),
    windows: {
      "24h": latestTs ? excessReturn(series, latestTs - DAY, latestTs) : null,
      "7d": latestTs ? excessReturn(series, latestTs - 7 * DAY, latestTs) : null,
      "30d": latestTs ? excessReturn(series, latestTs - 30 * DAY, latestTs) : null,
    },
    settings: await getMarketAlertSettings(),
  };
}

/** Chart + linkage for the last `days` days (sentiment counts exist for ~30 days of retention). */
export async function getMarketLinkage(days: number, now = Date.now()) {
  const client = await d1();
  const step = days <= 7 ? HOUR : days <= 30 ? 4 * HOUR : DAY;
  const end = Math.floor(now / HOUR) * HOUR;
  const start = days <= 30 ? end - days * DAY : bjDayStart(end - days * DAY);
  const series = await loadSeries(client, start - 2 * DAY);

  const negatives = await client.prepare(`SELECT publishedAt, threatLevel FROM monitor_articles
    WHERE publishedAt >= ? AND publishedAt <= ? AND ${NEGATIVE_SQL}`).bind(start, now)
    .all<{ publishedAt: number; threatLevel: string | null }>();
  const counts = new Map<number, { negatives: number; highThreats: number }>();
  const byDay = new Map<string, number>();
  for (const row of negatives.results) {
    const t = Number(row.publishedAt);
    const bucket = start + Math.floor((t - start) / step) * step;
    const entry = counts.get(bucket) || { negatives: 0, highThreats: 0 };
    entry.negatives++;
    if (row.threatLevel === "high") entry.highThreats++;
    counts.set(bucket, entry);
    byDay.set(bjDay(t), (byDay.get(bjDay(t)) || 0) + 1);
  }
  // Points are bucket starts; bars count the articles published inside each bucket.
  const chart = chartRows(series, start, end, step, counts);

  const eventRows = await client.prepare(`SELECT id, title, url, sourcePlatform, threatLevel, publishedAt FROM monitor_articles
    WHERE publishedAt >= ? AND ${NEGATIVE_SQL} AND threatLevel IN ('high','medium')
    ORDER BY publishedAt DESC LIMIT 300`).bind(Math.max(start, now - 30 * DAY)).all<MarketEvent>();
  const impacts = eventImpacts(series, eventRows.results.map(e => ({ ...e, publishedAt: Number(e.publishedAt) })), now);
  const summarize = (level: string) => {
    const group = impacts.filter(e => e.threatLevel === level);
    return {
      level, count: group.length,
      after1h: average(group.map(e => e.after1h)), after4h: average(group.map(e => e.after4h)), after24h: average(group.map(e => e.after24h)),
    };
  };
  const links = dailyLinks(series, byDay, Math.max(start, now - 30 * DAY), now);
  return {
    step, chart,
    events: impacts.slice(0, 80),
    eventSummary: [summarize("high"), summarize("medium")],
    daily: links,
    correlation: correlation(links),
    tronIndex: TRON_INDEX, benchmark: BENCHMARK,
  };
}

export type MarketPeriodSummary = {
  trx: number | null; tronIndex: number | null; benchmark: number | null; excess: number | null;
  tokens: { symbol: string; change: number | null }[];
  usddMin: number | null; usddMax: number | null;
  worstDay: { day: string; excess: number } | null;
  bestDay: { day: string; excess: number } | null;
};

/** Market section for weekly/monthly sentiment reports; null when no prices cover the period. */
export async function getMarketPeriodSummary(startMs: number, endMs: number): Promise<MarketPeriodSummary | null> {
  const client = await d1();
  const end = Math.min(endMs, Date.now());
  const series = await loadSeries(client, startMs - DAY);
  if (!series.TRX || priceAt(series.TRX, startMs, 6 * HOUR) === null) return null;
  const move = excessReturn(series, startMs, end);
  const usdd = (series.USDD || []).filter(p => p[0] >= startMs && p[0] <= end).map(p => p[1]);
  const days = dailyLinks(series, new Map(), startMs, end).filter(d => d.excess !== null) as { day: string; excess: number }[];
  const sorted = [...days].sort((a, b) => a.excess - b.excess);
  return {
    ...move,
    tokens: MARKET_TOKENS.map(token => ({
      symbol: token.symbol,
      change: round2(pct(priceAt(series[token.symbol], startMs, 6 * HOUR), priceAt(series[token.symbol], end))),
    })),
    usddMin: usdd.length ? Math.min(...usdd) : null,
    usddMax: usdd.length ? Math.max(...usdd) : null,
    worstDay: sorted[0] ? { day: sorted[0].day, excess: sorted[0].excess } : null,
    bestDay: sorted.length ? { day: sorted[sorted.length - 1].day, excess: sorted[sorted.length - 1].excess } : null,
  };
}
