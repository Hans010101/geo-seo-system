import { createHash, timingSafeEqual } from "node:crypto";
import { withCloudflareEnv } from "../server/_core/cloudflare-env";
import { withHyperdriveDatabase } from "../server/db";
import { runMonitorCycle } from "../server/monitor/pipeline";
import { normalizeUrl, sha256 } from "../server/monitor/util";
import type { DiscoveredPost } from "../server/monitor/sources/types";
import type { WorkersAiBinding } from "../server/_core/cloudflare-env";
import { parseMarketRows } from "../server/market-calc";
import { storeMarketRows, type D1Like } from "../server/market";
import { parseIndustryBatch } from "../server/industry-calc";
import { parseIndustryMetrics, parseIndustrySnapshot } from "../server/industry-metrics";
import { storeIndustryItems, type D1Like as IndustryD1 } from "../server/industry";

type IngestEnv = Omit<AgentReachEnv, "AI"> & {
  INGEST_TOKEN: string; AI: WorkersAiBinding;
  /** Producer on the cron worker's queue: new 行业动态 items trigger a triage right away. */
  MONITOR_QUEUE?: { send(body: unknown): Promise<void> };
};

const MAX_BODY_BYTES = 48_000;
/** External-GEO batches carry full AI answers (≈1.5 KB each, up to 100 per request). */
const MAX_BATCH_BYTES = 1_000_000;
export const DAILY_CAP = 20;
/** Per-platform daily caps; the Mac browser collector feeds these platforms at higher volume. */
export const PLATFORM_DAILY_CAPS: Record<string, number> = { weibo: 300, tieba: 40, bilibili: 80, xiaohongshu: 80, percent: 800 };
const CHANNELS = new Set(["web", "reddit", "youtube", "xiaohongshu", "weibo", "tieba", "bilibili", "percent"]);
/** 百分点 Mediaforce sensitive posts keep their original platform for display and stats. */
const PERCENT_PLATFORMS = new Set(["douyin", "kuaishou", "zhihu", "xiaohongshu", "weibo", "wechat", "bilibili", "tieba", "web"]);
/** Platforms only the Mac's logged-in browser collector sends (never Agent-Reach public routes). */
const LOCAL_ONLY = new Set(["weibo", "tieba", "bilibili"]);
/** Platforms the Mac collector reports heartbeats for (Xiaohongshu is shared with Agent-Reach). */
const LOCAL_BROWSER = new Set([...LOCAL_ONLY, "xiaohongshu"]);
/** Heartbeat names: local platforms plus the two vendor systems read through the Mac browser. */
const REPORT_SOURCES = new Set([...LOCAL_BROWSER, "percent", "genoptima", "market", "industry"]);
/** Gossip-heavy local platforms whose medium alerts stay in the alert center (user choice 11-08). */
const PUSH_HIGH_ONLY = new Set(["weibo", "tieba"]);
export const LOCAL_HEALTH_KEY = "cf_local_source_health";

export function dailyCap(platform: string): number {
  return PLATFORM_DAILY_CAPS[platform] ?? DAILY_CAP;
}

/** Receipt/cap bucket: 百分点 posts share one cap whatever their original platform. */
export function capKey(post: DiscoveredPost): string {
  return post.sourceName === "percent" ? "percent" : post.sourcePlatform;
}

export function authorized(header: string | null, token: string | undefined): boolean {
  if (!token || token.length < 32 || !header?.startsWith("Bearer ")) return false;
  const hash = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(hash(header.slice(7)), hash(token));
}

