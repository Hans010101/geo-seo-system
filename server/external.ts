// Read side of the two vendor systems the Mac collector mirrors into D1
// (scripts/external-sources.sql): 智推时代 GenOptima AI answers and 百分点 daily totals.
import { getDb } from "./db";
import { GENOPTIMA_TOPICS, TOPIC_BY_ID, TOPIC_LINE_LABELS, TOPIC_OF_SELF_QUESTION, topicOfQuestion, type TopicLine } from "@shared/genoptima-topics";

export const EXTERNAL_GEO_PLATFORMS: Record<string, string> = {
  doubao: "豆包", deepseek: "DeepSeek", yuanbao: "腾讯元宝", qianwen: "通义千问", kimi: "Kimi", wenxin: "文心一言",
};

type D1Like = {
  prepare(sql: string): { bind(...values: unknown[]): D1Stmt } & D1Stmt;
  batch(statements: D1Stmt[]): Promise<{ results: unknown[] }[]>;
};
type D1Stmt = { all<T = unknown>(): Promise<{ results: T[] }>; first<T = unknown>(): Promise<T | null> };

export async function d1(): Promise<D1Like> {
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
  topic?: string; line?: TopicLine; limit: number; offset: number;
}): Promise<{ total: number; items: ExternalGeoListItem[] }> {
  const client = await d1();
  let scoped: string[] | null = null;
  if (opts.topic || opts.line) {
    scoped = await questionsOfTopic(opts.days, { topic: opts.topic, line: opts.line });
    if (!scoped.length) return { total: 0, items: [] };
  }
  const where = ["queryTime >= ?"];
  const values: unknown[] = [since(opts.days)];
  if (opts.platform) { where.push("platform = ?"); values.push(opts.platform); }
  if (opts.sentiment === "none") where.push("(sentiment IS NULL OR sentiment NOT IN ('positive', 'negative'))");
  else if (opts.sentiment) { where.push("sentiment = ?"); values.push(opts.sentiment); }
  if (opts.question) { where.push("question LIKE ?"); values.push(`%${opts.question}%`); }
  if (scoped) { where.push(`question IN (${scoped.map(() => "?").join(",")})`); values.push(...scoped); }
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

// ---------------------------------------------------------------- 智推时代 · 供应商服务效果
// Self-test platform key for each 智推 platform (same model family), for the 一致性 comparison.
export const GENOPTIMA_TO_SELF: Record<string, string> = {
  deepseek: "deepseek", doubao: "doubao", kimi: "kimi", qianwen: "tongyi", wenxin: "wenxin", yuanbao: "hunyuan",
};

export type SupplierDay = {
  day: string; total: number; rounds: number; platforms: number; questions: number; pairs: number; unjudged: number;
};
export type SupplierEvaluation = {
  days: number;
  scope: { platforms: number; questions: number };
  /** Median daily volume over complete days — the vendor's normal delivery level. */
  baseline: number;
  daily: SupplierDay[];
  missingDays: string[];
  latestQueryTime: number | null;
  latestSyncTime: number | null;
  totals: { total: number; unjudged: number; noRefs: number; shortAnswers: number };
  consistency: {
    platform: string; label: string; selfPlatform: string;
    vendor: { total: number; positive: number; negative: number };
    self: { total: number; positive: number; negative: number };
  }[];
};

const bjDayOf = (ms: number) => new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10);

export function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Beijing calendar days in [from, to] that have no delivery (today excluded: it is still in progress). */
export function missingDaysBetween(firstDay: string, today: string, delivered: Set<string>) {
  const out: string[] = [];
  for (let t = Date.parse(`${firstDay}T00:00:00Z`); ; t += 86400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    if (day >= today) break;
    if (!delivered.has(day)) out.push(day);
  }
  return out;
}

