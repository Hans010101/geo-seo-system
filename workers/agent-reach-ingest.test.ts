import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../server/monitor/pipeline", () => ({ runMonitorCycle: mocks.run }));
vi.mock("../server/db", () => ({ withHyperdriveDatabase: (_db: unknown, fn: () => unknown) => fn() }));
import worker, { authorized, parsePost, DAILY_CAP } from "./agent-reach-ingest";

const token = "a".repeat(64);
const validPost = () => ({
  channel: "reddit", url: "https://www.reddit.com/r/Tronix/comments/abc/tron/", title: "Justin Sun and TRON",
  text: "Justin Sun discussed the TRON blockchain and stablecoin network today.".repeat(2),
  publishedAt: Date.now() - 3600_000, access: "public", completenessVerified: false,
});

function environment() {
  const receipts = new Map<string, { status: string; result?: string }>();
  const binding = {
    prepare(sql: string) {
      let args: unknown[];
      return {
        bind(...values: unknown[]) { args = values; return this; },
        async run() {
          if (sql.startsWith("INSERT")) {
            if (receipts.has(String(args[0])) || receipts.size >= DAILY_CAP) return { meta: { changes: 0 } };
            receipts.set(String(args[0]), { status: "processing" });
          } else if (sql.includes("result = ?")) {
            receipts.set(String(args[2]), { status: String(args[0]), result: String(args[1]) });
          }
          return { meta: { changes: 1 } };
        },
        async first() { return receipts.get(String(args[0])) || null; },
        async all() { return { results: [...receipts.values()] }; },
      };
    },
  };
  return { env: { HYPERDRIVE: binding, INGEST_TOKEN: token, PILOT_END: "2099-01-01", AI: {} } as any, receipts };
}
const request = (p: unknown, auth = token) => new Request("https://pilot.test/ingest", {
  method: "POST", headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify(p),
});

describe("Agent-Reach pilot boundary", () => {
  beforeEach(() => { mocks.run.mockReset(); mocks.run.mockResolvedValue({ inserted: 1, failed: 0, analysisFailed: 0 }); });
  it("requires a configured strong token", () => {
    expect(authorized(`Bearer ${token}`, token)).toBe(true);
    expect(authorized(`Bearer ${token}x`, token)).toBe(false);
    expect(authorized(`Bearer ${token}`, undefined)).toBe(false);
    expect(authorized("Bearer short", "short")).toBe(false);
  });
  it("rejects stale/undated data, unsafe URLs, forged channels and full-text claims", () => {
    const post = validPost();
    expect(parsePost(post).fullContent).toBeUndefined();
    for (const patch of [
      { publishedAt: undefined }, { publishedAt: Date.now() - 49 * 3600_000 },
      { publishedAt: Date.now() + 2 * 3600_000 }, { url: "http://reddit.com/a" },
      { url: "https://127.0.0.1/a", channel: "web" }, { url: "https://reddit.com.evil.org/a" },
      { url: "https://user:password@reddit.com/a" }, { channel: "x" }, { completenessVerified: true },
      { url: "https://reddit.com/r/Tronix/" }, { channel: "youtube", url: "https://youtube.com/@TRON" },
    ]) expect(() => parsePost({ ...post, ...patch })).toThrow();
  });
  it("does not invoke analysis for unauthorized, expired or oversized requests", async () => {
    const { env } = environment();
    expect((await worker.fetch(request(validPost(), "wrong"), env)).status).toBe(401);
    expect((await worker.fetch(request(validPost()), { ...env, PILOT_END: "2000-01-01" })).status).toBe(410);
    expect((await worker.fetch(request({ ...validPost(), text: "x".repeat(50_000) }), env)).status).toBe(400);
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("claims once before analysis and suppresses duplicate token spend", async () => {
    const { env } = environment();
    const post = validPost();
    expect((await worker.fetch(request(post), env)).status).toBe(200);
    const second = await worker.fetch(request(post), env);
    expect(await second.json()).toMatchObject({ replay: true, status: "inserted" });
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.run.mock.calls[0][0]).toMatchObject({ importPosts: [{ sourcePlatform: "reddit" }], maxArticles: 1 });
  });
  it("enforces a hard daily cap", async () => {
    const { env, receipts } = environment();
    for (let i = 0; i < DAILY_CAP; i++) receipts.set(String(i), { status: "filtered_or_duplicate" });
    expect((await worker.fetch(request(validPost()), env)).status).toBe(429);
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
