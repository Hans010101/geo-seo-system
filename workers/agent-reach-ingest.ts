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
const CHANNELS = new Set(["web", "reddit", "youtube", "xiaohongshu"]);

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
    : belongs("xiaohongshu.com") || host === "xhslink.com" ? "xiaohongshu" : "web";
  if (platform !== p.channel) throw new Error("Channel/host mismatch");
  if (platform === "reddit" && !/^\/r\/[^/]+\/comments\/[a-z0-9]+\//i.test(url.pathname)) throw new Error("Reddit post permalink required");
  if (platform === "xiaohongshu" && host !== "xhslink.com" && !/^\/(?:explore|discovery\/item)\/[a-z0-9]+/i.test(url.pathname)) throw new Error("Xiaohongshu note permalink required");
  if (platform === "youtube" && !(
    (url.pathname === "/watch" && /^[\w-]{11}$/.test(url.searchParams.get("v") || "")) ||
    /^\/(?:shorts|live)\/[\w-]{11}\/?$/.test(url.pathname) ||
    (host === "youtu.be" && /^\/[\w-]{11}\/?$/.test(url.pathname))
  )) throw new Error("YouTube video permalink required");
  if (typeof p.title !== "string" || !p.title.trim() || p.title.length > 512) throw new Error("Invalid title");
  if (typeof p.text !== "string" || p.text.trim().length < 40 || p.text.length > 12_000) throw new Error("Invalid text");
  if (typeof p.publishedAt !== "number" || !Number.isFinite(p.publishedAt) ||
      p.publishedAt > now + 60 * 60_000 || p.publishedAt < now - 48 * 60 * 60_000) throw new Error("Verified publication within 48 hours required");
  if (p.access !== "public" || p.completenessVerified !== false) throw new Error("Public partial provenance required");
  return {
    url: normalizeUrl(url.href), title: p.title.trim(), contentSnippet: p.text.trim(),
    publishedAt: p.publishedAt, sourcePlatform: platform, sourceName: "agent_reach",
    fetchEngineHint: "agent_reach_public", fetchCostUsdHint: 0,
  };
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
      return Response.json({ expires: env.PILOT_END, dailyCap: DAILY_CAP, receipts: rows.results });
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
      SELECT ?, ?, ?, 'processing', ? WHERE (SELECT COUNT(*) FROM agentReachReceipts WHERE day = ?) < ?`)
      .bind(hash, day, post.sourcePlatform, Date.now(), day, DAILY_CAP).run();
    if (!claim.meta.changes) {
      const existing = await env.HYPERDRIVE.prepare("SELECT status, result FROM agentReachReceipts WHERE urlHash = ?").bind(hash).first();
      return existing ? Response.json({ replay: true, ...existing }) : Response.json({ error: "Daily pilot cap reached" }, { status: 429 });
    }
    try {
      const result = await withCloudflareEnv(env, () => withHyperdriveDatabase(env.HYPERDRIVE, () =>
        runMonitorCycle({ importPosts: [post], maxArticles: 1 })));
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
