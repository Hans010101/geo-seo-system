// GEO 穿透联动 (Phase 3): bridge the upstream sentiment monitor with the downstream AI-citation
// dataset. Both sides carry a `domain`; we JOIN on a normalized domain key to answer:
//   • getSourcePenetration()      — per source: sentiment activity × AI-citation reach × risk
//   • getArticlePenetration(id)   — is THIS article's source already cited by AI, and where?
//   • getCitationSourceActivity() — reverse lens: AI-cited sources, what are they publishing now?
//
// monitor_articles.domain is clean (domainOf). citations.domain is DIRTY (explicit URLs store a
// hostname; implicit LLM citations store a source NAME like "彭博社"). normalizeDomain() + the
// SQL twin below reconcile the hostname variants; source-name rows simply never match a hostname.
import { sql } from "drizzle-orm";
import { getDb, getMonitorArticleById } from "../db";
import { normalizeDomain, urlKey, isSharedPlatformDomain, SHARED_PLATFORM_DOMAINS, log } from "./util";

// SQL twin of normalizeDomain() in util.ts — MUST stay equivalent for the JOIN to be consistent.
// LOWER first (so scheme stripping is case-insensitive like the JS regex) -> strip http(s):// ->
// host-only (before first '/') -> before first ':' (port) -> strip a leading "www." prefix.
// (citations.domain never actually carries a scheme, but keeping this in lock-step avoids silent drift.)
// Note: SQLite LTRIM(x, 'www.') strips any leading 'w'/'.' characters (weibo.com -> eibo.com),
// so the prefix is removed with an explicit CASE instead.
export function normSql(col: string): string {
  const noScheme = `REPLACE(REPLACE(LOWER(TRIM(${col})),'https://',''),'http://','')`;
  const hostPort = `SUBSTR(${noScheme}, 1, INSTR(${noScheme} || '/', '/') - 1)`;
  const host = `SUBSTR(${hostPort} || ':', 1, INSTR(${hostPort} || ':', ':') - 1)`;
  return `(CASE WHEN ${host} LIKE 'www.%' THEN SUBSTR(${host}, 5) ELSE ${host} END)`;
}

// SQL twin of urlKey() in util.ts: scheme-less, www-less, query/fragment-free, lower-case URL
// without a trailing slash; twitter.com is folded into x.com.
export function urlKeySql(col: string): string {
  const noScheme = `REPLACE(REPLACE(LOWER(TRIM(${col})),'https://',''),'http://','')`;
  const noQuery = `SUBSTR(${noScheme}, 1, INSTR(${noScheme} || '?', '?') - 1)`;
  const noFrag = `SUBSTR(${noQuery}, 1, INSTR(${noQuery} || '#', '#') - 1)`;
  const noWww = `(CASE WHEN ${noFrag} LIKE 'www.%' THEN SUBSTR(${noFrag}, 5) ELSE ${noFrag} END)`;
  const folded = `(CASE WHEN ${noWww} LIKE 'twitter.com/%' THEN 'x.com/' || SUBSTR(${noWww}, 13) ELSE ${noWww} END)`;
  return `RTRIM(${folded}, '/')`;
}

// Only answers from the last 90 days, from AI platforms that are still enabled, count as
// "AI is citing this now"; older batches and retired platforms no longer reflect current answers.
export const CITATION_WINDOW_DAYS = 90;
export function citationWindowSql(collectionAlias = "co"): string {
  return `${collectionAlias}.timestamp >= (unixepoch('now', '-${CITATION_WINDOW_DAYS} days') * 1000)
    AND ${collectionAlias}.platform IN (SELECT platform FROM platformConfigs WHERE isEnabled = 1)`;
}

const sharedPlatformListSql = () =>
  SHARED_PLATFORM_DOMAINS.map((d) => `'${d.replace(/'/g, "''")}'`).join(", ");

