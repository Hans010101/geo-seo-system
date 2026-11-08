// X (Twitter) via twitterapi.io — the ONLY paid source. Two streams, pulled ONCE per cycle (cached,
// like RSS/telegram), then search(keyword) filters the pool locally:
//   (1) @justinsuntron 本人时间线 (last_tweets) — first-party, clean, always kept (attributed to the person).
//   (2) 关键词提及 (advanced_search) — where negative 舆情 lives, BUT raw "Latest" is a spam firehose
//       Top lanes control noise; a small Latest lane keeps low-engagement breaking news from disappearing.
// Cost: $0.15/1000 tweets, budget-gated via budget.hasXBudget()/addXUsage() (monitor_x_monthly_limit).
import * as db from "../../db";
import * as budget from "../budget";
import { log, keywordMatchesText, fetchWithTimeout } from "../util";
import type { SocialSource, DiscoveredPost, SearchOpts } from "./types";

const BASE_DEFAULT = "https://api.twitterapi.io";
const OWN_HANDLE = "justinsuntron"; // 孙宇晨本人主账号
// advanced_search supports OR + since_time. SPLIT into a Chinese and an English query (not one combined):
// a single Top-ranked OR query is dominated by higher-engagement English crypto-Twitter and buries the
// Chinese 舆情 (validated 2026-07-04: combined → 13en/0zh). Two queries keep both languages represented.
const SEARCH_LANES = [
  { query: '("孙宇晨" OR "Justin Sun" OR "波场" OR TRON OR HTX)', queryType: "Latest", limit: 12, useEngagementFloor: false },
  { query: '("孙宇晨" OR "波场" OR "孙哥" OR "孙割" OR "火币")', queryType: "Top", limit: 20, useEngagementFloor: true },
  { query: '("Justin Sun" OR TRON OR $TRX OR HTX OR USDD)', queryType: "Top", limit: 20, useEngagementFloor: true },
];
// A founder tweet is inherently "by 孙宇晨" even when its text names no entity (e.g. a product launch),
// so all timeline tweets are attributed to any person-keyword rather than dropped by the entity filter.
const PERSON_KW_RE = /孙宇晨|孙哥|justin\s*sun/i;
const CACHE_TTL_MS = 8 * 60 * 1000; // one cycle shares one pull
const OWN_MAX = 15;      // most-recent founder tweets to ingest
const SEARCH_PER_QUERY = 20; // ingest per zh/en search
const WINDOW_DAYS = 7;   // tweets are time-sensitive; 7d matches the other realtime sources
const DEFAULT_MIN_ENGAGEMENT = 2; // mentions only; founder timeline is exempt
// X is a firehose relative to the other sources; without a cap its (all-fresh) tweets crowd out the
// shared per-cycle analysis budget (validated: 39/50 slots). Cap X's ingest, founder-timeline-first.
const MAX_KEEP_PER_CYCLE = 52;

type Tw = { url: string; text: string; author: string | null; publishedAt: number | null; own: boolean };
let cache: { at: number; tweets: Tw[]; errors: string[]; failed: boolean } | null = null;

async function getCfg(): Promise<{ apiKey: string | null; base: string; minEng: number }> {
  const key = await db.getGlobalApiKeyByName("TwitterAPI");
  const raw = await db.getSysConfig("monitor_x_min_engagement");
  const minEng = raw == null || raw === "" ? DEFAULT_MIN_ENGAGEMENT : parseInt(raw, 10);
  return {
    apiKey: key?.apiKey || null,
    base: (key?.baseUrl || BASE_DEFAULT).replace(/\/$/, ""),
    minEng: Number.isNaN(minEng) ? DEFAULT_MIN_ENGAGEMENT : minEng,
  };
}

async function apiGet(base: string, path: string, params: Record<string, string>, apiKey: string): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  const resp = await fetchWithTimeout(`${base}${path}?${qs}`, { headers: { "X-API-Key": apiKey } }, 20000);
  const body = await resp.json().catch(() => null);
  if (!resp.ok || body?.status === "error" || body?.status === "failed" || body?.success === false || body?.error) {
    const hint = `${body?.message || ""} ${body?.msg || ""} ${body?.error || ""}`;
    const reason = resp.status === 402 || /insufficient|not enough|recharge|balance|credits/i.test(hint)
      ? "余额不足，请检查 TwitterAPI.io 余额并充值"
      : resp.status === 401 || resp.status === 403
        ? "鉴权失败，请检查 TwitterAPI.io API Key"
        : resp.status === 429 ? "接口限流" : "接口返回错误";
    // Do not put upstream bodies (which may contain credentials) in logs or alerts.
    throw new Error(`TwitterAPI.io ${reason} (${path}, HTTP ${resp.status})`);
  }
  if (!Array.isArray(body?.data?.tweets ?? body?.tweets)) {
    throw new Error(`TwitterAPI.io 响应缺少 tweets 数组 (${path})`);
  }
  return body;
}

