import { createHash, timingSafeEqual } from "node:crypto";
import { withCloudflareEnv } from "../server/_core/cloudflare-env";
import { withHyperdriveDatabase } from "../server/db";
import { runMonitorCycle } from "../server/monitor/pipeline";
import { normalizeUrl, sha256 } from "../server/monitor/util";
import type { DiscoveredPost } from "../server/monitor/sources/types";
import type { WorkersAiBinding } from "../server/_core/cloudflare-env";

type IngestEnv = Omit<AgentReachEnv, "AI"> & { INGEST_TOKEN: string; AI: WorkersAiBinding };

const MAX_BODY_BYTES = 48_000;
export const DAILY_CAP = 20;
/** Per-platform daily caps; the Mac browser collector feeds Weibo and Tieba at higher volume. */
export const PLATFORM_DAILY_CAPS: Record<string, number> = { weibo: 150, tieba: 40 };
const CHANNELS = new Set(["web", "reddit", "youtube", "xiaohongshu", "weibo", "tieba"]);
/** Platforms collected by the local logged-in browser rather than Agent-Reach public routes. */
const LOCAL_BROWSER = new Set(["weibo", "tieba"]);
export const LOCAL_HEALTH_KEY = "cf_local_source_health";

export function dailyCap(platform: string): number {
  return PLATFORM_DAILY_CAPS[platform] ?? DAILY_CAP;
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
  const platform = belongs("reddit.com") ? "reddit"
    : belongs("youtube.com") || host === "youtu.be" ? "youtube"
    : belongs("xiaohongshu.com") || host === "xhslink.com" ? "xiaohongshu"
    : belongs("weibo.com") || belongs("weibo.cn") ? "weibo"
    : host === "tieba.baidu.com" ? "tieba" : "web";
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
  // Weibo posts and Tieba threads are often short; other channels keep the 40-character floor.
  const minText = LOCAL_BROWSER.has(platform) ? 8 : 40;
  if (typeof p.title !== "string" || !p.title.trim() || p.title.length > 512) throw new Error("Invalid title");
  if (typeof p.text !== "string" || p.text.trim().length < minText || p.text.length > 12_000) throw new Error("Invalid text");
  if (typeof p.publishedAt !== "number" || !Number.isFinite(p.publishedAt) ||
      p.publishedAt > now + 60 * 60_000 || p.publishedAt < now - 48 * 60 * 60_000) throw new Error("Verified publication within 48 hours required");
  if (p.access !== "public" || p.completenessVerified !== false) throw new Error("Public partial provenance required");
  return {
    url: normalizeUrl(url.href), title: p.title.trim(), contentSnippet: p.text.trim(),
    publishedAt: p.publishedAt, sourcePlatform: platform,
    sourceName: LOCAL_BROWSER.has(platform) ? "local_browser" : "agent_reach",
    fetchEngineHint: LOCAL_BROWSER.has(platform) ? "local_browser" : "agent_reach_public", fetchCostUsdHint: 0,
  };
}

export type LocalHealthEntry = { lastRunAt: number; lastDiscoveredAt?: number; lastError?: string };

export function parseReport(value: unknown): Record<string, { discovered: number; error?: string }> {
  const platforms = (value as { platforms?: unknown } | null)?.platforms;
  if (!platforms || typeof platforms !== "object") throw new Error("Expected platforms");
  const out: Record<string, { discovered: number; error?: string }> = {};
  for (const [name, raw] of Object.entries(platforms as Record<string, unknown>)) {
    if (!LOCAL_BROWSER.has(name) || !raw || typeof raw !== "object") throw new Error("Unsupported platform");
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

async function readJson(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("Missing body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
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
      .bind(hash, day, post.sourcePlatform, Date.now(), day, post.sourcePlatform, dailyCap(post.sourcePlatform)).run();
    if (!claim.meta.changes) {
      const existing = await env.HYPERDRIVE.prepare("SELECT status, result FROM agentReachReceipts WHERE urlHash = ?").bind(hash).first();
      return existing ? Response.json({ replay: true, ...existing }) : Response.json({ error: "Daily pilot cap reached" }, { status: 429 });
    }
    try {
      const result = await withCloudflareEnv(env, () => withHyperdriveDatabase(env.HYPERDRIVE, () =>
        runMonitorCycle({
          importPosts: [post],
          maxArticles: 1,
          // Weibo/Tieba are high-volume and gossip-heavy: medium alerts go to the alert center only.
          ...(post.sourceName === "local_browser" ? { alertPushMinSeverity: "high" as const } : {}),
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