// Recent AI-citation reach per normalized source domain (columns: domain, aiCitations, aiPlatforms,
// platformList) for ordinary sites. Shared platforms (x.com, binance.com, bilibili…) are excluded:
// an AI citing one tweet says nothing about the others, so they are matched per post URL by
// getSharedPlatformReach() instead.
export function citationReachSql(): string {
  return `(
    SELECT ${normSql("ci.domain")} AS domain, COUNT(*) AS aiCitations,
           COUNT(DISTINCT co.platform) AS aiPlatforms, GROUP_CONCAT(DISTINCT co.platform) AS platformList
    FROM citations ci JOIN collections co ON ci.collectionId = co.id
    WHERE ${citationWindowSql("co")} AND ${normSql("ci.domain")} NOT IN (${sharedPlatformListSql()})
    GROUP BY ${normSql("ci.domain")}
  )`;
}

// Step 1 of shared-platform matching: recent citations that point at a post on a shared platform,
// keyed as "https://" + urlKey (monitor_articles.url is stored scheme-normalized without www).
export function sharedCitationKeysSql(): string {
  return `
    SELECT 'https://' || ${urlKeySql("ci.url")} AS u, co.platform AS platform
    FROM citations ci JOIN collections co ON ci.collectionId = co.id
    WHERE ${citationWindowSql("co")} AND ci.url LIKE 'http%'
      AND ${normSql("ci.domain")} IN (${sharedPlatformListSql()})`;
}

// Step 2: which monitored posts have one of those keys. Keys are inlined as escaped literals
// (D1 caps bound parameters at 100) and matched in a single pass over the shared-platform rows.
export function monitoredPostsByKeySql(keys: string[]): string {
  const list = keys.map((k) => `'${k.replace(/'/g, "''")}'`).join(", ");
  const maKey = `LOWER(RTRIM(SUBSTR(ma.url, 1, INSTR(ma.url || '?', '?') - 1), '/'))`;
  return `
    SELECT ma.domain AS domain, ${maKey} AS u
    FROM monitor_articles ma
    WHERE ma.domain IN (${sharedPlatformListSql()}) AND ${maKey} IN (${list})`;
}

export interface CitationReach {
  aiCitations: number;
  aiPlatforms: number;
  platformList: string[];
}

export function aggregateSharedReach(
  citations: { u: string; platform: string }[],
  posts: { domain: string; u: string }[],
): Map<string, CitationReach> {
  const domainByKey = new Map(posts.map((p) => [String(p.u), normalizeDomain(p.domain)]));
  const acc = new Map<string, { count: number; platforms: Set<string> }>();
  for (const c of citations) {
    const domain = domainByKey.get(String(c.u));
    if (!domain) continue;
    const entry = acc.get(domain) ?? { count: 0, platforms: new Set<string>() };
    entry.count += 1;
    entry.platforms.add(String(c.platform));
    acc.set(domain, entry);
  }
  return new Map(
    [...acc].map(([domain, e]) => [
      domain,
      { aiCitations: e.count, aiPlatforms: e.platforms.size, platformList: [...e.platforms] },
    ]),
  );
}

// Per-post AI-citation reach on shared platforms, aggregated per platform domain.
export async function getSharedPlatformReach(): Promise<Map<string, CitationReach>> {
  const citations = await rawRows<{ u: string; platform: string }>(sql.raw(sharedCitationKeysSql()));
  if (citations.length === 0) return new Map();
  const keys = [...new Set(citations.map((c) => String(c.u)))];
  const posts: { domain: string; u: string }[] = [];
  for (let i = 0; i < keys.length; i += 200) {
    posts.push(...(await rawRows<{ domain: string; u: string }>(sql.raw(monitoredPostsByKeySql(keys.slice(i, i + 200))))));
  }
  return aggregateSharedReach(citations, posts);
}

export async function rawRows<T = any>(query: any): Promise<T[]> {
  const db = await getDb();
  if (!db) return [];
  return db.all<T>(query);
}

export type PenetrationCategory = "amplified" | "potential" | "cited_neutral" | "low";

export interface SourcePenetration {
  domain: string;
  // sentiment side
  articles: number;
  negatives: number; // negative (sentiment<=2) among high/medium relevance
  highThreat: number;
  avgSentiment: number | null;
  latestAt: number | null; // epoch ms
  // GEO / AI-citation side
  aiCitations: number;
  aiPlatforms: number;
  platformList: string[];
  // source rule
  stance: "hostile" | "neutral" | "friendly" | null;
  authorityLevel: number | null;
  // derived
  category: PenetrationCategory;
  riskLevel: "high" | "medium" | "low";
  riskScore: number;
}