export function parsePost(value: unknown, now = Date.now()): DiscoveredPost {
  if (!value || typeof value !== "object") throw new Error("Expected one post");
  const p = value as Record<string, unknown>;
  if (typeof p.channel !== "string" || !CHANNELS.has(p.channel)) throw new Error("Unsupported channel");
  if (typeof p.url !== "string" || p.url.length > 768) throw new Error("Invalid URL");
  const url = new URL(p.url);
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("HTTPS public URL required");
  const host = url.hostname.toLowerCase();
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host) || !/[a-z]{2,}$/.test(host) ||
      /(?:^|\.)(localhost|local|internal|test|example|invalid)$/.test(host)) throw new Error("Public host required");
  const belongs = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (p.channel === "percent") return parsePercentPost(p, url, now);
  const platform = belongs("reddit.com") ? "reddit"
    : belongs("youtube.com") || host === "youtu.be" ? "youtube"
    : belongs("xiaohongshu.com") || host === "xhslink.com" ? "xiaohongshu"
    : belongs("weibo.com") || belongs("weibo.cn") ? "weibo"
    : host === "tieba.baidu.com" ? "tieba"
    : belongs("bilibili.com") ? "bilibili" : "web";
  if (platform !== p.channel) throw new Error("Channel/host mismatch");
  if (platform === "reddit" && !/^\/r\/[^/]+\/comments\/[a-z0-9]+\//i.test(url.pathname)) throw new Error("Reddit post permalink required");
  if (platform === "xiaohongshu" && host !== "xhslink.com" && !/^\/(?:explore|discovery\/item)\/[a-z0-9]+/i.test(url.pathname)) throw new Error("Xiaohongshu note permalink required");
  if (platform === "youtube" && !(
    (url.pathname === "/watch" && /^[\w-]{11}$/.test(url.searchParams.get("v") || "")) ||
    /^\/(?:shorts|live)\/[\w-]{11}\/?$/.test(url.pathname) ||
    (host === "youtu.be" && /^\/[\w-]{11}\/?$/.test(url.pathname))
  )) throw new Error("YouTube video permalink required");
  if (platform === "weibo" && !(
    (host === "m.weibo.cn" && /^\/(?:detail|status)\/[A-Za-z0-9]+\/?$/.test(url.pathname)) ||
    (host === "weibo.com" && /^\/\d+\/[A-Za-z0-9]+\/?$/.test(url.pathname))
  )) throw new Error("Weibo post permalink required");
  if (platform === "tieba" && !/^\/p\/\d+\/?$/.test(url.pathname)) throw new Error("Tieba thread permalink required");
  if (platform === "bilibili" && !(host === "www.bilibili.com" && /^\/video\/BV[0-9A-Za-z]{10}\/?$/.test(url.pathname))) throw new Error("Bilibili video permalink required");
  const local = LOCAL_ONLY.has(platform) || (LOCAL_BROWSER.has(platform) && p.collector === "local_browser");
  // Local posts (Weibo, Tieba threads, video titles, note titles) are often short; others keep 40.
  const minText = local ? 8 : 40;
  const body = checkPostBody(p, minText, now);
  return {
    url: normalizeUrl(url.href), title: body.title, contentSnippet: body.text,
    publishedAt: body.publishedAt, sourcePlatform: platform,
    sourceName: local ? "local_browser" : "agent_reach",
    fetchEngineHint: local ? "local_browser" : "agent_reach_public", fetchCostUsdHint: 0,
  };
}

function checkPostBody(p: Record<string, unknown>, minText: number, now: number): { title: string; text: string; publishedAt: number } {
  if (typeof p.title !== "string" || !p.title.trim() || p.title.length > 512) throw new Error("Invalid title");
  if (typeof p.text !== "string" || p.text.trim().length < minText || p.text.length > 12_000) throw new Error("Invalid text");
  if (typeof p.publishedAt !== "number" || !Number.isFinite(p.publishedAt) ||
      p.publishedAt > now + 60 * 60_000 || p.publishedAt < now - 48 * 60 * 60_000) throw new Error("Verified publication within 48 hours required");
  if (p.access !== "public" || p.completenessVerified !== false) throw new Error("Public partial provenance required");
  return { title: p.title.trim(), text: p.text.trim(), publishedAt: p.publishedAt };
}

/** A 百分点 Mediaforce item: any public article URL, labelled with the platform 百分点 reported. */
function parsePercentPost(p: Record<string, unknown>, url: URL, now: number): DiscoveredPost {
  const body = checkPostBody(p, 8, now);
  const platform = typeof p.platform === "string" && PERCENT_PLATFORMS.has(p.platform) ? p.platform : "web";
  return {
    url: normalizeUrl(url.href), title: body.title, contentSnippet: body.text,
    publishedAt: body.publishedAt, sourcePlatform: platform,
    sourceName: "percent", fetchEngineHint: "percent", fetchCostUsdHint: 0,
  };
}

export type ExternalGeoRecord = {
  id: string; platform: string; question: string; answer: string; sentiment: string | null;
  brandMentioned: number | null; brandRank: number | null; intentType: number | null;
  references: string[]; referenceCount: number; competitors: string[]; queryTime: number;
};

const GEO_PLATFORMS = new Set(["wenxin", "kimi", "yuanbao", "doubao", "deepseek", "qianwen"]);
const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const names = (v: unknown, max: number) =>
  (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, max).map(x => x.slice(0, 120));

