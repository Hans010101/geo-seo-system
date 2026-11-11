// 行业动态 module: storage, LLM triage, alerts and reads. See industry-calc.ts for the pure parts.
import { getDb, getSysConfig, setSysConfig } from "./db";
import { getCloudflareEnv } from "./_core/cloudflare-env";
import { ENV } from "./_core/env";
import { invokeLLM } from "./_core/llm";
import { dispatchNotification } from "./_core/notification";
import {
  CATEGORIES, DAY, ENTITIES, HOUR, INDUSTRY_SOURCES, fingerprint, findDuplicate, itemId, parseTriage, triagePrompt,
  type Fingerprint, type IndustryRow, type RawIndustryItem, type Triage,
} from "./industry-calc";

type D1Result = { results: unknown[]; meta?: { changes?: number } };
type D1Stmt = {
  bind(...values: unknown[]): D1Stmt; all<T = unknown>(): Promise<{ results: T[] }>;
  first<T = unknown>(): Promise<T | null>; run(): Promise<D1Result>;
};
export type D1Like = { prepare(sql: string): D1Stmt; batch(statements: D1Stmt[]): Promise<D1Result[]> };

async function d1(): Promise<D1Like> {
  const database = await getDb();
  if (!database) throw new Error("Database unavailable");
  return (database as unknown as { $client: D1Like }).$client;
}

const RETENTION_DAYS = 120;
const BATCH = 40;
export const INDUSTRY_FETCH_KEY = "industry_last_fetch";
const TRIAGE_STATUS_KEY = "industry_last_triage";
const MODEL_KEY = "industry_model";
const DEFAULT_MODEL = "anthropic/claude-haiku-5.5";
const ALERTS_KEY = "industry_alerts_enabled";

async function runBatches(client: D1Like, statements: D1Stmt[]) {
  for (let i = 0; i < statements.length; i += 50) await client.batch(statements.slice(i, i + 50));
}

/** /industry-news (ingest worker): insert new URLs; known URLs are ignored. */
export async function storeIndustryItems(client: D1Like, items: RawIndustryItem[], perSource: Record<string, unknown> = {}, now = Date.now()) {
  const statements = items.map(it => client.prepare(`INSERT OR IGNORE INTO industryNews
    (id, source, url, title, excerpt, publishedAt, fetchedAt, status, attempts, sourceCount, sources)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'new', 0, 1, ?)`)
    .bind(itemId(it.url), it.source, it.url, it.title, it.excerpt, it.publishedAt, now, it.source));
  let inserted = 0;
  for (let i = 0; i < statements.length; i += 50) {
    const results = await client.batch(statements.slice(i, i + 50));
    inserted += results.reduce((n, r) => n + (r.meta?.changes || 0), 0);
  }
  await client.prepare(`INSERT INTO sysConfigs (configKey, configValue, updatedAt) VALUES (?, ?, ?)
    ON CONFLICT(configKey) DO UPDATE SET configValue = excluded.configValue, updatedAt = excluded.updatedAt`)
    .bind(INDUSTRY_FETCH_KEY, JSON.stringify({ at: now, received: items.length, inserted, sources: perSource }), Math.floor(now / 1000)).run();
  return { received: items.length, inserted };
}

export async function getIndustrySettings() {
  const [model, alerts] = await Promise.all([getSysConfig(MODEL_KEY), getSysConfig(ALERTS_KEY)]);
  return { model: model?.trim() || DEFAULT_MODEL, alertsEnabled: alerts === "true" };
}

export async function setIndustryAlerts(enabled: boolean) {
  await setSysConfig(ALERTS_KEY, String(enabled));
}

type Pending = { id: string; source: string; title: string; excerpt: string | null; publishedAt: number; attempts: number };
type Primary = { id: string; grams: Fingerprint[] };

