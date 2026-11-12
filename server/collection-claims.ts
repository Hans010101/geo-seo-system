// GEO batch execution is driven by browser polling (POST /api/geo/execute-round, which streams so the
// request is not cut by Cloudflare's ~120s 524 timeout; it runs collections.executeNextBatch). Each pending row is
// claimed before its model call so that (a) two open pages never call the model for the same row, and
// (b) a row whose round died mid-call (closed page, dropped connection) is retried at most once instead
// of being re-picked forever. Exhausted rows end as "timeout" and can be retried from the batch list.
//
// Columns (scripts/collection-claims.sql): collections.attempts INTEGER NOT NULL DEFAULT 0,
// collections.claimedAt INTEGER (ms).

import { d1 } from "./external";

export const MAX_COLLECTION_ATTEMPTS = 2;
// A claim older than this is considered abandoned. Must exceed the round budget plus post-processing.
export const CLAIM_LEASE_MS = 7 * 60_000;
// Model calls in one executeNextBatch round must finish by this budget (round start + budget).
export const ROUND_BUDGET_MS = 240_000;
export const PER_CALL_TIMEOUT_MS = 150_000;
// Don't start a retry attempt with less time than this left in the round.
export const MIN_ATTEMPT_MS = 40_000;
export const EXHAUSTED_MESSAGE = "两次尝试都未完成，已停止重跑（可在采集记录中重试）";

type BoundStmt = { run(): Promise<unknown>; all<T = unknown>(): Promise<{ results?: T[] }> };
export type ClaimClient = { prepare(sql: string): { bind(...values: unknown[]): BoundStmt } };

export async function claimClient(): Promise<ClaimClient> {
  return d1();
}

export type ClaimedRow = { id: number; questionId: string; platform: string; attempts: number };

/** Pending rows that already used every attempt and whose last claim lapsed → timeout. */
export async function expireExhaustedRows(client: ClaimClient, batchId: string, now: number): Promise<number> {
  const res = await client
    .prepare(
      `UPDATE collections SET status = 'timeout', errorMessage = ?, claimedAt = NULL
       WHERE batchId = ? AND status = 'pending' AND attempts >= ?
         AND (claimedAt IS NULL OR claimedAt < ?)
       RETURNING id`,
    )
    .bind(EXHAUSTED_MESSAGE, batchId, MAX_COLLECTION_ATTEMPTS, now - CLAIM_LEASE_MS)
    .all<{ id: number }>();
  return res.results?.length ?? 0;
}

/**
 * Atomically claim up to `limit` runnable pending rows (oldest first). SQLite runs the UPDATE with its
 * sub-select as one statement, so concurrent rounds can never claim the same row.
 */
export async function claimPendingRows(client: ClaimClient, batchId: string, limit: number, now: number): Promise<ClaimedRow[]> {
  const res = await client
    .prepare(
      `UPDATE collections SET attempts = attempts + 1, claimedAt = ?
       WHERE id IN (
         SELECT id FROM collections
         WHERE batchId = ? AND status = 'pending' AND attempts < ?
           AND (claimedAt IS NULL OR claimedAt < ?)
         ORDER BY id LIMIT ?
       )
       RETURNING id, questionId, platform, attempts`,
    )
    .bind(now, batchId, MAX_COLLECTION_ATTEMPTS, now - CLAIM_LEASE_MS, limit)
    .all<ClaimedRow>();
  return (res.results ?? []).sort((a, b) => a.id - b.id);
}

/** Give a claimed row back (its round ran out of time) so the next round can pick it up. */
export async function releaseClaim(client: ClaimClient, id: number): Promise<void> {
  await client.prepare(`UPDATE collections SET claimedAt = NULL WHERE id = ? AND status = 'pending'`).bind(id).run();
}

/** Rows still pending but held by a live claim (another round is working on them). */
export async function countClaimedPending(client: ClaimClient, batchId: string, now: number): Promise<number> {
  const res = await client
    .prepare(`SELECT COUNT(*) AS n FROM collections WHERE batchId = ? AND status = 'pending' AND claimedAt >= ?`)
    .bind(batchId, now - CLAIM_LEASE_MS)
    .all<{ n: number }>();
  return Number(res.results?.[0]?.n ?? 0);
}

/** Timeout for the next attempt given the round deadline; null = not enough time left to start one. */
export function attemptTimeoutMs(deadline: number | undefined, now: number): number | null {
  if (deadline == null) return PER_CALL_TIMEOUT_MS;
  const left = deadline - now;
  if (left < MIN_ATTEMPT_MS) return null;
  return Math.min(PER_CALL_TIMEOUT_MS, left);
}

export class RoundDeadlineError extends Error {
  constructor(message = "本轮时间用完，留给下一轮") {
    super(message);
    this.name = "RoundDeadlineError";
  }
}

// A worker slot only claims a new row while at least this much of the round is left, so the first
// attempt of every row it starts gets a reasonable time budget.
export const NEW_ROW_MIN_MS = 100_000;