function classify(r: {
  negatives: number;
  highThreat: number;
  aiPlatforms: number;
  stance: string | null;
}): { category: PenetrationCategory; riskLevel: "high" | "medium" | "low"; riskScore: number } {
  const hostile = r.stance === "hostile";
  const cited = r.aiPlatforms > 0;
  const negative = r.negatives > 0 || r.highThreat > 0;
  const riskScore =
    r.aiPlatforms * 3 + r.negatives * 2 + r.highThreat * 4 + (hostile ? 5 : 0);
  if (cited && (hostile || negative)) {
    // already feeding AI answers AND hostile/negative → the source has been amplified
    return { category: "amplified", riskLevel: "high", riskScore };
  }
  if (!cited && (hostile || negative)) {
    // producing negatives but not yet cited by AI → watch window before it penetrates
    return { category: "potential", riskLevel: "medium", riskScore };
  }
  if (cited) {
    // cited by AI but currently neutral about us
    return { category: "cited_neutral", riskLevel: "low", riskScore };
  }
  return { category: "low", riskLevel: "low", riskScore };
}

// Per-source penetration matrix: every monitored source (domain), enriched with how far it has
// penetrated the AI-citation layer. Ordered most-penetrated/most-negative first.
export async function getSourcePenetration(opts?: { days?: number }): Promise<SourcePenetration[]> {
  const days = opts?.days;
  const windowClause =
    days && Number.isInteger(days) && days > 0
      ? `AND publishedAt >= (unixepoch('now', '-${days} days') * 1000)`
      : "";
  const query = sql.raw(`
    SELECT m.domain AS domain, m.articles AS articles, m.negatives AS negatives,
           m.highThreat AS highThreat, m.avgSentiment AS avgSentiment, m.latestAt AS latestAt,
           COALESCE(c.aiCitations, 0) AS aiCitations, COALESCE(c.aiPlatforms, 0) AS aiPlatforms,
           c.platformList AS platformList, sr.stance AS stance, sr.authorityLevel AS authorityLevel
    FROM (
      SELECT ${normSql("domain")} AS domain,
             COUNT(*) AS articles,
             SUM(CASE WHEN sentimentScore <= 2 AND relevance IN ('high','medium') THEN 1 ELSE 0 END) AS negatives,
             SUM(CASE WHEN threatLevel = 'high' THEN 1 ELSE 0 END) AS highThreat,
             ROUND(AVG(sentimentScore), 2) AS avgSentiment,
             MAX(publishedAt) AS latestAt
      FROM monitor_articles
      WHERE domain IS NOT NULL AND domain <> '' ${windowClause}
      GROUP BY ${normSql("domain")}
    ) m
    LEFT JOIN ${citationReachSql()} c ON m.domain = c.domain
    LEFT JOIN monitor_source_rules sr ON sr.domain = m.domain
    ORDER BY aiPlatforms DESC, negatives DESC, highThreat DESC, articles DESC
  `);
  const [rows, sharedReach] = await Promise.all([rawRows<any>(query), getSharedPlatformReach()]);
  const result = rows.map((r) => {
    const domain = String(r.domain);
    const shared = isSharedPlatformDomain(domain) ? sharedReach.get(domain) : undefined;
    const base = {
      domain,
      articles: Number(r.articles) || 0,
      negatives: Number(r.negatives) || 0,
      highThreat: Number(r.highThreat) || 0,
      avgSentiment: r.avgSentiment == null ? null : Number(r.avgSentiment),
      latestAt: r.latestAt == null ? null : Number(r.latestAt),
      aiCitations: shared ? shared.aiCitations : Number(r.aiCitations) || 0,
      aiPlatforms: shared ? shared.aiPlatforms : Number(r.aiPlatforms) || 0,
      platformList: shared
        ? shared.platformList
        : r.platformList ? String(r.platformList).split(",").filter(Boolean) : [],
      stance: (r.stance ?? null) as SourcePenetration["stance"],
      authorityLevel: r.authorityLevel == null ? null : Number(r.authorityLevel),
    };
    return { ...base, ...classify(base) };
  });
  return result.sort(
    (a, b) =>
      b.aiPlatforms - a.aiPlatforms || b.negatives - a.negatives || b.highThreat - a.highThreat || b.articles - a.articles,
  );
}