async function callTriage(model: string, items: Pending[]): Promise<{ triage: Triage[]; tokens: number }> {
  const env = getCloudflareEnv();
  const apiKey = env?.OPENROUTER_API_KEY?.trim() || ENV.openrouterApiKey;
  const input = items.map((it, i) => ({ i, source: INDUSTRY_SOURCES[it.source]?.label || it.source, title: it.title, excerpt: it.excerpt || "" }));
  const prompt = triagePrompt(input);
  const result = await invokeLLM({
    apiKey, baseUrl: "https://openrouter.ai/api/v1", model, maxTokens: 9000, timeoutMs: 120_000,
    messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }],
  });
  const content = result.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map(c => ("text" in c ? c.text : "")).join("") : "";
  return {
    triage: parseTriage(text, new Set(input.map(x => x.i))),
    tokens: (result.usage?.prompt_tokens ?? 0) + (result.usage?.completion_tokens ?? 0),
  };
}

/**
 * Cron queue task (every :15 / :40): dedupe new items against the last 48 hours, classify the rest
 * with the LLM, alert on importance-5 events, prune old rows.
 */
export async function triageIndustry(opts: { now?: number; maxBatches?: number } = {}) {
  const now = opts.now ?? Date.now();
  const client = await d1();
  const settings = await getIndustrySettings();
  await client.prepare("DELETE FROM industryNews WHERE publishedAt < ?").bind(now - RETENTION_DAYS * DAY).run();

  const pending = (await client.prepare(`SELECT id, source, title, excerpt, publishedAt, attempts FROM industryNews
    WHERE status = 'new' AND attempts < 3 ORDER BY publishedAt LIMIT ?`).bind(BATCH * (opts.maxBatches ?? 8)).all<Pending>()).results;
  const recent = (await client.prepare(`SELECT id, title, summary FROM industryNews
    WHERE status = 'done' AND dupOf IS NULL AND publishedAt >= ?`).bind(now - 2 * DAY)
    .all<{ id: string; title: string; summary: string | null }>()).results;
  const primaries: Primary[] = recent.map(r => ({ id: r.id, grams: [fingerprint(r.title), ...(r.summary ? [fingerprint(r.summary)] : [])] }));
  const flat = () => primaries.flatMap(p => p.grams.map(g => ({ id: p.id, g })));

  const writes: D1Stmt[] = [];
  const markDup = (it: Pending, primaryId: string) => {
    writes.push(client.prepare("UPDATE industryNews SET status = 'dup', dupOf = ? WHERE id = ?").bind(primaryId, it.id));
    writes.push(client.prepare(`UPDATE industryNews SET sourceCount = sourceCount + 1,
      sources = CASE WHEN instr(',' || COALESCE(sources, '') || ',', ',' || ? || ',') > 0 THEN sources ELSE COALESCE(sources || ',', '') || ? END
      WHERE id = ?`).bind(it.source, it.source, primaryId));
  };

  // 1) Title-level duplicates (same-language reposts) before spending tokens.
  const fresh: Pending[] = [];
  const freshGrams: Fingerprint[] = [];
  let dups = 0;
  for (const it of pending) {
    const candidates = flat();
    const hit = findDuplicate(it.title, candidates.map(c => c.g));
    if (hit >= 0) { markDup(it, candidates[hit].id); dups++; continue; }
    const inner = findDuplicate(it.title, freshGrams);
    if (inner >= 0) { markDup(it, fresh[inner].id); dups++; continue; }
    fresh.push(it);
    freshGrams.push(fingerprint(it.title));
  }
  // Duplicates of a pending item point at it; it becomes a primary once classified.
  await runBatches(client, writes.splice(0));

  // 2) LLM triage in batches.
  let kept = 0, skipped = 0, failed = 0, tokens = 0;
  const alerts: string[] = [];
  for (let b = 0; b < fresh.length; b += BATCH) {
    const chunk = fresh.slice(b, b + BATCH);
    let triage: Triage[] = [];
    for (let attempt = 0; attempt < 2 && !triage.length; attempt++) {
      try {
        const res = await callTriage(settings.model, chunk);
        triage = res.triage;
        tokens += res.tokens;
      } catch (error) {
        console.log(JSON.stringify({ event: "industry.triage_failed", attempt, error: String((error as Error).message).slice(0, 200) }));
      }
    }
    const byI = new Map(triage.map(t => [t.i, t]));
    chunk.forEach((it, i) => {
      const t = byI.get(i);
      if (!t) {
        failed++;
        writes.push(client.prepare("UPDATE industryNews SET attempts = attempts + 1 WHERE id = ?").bind(it.id));
        return;
      }
      if (!t.keep) {
        skipped++;
        writes.push(client.prepare("UPDATE industryNews SET status = 'skip', category = ?, importance = ? WHERE id = ?").bind(t.category, t.importance, it.id));
        return;
      }
      // 3) Cross-language duplicates: compare the Chinese summary with known primaries.
      const candidates = flat();
      const hit = t.summary ? findDuplicate(t.summary, candidates.map(c => c.g)) : -1;
      if (hit >= 0 && candidates[hit].id !== it.id) { markDup(it, candidates[hit].id); dups++; return; }
      kept++;
      primaries.push({ id: it.id, grams: [fingerprint(it.title), ...(t.summary ? [fingerprint(t.summary)] : [])] });
      writes.push(client.prepare(`UPDATE industryNews SET status = 'done', category = ?, importance = ?, entities = ?, tron = ?,
        tronNote = ?, summary = ? WHERE id = ?`)
        .bind(t.category, t.importance, JSON.stringify(t.entities), t.tron, t.tronNote || null, t.summary || it.title, it.id));
      if (t.importance >= 5 && it.publishedAt >= now - 6 * HOUR) {
        alerts.push(it.id);
      }
    });
    await runBatches(client, writes.splice(0));
  }

  let alertsSent = 0;
  if (settings.alertsEnabled && alerts.length) alertsSent = await sendIndustryAlerts(client, alerts);
  const summary = { at: now, pending: pending.length, dups, kept, skipped, failed, tokens, alertsSent, model: settings.model };
  await setSysConfig(TRIAGE_STATUS_KEY, JSON.stringify(summary));
  return summary;
}