export async function getExternalGeoSupplier(days: number, now = Date.now()): Promise<SupplierEvaluation> {
  const client = await d1();
  const from = since(days);
  const fromDay = bjDayOf(from + 86400_000);
  const selfPlatforms = Object.values(GENOPTIMA_TO_SELF);
  const selfIds = GENOPTIMA_TOPICS.flatMap(t => t.selfQuestionIds);
  const [daily, scope, totals, latest, vendor, self] = await client.batch([
    client.prepare(`SELECT queryDay AS day, COUNT(*) AS total,
        COUNT(DISTINCT strftime('%H', queryTime / 1000, 'unixepoch')) AS rounds,
        COUNT(DISTINCT platform) AS platforms, COUNT(DISTINCT question) AS questions,
        COUNT(DISTINCT platform || '|' || question) AS pairs,
        SUM(sentiment IS NULL OR sentiment NOT IN ('positive', 'negative')) AS unjudged
      FROM externalGeoAnswers WHERE queryDay >= ? GROUP BY queryDay ORDER BY queryDay DESC`).bind(fromDay),
    client.prepare(`SELECT COUNT(DISTINCT platform) AS platforms, COUNT(DISTINCT question) AS questions
      FROM externalGeoAnswers WHERE queryDay >= ?`).bind(fromDay),
    client.prepare(`SELECT COUNT(*) AS total,
        SUM(sentiment IS NULL OR sentiment NOT IN ('positive', 'negative')) AS unjudged,
        SUM(referenceCount = 0) AS noRefs, SUM(length(answer) < 50) AS shortAnswers
      FROM externalGeoAnswers WHERE queryDay >= ?`).bind(fromDay),
    client.prepare(`SELECT MAX(queryTime) AS latestQueryTime, MAX(createdAt) AS latestSyncTime FROM externalGeoAnswers`),
    client.prepare(`SELECT platform, COUNT(*) AS total, SUM(sentiment = 'positive') AS positive, SUM(sentiment = 'negative') AS negative
      FROM externalGeoAnswers WHERE queryDay >= ? GROUP BY platform`).bind(fromDay),
    // Self-test answers to the 情绪类 questions 智推 also asks, on the same model families; score 1–5 (≥4 正面, ≤2 负面).
    client.prepare(`SELECT c.platform AS platform, COUNT(*) AS total,
        SUM(a.sentimentScore >= 4) AS positive, SUM(a.sentimentScore <= 2) AS negative
      FROM collections c JOIN analyses a ON a.collectionId = c.id
      WHERE c.status = 'success' AND c.timestamp >= ? AND c.questionId IN (${selfIds.map(() => "?").join(",")})
        AND c.platform IN (${selfPlatforms.map(() => "?").join(",")})
      GROUP BY c.platform`).bind(from, ...selfIds, ...selfPlatforms),
  ]);
  const rows = (daily.results as SupplierDay[]).map(r => ({ ...r, unjudged: r.unjudged ?? 0 }));
  const today = bjDayOf(now);
  const complete = rows.filter(r => r.day < today).map(r => r.total);
  const first = rows.length ? rows[rows.length - 1].day : today;
  const vendorBy = new Map((vendor.results as { platform: string; total: number; positive: number; negative: number }[]).map(r => [r.platform, r]));
  const selfBy = new Map((self.results as { platform: string; total: number; positive: number; negative: number }[]).map(r => [r.platform, r]));
  const t = (totals.results[0] ?? {}) as Partial<SupplierEvaluation["totals"]>;
  const l = (latest.results[0] ?? {}) as { latestQueryTime?: number | null; latestSyncTime?: number | null };
  const zero = { total: 0, positive: 0, negative: 0 };
  return {
    days,
    scope: (scope.results[0] as SupplierEvaluation["scope"] | undefined) ?? { platforms: 0, questions: 0 },
    baseline: median(complete),
    daily: rows,
    missingDays: missingDaysBetween(first, today, new Set(rows.map(r => r.day))),
    latestQueryTime: l.latestQueryTime ?? null,
    latestSyncTime: l.latestSyncTime ?? null,
    totals: { total: t.total ?? 0, unjudged: t.unjudged ?? 0, noRefs: t.noRefs ?? 0, shortAnswers: t.shortAnswers ?? 0 },
    consistency: Object.entries(GENOPTIMA_TO_SELF).map(([platform, selfPlatform]) => ({
      platform, label: EXTERNAL_GEO_PLATFORMS[platform] || platform, selfPlatform,
      vendor: { ...zero, ...vendorBy.get(platform) },
      self: { ...zero, ...selfBy.get(selfPlatform) },
    })),
  };
}

