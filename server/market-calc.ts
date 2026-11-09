// Pure helpers for the 币价联动 module: token list, CoinGecko chart parsing, basket returns,
// TRX excess return over the market, event impact, correlation and alert decisions.
// Kept free of I/O so the cron worker, the Pages API and tests share one implementation.

export type MarketGroup = "tron" | "stable" | "benchmark";
/**
 * `binance`: USDT pair with precise 1h klines (Binance public market data, generous limits).
 * Tokens without one (USDD, NFT) or with too few digits there (BTTC prices 0.00000035) use
 * CoinGecko's free API, whose per-minute limit only allows a few calls per run.
 */
export type MarketToken = { symbol: string; id: string; name: string; group: MarketGroup; binance?: string };

export const MARKET_TOKENS: MarketToken[] = [
  { symbol: "TRX", id: "tron", name: "TRON", group: "tron", binance: "TRXUSDT" },
  { symbol: "USDD", id: "usdd", name: "USDD", group: "stable" },
  { symbol: "BTT", id: "bittorrent", name: "BitTorrent", group: "tron" },
  { symbol: "NFT", id: "apenft", name: "APENFT", group: "tron" },
  { symbol: "JST", id: "just", name: "JUST", group: "tron", binance: "JSTUSDT" },
  { symbol: "WIN", id: "wink", name: "WINkLink", group: "tron", binance: "WINUSDT" },
  { symbol: "BTC", id: "bitcoin", name: "Bitcoin", group: "benchmark", binance: "BTCUSDT" },
  { symbol: "ETH", id: "ethereum", name: "Ethereum", group: "benchmark", binance: "ETHUSDT" },
  { symbol: "BNB", id: "binancecoin", name: "BNB", group: "benchmark", binance: "BNBUSDT" },
  { symbol: "SOL", id: "solana", name: "Solana", group: "benchmark", binance: "SOLUSDT" },
];
/** Equal-weight TRON ecosystem index (USDD is a stablecoin and tracked separately). */
export const TRON_INDEX = MARKET_TOKENS.filter(t => t.group === "tron").map(t => t.symbol);
/** Equal-weight market benchmark: BTC, ETH, BNB, SOL. */
export const BENCHMARK = MARKET_TOKENS.filter(t => t.group === "benchmark").map(t => t.symbol);

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
const BJ_OFFSET = 8 * HOUR;

export type PriceRow = { symbol: string; ts: number; price: number; marketCap: number | null; volume: number | null };
type ChartPoint = [number, number];
export type CoinGeckoChart = { prices?: ChartPoint[]; market_caps?: ChartPoint[]; total_volumes?: ChartPoint[] };

/** One row per whole hour (the last sample inside that hour wins). */
export function hourlyRows(symbol: string, chart: CoinGeckoChart): PriceRow[] {
  const bucket = (points: ChartPoint[] | undefined) => {
    const out = new Map<number, number>();
    for (const point of points || []) {
      if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;
      out.set(Math.floor(point[0] / HOUR) * HOUR, point[1]);
    }
    return out;
  };
  const prices = bucket(chart.prices);
  const caps = bucket(chart.market_caps);
  const volumes = bucket(chart.total_volumes);
  return Array.from(prices.entries())
    .filter(([, price]) => price > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([ts, price]) => ({ symbol, ts, price, marketCap: caps.get(ts) ?? null, volume: volumes.get(ts) ?? null }));
}

/**
 * Binance 1h klines → rows keyed by the kline's open hour with its close price, matching the
 * CoinGecko convention (last price inside the hour). Volume/market cap come from the snapshot.
 */
export function klineRows(symbol: string, klines: unknown): PriceRow[] {
  if (!Array.isArray(klines)) return [];
  return klines
    .map(k => (Array.isArray(k) ? { ts: Number(k[0]), price: Number(k[4]) } : null))
    .filter((k): k is { ts: number; price: number } => !!k && Number.isFinite(k.ts) && k.price > 0)
    .map(k => ({ symbol, ts: Math.floor(k.ts / HOUR) * HOUR, price: k.price, marketCap: null, volume: null }));
}

