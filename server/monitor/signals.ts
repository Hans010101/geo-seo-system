// Spread signals borrowed from vendor 舆情 systems (道丁/智慧星光 舆情秘书, 百分点):
//   1. 相似信息聚合 — near-duplicate reposts fold into one article (simhash) and count as its spread.
//   2. 互动量与作者影响力 — likes/comments/shares/views and author followers/verification per post.
//   3. 预警升级 — a negative alert climbs 中→高→紧急 as the post spreads, with a timeline.
//   4. 规则降噪 — posts that only carry a bare entity hashtag and no text skip the LLM.
import { createHash } from "crypto";

export type AuthorVerified = "org" | "person";

/** Engagement and author fields a source may report for one post (all optional). */
export type PostMetrics = {
  authorName?: string | null;
  authorFollowers?: number | null;
  authorVerified?: AuthorVerified | null;
  likeCount?: number | null;
  commentCount?: number | null;
  shareCount?: number | null;
  viewCount?: number | null;
  /** Copies the vendor itself folded under this post (百分点 similarityNumber). */
  vendorSimilar?: number | null;
};

const MAX_COUNT = 100_000_000_000;

function count(value: unknown): number | null {
  const n = typeof value === "string" ? parseCountText(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  return Math.min(MAX_COUNT, Math.round(n));
}

/** "2.4万" → 24000, "1.2w" → 12000, "3亿" → 300000000, "10+" → 10, "1,234" → 1234. */
export function parseCountText(text: string): number | null {
  const m = String(text).trim().replace(/,/g, "").match(/^(\d+(?:\.\d+)?)\s*(万|w|亿|k)?\+?$/i);
  if (!m) return null;
  const unit = (m[2] || "").toLowerCase();
  const mult = unit === "万" || unit === "w" ? 10_000 : unit === "亿" ? 100_000_000 : unit === "k" ? 1_000 : 1;
  return Math.round(parseFloat(m[1]) * mult);
}

/** Validates an untrusted metrics object (ingest JSON, queue message) into PostMetrics or undefined. */
export function sanitizeMetrics(raw: unknown): PostMetrics | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: PostMetrics = {};
  if (typeof r.authorName === "string" && r.authorName.trim()) out.authorName = r.authorName.trim().slice(0, 64);
  if (r.authorVerified === "org" || r.authorVerified === "person") out.authorVerified = r.authorVerified;
  for (const key of ["authorFollowers", "likeCount", "commentCount", "shareCount", "viewCount", "vendorSimilar"] as const) {
    const n = count(r[key]);
    if (n != null) out[key] = n;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Column values for monitor_articles from a post's metrics. */
export function metricsColumns(m: PostMetrics | undefined, fallbackAuthor?: string | null) {
  const author = m?.authorName || fallbackAuthor || null;
  return {
    authorName: author ? author.slice(0, 64) : null,
    authorFollowers: m?.authorFollowers ?? null,
    authorVerified: m?.authorVerified ?? null,
    likeCount: m?.likeCount ?? null,
    commentCount: m?.commentCount ?? null,
    shareCount: m?.shareCount ?? null,
    viewCount: m?.viewCount ?? null,
    similarCount: m?.vendorSimilar ?? 0,
  };
}

// ---------------------------------------------------------------- 1. 相似信息聚合 (simhash)

// Leading labels our sources add: "【抖音】@作者：", "@作者：", "UP主 作者：", "【xx吧】".
const LEAD_LABEL = /^(?:UP主 [^：:]{1,40}[：:]|\s*(?:【[^】]{1,30}】)?\s*(?:@[^：:\s]{1,40}[：:])?)/;
const URLS = /https?:\/\/\S+/g;
/** Below this many normalized characters a fingerprint is too unstable to compare. */
export const SIMHASH_MIN_CHARS = 40;
/** Max differing bits for two posts to count as the same text (calibrated on 7 days, 2026-11-27). */
export const SIMHASH_MAX_DISTANCE = 3;

/** Text used for the fingerprint: no author/platform label, no links, punctuation or spacing. */
export function similarityText(content: string): string {
  return (content || "")
    .normalize("NFKC")
    .replace(LEAD_LABEL, "")
    .replace(URLS, " ")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}_]+/gu, "");
}

function hash64(s: string): [number, number] {
  const d = createHash("md5").update(s).digest();
  return [d.readUInt32BE(0), d.readUInt32BE(4)];
}

/** 64-bit simhash over character trigrams, as 16 hex chars; null when the text is too short. */
export function simHashHex(content: string): string | null {
  const t = similarityText(content).slice(0, 4000);
  if (t.length < SIMHASH_MIN_CHARS) return null;
  const grams = new Map<string, number>();
  for (let i = 0; i + 3 <= t.length; i++) {
    const g = t.slice(i, i + 3);
    grams.set(g, (grams.get(g) || 0) + 1);
  }
  const v = new Array<number>(64).fill(0);
  for (const [g, w] of Array.from(grams)) {
    const [hi, lo] = hash64(g);
    for (let b = 0; b < 32; b++) {
      v[b] += (lo >>> b) & 1 ? w : -w;
      v[b + 32] += (hi >>> b) & 1 ? w : -w;
    }
  }
  let hi = 0;
  let lo = 0;
  for (let b = 0; b < 32; b++) {
    if (v[b] > 0) lo |= 1 << b;
    if (v[b + 32] > 0) hi |= 1 << b;
  }
  return (hi >>> 0).toString(16).padStart(8, "0") + (lo >>> 0).toString(16).padStart(8, "0");
}