// ---------------------------------------------------------------- 主题对照（智推 13 主题 × 自测情绪类问题）
export type SentimentStat = { total: number; positive: number; negative: number };
export type TopicComparison = {
  id: string; label: string; line: TopicLine; selfQuestionIds: string[];
  vendor: SentimentStat;
  /** Self-test on the same model families as 智推 (fair comparison). */
  selfMatched: SentimentStat;
  /** Self-test on every platform (incl. international). */
  selfAll: SentimentStat;
  platforms: { platform: string; label: string; selfPlatform: string; vendor: SentimentStat; self: SentimentStat }[];
  selfOtherPlatforms: ({ platform: string } & SentimentStat)[];
  questions: { question: string; total: number; negative: number }[];
};
export type GenoptimaTopicsResult = {
  days: number;
  topics: TopicComparison[];
  unmapped: { question: string; total: number }[];
  byLine: { line: TopicLine; label: string; total: number; negative: number;
    platforms: { platform: string; label: string; total: number; negative: number }[] }[];
};

const emptyStat = (): SentimentStat => ({ total: 0, positive: 0, negative: 0 });
const addStat = (to: SentimentStat, from: Partial<SentimentStat>) => {
  to.total += Number(from.total) || 0;
  to.positive += Number(from.positive) || 0;
  to.negative += Number(from.negative) || 0;
};

type VendorRow = { question: string; platform: string } & SentimentStat;
type SelfRow = { questionId: string; platform: string } & SentimentStat;