/** One 智推时代 GenOptima AI-answer batch: { source: "genoptima", records: [...] }. */
export function parseExternalGeo(value: unknown, now = Date.now()): ExternalGeoRecord[] {
  const body = value as { source?: unknown; records?: unknown } | null;
  if (body?.source !== "genoptima" || !Array.isArray(body.records) || body.records.length === 0 || body.records.length > 100) {
    throw new Error("Expected 1-100 genoptima records");
  }
  return body.records.map((raw) => {
    const r = (raw || {}) as Record<string, unknown>;
    if (typeof r.id !== "string" || !/^[\w-]{8,64}$/.test(r.id)) throw new Error("Invalid record id");
    if (typeof r.platform !== "string" || !GEO_PLATFORMS.has(r.platform)) throw new Error("Unsupported AI platform");
    if (typeof r.question !== "string" || !r.question.trim()) throw new Error("Invalid question");
    if (typeof r.queryTime !== "number" || !Number.isFinite(r.queryTime) || r.queryTime > now + 3600_000 ||
        r.queryTime < now - 60 * 86400_000) throw new Error("Invalid queryTime");
    const sentiment = r.sentiment === "positive" || r.sentiment === "negative" || r.sentiment === "neutral" ? r.sentiment : null;
    const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);
    const mentioned = typeof r.brandMentioned === "boolean" ? Number(r.brandMentioned) : null;
    return {
      id: r.id, platform: r.platform, question: r.question.trim().slice(0, 500), answer: text(r.answer, 20_000),
      sentiment, brandMentioned: mentioned, brandRank: int(r.brandRank), intentType: int(r.intentType),
      references: names(r.references, 50), referenceCount: Math.max(0, int(r.referenceCount) ?? 0),
      competitors: names(r.competitors, 20), queryTime: r.queryTime,
    };
  });
}

/** A vendor's daily summary snapshot, e.g. 百分点 totals and sensitive counts per platform. */
export function parseExternalStats(value: unknown): { source: string; day: string; stats: string } {
  const body = value as { source?: unknown; day?: unknown; stats?: unknown } | null;
  if (body?.source !== "percent") throw new Error("Unsupported source");
  if (typeof body.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.day)) throw new Error("Invalid day");
  if (!body.stats || typeof body.stats !== "object" || Array.isArray(body.stats)) throw new Error("Invalid stats");
  const stats = JSON.stringify(body.stats);
  if (stats.length > 8000) throw new Error("Stats too large");
  return { source: body.source, day: body.day, stats };
}

export type LocalHealthEntry = { lastRunAt: number; lastDiscoveredAt?: number; lastError?: string };

export function parseReport(value: unknown): Record<string, { discovered: number; error?: string }> {
  const platforms = (value as { platforms?: unknown } | null)?.platforms;
  if (!platforms || typeof platforms !== "object") throw new Error("Expected platforms");
  const out: Record<string, { discovered: number; error?: string }> = {};
  for (const [name, raw] of Object.entries(platforms as Record<string, unknown>)) {
    if (!REPORT_SOURCES.has(name) || !raw || typeof raw !== "object") throw new Error("Unsupported platform");
    const r = raw as { discovered?: unknown; error?: unknown };
    if (typeof r.discovered !== "number" || !Number.isFinite(r.discovered) || r.discovered < 0) throw new Error("Invalid discovered");
    out[name] = { discovered: Math.floor(r.discovered), ...(typeof r.error === "string" && r.error ? { error: r.error.slice(0, 300) } : {}) };
  }
  return out;
}

export function mergeLocalHealth(
  raw: string | null,
  report: Record<string, { discovered: number; error?: string }>,
  now: number,
): Record<string, LocalHealthEntry> {
  let health: Record<string, LocalHealthEntry> = {};
  try { health = raw ? JSON.parse(raw) : {}; } catch { health = {}; }
  for (const [name, item] of Object.entries(report)) {
    const entry: LocalHealthEntry = { ...(health[name] || {}), lastRunAt: now };
    if (item.discovered > 0) { entry.lastDiscoveredAt = now; delete entry.lastError; }
    if (item.error) entry.lastError = item.error;
    health[name] = entry;
  }
  return health;
}