export function hammingHex(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < 16; i += 8) {
    let x = (parseInt(a.slice(i, i + 8), 16) ^ parseInt(b.slice(i, i + 8), 16)) >>> 0;
    while (x) {
      x &= x - 1;
      d++;
    }
  }
  return d;
}

/** Four 16-bit bands; two hashes within 3 bits share at least one band (pigeonhole). */
export function simHashBands(hex: string): string[] {
  return [0, 4, 8, 12].map((i) => hex.slice(i, i + 4));
}

// ---------------------------------------------------------------- 4. 规则降噪

const ENTITY_HINT = /孙宇晨|孙哥|孙割|波场|火币|tron|trx|htx|usdd|justin/i;
const BARE_ENTITY_TAG = /^(?:孙宇晨|孙哥|孙割|波场|火币|tron|trx|htx|usdd|justin\s*sun|justinsun)(?:\/[a-z]{2,6})?$/i;

/**
 * A post whose only text is hashtags, with our entity present only as a bare tag ("#孙宇晨 #股民交流"),
 * is tag-stuffing and skips analysis. Anything with actual text, or a specific tag such as
 * "#孙宇晨嘲讽京东翻车#", still goes to the analyzer: on 2026-11 data a broader 道丁-style "ignore
 * keywords inside tags/@" rule dropped real negatives (both medium-threat).
 */
export function ruleNoiseReason(title: string, content: string): string | null {
  const body = (content || title || "").normalize("NFKC").replace(LEAD_LABEL, "");
  // Whitespace tokens that start with "#" are tags ("#a #b", "#a#b#c", "#话题[话题]#"); any other
  // token is text. A tag glued to text ("…有钱#孙宇晨#") therefore keeps the post.
  const tags: string[] = [];
  let rest = "";
  for (const token of body.split(/\s+/).filter(Boolean)) {
    if (token.startsWith("#")) tags.push(...token.split("#").map((t) => t.replace(/\[话题\]$/, "").trim()).filter(Boolean));
    else rest += token;
  }
  if (!tags.some((t) => BARE_ENTITY_TAG.test(t))) return null;
  if (tags.some((t) => !BARE_ENTITY_TAG.test(t) && ENTITY_HINT.test(t))) return null;
  if (rest.replace(/[\p{P}\p{S}]+/gu, "").length >= 4) return null;
  return "仅话题标签，无正文";
}

// ---------------------------------------------------------------- 3. 预警升级

/** One step in an alert's severity timeline (alerts.escalations JSON). */
export type AlertEscalation = { at: number; to: "medium" | "high" | "critical"; from?: string; reason: string };

export const SPREAD_SIMILAR = 5;
export const SPREAD_INTERACTIONS = 500; // comments + shares
export const SPREAD_LIKES = 2_000;
export const SPREAD_VIEWS = 100_000;
export const INFLUENTIAL_FOLLOWERS = 100_000;

export type SpreadInput = PostMetrics & { similarCount?: number | null };

const wan = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000) / 10}万` : String(n));

/** Why a post counts as spreading (empty = not spreading). Used to raise alert severity. */
export function spreadReasons(s: SpreadInput | null | undefined): string[] {
  if (!s) return [];
  const out: string[] = [];
  if ((s.similarCount ?? 0) >= SPREAD_SIMILAR) out.push(`相似转载 ${s.similarCount} 条`);
  const interactions = (s.commentCount ?? 0) + (s.shareCount ?? 0);
  if (interactions >= SPREAD_INTERACTIONS) out.push(`评论+转发 ${wan(interactions)}`);
  else if ((s.likeCount ?? 0) >= SPREAD_LIKES) out.push(`点赞 ${wan(s.likeCount!)}`);
  else if ((s.viewCount ?? 0) >= SPREAD_VIEWS) out.push(`播放/阅读 ${wan(s.viewCount!)}`);
  if ((s.authorFollowers ?? 0) >= INFLUENTIAL_FOLLOWERS) out.push(`作者粉丝 ${wan(s.authorFollowers!)}`);
  else if (s.authorVerified === "org") out.push("机构认证作者");
  return out;
}

/** Influence of a reposting copy, e.g. "被 @某大V（粉丝 52万）转载". */
export function copyInfluenceReason(m: PostMetrics | undefined, platformLabel: string): string | null {
  if (!m) return null;
  const who = m.authorName ? `${m.authorName}` : `${platformLabel}账号`;
  if ((m.authorFollowers ?? 0) >= INFLUENTIAL_FOLLOWERS) return `被 ${who}（粉丝 ${wan(m.authorFollowers!)}）转载`;
  if (m.authorVerified === "org") return `被机构认证账号 ${who} 转载`;
  return null;
}

// Same words as the alert center (shared/geo-types SEVERITY_LABELS).
export const SEVERITY_LABEL: Record<string, string> = { medium: "中", high: "高", critical: "紧急", low: "低" };
const RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function severityRank(s: string | null | undefined): number {
  return RANK[s || ""] ?? 0;
}

export function parseEscalations(raw: unknown): AlertEscalation[] {
  if (Array.isArray(raw)) return raw as AlertEscalation[];
  if (typeof raw !== "string" || !raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