export interface DomainAiCitation {
  domain: string; // normalized
  aiPlatforms: number;
  platformList: string[];
  citationCount: number;
  // "url": this exact post is cited (shared platforms); "domain": the publishing site is cited.
  matchLevel: "url" | "domain";
}

// SQL condition selecting the citations that count for one article/source (see citationReachSql).
function citationMatchSql(domain: string, rawUrl: string | null | undefined) {
  if (isSharedPlatformDomain(domain)) {
    const key = urlKey(rawUrl);
    return key ? sql`${sql.raw(urlKeySql("ci.url"))} = ${key}` : sql`1 = 0`;
  }
  return sql`${sql.raw(normSql("ci.domain"))} = ${domain}`;
}

// Lightweight primitive: how far has a single source penetrated the AI-citation layer recently?
// For shared platforms pass the article URL — only that exact post counts.
// Reused by getArticlePenetration() and by the alert/briefing integration (notify.ts).
export async function getDomainAiCitation(
  rawDomain: string | null | undefined,
  rawUrl?: string | null,
): Promise<DomainAiCitation> {
  const domain = normalizeDomain(rawDomain);
  const matchLevel = isSharedPlatformDomain(domain) ? "url" : "domain";
  if (!domain) return { domain: "", aiPlatforms: 0, platformList: [], citationCount: 0, matchLevel };
  const rows = await rawRows<{ platform: string; c: number }>(sql`
    SELECT co.platform AS platform, COUNT(*) AS c
    FROM citations ci JOIN collections co ON ci.collectionId = co.id
    WHERE ${sql.raw(citationWindowSql("co"))} AND ${citationMatchSql(domain, rawUrl)}
    GROUP BY co.platform
    ORDER BY c DESC`);
  const platformList = rows.map((r) => String(r.platform));
  const citationCount = rows.reduce((s, r) => s + (Number(r.c) || 0), 0);
  return { domain, aiPlatforms: platformList.length, platformList, citationCount, matchLevel };
}

export interface ArticlePenetration extends DomainAiCitation {
  articleId: number;
  cited: boolean;
  questions: { platform: string; questionText: string; count: number }[];
  sameDomainArticles: number;
  stance: "hostile" | "neutral" | "friendly" | null;
  authorityLevel: number | null;
  // AI-propagation risk: high-authority + negative article + already AI-cited = highest
  propagationRisk: "high" | "medium" | "low";
}

// For a single monitored article: is its source already cited by AI, on which platforms/questions,
// and how severe is the AI-propagation risk (authority × negativity × already-cited).
export async function getArticlePenetration(articleId: number): Promise<ArticlePenetration | null> {
  const article = await getMonitorArticleById(articleId);
  if (!article) return null;
  const cit = await getDomainAiCitation(article.domain, article.url);
  const domain = cit.domain;

  let questions: ArticlePenetration["questions"] = [];
  let sameDomainArticles = 0;
  if (domain) {
    const qRows = await rawRows<{ platform: string; questionText: string; c: number }>(sql`
      SELECT co.platform AS platform, co.questionText AS questionText, COUNT(*) AS c
      FROM citations ci JOIN collections co ON ci.collectionId = co.id
      WHERE ${sql.raw(citationWindowSql("co"))} AND ${citationMatchSql(domain, article.url)}
      GROUP BY co.platform, co.questionText
      ORDER BY c DESC
      LIMIT 12`);
    questions = qRows.map((r) => ({
      platform: String(r.platform),
      questionText: String(r.questionText ?? ""),
      count: Number(r.c) || 0,
    }));
    const cntRows = await rawRows<{ n: number }>(sql`
      SELECT COUNT(*) AS n FROM monitor_articles
      WHERE ${sql.raw(normSql("domain"))} = ${domain}`);
    sameDomainArticles = Number(cntRows[0]?.n) || 0;
  }

  const stance = ((article as any).stance ?? null) as ArticlePenetration["stance"];
  const authorityLevel =
    (article as any).authorityLevel == null ? null : Number((article as any).authorityLevel);
  const negative = (article.sentimentScore ?? 3) <= 2 || article.threatLevel === "high";
  let propagationRisk: "high" | "medium" | "low" = "low";
  if (cit.aiPlatforms > 0 && negative && (stance === "hostile" || (authorityLevel ?? 0) >= 7)) {
    propagationRisk = "high";
  } else if (cit.aiPlatforms > 0 && (negative || stance === "hostile")) {
    propagationRisk = "medium";
  }

  return {
    articleId,
    ...cit,
    cited: cit.aiPlatforms > 0,
    questions,
    sameDomainArticles,
    stance,
    authorityLevel,
    propagationRisk,
  };
}