export type CoinGeckoMarket = {
  id?: string; current_price?: number; market_cap?: number; total_volume?: number; last_updated?: string;
};

/** /coins/markets snapshot → one row per token at the hour of its last update. */
export function snapshotRows(markets: unknown): PriceRow[] {
  if (!Array.isArray(markets)) return [];
  const byId = new Map(MARKET_TOKENS.map(t => [t.id, t.symbol]));
  return (markets as CoinGeckoMarket[]).flatMap(m => {
    const symbol = m && m.id ? byId.get(m.id) : undefined;
    const ts = Date.parse(m?.last_updated || "");
    if (!symbol || !Number.isFinite(ts) || !(Number(m.current_price) > 0)) return [];
    return [{
      symbol, ts: Math.floor(ts / HOUR) * HOUR, price: Number(m.current_price),
      marketCap: Number.isFinite(m.market_cap) ? Number(m.market_cap) : null,
      volume: Number.isFinite(m.total_volume) ? Number(m.total_volume) : null,
    }];
  });
}

/** symbol → time-sorted [ts, price] points. */
export type PriceSeries = Record<string, ChartPoint[]>;

export function toSeries(rows: { symbol: string; ts: number; price: number }[]): PriceSeries {
  const series: PriceSeries = {};
  for (const row of rows) (series[row.symbol] ||= []).push([Number(row.ts), Number(row.price)]);
  for (const points of Object.values(series)) points.sort((a, b) => a[0] - b[0]);
  return series;
}

/** Last price at or before `t`, if it is no older than `tolerance` (gaps must not fake a value). */
export function priceAt(points: ChartPoint[] | undefined, t: number, tolerance = 3 * HOUR): number | null {
  if (!points || points.length === 0) return null;
  let lo = 0;
  let hi = points.length - 1;
  if (points[0][0] > t) return null;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (points[mid][0] <= t) lo = mid; else hi = mid - 1;
  }
  return t - points[lo][0] <= tolerance ? points[lo][1] : null;
}

export const pct = (from: number | null, to: number | null) =>
  from && to && from > 0 ? ((to - from) / from) * 100 : null;

const round = (value: number | null, digits = 2) =>
  value === null || !Number.isFinite(value) ? null : Math.round(value * 10 ** digits) / 10 ** digits;

/** Equal-weight return of the symbols that have prices at both ends (null when none do). */
export function basketReturn(series: PriceSeries, symbols: string[], from: number, to: number): number | null {
  const returns = symbols
    .map(symbol => pct(priceAt(series[symbol], from), priceAt(series[symbol], to)))
    .filter((value): value is number => value !== null);
  return returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : null;
}

export type ExcessReturn = { trx: number | null; tronIndex: number | null; benchmark: number | null; excess: number | null };

/** TRX return, TRON ecosystem index return, benchmark return and TRX minus benchmark, in %. */
export function excessReturn(series: PriceSeries, from: number, to: number): ExcessReturn {
  const trx = pct(priceAt(series.TRX, from), priceAt(series.TRX, to));
  const tronIndex = basketReturn(series, TRON_INDEX, from, to);
  const benchmark = basketReturn(series, BENCHMARK, from, to);
  return {
    trx: round(trx), tronIndex: round(tronIndex), benchmark: round(benchmark),
    excess: trx !== null && benchmark !== null ? round(trx - benchmark) : null,
  };
}

/** Index level (start = 100) of an equal-weight basket at `t`. */
function basketLevel(series: PriceSeries, symbols: string[], start: number, t: number): number | null {
  const ratios = symbols
    .map(symbol => {
      const base = priceAt(series[symbol], start, 2 * DAY);
      const now = priceAt(series[symbol], t);
      return base && now ? now / base : null;
    })
    .filter((value): value is number => value !== null);
  return ratios.length > 0 ? (100 * ratios.reduce((a, b) => a + b, 0)) / ratios.length : null;
}

