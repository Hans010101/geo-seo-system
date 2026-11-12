import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  CLAIM_LEASE_MS,
  EXHAUSTED_MESSAGE,
  MIN_ATTEMPT_MS,
  PER_CALL_TIMEOUT_MS,
  attemptTimeoutMs,
  claimPendingRows,
  expireExhaustedRows,
  releaseClaim,
  type ClaimClient,
} from "./collection-claims";
import { REASONING_BUDGETS } from "./llm-answer";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");

function makeDb(rows: { platform: string; status?: string; attempts?: number; claimedAt?: number | null }[]) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE collections (id INTEGER PRIMARY KEY, questionId TEXT, platform TEXT, batchId TEXT,
    status TEXT, errorMessage TEXT, attempts INTEGER NOT NULL DEFAULT 0, claimedAt INTEGER)`);
  const ins = db.prepare("INSERT INTO collections (questionId, platform, batchId, status, attempts, claimedAt) VALUES (?, ?, 'b1', ?, ?, ?)");
  rows.forEach((r, i) => ins.run(`Q${i}`, r.platform, r.status ?? "pending", r.attempts ?? 0, r.claimedAt ?? null));
  const client: ClaimClient = {
    prepare: (sql) => ({
      bind: (...values) => {
        const stmt = db.prepare(sql);
        return {
          run: async () => stmt.run(...(values as any[])),
          all: async <T,>() => ({ results: stmt.all(...(values as any[])).map((r: object) => ({ ...r })) as T[] }),
        };
      },
    }),
  };
  const get = (id: number) => ({ ...db.prepare("SELECT * FROM collections WHERE id = ?").get(id) });
  return { client, get };
}

describe("collection claims", () => {
  const now = 1_800_000_000_000;

  it("two rounds never claim the same row", async () => {
    const { client } = makeDb([{ platform: "a" }, { platform: "b" }, { platform: "c" }]);
    const first = await claimPendingRows(client, "b1", 2, now);
    const second = await claimPendingRows(client, "b1", 2, now);
    expect(first.map((r) => r.id)).toEqual([1, 2]);
    expect(second.map((r) => r.id)).toEqual([3]);
    expect(await claimPendingRows(client, "b1", 2, now)).toEqual([]);
  });

  it("a row whose round died is retried once after the lease, then closed as timeout", async () => {
    const { client, get } = makeDb([{ platform: "doubao" }]);
    expect((await claimPendingRows(client, "b1", 1, now))[0].attempts).toBe(1);
    // Still leased: nobody else may take it.
    expect(await claimPendingRows(client, "b1", 1, now + 60_000)).toEqual([]);
    const later = now + CLAIM_LEASE_MS + 1;
    expect(await expireExhaustedRows(client, "b1", later)).toBe(0);
    expect((await claimPendingRows(client, "b1", 1, later))[0].attempts).toBe(2);
    // Second round dies too → the row stops being re-run.
    const last = later + CLAIM_LEASE_MS + 1;
    expect(await claimPendingRows(client, "b1", 1, last)).toEqual([]);
    expect(await expireExhaustedRows(client, "b1", last)).toBe(1);
    expect(get(1)).toMatchObject({ status: "timeout", errorMessage: EXHAUSTED_MESSAGE, claimedAt: null });
  });

  it("a released row is immediately claimable again", async () => {
    const { client } = makeDb([{ platform: "grok" }]);
    await claimPendingRows(client, "b1", 1, now);
    await releaseClaim(client, 1);
    expect((await claimPendingRows(client, "b1", 1, now + 1000))[0]).toMatchObject({ id: 1, attempts: 2 });
  });

  it("finished rows are left alone", async () => {
    const { client, get } = makeDb([{ platform: "a", status: "success", attempts: 2 }]);
    expect(await claimPendingRows(client, "b1", 5, now)).toEqual([]);
    expect(await expireExhaustedRows(client, "b1", now + CLAIM_LEASE_MS * 3)).toBe(0);
    expect(get(1).status).toBe("success");
  });
});

describe("attempt timeouts", () => {
  it("caps a call at the per-call timeout, or the time left in the round", () => {
    expect(attemptTimeoutMs(undefined, 0)).toBe(PER_CALL_TIMEOUT_MS);
    expect(attemptTimeoutMs(1_000_000, 0)).toBe(PER_CALL_TIMEOUT_MS);
    expect(attemptTimeoutMs(60_000, 0)).toBe(60_000);
    expect(attemptTimeoutMs(MIN_ATTEMPT_MS - 1, 0)).toBeNull();
  });

  it("doubao gets a capped reasoning budget with room left for the answer", () => {
    const b = REASONING_BUDGETS.doubao;
    expect(b.reasoningTokens).toBeLessThan(b.maxTokens / 2);
  });
});
