// 币价联动: hourly prices of TRON-ecosystem tokens and benchmark majors (D1 marketPrices), linked
// to the sentiment monitor. Binance and CoinGecko refuse Cloudflare's egress IPs (403/429 seen
// 2026-11-09), so the always-on Mac collector fetches prices and posts them to the ingest worker
// (/market-prices → storeMarketRows); the cron queue task only prunes and evaluates alerts.
import { getDb, getSysConfig, setSysConfig } from "./db";
import { dispatchNotification } from "./_core/notification";
import {
  BENCHMARK, DAY, HOUR, MARKET_TOKENS, TRON_INDEX, sparkline,
  average, bjDay, bjDayStart, chartRows, correlation, dailyLinks, eventImpacts, evaluateMarketAlerts,
  excessReturn, pct, priceAt, toSeries,
  type MarketAlertSettings, type MarketAlertState, type MarketEvent, type PriceRow,
} from "./market-calc";

const RETENTION_DAYS = 400;
/** Written by the ingest endpoint on every accepted batch. */
export const MARKET_STATUS_KEY = "market_last_fetch";
/** Written by the cron alert check. */
export const MARKET_ALERT_STATUS_KEY = "market_last_alert_check";
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
export type D1Like = { prepare(sql: string): D1Stmt; batch(statements: D1Stmt[]): Promise<{ results: unknown[] }[]> };

async function d1(): Promise<D1Like> {
  const database = await getDb();
  if (!database) throw new Error("Database unavailable");
  return (database as unknown as { $client: D1Like }).$client;
}

const round2 = (value: number | null) => (value === null ? null : Math.round(value * 100) / 100);

/** Upsert hourly rows (used by the ingest worker's /market-prices endpoint). */
export async function storeMarketRows(client: D1Like, rows: PriceRow[], now = Date.now()) {
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
  const symbols = Array.from(new Set(rows.map(r => r.symbol))).sort();
  const latest = rows.reduce((max, r) => Math.max(max, r.ts), 0);
  await client.prepare(`INSERT INTO sysConfigs (configKey, configValue, updatedAt) VALUES (?, ?, ?)
    ON CONFLICT(configKey) DO UPDATE SET configValue = excluded.configValue, updatedAt = excluded.updatedAt`)
    .bind(MARKET_STATUS_KEY, JSON.stringify({ at: now, rows: rows.length, symbols, latest }), Math.floor(now / 1000)).run();
  return { stored: rows.length, symbols };
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

/**
 * Cron queue task (every :15, ten minutes after the Mac collector's :05 run): prune old rows and
 * evaluate USDD-depeg / TRX-underperformance alerts on the stored prices.
 */
export async function checkMarketAlerts(opts: { now?: number } = {}) {
  const now = opts.now ?? Date.now();
  const client = await d1();
  await client.prepare("DELETE FROM marketPrices WHERE ts < ?").bind(now - RETENTION_DAYS * DAY).run();
  const series = await loadSeries(client, now - 2 * DAY);
  const latest = Math.max(0, ...Object.values(series).map(points => points[points.length - 1]?.[0] ?? 0));
  const stale = now - latest > 6 * HOUR; // Mac asleep/offline: don't judge on old prices
  const settings = await getMarketAlertSettings();
  let alertsSent = 0;
  if (settings.enabled && !stale) {
    let state: MarketAlertState = {};
    try { state = JSON.parse((await getSysConfig(ALERT_STATE_KEY)) || "{}"); } catch { state = {}; }
    // Evaluate at the newest stored hour so a 10-minute-old price still counts as "now".
    const at = Math.max(latest, Math.floor(now / HOUR) * HOUR - HOUR);
    const result = evaluateMarketAlerts({ now: at, series, settings, state, negatives: await recentNegatives(client, now - DAY) });
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
    at: now, latestPriceAt: latest || null, stale, alertsEnabled: settings.enabled, alertsSent,
    trx24h: latest ? excessReturn(series, latest - DAY, latest) : null,
  };
  await setSysConfig(MARKET_ALERT_STATUS_KEY, JSON.stringify(summary));
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
        // 7-day card sparkline, one point every 2 hours.
        spark: latestTs ? sparkline(series[token.symbol], latestTs - 7 * DAY, latestTs, 2 * HOUR) : [],
      };
    }),
    tronIndex: TRON_INDEX,
    benchmark: BENCHMARK,
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
    // Every high-threat event, plus the newest medium ones (the medium tail is mostly noise).
    events: [...impacts.filter(e => e.threatLevel === "high"), ...impacts.filter(e => e.threatLevel !== "high").slice(0, 80)],
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