export interface CitationSourceActivity {
  domain: string;
  aiPlatforms: number;
  aiCitations: number;
  platformList: string[];
  stance: "hostile" | "neutral" | "friendly" | null;
  articles: number;
  negatives: number;
  latest: { title: string | null; url: string; sentimentScore: number | null; publishedAt: number | null } | null;
}

// Reverse lens: start from the sources AI is already citing, and surface what they are publishing
// about us now (esp. negatives). Answers "an AI-trusted source just went hostile — act."
export async function getCitationSourceActivity(opts?: { limit?: number }): Promise<CitationSourceActivity[]> {
  const limit = opts?.limit && Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 40;
  // Cited domains that also appear in the monitor, most-negative / most-penetrated first.
  const rows = await rawRows<any>(
    sql.raw(`
    SELECT c.domain AS domain, c.aiCitations AS aiCitations, c.aiPlatforms AS aiPlatforms,
           c.platformList AS platformList, sr.stance AS stance,
           m.articles AS articles, m.negatives AS negatives
    FROM ${citationReachSql()} c
    JOIN (
      SELECT ${normSql("domain")} AS domain, COUNT(*) AS articles,
             SUM(CASE WHEN sentimentScore <= 2 AND relevance IN ('high','medium') THEN 1 ELSE 0 END) AS negatives
      FROM monitor_articles WHERE domain IS NOT NULL AND domain <> ''
      GROUP BY ${normSql("domain")}
    ) m ON c.domain = m.domain
    LEFT JOIN monitor_source_rules sr ON sr.domain = c.domain
    WHERE c.domain NOT IN (${sharedPlatformListSql()})
    ORDER BY (sr.stance = 'hostile') DESC, m.negatives DESC, c.aiPlatforms DESC
    LIMIT ${limit}
  `),
  );
  if (rows.length === 0) return [];

  // Pull the latest monitor article per domain in one query, pick newest in JS.
  const domains = rows.map((r) => String(r.domain));
  const latestByDomain = new Map<string, CitationSourceActivity["latest"]>();
  const latestRows = await rawRows<any>(sql`
    SELECT ${sql.raw(normSql("domain"))} AS domain, title, url, sentimentScore, publishedAt, createdAt
    FROM monitor_articles
    WHERE ${sql.raw(normSql("domain"))} IN (${sql.join(domains, sql`, `)})
    ORDER BY COALESCE(publishedAt, createdAt * 1000) DESC`);
  for (const r of latestRows) {
    const d = String(r.domain);
    if (!latestByDomain.has(d)) {
      latestByDomain.set(d, {
        title: r.title ?? null,
        url: String(r.url),
        sentimentScore: r.sentimentScore == null ? null : Number(r.sentimentScore),
        publishedAt: r.publishedAt == null ? null : Number(r.publishedAt),
      });
    }
  }

  return rows.map((r) => ({
    domain: String(r.domain),
    aiCitations: Number(r.aiCitations) || 0,
    aiPlatforms: Number(r.aiPlatforms) || 0,
    platformList: r.platformList ? String(r.platformList).split(",").filter(Boolean) : [],
    stance: (r.stance ?? null) as CitationSourceActivity["stance"],
    articles: Number(r.articles) || 0,
    negatives: Number(r.negatives) || 0,
    latest: latestByDomain.get(String(r.domain)) ?? null,
  }));
}