export type ChartRow = {
  t: number; trx: number | null; tronIndex: number | null; benchmark: number | null;
  relative: number | null; usdd: number | null; negatives: number; highThreats: number;
};

/** Chart points from `start` to `end` every `step` ms, all levels rebased to 100 at `start`. */
export function chartRows(
  series: PriceSeries, start: number, end: number, step: number,
  counts: Map<number, { negatives: number; highThreats: number }> = new Map(),
): ChartRow[] {
  const rows: ChartRow[] = [];
  const trxBase = priceAt(series.TRX, start, 2 * DAY);
  for (let t = start; t <= end; t += step) {
    const trxNow = priceAt(series.TRX, t);
    const trx = trxBase && trxNow ? (100 * trxNow) / trxBase : null;
    const benchmark = basketLevel(series, BENCHMARK, start, t);
    const bucket = counts.get(t) || { negatives: 0, highThreats: 0 };
    rows.push({
      t, trx: round(trx), tronIndex: round(basketLevel(series, TRON_INDEX, start, t)), benchmark: round(benchmark),
      relative: trx !== null && benchmark ? round((100 * trx) / benchmark) : null,
      usdd: round(priceAt(series.USDD, t), 5), ...bucket,
    });
  }
  return rows;
}

/** Start of the Beijing-time day containing `ms`. */
export function bjDayStart(ms: number): number {
  return Math.floor((ms + BJ_OFFSET) / DAY) * DAY - BJ_OFFSET;
}

export function bjDay(ms: number): string {
  return new Date(ms + BJ_OFFSET).toISOString().slice(0, 10);
}

export type MarketEvent = {
  id: number; title: string | null; url: string; sourcePlatform: string | null;
  threatLevel: string | null; publishedAt: number;
};
export type EventImpact = MarketEvent & { after1h: number | null; after4h: number | null; after24h: number | null };

/** TRX excess return 1h/4h/24h after each event (null while the window has not closed yet). */
export function eventImpacts(series: PriceSeries, events: MarketEvent[], now = Date.now()): EventImpact[] {
  const after = (t: number, hours: number) =>
    t + hours * HOUR <= now ? excessReturn(series, t, t + hours * HOUR).excess : null;
  return events.map(event => ({
    ...event,
    after1h: after(event.publishedAt, 1),
    after4h: after(event.publishedAt, 4),
    after24h: after(event.publishedAt, 24),
  }));
}

export function average(values: (number | null)[]): number | null {
  const real = values.filter((value): value is number => value !== null);
  return real.length > 0 ? round(real.reduce((a, b) => a + b, 0) / real.length) : null;
}

export function pearson(xs: number[], ys: number[]): { r: number | null; n: number } {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return { r: null, n };
  const mx = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const my = ys.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return { r: sxx > 0 && syy > 0 ? round(sxy / Math.sqrt(sxx * syy)) : null, n };
}

export type DailyLink = { day: string; negatives: number; excess: number | null; nextExcess: number | null };

/** Per Beijing day: negative-article count, TRX excess return that day and the next day. */
export function dailyLinks(series: PriceSeries, negativesByDay: Map<string, number>, start: number, end: number): DailyLink[] {
  const out: DailyLink[] = [];
  for (let day = bjDayStart(start); day + DAY <= end; day += DAY) {
    const next = day + DAY;
    out.push({
      day: bjDay(day),
      negatives: negativesByDay.get(bjDay(day)) || 0,
      excess: excessReturn(series, day, next).excess,
      nextExcess: next + DAY <= end ? excessReturn(series, next, next + DAY).excess : null,
    });
  }
  return out;
}

export function correlation(links: DailyLink[]) {
  const same = links.filter(l => l.excess !== null);
  const next = links.filter(l => l.nextExcess !== null);
  return {
    sameDay: pearson(same.map(l => l.negatives), same.map(l => l.excess as number)),
    nextDay: pearson(next.map(l => l.negatives), next.map(l => l.nextExcess as number)),
  };
}

