import { describe, expect, it } from "vitest";
import {
  DAY, HOUR, bjDay, bjDayStart, chartRows, correlation, dailyLinks, eventImpacts, evaluateMarketAlerts,
  excessReturn, hourlyRows, klineRows, pearson, priceAt, snapshotRows, toSeries, type PriceSeries,
} from "./market-calc";

const T0 = Date.UTC(2026, 10, 1, 0, 0); // 2026-11-01 08:00 Beijing

/** Hourly points from T0 for `hours`, price = f(hour index). */
function line(hours: number, f: (h: number) => number): [number, number][] {
  return Array.from({ length: hours + 1 }, (_, h) => [T0 + h * HOUR, f(h)]);
}

function market(trx: (h: number) => number, bench: (h: number) => number, hours = 72): PriceSeries {
  return {
    TRX: line(hours, trx), BTT: line(hours, trx), NFT: line(hours, trx), JST: line(hours, trx), WIN: line(hours, trx),
    BTC: line(hours, bench), ETH: line(hours, bench), BNB: line(hours, bench), SOL: line(hours, bench),
    USDD: line(hours, () => 1),
  };
}

describe("market calc", () => {
  it("buckets CoinGecko samples into whole hours, last sample wins", () => {
    const rows = hourlyRows("TRX", {
      prices: [[T0 + 60_000, 0.3], [T0 + 50 * 60_000, 0.31], [T0 + HOUR + 1, 0.32], [T0 + 2 * HOUR, -1]],
      market_caps: [[T0 + 50 * 60_000, 3e10]],
      total_volumes: [[T0 + HOUR, 1e9]],
    });
    expect(rows).toEqual([
      { symbol: "TRX", ts: T0, price: 0.31, marketCap: 3e10, volume: null },
      { symbol: "TRX", ts: T0 + HOUR, price: 0.32, marketCap: null, volume: 1e9 },
    ]);
  });

  it("parses Binance klines (open hour, close price) and the CoinGecko market snapshot", () => {
    expect(klineRows("TRX", [[T0, "0.317", "0.3173", "0.3164", "0.3165", "3033898.9"], ["bad"], [T0 + HOUR, "0", "0", "0", "0"]]))
      .toEqual([{ symbol: "TRX", ts: T0, price: 0.3165, marketCap: null, volume: null }]);
    expect(klineRows("TRX", { code: -1121 })).toEqual([]);
    expect(snapshotRows([
      { id: "usdd", current_price: 0.9992, market_cap: 5e8, total_volume: 2e7, last_updated: "2026-11-01T00:42:10.000Z" },
      { id: "unknown", current_price: 1, last_updated: "2026-11-01T00:42:10.000Z" },
      { id: "tron", current_price: 0, last_updated: "2026-11-01T00:42:10.000Z" },
    ])).toEqual([{ symbol: "USDD", ts: T0, price: 0.9992, marketCap: 5e8, volume: 2e7 }]);
  });

  it("reads the last price before t but not across long gaps", () => {
    const points: [number, number][] = [[T0, 1], [T0 + HOUR, 2], [T0 + 10 * HOUR, 3]];
    expect(priceAt(points, T0 - 1)).toBeNull();
    expect(priceAt(points, T0 + 90 * 60_000)).toBe(2);
    expect(priceAt(points, T0 + 5 * HOUR)).toBeNull();
    expect(priceAt(points, T0 + 10 * HOUR)).toBe(3);
    expect(toSeries([{ symbol: "A", ts: 2, price: 5 }, { symbol: "A", ts: 1, price: 4 }]).A).toEqual([[1, 4], [2, 5]]);
  });

  it("separates TRX moves from market moves", () => {
    // TRX −10% while the market −4% over 24h → excess −6%.
    const series = market(h => (h >= 24 ? 0.9 : 1), h => (h >= 24 ? 96 : 100));
    expect(excessReturn(series, T0, T0 + DAY)).toEqual({ trx: -10, tronIndex: -10, benchmark: -4, excess: -6 });
    const rows = chartRows(series, T0, T0 + DAY, 12 * HOUR, new Map([[T0 + 12 * HOUR, { negatives: 3, highThreats: 1 }]]));
    expect(rows.map(r => r.trx)).toEqual([100, 100, 90]);
    expect(rows[2].relative).toBe(93.75);
    expect(rows[1]).toMatchObject({ negatives: 3, highThreats: 1, usdd: 1 });
  });

  it("measures event impact only after the window closes", () => {
    const series = market(h => (h >= 10 ? 0.95 : 1), () => 100);
    const event = { id: 1, title: "x", url: "u", sourcePlatform: "weibo", threatLevel: "high", publishedAt: T0 + 9 * HOUR };
    const [impact] = eventImpacts(series, [event], T0 + 14 * HOUR);
    expect(impact).toMatchObject({ after1h: -5, after4h: -5, after24h: null });
  });

  it("links daily negatives with same-day and next-day excess returns", () => {
    expect(bjDay(T0)).toBe("2026-11-01");
    expect(bjDayStart(T0 + 5 * HOUR)).toBe(T0 - 8 * HOUR);
    const series = market(h => 1 - 0.01 * Math.floor(h / 24), () => 100, 96);
    const links = dailyLinks(series, new Map([["2026-11-01", 4]]), T0, T0 + 4 * DAY);
    expect(links[0]).toMatchObject({ day: "2026-11-01", negatives: 4 });
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8]).r).toBe(1);
    expect(pearson([1, 2], [1, 2]).r).toBeNull();
    expect(correlation(links).sameDay.n).toBeGreaterThan(0);
  });

  it("alerts USDD depeg once, reminds daily, reports recovery, and respects the switch", () => {
    const settings = { enabled: true, usddDepegPct: 0.5, trxExcessDropPct: 5 };
    // A single off-peg hour (aggregator spike) is ignored; two in a row alert.
    const spike: PriceSeries = { USDD: [[T0 - HOUR, 0.9995], [T0, 0.975]] };
    expect(evaluateMarketAlerts({ now: T0, series: spike, settings, state: {} }).alerts).toEqual([]);
    const depeg: PriceSeries = { USDD: [[T0 - HOUR, 0.993], [T0, 0.992]] };
    const first = evaluateMarketAlerts({ now: T0, series: depeg, settings, state: {} });
    expect(first.alerts.map(a => a.kind)).toEqual(["usdd_depeg"]);
    expect(first.alerts[0].title).toContain("-0.80%");
    const again = evaluateMarketAlerts({ now: T0 + HOUR, series: { USDD: [[T0, 0.992], [T0 + HOUR, 0.99]] }, settings, state: first.state });
    expect(again.alerts).toEqual([]);
    const daily = evaluateMarketAlerts({ now: T0 + DAY, series: { USDD: [[T0 + DAY - HOUR, 0.99], [T0 + DAY, 0.99]] }, settings, state: first.state });
    expect(daily.alerts.map(a => a.kind)).toEqual(["usdd_depeg"]);
    const back = evaluateMarketAlerts({ now: T0 + 2 * HOUR, series: { USDD: [[T0 + 2 * HOUR, 0.999]] }, settings, state: first.state });
    expect(back.alerts.map(a => a.kind)).toEqual(["usdd_recovered"]);
    expect(evaluateMarketAlerts({ now: T0, series: depeg, settings: { ...settings, enabled: false }, state: {} }).alerts).toEqual([]);
  });

  it("alerts a TRX drop beyond the market with headlines, at most every 12h", () => {
    const settings = { enabled: true, usddDepegPct: 0.5, trxExcessDropPct: 5 };
    const series = market(h => (h >= 30 ? 0.9 : 1), () => 100, 48);
    const now = T0 + 36 * HOUR;
    const first = evaluateMarketAlerts({ now, series, settings, state: {}, negatives: [{ title: "某负面", sourcePlatform: "weibo" }] });
    expect(first.alerts.map(a => a.kind)).toEqual(["trx_drop"]);
    expect(first.alerts[0].content).toContain("[weibo] 某负面");
    expect(evaluateMarketAlerts({ now: now + HOUR, series, settings, state: first.state }).alerts).toEqual([]);
    const calm = market(h => (h >= 30 ? 0.97 : 1), () => 100, 48);
    expect(evaluateMarketAlerts({ now, series: calm, settings, state: {} }).alerts).toEqual([]);
  });
});
