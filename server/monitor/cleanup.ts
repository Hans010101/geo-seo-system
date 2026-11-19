// Rolling retention for monitor_articles.
// Only source records with a verifiable publication timestamp are retained, and the complete
// source record is physically deleted after 100 days. Reports generated before deletion remain
// stored independently in monitor_reports.
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { MONITOR_RETENTION_DAYS } from "./util";
import { log } from "./util";

export const CLEANUP_DAYS = MONITOR_RETENTION_DAYS;
/** Active alerts older than this nobody acted on are archived (dismissed), like the 2026-11-08 backlog. */
export const ALERT_ARCHIVE_DAYS = 7;
export const ALERT_ARCHIVE_BY = "system: 7 天未处理自动归档";

export interface CleanupResult {
  deleted: number;
  freedBytes: number;
  cutoffMs: number;
  expiredGeoPending: number;
  archivedAlerts: number;
}

export async function cleanupOldArticles(): Promise<CleanupResult> {
  const db = await getDb();
  const now = Date.now();
  const cutoffMs = now - CLEANUP_DAYS * 86_400_000;
  const futureCutoffMs = now + 86_400_000;
  if (!db) return { deleted: 0, freedBytes: 0, cutoffMs, expiredGeoPending: 0, archivedAlerts: 0 };

  // alerts.createdAt is Unix seconds, resolvedAt milliseconds.
  const alertCutoff = Math.floor((now - ALERT_ARCHIVE_DAYS * 86_400_000) / 1000);
  const staleAlerts = await db.all<any>(sql`
    SELECT COUNT(*) AS n FROM alerts WHERE status = 'active' AND createdAt < ${alertCutoff}`);
  const archivedAlerts = Number(staleAlerts[0]?.n) || 0;
  if (archivedAlerts > 0) {
    await db.run(sql`
      UPDATE alerts SET status = 'dismissed', resolvedAt = ${now}, resolvedBy = ${ALERT_ARCHIVE_BY}
      WHERE status = 'active' AND createdAt < ${alertCutoff}`);
    log.info("Cleanup: archived stale active alerts", { archivedAlerts, days: ALERT_ARCHIVE_DAYS });
  }

  const staleGeoCutoff = now - 24 * 60 * 60 * 1000;
  const staleGeoRows = await db.all<any>(sql`
    SELECT COUNT(*) AS n FROM collections
    WHERE status = 'pending' AND timestamp < ${staleGeoCutoff}`);
  const expiredGeoPending = Number(staleGeoRows[0]?.n) || 0;
  if (expiredGeoPending > 0) {
    await db.run(sql`
      UPDATE collections
      SET status = 'timeout', errorMessage = '任务超过 24 小时未完成，已由运行治理自动终止'
      WHERE status = 'pending' AND timestamp < ${staleGeoCutoff}`);
  }

  const sizeRes = await db.all<any>(sql`
    SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(contentMd)), 0) AS bytes
    FROM monitor_articles
    WHERE publishedAt IS NULL
       OR publishedAt < ${cutoffMs}
       OR publishedAt > ${futureCutoffMs}`);
  const sizeRow = sizeRes[0] ?? {};
  const candidates = Number(sizeRow.n) || 0;
  const freedBytes = Number(sizeRow.bytes) || 0;
  if (candidates === 0) {
    log.info("Cleanup: no source records outside retention/freshness bounds", {
      days: CLEANUP_DAYS,
    });
    return { deleted: 0, freedBytes: 0, cutoffMs, expiredGeoPending, archivedAlerts };
  }

  await db.run(sql`
    DELETE FROM monitor_articles
    WHERE publishedAt IS NULL
       OR publishedAt < ${cutoffMs}
       OR publishedAt > ${futureCutoffMs}`);
  const deleted = candidates;
  log.info("Cleanup: deleted expired or unverifiable source records", {
    deleted,
    freedKB: Math.round(freedBytes / 1024),
    cutoff: new Date(cutoffMs).toISOString(),
  });
  return { deleted, freedBytes, cutoffMs, expiredGeoPending, archivedAlerts };
}