// ---------------------------------------------------------------- alerts
export type MarketAlertSettings = { enabled: boolean; usddDepegPct: number; trxExcessDropPct: number };
export type MarketAlertState = { usddDepegged?: boolean; usddAlertedAt?: number; trxAlertedAt?: number };
export type MarketAlert = { kind: "usdd_depeg" | "usdd_recovered" | "trx_drop"; title: string; content: string };

const USDD_REMIND_MS = DAY;
const TRX_REMIND_MS = 12 * HOUR;

const signed = (value: number | null, digits = 2) =>
  value === null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(digits)}%`;

/**
 * Decide which alerts to send now. USDD: when |price − 1| ≥ threshold (repeat daily while it
 * lasts, report recovery once). TRX: when its 24h return trails the benchmark by ≥ threshold
 * (at most every 12h). `negatives` are recent negative headlines shown as context.
 */
export function evaluateMarketAlerts(input: {
  now: number; series: PriceSeries; settings: MarketAlertSettings; state: MarketAlertState;
  negatives?: { title: string | null; sourcePlatform: string | null }[];
}): { alerts: MarketAlert[]; state: MarketAlertState } {
  const { now, series, settings } = input;
  const state = { ...input.state };
  const alerts: MarketAlert[] = [];
  if (!settings.enabled) return { alerts, state };

  const usdd = priceAt(series.USDD, now);
  if (usdd !== null) {
    const deviation = (usdd - 1) * 100;
    // Two consecutive hourly prices beyond the band: single-hour aggregator spikes (one seen
    // 2026-10-28 04:00 at 0.9748 between normal hours) must not page anyone.
    const previous = priceAt(series.USDD, now - HOUR, 2 * HOUR);
    const beyond = (price: number | null) => price !== null && Math.abs((price - 1) * 100) >= settings.usddDepegPct;
    const depegged = beyond(usdd) && beyond(previous);
    if (depegged && (!state.usddDepegged || now - (state.usddAlertedAt || 0) >= USDD_REMIND_MS)) {
      const low = Math.min(...(series.USDD || []).filter(p => p[0] >= now - DAY).map(p => p[1]));
      alerts.push({
        kind: "usdd_depeg",
        title: `USDD 偏离锚定 ${signed(deviation)}`,
        content: [
          `USDD 当前 $${usdd.toFixed(4)}，偏离 1 美元 ${signed(deviation)}（提醒阈值 ±${settings.usddDepegPct}%）。`,
          Number.isFinite(low) ? `近 24 小时最低 $${low.toFixed(4)}。` : "",
          "稳定币脱锚易引发集中舆情，请关注社媒与媒体动向。",
        ].filter(Boolean).join("\n"),
      });
      state.usddDepegged = true;
      state.usddAlertedAt = now;
    } else if (!depegged && state.usddDepegged) {
      alerts.push({ kind: "usdd_recovered", title: "USDD 已回到锚定区间", content: `USDD 当前 $${usdd.toFixed(4)}，偏离 ${signed(deviation)}。` });
      state.usddDepegged = false;
    }
  }

  const move = excessReturn(series, now - DAY, now);
  if (move.excess !== null && move.excess <= -settings.trxExcessDropPct && now - (state.trxAlertedAt || 0) >= TRX_REMIND_MS) {
    const headlines = (input.negatives || []).slice(0, 5)
      .map(item => `· ${item.sourcePlatform ? `[${item.sourcePlatform}] ` : ""}${(item.title || "（无标题）").slice(0, 60)}`);
    alerts.push({
      kind: "trx_drop",
      title: `TRX 24 小时跑输大盘 ${signed(move.excess)}`,
      content: [
        `TRX ${signed(move.trx)}，大盘（BTC/ETH/BNB/SOL 等权）${signed(move.benchmark)}，超额 ${signed(move.excess)}（阈值 -${settings.trxExcessDropPct}%）。`,
        `TRON 生态指数 ${signed(move.tronIndex)}。`,
        headlines.length > 0 ? "同时段主要负面舆情：" : "同时段没有中高相关的负面舆情。",
        ...headlines,
      ].join("\n"),
    });
    state.trxAlertedAt = now;
  }
  return { alerts, state };
}