const engagement = (t: any) => (t.likeCount || 0) + (t.retweetCount || 0) + (t.replyCount || 0);
const toTw = (t: any, own: boolean): Tw => ({
  url: (t.url || (t.id ? `https://x.com/i/status/${t.id}` : "")).split("?")[0],
  text: String(t.text || "").trim(),
  author: t.author?.userName ? `@${t.author.userName}` : null,
  publishedAt: t.createdAt ? Date.parse(t.createdAt) || null : null,
  own,
});

async function ensureTweets(opts?: SearchOpts): Promise<Tw[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    if (cache.failed) throw new Error(cache.errors.join("; "));
    return cache.tweets;
  }
  const { apiKey, base, minEng } = await getCfg();
  if (!apiKey) throw new Error("TwitterAPI.io 未配置 API Key");
  if (!opts?.budgetReserved && !budget.hasXBudget()) throw new Error("X 本月采集额度已用完");

  const since = Math.floor((Date.now() - WINDOW_DAYS * 86_400_000) / 1000);
  const out: Tw[] = [];
  const seen = new Set<string>();
  let pulled = 0;
  let succeeded = 0;
  const errors: string[] = [];

  // (1) 本人时间线 — kept in full (first-party).
  try {
    const j = await apiGet(base, "/twitter/user/last_tweets", { userName: OWN_HANDLE }, apiKey);
    const tws: any[] = j?.data?.tweets || j?.tweets || [];
    succeeded++;
    pulled += tws.length;
    for (const t of tws.slice(0, OWN_MAX)) {
      const w = toTw(t, true);
      if (w.url && w.text.length >= 5 && !seen.has(w.url)) { seen.add(w.url); out.push(w); }
    }
  } catch (e: any) { errors.push(`timeline: ${String(e?.message || e).replaceAll(apiKey, "[redacted]").slice(0, 180)}`); }

  // (2) 关键词提及 — a small realtime lane plus ranked zh/en lanes.
  for (const lane of SEARCH_LANES) {
    try {
      const j = await apiGet(base, "/twitter/tweet/advanced_search", { query: `${lane.query} since_time:${since}`, queryType: lane.queryType, cursor: "" }, apiKey);
      const tws: any[] = j?.tweets || [];
      succeeded++;
      pulled += tws.length;
      for (const t of tws.slice(0, lane.limit || SEARCH_PER_QUERY)) {
        if (lane.useEngagementFloor && engagement(t) < minEng) continue;
        const w = toTw(t, false);
        if (w.url && w.text.length >= 10 && !seen.has(w.url)) { seen.add(w.url); out.push(w); }
      }
    } catch (e: any) { errors.push(`${lane.queryType}: ${String(e?.message || e).replaceAll(apiKey, "[redacted]").slice(0, 180)}`); }
  }

  if (opts?.budgetReserved) await budget.addQueuedXUsage(pulled);
  else budget.addXUsage(pulled); // record tweets billed (whole pages) — cost = pulled × $0.00015
  // Founder timeline was pushed first, so the cap keeps @justinsuntron before trimming mentions.
  const kept = out.slice(0, MAX_KEEP_PER_CYCLE);
  cache = { at: Date.now(), tweets: kept, errors, failed: succeeded === 0 };
  for (const error of errors) log.warn(`x: ${error}`);
  if (cache.failed) throw new Error(errors.join("; "));
  log.info(`x: pulled ${pulled} tweets → kept ${kept.length}/${out.length} (own ${kept.filter((w) => w.own).length} + mentions ${kept.filter((w) => !w.own).length}), cost ~$${(pulled * budget.X_USD_PER_TWEET).toFixed(4)}`);
  return kept;
}

export const xSource: SocialSource = {
  name: "x",
  platform: "x",
  enabled: true,
  async search(keyword: string, opts?: SearchOpts): Promise<DiscoveredPost[]> {
    const tweets = await ensureTweets(opts);
    if (!keyword.trim()) return [];
    const isPersonKw = PERSON_KW_RE.test(keyword);
    const matched = tweets.filter((tw) =>
      tw.own ? isPersonKw : keywordMatchesText(keyword, tw.text)
    );
    return matched.map((tw): DiscoveredPost => ({
      url: tw.url,
      // monitor_articles has no author column → surface the handle in the title (his own tweets get 本人).
      title: (tw.author ? `${tw.author}${tw.own ? "(本人)" : ""}: ` : "") + tw.text.replace(/\s+/g, " ").slice(0, 80),
      fullContent: tw.text,
      author: tw.author,
      publishedAt: tw.publishedAt,
      sourceName: "x",
      sourcePlatform: "x",
      fetchEngineHint: "x_api",
      fetchCostUsdHint: 0, // per-tweet cost is tracked in the monthly X budget counter, not per-article
    }));
  },
};

export function __resetXCache() { cache = null; }

export function getXErrors(): string[] {
  return cache && Date.now() - cache.at < CACHE_TTL_MS ? [...cache.errors] : [];
}