async function readJson(request: Request, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  if (!request.body) throw new Error("Missing body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("Body too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export default {
  async fetch(request: Request, env: IngestEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET") return Response.json({ service: "agent-reach-pilot", expires: env.PILOT_END });
    if (!authorized(request.headers.get("authorization"), env.INGEST_TOKEN)) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (path === "/status" && request.method === "GET") {
      const rows = await env.HYPERDRIVE.prepare("SELECT day, platform, status, COUNT(*) AS count FROM agentReachReceipts GROUP BY day, platform, status ORDER BY day DESC").all();
      return Response.json({ expires: env.PILOT_END, dailyCap: DAILY_CAP, platformDailyCaps: PLATFORM_DAILY_CAPS, receipts: rows.results });
    }
    if (path === "/report" && request.method === "POST") {
      // Per-run collector heartbeat: the cron worker turns stale entries into outage alerts.
      let report: Record<string, { discovered: number; error?: string }>;
      try { report = parseReport(await readJson(request)); }
      catch (e) { return Response.json({ error: String((e as Error).message).slice(0, 160) }, { status: 400 }); }
      const row = await env.HYPERDRIVE.prepare("SELECT configValue FROM sysConfigs WHERE configKey = ?").bind(LOCAL_HEALTH_KEY).first<{ configValue: string }>();
      const health = mergeLocalHealth(row?.configValue ?? null, report, Date.now());
      await env.HYPERDRIVE.prepare(`INSERT INTO sysConfigs (configKey, configValue, updatedAt) VALUES (?, ?, ?)
        ON CONFLICT(configKey) DO UPDATE SET configValue = excluded.configValue, updatedAt = excluded.updatedAt`)
        .bind(LOCAL_HEALTH_KEY, JSON.stringify(health), Math.floor(Date.now() / 1000)).run();
      return Response.json({ ok: true, health });
    }
    if (path === "/external-geo" && request.method === "POST") {
      let records: ExternalGeoRecord[];
      try { records = parseExternalGeo(await readJson(request, MAX_BATCH_BYTES)); }
      catch (e) { return Response.json({ error: String((e as Error).message).slice(0, 160) }, { status: 400 }); }
      const now = Date.now();
      const results = await env.HYPERDRIVE.batch(records.map(r => env.HYPERDRIVE.prepare(`INSERT OR IGNORE INTO externalGeoAnswers
        (id, source, platform, question, answer, sentiment, brandMentioned, brandRank, intentType, refs, referenceCount, competitors, queryTime, queryDay, createdAt)
        VALUES (?, 'genoptima', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        r.id, r.platform, r.question, r.answer, r.sentiment, r.brandMentioned, r.brandRank, r.intentType,
        JSON.stringify(r.references), r.referenceCount, JSON.stringify(r.competitors), r.queryTime,
        new Date(r.queryTime + 8 * 3600_000).toISOString().slice(0, 10), now)));
      return Response.json({ received: records.length, inserted: results.reduce((n, x) => n + (x.meta.changes || 0), 0) });
    }
    if (path === "/market-prices" && request.method === "POST") {
      // Hourly token prices fetched by the Mac (Binance/CoinGecko refuse Cloudflare egress).
      let rows;
      try { rows = parseMarketRows(await readJson(request, MAX_BATCH_BYTES)); }
      catch (e) { return Response.json({ error: String((e as Error).message).slice(0, 160) }, { status: 400 }); }
      return Response.json(await storeMarketRows(env.HYPERDRIVE as unknown as D1Like, rows));
    }
    if (path === "/industry-news" && request.method === "POST") {
      // 行业动态 feeds fetched hourly by the Mac; the cron queue triages them.
      let body: unknown;
      let items;
      try { body = await readJson(request, MAX_BATCH_BYTES); items = parseIndustryBatch(body); }
      catch (e) { return Response.json({ error: String((e as Error).message).slice(0, 160) }, { status: 400 }); }
      const sources = (body as { sources?: unknown }).sources;
      const perSource = sources && typeof sources === "object" && !Array.isArray(sources) && JSON.stringify(sources).length < 4000
        ? sources as Record<string, unknown> : {};
      const stored = await storeIndustryItems(env.HYPERDRIVE as unknown as IndustryD1, items, perSource);
      if (stored.inserted > 0 && env.MONITOR_QUEUE) {
        try { await env.MONITOR_QUEUE.send({ kind: "industry_triage", scheduledTime: Date.now() }); }
        catch (e) { console.log(JSON.stringify({ event: "industry.trigger_failed", error: String((e as Error).message).slice(0, 120) })); }
      }
      return Response.json(stored);
    }
    if (path === "/industry-metrics" && request.method === "POST") {
      // Daily competitor / macro numbers (DefiLlama, Fear & Greed, Polymarket) from the Mac.
      let rows;
      try { rows = parseIndustryMetrics(await readJson(request, MAX_BATCH_BYTES)); }
      catch (e) { return Response.json({ error: String((e as Error).message).slice(0, 160) }, { status: 400 }); }
      const db = env.HYPERDRIVE as unknown as IndustryD1;
      const statements = rows.map(r => db.prepare(`INSERT INTO industryMetrics (day, entity, metric, value, updatedAt) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(day, entity, metric) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`)
        .bind(r.day, r.entity, r.metric, r.value, Date.now()));
      for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50));
      return Response.json({ stored: rows.length });
    }
    if (path === "/industry-snapshot" && request.method === "POST") {
      let snap;
      try { snap = parseIndustrySnapshot(await readJson(request, 200_000)); }
      catch (e) { return Response.json({ error: String((e as Error).message).slice(0, 160) }, { status: 400 }); }
      await env.HYPERDRIVE.prepare(`INSERT INTO sysConfigs (configKey, configValue, updatedAt) VALUES (?, ?, ?)
        ON CONFLICT(configKey) DO UPDATE SET configValue = excluded.configValue, updatedAt = excluded.updatedAt`)
        .bind(`industry_snapshot_${snap.kind}`, snap.data, Math.floor(Date.now() / 1000)).run();
      return Response.json({ ok: true });
    }
    if (path === "/external-stats" && request.method === "POST") {
      let row: { source: string; day: string; stats: string };
      try { row = parseExternalStats(await readJson(request)); }
      catch (e) { return Response.json({ error: String((e as Error).message).slice(0, 160) }, { status: 400 }); }
      await env.HYPERDRIVE.prepare(`INSERT INTO externalDailyStats (source, day, stats, updatedAt) VALUES (?, ?, ?, ?)
        ON CONFLICT(source, day) DO UPDATE SET stats = excluded.stats, updatedAt = excluded.updatedAt`)
        .bind(row.source, row.day, row.stats, Date.now()).run();
      return Response.json({ ok: true });
    }
    if (path !== "/ingest" || request.method !== "POST") return new Response(null, { status: 404 });
    if (!Number.isFinite(Date.parse(env.PILOT_END)) || Date.now() >= Date.parse(env.PILOT_END)) return Response.json({ error: "Pilot expired" }, { status: 410 });
    let post: DiscoveredPost;
    try { post = parsePost(await readJson(request)); }
    catch (e) { return Response.json({ error: String((e as Error).message).slice(0, 160) }, { status: 400 }); }
    const hash = sha256(post.url);
    const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    // A durable unique claim prevents timeout retries from spending AI tokens twice.
    const claim = await env.HYPERDRIVE.prepare(`INSERT OR IGNORE INTO agentReachReceipts (urlHash, day, platform, status, createdAt)
      SELECT ?, ?, ?, 'processing', ? WHERE (SELECT COUNT(*) FROM agentReachReceipts WHERE day = ? AND platform = ?) < ?`)
      .bind(hash, day, capKey(post), Date.now(), day, capKey(post), dailyCap(capKey(post))).run();
    if (!claim.meta.changes) {
      const existing = await env.HYPERDRIVE.prepare("SELECT status, result FROM agentReachReceipts WHERE urlHash = ?").bind(hash).first();
      return existing ? Response.json({ replay: true, ...existing }) : Response.json({ error: "Daily pilot cap reached" }, { status: 429 });
    }
    try {
      const result = await withCloudflareEnv(env, () => withHyperdriveDatabase(env.HYPERDRIVE, () =>
        runMonitorCycle({
          importPosts: [post],
          maxArticles: 1,
          // Weibo/Tieba and 百分点's bulk sensitive feed are noisy: medium alerts stay in the alert center.
          ...(PUSH_HIGH_ONLY.has(post.sourcePlatform) || post.sourceName === "percent" ? { alertPushMinSeverity: "high" as const } : {}),
        })));
      const status = result.failed || result.analysisFailed ? "failed" : result.inserted ? "inserted" : "filtered_or_duplicate";
      await env.HYPERDRIVE.prepare("UPDATE agentReachReceipts SET status = ?, result = ? WHERE urlHash = ?")
        .bind(status, JSON.stringify(result), hash).run();
      return Response.json({ status, result });
    } catch (e) {
      console.error("Agent-Reach ingestion failed", String((e as Error).message).slice(0, 200));
      await env.HYPERDRIVE.prepare("UPDATE agentReachReceipts SET status = 'failed' WHERE urlHash = ?").bind(hash).run();
      return Response.json({ status: "failed", error: "Processing failed; inspect receipt before retrying" }, { status: 500 });
    }
  },
} satisfies ExportedHandler<IngestEnv>;