const catLabel = (key: string | null) => CATEGORIES.find(c => c.key === key)?.label || "其他";
const srcLabel = (key: string) => INDUSTRY_SOURCES[key]?.label || key;

async function sendIndustryAlerts(client: D1Like, ids: string[]) {
  let sent = 0;
  for (const id of ids) {
    const row = await client.prepare("SELECT id, source, url, summary, category, tronNote, sources, alertedAt FROM industryNews WHERE id = ?")
      .bind(id).first<{ id: string; source: string; url: string; summary: string; category: string; tronNote: string | null; sources: string | null; alertedAt: number | null }>();
    if (!row || row.alertedAt) continue;
    const result = await dispatchNotification({
      messageType: "alert", severity: "high", dedupKey: `industry:${row.id}`,
      title: `行业重大事件｜${catLabel(row.category)}`,
      content: [row.summary, row.tronNote ? `与 TRON：${row.tronNote}` : "", `来源：${srcLabel(row.source)} ${row.url}`].filter(Boolean).join("\n"),
    });
    if (result.sent > 0) {
      sent++;
      await client.prepare("UPDATE industryNews SET alertedAt = ? WHERE id = ?").bind(Date.now(), row.id).run();
    }
  }
  return sent;
}

// ------------------------------------------------------------------ reads
export type IndustryFilter = {
  days: number; category?: string; entity?: string; minImportance?: number; tronOnly?: boolean; q?: string;
  limit?: number; offset?: number;
};

const ROW_COLUMNS = "id, source, url, title, summary, publishedAt, category, importance, entities, tron, tronNote, sourceCount, sources";

export type IndustryItem = IndustryRow & { sources: string | null };

