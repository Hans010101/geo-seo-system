// Read side of the two vendor systems the Mac collector mirrors into D1
// (scripts/external-sources.sql): 智推时代 GenOptima AI answers and 百分点 daily totals.
import { getDb } from "./db";

export const EXTERNAL_GEO_PLATFORMS: Record<string, string> = {
  doubao: "豆包", deepseek: "DeepSeek", yuanbao: "腾讯元宝", qianwen: "通义千问", kimi: "Kimi", wenxin: "文心一言",
};

type D1Like = {
  prepare(sql: string): { bind(...values: unknown[]): D1Stmt } & D1Stmt;
  batch(statements: D1Stmt[]): Promise<{ results: unknown[] }[]>;
};
type D1Stmt = { all<T = unknown>(): Promise<{ results: T[] }>; first<T = unknown>(): Promise<T | null> };

async function d1(): Promise<D1Like> {
  const database = await getDb();
  if (!database) throw new Error("Database unavailable");
  return (database as unknown as { $client: D1Like }).$client;
}

const since = (days: number) => Date.now() - days * 86400_000;

export type ExternalGeoOverview = {
  latestQueryTime: number | null;
  total: number;
  byPlatform: { platform: string; label: string; total: number; positive: number; negative: number; none: number }[];
  byDay: { day: string; total: number; positive: number; negative: number }[];
  topReferences: { name: string; count: number }[];
  negativeQuestions: { question: string; total: number; negative: number }[];
};

export async function getExternalGeoOverview(days: number): Promise<ExternalGeoOverview> {
  const client = await d1();
  const from = since(days);
  const [platforms, trend, refs, questions, latest] = await client.batch([
    client.prepare(`SELECT platform, COUNT(*) AS total,
        SUM(sentiment = 'positive') AS positive, SUM(sentiment = 'negative') AS negative,
        SUM(sentiment IS NULL OR sentiment NOT IN ('positive', 'negative')) AS none
      FROM externalGeoAnswers WHERE queryTime >= ? GROUP BY platform ORDER BY total DESC`).bind(from),
    client.prepare(`SELECT queryDay AS day, COUNT(*) AS total,
        SUM(sentiment = 'positive') AS positive, SUM(sentiment = 'negative') AS negative
      FROM externalGeoAnswers WHERE queryTime >= ? GROUP BY queryDay ORDER BY queryDay`).bind(from),
    client.prepare(`SELECT j.value AS name, COUNT(*) AS count
      FROM externalGeoAnswers a, json_each(a.refs) j WHERE a.queryTime >= ?
      GROUP BY j.value ORDER BY count DESC LIMIT 20`).bind(from),
    client.prepare(`SELECT question, COUNT(*) AS total, SUM(sentiment = 'negative') AS negative
      FROM externalGeoAnswers WHERE queryTime >= ? GROUP BY question
      HAVING negative > 0 ORDER BY negative DESC, total DESC LIMIT 30`).bind(from),
    client.prepare(`SELECT MAX(queryTime) AS latest FROM externalGeoAnswers`),
  ]);
  const byPlatform = (platforms.results as ExternalGeoOverview["byPlatform"]).map(row => ({
    ...row, label: EXTERNAL_GEO_PLATFORMS[row.platform] || row.platform,
  }));
  return {
    latestQueryTime: (latest.results[0] as { latest: number | null } | undefined)?.latest ?? null,
    total: byPlatform.reduce((sum, row) => sum + row.total, 0),
    byPlatform,
    byDay: trend.results as ExternalGeoOverview["byDay"],
    topReferences: refs.results as ExternalGeoOverview["topReferences"],
    negativeQuestions: questions.results as ExternalGeoOverview["negativeQuestions"],
  };
}

export type ExternalGeoListItem = {
  id: string; platform: string; question: string; sentiment: string | null;
  referenceCount: number; queryTime: number; preview: string;
};

export async function listExternalGeoAnswers(opts: {
  days: number; platform?: string; sentiment?: "positive" | "negative" | "none"; question?: string;
  limit: number; offset: number;
}): Promise<{ total: number; items: ExternalGeoListItem[] }> {
  const client = await d1();
  const where = ["queryTime >= ?"];
  const values: unknown[] = [since(opts.days)];
  if (opts.platform) { where.push("platform = ?"); values.push(opts.platform); }
  if (opts.sentiment === "none") where.push("(sentiment IS NULL OR sentiment NOT IN ('positive', 'negative'))");
  else if (opts.sentiment) { where.push("sentiment = ?"); values.push(opts.sentiment); }
  if (opts.question) { where.push("question LIKE ?"); values.push(`%${opts.question}%`); }
  const clause = where.join(" AND ");
  const [count, rows] = await client.batch([
    client.prepare(`SELECT COUNT(*) AS total FROM externalGeoAnswers WHERE ${clause}`).bind(...values),
    client.prepare(`SELECT id, platform, question, sentiment, referenceCount, queryTime, substr(answer, 1, 160) AS preview
      FROM externalGeoAnswers WHERE ${clause} ORDER BY queryTime DESC, platform LIMIT ? OFFSET ?`)
      .bind(...values, opts.limit, opts.offset),
  ]);
  return {
    total: (count.results[0] as { total: number } | undefined)?.total ?? 0,
    items: rows.results as ExternalGeoListItem[],
  };
}

export async function getExternalGeoAnswer(id: string) {
  const client = await d1();
  const row = await client.prepare(`SELECT id, platform, question, answer, sentiment, refs, referenceCount,
      competitors, queryTime FROM externalGeoAnswers WHERE id = ?`).bind(id)
    .first<Omit<ExternalGeoListItem, "preview"> & { answer: string; refs: string; competitors: string }>();
  if (!row) return null;
  const parse = (value: string) => { try { return JSON.parse(value) as string[]; } catch { return []; } };
  return { ...row, refs: parse(row.refs), competitors: parse(row.competitors) };
}

export type PercentDailyStats = {
  day: string; updatedAt: number; total?: number; totalFolded?: number;
  sensitive?: number; sensitiveFolded?: number; sensitiveByPlatform?: Record<string, number>;
};

export async function listPercentDailyStats(days: number): Promise<PercentDailyStats[]> {
  const client = await d1();
  const rows = await client.prepare(`SELECT day, stats, updatedAt FROM externalDailyStats
    WHERE source = 'percent' ORDER BY day DESC LIMIT ?`).bind(days).all<{ day: string; stats: string; updatedAt: number }>();
  return rows.results.map(row => {
    let stats: Partial<PercentDailyStats> = {};
    try { stats = JSON.parse(row.stats); } catch { stats = {}; }
    return { ...stats, day: row.day, updatedAt: row.updatedAt };
  });
}
