// Cost guardrails for the monitor. Limits + monthly usage counters live in sysConfigs (single source of
// truth); counters reset transactionally on month rollover. Paid scrape reservations are atomic in D1.
import * as db from "../db";
import { log } from "./util";

const KEYS = {
  firecrawlLimit: "monitor_firecrawl_monthly_limit",
  serperLimit: "monitor_serper_monthly_limit",
  xLimit: "monitor_x_monthly_limit", // twitterapi.io: limit in TWEETS/month (the only paid source)
  maxPerCycle: "monitor_max_articles_per_cycle",
  firecrawlUsed: "monitor_firecrawl_used_this_month",
  serperUsed: "monitor_serper_used_this_month",
  xUsed: "monitor_x_used_this_month",
  month: "monitor_counters_month",
};
export const DEFAULTS = { firecrawlLimit: 800, serperLimit: 30000, xLimit: 60000, maxPerCycle: 80 };
// Firecrawl scrape = 1 credit/page. Rough USD conversion for cost accounting (Hobby $16 / ~19k credits).
export const FIRECRAWL_USD_PER_CREDIT = 0.00083;
// twitterapi.io: $0.15 / 1000 tweets. Default cap 60000 tweets/month ≈ $9/mo.
export const X_USD_PER_TWEET = 0.00015;

// Live in-memory snapshot for the current cycle (populated by beginCycle()).
let live = {
  month: "",
  firecrawlUsed: 0,
  serperUsed: 0,
  xUsed: 0,
  firecrawlLimit: DEFAULTS.firecrawlLimit,
  serperLimit: DEFAULTS.serperLimit,
  xLimit: DEFAULTS.xLimit,
  maxPerCycle: DEFAULTS.maxPerCycle,
};

function currentMonth(): string {
  // YYYY-MM in Asia/Shanghai (matches the cron tz), so the reset boundary is the local 1st.
  const shifted = new Date(Date.now() + 8 * 3600 * 1000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function num(key: string, def: number): Promise<number> {
  const v = await db.getSysConfig(key);
  if (v == null || v === "") return def;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? def : n;
}

// Reset counters if the stored month is stale. Returns the (possibly reset) used counts.
async function ensureMonth(): Promise<{ firecrawlUsed: number; serperUsed: number; xUsed: number }> {
  const cur = currentMonth();
  const stored = await db.getSysConfig(KEYS.month);
  if (stored !== cur) {
    await db.resetMonitorBudgetMonth(cur);
    log.info(`Monitor budget counters reset for ${cur}`);
  }
  return { firecrawlUsed: await num(KEYS.firecrawlUsed, 0), serperUsed: await num(KEYS.serperUsed, 0), xUsed: await num(KEYS.xUsed, 0) };
}

// Load fresh state from DB into `live`. Call at the start of a cycle so limit changes + monthly resets apply.
export async function beginCycle(): Promise<void> {
  const { firecrawlUsed, serperUsed, xUsed } = await ensureMonth();
  live = {
    month: currentMonth(),
    firecrawlUsed,
    serperUsed,
    xUsed,
    firecrawlLimit: await num(KEYS.firecrawlLimit, DEFAULTS.firecrawlLimit),
    serperLimit: await num(KEYS.serperLimit, DEFAULTS.serperLimit),
    xLimit: await num(KEYS.xLimit, DEFAULTS.xLimit),
    maxPerCycle: await num(KEYS.maxPerCycle, DEFAULTS.maxPerCycle),
  };
  log.info(`Monitor budget: firecrawl ${live.firecrawlUsed}/${live.firecrawlLimit}, serper ${live.serperUsed}/${live.serperLimit}, x ${live.xUsed}/${live.xLimit}, max/cycle ${live.maxPerCycle}`);
}

export async function tryConsumeFirecrawl(): Promise<boolean> {
  await ensureMonth();
  return db.reserveSysConfigCredit(KEYS.firecrawlUsed, KEYS.firecrawlLimit, DEFAULTS.firecrawlLimit);
}

export async function hasSerperBudget(): Promise<boolean> {
  const state = await readBudget();
  return state.serper.used < state.serper.limit;
}

// Count provider usage only after Serper accepted the request. Queue reservations
// are capacity hints and must never be reported as consumed API credits.
export async function recordSerperUsage(): Promise<void> {
  await db.incrementSysConfig(KEYS.serperUsed);
  live.serperUsed++;
}

// X (twitterapi.io) is pulled ONCE per cycle (single-threaded, cached) — no per-worker race, so a plain
// check-then-add is safe. hasXBudget() gates the next cycle; addXUsage() records tweets actually fetched.
export function hasXBudget(): boolean {
  return live.xUsed < live.xLimit;
}
export function addXUsage(tweets: number): void {
  if (tweets <= 0) return;
  live.xUsed += tweets;
  db.setSysConfig(KEYS.xUsed, String(live.xUsed)).catch(() => {});
}

export function maxArticlesPerCycle(): number {
  return live.maxPerCycle;
}

// Fresh read from DB for UI / stats (independent of the cycle snapshot).
export async function readBudget() {
  const { firecrawlUsed, serperUsed, xUsed } = await ensureMonth();
  const xLimit = await num(KEYS.xLimit, DEFAULTS.xLimit);
  return {
    month: currentMonth(),
    firecrawl: { used: firecrawlUsed, limit: await num(KEYS.firecrawlLimit, DEFAULTS.firecrawlLimit) },
    serper: { used: serperUsed, limit: await num(KEYS.serperLimit, DEFAULTS.serperLimit) },
    x: { used: xUsed, limit: xLimit, usdPerTweet: X_USD_PER_TWEET, estUsd: +(xUsed * X_USD_PER_TWEET).toFixed(4) },
    maxArticlesPerCycle: await num(KEYS.maxPerCycle, DEFAULTS.maxPerCycle),
  };
}

// Queue-backed Cloudflare cycles span many isolates, so this grants only the
// currently available task capacity. Actual Serper usage is recorded centrally
// by searchNews/searchWeb after a successful provider response.
export async function reserveQueuedBudget(requested: {
  firecrawl?: number;
  serper?: number;
}): Promise<{ firecrawl: number; serper: number; xAvailable: boolean }> {
  const state = await readBudget();
  let firecrawl = 0;
  const wanted = Math.max(0, Math.floor(requested.firecrawl || 0));
  while (firecrawl < wanted && await tryConsumeFirecrawl()) firecrawl++;
  const serper = Math.max(
    0,
    Math.min(requested.serper || 0, state.serper.limit - state.serper.used),
  );
  return {
    firecrawl,
    serper,
    xAvailable: state.x.used < state.x.limit,
  };
}

export async function addQueuedXUsage(tweets: number): Promise<void> {
  if (tweets <= 0) return;
  const state = await readBudget();
  await db.setSysConfig(
    KEYS.xUsed,
    String(Math.min(state.x.limit, state.x.used + tweets)),
  );
}