export function buildTopicComparison(vendorRows: VendorRow[], selfRows: SelfRow[], days: number): GenoptimaTopicsResult {
  const selfToVendor = new Map(Object.entries(GENOPTIMA_TO_SELF).map(([v, s]) => [s, v]));
  const topics = new Map<string, TopicComparison>(GENOPTIMA_TOPICS.map(t => [t.id, {
    ...t, vendor: emptyStat(), selfMatched: emptyStat(), selfAll: emptyStat(),
    platforms: Object.entries(GENOPTIMA_TO_SELF).map(([platform, selfPlatform]) => ({
      platform, label: EXTERNAL_GEO_PLATFORMS[platform] || platform, selfPlatform, vendor: emptyStat(), self: emptyStat(),
    })),
    selfOtherPlatforms: [], questions: [],
  }]));
  const unmapped = new Map<string, number>();
  const questionStats = new Map<string, { topic: string; total: number; negative: number }>();
  const lines = new Map<TopicLine, Map<string, { total: number; negative: number }>>();

  for (const row of vendorRows) {
    const topicId = topicOfQuestion(row.question);
    const topic = topicId ? topics.get(topicId) : undefined;
    if (!topic) { unmapped.set(row.question, (unmapped.get(row.question) ?? 0) + Number(row.total)); continue; }
    addStat(topic.vendor, row);
    const p = topic.platforms.find(x => x.platform === row.platform);
    if (p) addStat(p.vendor, row);
    const q = questionStats.get(row.question) ?? { topic: topic.id, total: 0, negative: 0 };
    q.total += Number(row.total) || 0; q.negative += Number(row.negative) || 0;
    questionStats.set(row.question, q);
    const line = lines.get(topic.line) ?? new Map();
    const cell = line.get(row.platform) ?? { total: 0, negative: 0 };
    cell.total += Number(row.total) || 0; cell.negative += Number(row.negative) || 0;
    line.set(row.platform, cell); lines.set(topic.line, line);
  }
  for (const row of selfRows) {
    const topicId = TOPIC_OF_SELF_QUESTION.get(row.questionId);
    const topic = topicId ? topics.get(topicId) : undefined;
    if (!topic) continue;
    addStat(topic.selfAll, row);
    const vendorPlatform = selfToVendor.get(row.platform);
    const p = vendorPlatform ? topic.platforms.find(x => x.platform === vendorPlatform) : undefined;
    if (p) { addStat(p.self, row); addStat(topic.selfMatched, row); continue; }
    const other = topic.selfOtherPlatforms.find(x => x.platform === row.platform);
    if (other) addStat(other, row);
    else { const s = { platform: row.platform, ...emptyStat() }; addStat(s, row); topic.selfOtherPlatforms.push(s); }
  }
  for (const [question, q] of questionStats) topics.get(q.topic)!.questions.push({ question, total: q.total, negative: q.negative });
  for (const t of topics.values()) {
    t.questions.sort((a, b) => b.negative / (b.total || 1) - a.negative / (a.total || 1));
    t.selfOtherPlatforms.sort((a, b) => a.platform.localeCompare(b.platform));
  }
  return {
    days,
    topics: [...topics.values()],
    unmapped: [...unmapped.entries()].map(([question, total]) => ({ question, total })),
    byLine: (["sun", "tron"] as TopicLine[]).map(line => {
      const platforms = [...(lines.get(line) ?? new Map()).entries()]
        .map(([platform, v]) => ({ platform, label: EXTERNAL_GEO_PLATFORMS[platform] || platform, ...v }))
        .sort((a, b) => b.total - a.total);
      return {
        line, label: TOPIC_LINE_LABELS[line], platforms,
        total: platforms.reduce((n, p) => n + p.total, 0), negative: platforms.reduce((n, p) => n + p.negative, 0),
      };
    }),
  };
}

export async function getGenoptimaTopics(days: number): Promise<GenoptimaTopicsResult> {
  const client = await d1();
  const from = since(days);
  const selfIds = GENOPTIMA_TOPICS.flatMap(t => t.selfQuestionIds);
  const [vendor, self] = await client.batch([
    client.prepare(`SELECT question, platform, COUNT(*) AS total,
        SUM(sentiment = 'positive') AS positive, SUM(sentiment = 'negative') AS negative
      FROM externalGeoAnswers WHERE queryDay >= ? GROUP BY question, platform`).bind(bjDayOf(from + 86400_000)),
    // Self-test score 1–5: ≥4 正面, ≤2 负面.
    client.prepare(`SELECT c.questionId AS questionId, c.platform AS platform, COUNT(*) AS total,
        SUM(a.sentimentScore >= 4) AS positive, SUM(a.sentimentScore <= 2) AS negative
      FROM collections c JOIN analyses a ON a.collectionId = c.id
      WHERE c.status = 'success' AND c.timestamp >= ? AND c.questionId IN (${selfIds.map(() => "?").join(",")})
      GROUP BY c.questionId, c.platform`).bind(from, ...selfIds),
  ]);
  return buildTopicComparison(vendor.results as VendorRow[], self.results as SelfRow[], days);
}

/** 智推 questions of one topic or brand line seen in the window (for the answer-list filter). */
export async function questionsOfTopic(days: number, filter: { topic?: string; line?: TopicLine }) {
  const client = await d1();
  const rows = await client.prepare(`SELECT DISTINCT question FROM externalGeoAnswers WHERE queryTime >= ?`)
    .bind(since(days)).all<{ question: string }>();
  return rows.results.map(r => r.question).filter(q => {
    const topicId = topicOfQuestion(q);
    if (filter.topic) return filter.topic === "unmapped" ? topicId === null : topicId === filter.topic;
    return !!topicId && TOPIC_BY_ID.get(topicId)?.line === filter.line;
  });
}