function toItem(r: IndustryItem) {
  let entities: string[] = [];
  try { entities = JSON.parse(r.entities || "[]"); } catch { entities = []; }
  return {
    id: r.id, source: r.source, sourceLabel: srcLabel(r.source), url: r.url, title: r.title, summary: r.summary || r.title,
    publishedAt: Number(r.publishedAt), category: r.category || "other", categoryLabel: catLabel(r.category),
    importance: r.importance ?? 1, entities, tron: r.tron ?? 0, tronNote: r.tronNote || "",
    sourceCount: r.sourceCount || 1, sourceList: (r.sources || r.source).split(",").map(srcLabel),
  };
}
export type IndustryNewsItem = ReturnType<typeof toItem>;

export async function listIndustry(filter: IndustryFilter, now = Date.now()) {
  const client = await d1();
  const since = now - filter.days * DAY;
  const where = ["status = 'done'", "publishedAt >= ?"];
  const args: unknown[] = [since];
  if (filter.category) { where.push("category = ?"); args.push(filter.category); }
  if (filter.entity) { where.push("entities LIKE ?"); args.push(`%"${filter.entity}"%`); }
  if (filter.minImportance) { where.push("importance >= ?"); args.push(filter.minImportance); }
  if (filter.tronOnly) where.push("tron >= 1");
  if (filter.q?.trim()) { where.push("(summary LIKE ? OR title LIKE ?)"); args.push(`%${filter.q.trim()}%`, `%${filter.q.trim()}%`); }
  const sql = where.join(" AND ");
  const [rows, total, cats, ents] = await Promise.all([
    client.prepare(`SELECT ${ROW_COLUMNS} FROM industryNews WHERE ${sql} ORDER BY publishedAt DESC LIMIT ? OFFSET ?`)
      .bind(...args, filter.limit ?? 50, filter.offset ?? 0).all<IndustryItem>(),
    client.prepare(`SELECT COUNT(*) AS n FROM industryNews WHERE ${sql}`).bind(...args).first<{ n: number }>(),
    client.prepare(`SELECT category, COUNT(*) AS n, SUM(importance >= 4) AS major FROM industryNews
      WHERE status = 'done' AND publishedAt >= ? GROUP BY category`).bind(since).all<{ category: string; n: number; major: number }>(),
    Promise.all(ENTITIES.map(e => client.prepare(`SELECT COUNT(*) AS n FROM industryNews
      WHERE status = 'done' AND publishedAt >= ? AND entities LIKE ?`).bind(since, `%"${e.key}"%`).first<{ n: number }>()
      .then(r => ({ key: e.key, label: e.label, n: r?.n ?? 0 })))),
  ]);
  return {
    items: rows.results.map(toItem),
    total: total?.n ?? 0,
    categories: CATEGORIES.map(c => {
      const hit = cats.results.find(x => x.category === c.key);
      return { key: c.key, label: c.label, n: hit?.n ?? 0, major: hit?.major ?? 0 };
    }),
    entities: ents,
  };
}

/** Top items for a window (早晚报 section, weekly digest). */
export async function topIndustry(from: number, to: number, limit = 300) {
  const client = await d1();
  const rows = await client.prepare(`SELECT ${ROW_COLUMNS} FROM industryNews
    WHERE status = 'done' AND publishedAt >= ? AND publishedAt < ? AND importance >= 3
    ORDER BY importance DESC, publishedAt DESC LIMIT ?`).bind(from, to, limit).all<IndustryItem>();
  return rows.results;
}

export async function getIndustryStatus(now = Date.now()) {
  const client = await d1();
  const parse = (s: string | null) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  const [fetch, triage, settings, pending, day] = await Promise.all([
    getSysConfig(INDUSTRY_FETCH_KEY).then(parse),
    getSysConfig(TRIAGE_STATUS_KEY).then(parse),
    getIndustrySettings(),
    client.prepare("SELECT COUNT(*) AS n FROM industryNews WHERE status = 'new' AND attempts < 3").first<{ n: number }>(),
    client.prepare(`SELECT COUNT(*) AS raw, SUM(status = 'done') AS kept, SUM(status = 'dup') AS dups
      FROM industryNews WHERE publishedAt >= ?`).bind(now - DAY).first<{ raw: number; kept: number; dups: number }>(),
  ]);
  return { fetch, triage, settings, pending: pending?.n ?? 0, last24h: day };
}
