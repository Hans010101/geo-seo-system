// Rolling retention for monitor_articles.
// Only source records with a verifiable publication timestamp are retained, and the complete
// source record is physically deleted after 100 days. Reports generated before deletion remain
// stored independently in monitor_reports.
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { MONITOR_RETENTION_DAYS } from "./util";
import { log } from "./util";

export const CLEANUP_DAYS = MONITOR_RETENTION_DAYS;

export interface CleanupResult {
  deleted: number;
  freedBytes: number;
  cutoffMs: number;
}

export async function cleanupOldArticles(): Promise<CleanupResult> {
  const db = await getDb();
  const now = Date.now();
  const cutoffMs = now - CLEANUP_DAYS * 86_400_000;
  const futureCutoffMs = now + 86_400_000;
  if (!db) return { deleted: 0, freedBytes: 0, cutoffMs };

  const sizeRes: any = await db.execute(sql`
    SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(contentMd)), 0) AS bytes
    FROM monitor_articles
    WHERE publishedAt IS NULL
       OR publishedAt < ${cutoffMs}
       OR publishedAt > ${futureCutoffMs}`);
  const sizeRow = (
    Array.isArray(sizeRes) && Array.isArray(sizeRes[0]) ? sizeRes[0] : sizeRes
  )?.[0] ?? {};
  const candidates = Number(sizeRow.n) || 0;
  const freedBytes = Number(sizeRow.bytes) || 0;
  if (candidates === 0) {
    log.info("Cleanup: no source records outside retention/freshness bounds", {
      days: CLEANUP_DAYS,
    });
    return { deleted: 0, freedBytes: 0, cutoffMs };
  }

  const res: any = await db.execute(sql`
    DELETE FROM monitor_articles
    WHERE publishedAt IS NULL
       OR publishedAt < ${cutoffMs}
       OR publishedAt > ${futureCutoffMs}`);
  const header = Array.isArray(res) ? res[0] : res;
  const deleted = Number(header?.affectedRows) || candidates;
  log.info("Cleanup: deleted expired or unverifiable source records", {
    deleted,
    freedKB: Math.round(freedBytes / 1024),
    cutoff: new Date(cutoffMs).toISOString(),
  });
  return { deleted, freedBytes, cutoffMs };
}
