import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as orAccounts from "./openrouter-accounts";
import {
  ACCOUNT_COOLDOWN_MS,
  MODEL_BLOCK_MS,
  classifyFailover,
  failoverFromError,
  listBlocks,
  listOpenRouterAccounts,
  orderAccounts,
  parseBlocks,
  recordBlock,
  clearBlocks,
  setKeyOrder,
  summarizeBalance,
  usageByAccount,
  type AccountsClient,
  type OpenRouterAccount,
} from "./openrouter-accounts";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");

// invokeOpenRouter reads accounts and writes pauses through d1(): point it at an in-memory database.
const holder = vi.hoisted(() => ({ client: null as any }));
vi.mock("./external", () => ({ d1: async () => holder.client }));

function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE globalApiKeys (id INTEGER PRIMARY KEY, name TEXT, apiKey TEXT, baseUrl TEXT, isActive INTEGER, sortOrder INTEGER);
    CREATE TABLE sysConfigs (configKey TEXT PRIMARY KEY, configValue TEXT, updatedAt INTEGER);
    CREATE TABLE collections (id INTEGER PRIMARY KEY, status TEXT, provider TEXT, timestamp INTEGER, costUsd TEXT, billingKeyId INTEGER, billingFallback TEXT);`);
  const client: AccountsClient = {
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
  return { db, client };
}

const acct = (keyId: number, role: "primary" | "backup" = keyId === 1 ? "primary" : "backup"): OpenRouterAccount =>
  ({ keyId, name: `K${keyId}`, apiKey: `sk-${keyId}`, baseUrl: "https://openrouter.ai/api/v1", role });

describe("OpenRouter failover rules", () => {
  it("switches only on errors another account can fix", () => {
    expect(classifyFailover(402, '{"error":{"message":"Insufficient credits"}}')).toMatchObject({ scope: "account", reason: "余额不足" });
    expect(classifyFailover(401, "No auth credentials found")).toMatchObject({ scope: "account" });
    expect(classifyFailover(403, "Key limit exceeded")).toMatchObject({ scope: "account", ttlMs: ACCOUNT_COOLDOWN_MS });
    expect(classifyFailover(404, "No endpoints found matching your data policy")).toMatchObject({ scope: "model", ttlMs: MODEL_BLOCK_MS });
    expect(classifyFailover(429, "Rate limit exceeded")).toMatchObject({ scope: "model" });
    // Same result on any account: stay put.
    expect(classifyFailover(403, "Input was flagged by moderation")).toBeNull();
    expect(classifyFailover(400, "not a valid model ID")).toBeNull();
    expect(classifyFailover(500, "Internal error")).toBeNull();
    expect(classifyFailover(502, "Upstream error")).toBeNull();
  });

  it("reads the status out of invokeLLM errors", () => {
    expect(failoverFromError(new Error("LLM invoke failed: 402 Payment Required – {\"error\":\"Insufficient credits\"}"))).toMatchObject({ reason: "余额不足" });
    expect(failoverFromError(new Error("LLM request timeout after 120000ms"))).toBeNull();
  });

  it("tries unblocked accounts first, paused ones last", () => {
    const accounts = [acct(1), acct(2)];
    const now = 1_000;
    const blocks = parseBlocks([
      { configKey: "or_block:1:*", configValue: `${now + 5}|余额不足` },
      { configKey: "or_block:2:x-ai/grok", configValue: `${now - 1}|expired` },
    ], now);
    expect(blocks).toEqual([{ keyId: 1, model: "*", until: now + 5, reason: "余额不足" }]);
    expect(orderAccounts(accounts, blocks, "x-ai/grok").map(a => a.keyId)).toEqual([2, 1]);
    expect(orderAccounts(accounts, [], "x-ai/grok").map(a => a.keyId)).toEqual([1, 2]);
    const modelBlock = parseBlocks([{ configKey: "or_block:1:x-ai/grok", configValue: `${now + 5}|不允许` }], now);
    expect(orderAccounts(accounts, modelBlock, "x-ai/grok").map(a => a.keyId)).toEqual([2, 1]);
    expect(orderAccounts(accounts, modelBlock, "openai/gpt").map(a => a.keyId)).toEqual([1, 2]);
  });
});

describe("OpenRouter accounts in D1", () => {
  it("orders OpenRouter keys by sortOrder and ignores other providers / inactive keys", async () => {
    const { db, client } = makeDb();
    db.exec(`INSERT INTO globalApiKeys VALUES
      (2, '阿里百炼', 'sk-bl', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 1, 0),
      (3, 'OpenRouter 个人', 'sk-or-me', 'https://openrouter.ai/api/v1', 1, 1),
      (7, 'OpenRouter 公用', 'sk-or-team', 'https://openrouter.ai/api/v1', 1, 0),
      (8, 'OpenRouter 停用', 'sk-or-off', 'https://openrouter.ai/api/v1', 0, -1)`);
    const accounts = await listOpenRouterAccounts(client);
    expect(accounts.map(a => [a.keyId, a.role])).toEqual([[7, "primary"], [3, "backup"]]);
    await setKeyOrder([3, 7], 0, client);
    expect((await listOpenRouterAccounts(client)).map(a => a.keyId)).toEqual([3, 7]);
  });

  it("records and clears pauses", async () => {
    const { client } = makeDb();
    const now = 5_000_000;
    await recordBlock(acct(7), "x-ai/grok", { scope: "account", ttlMs: 1000, reason: "余额不足" }, now, client);
    await recordBlock(acct(3), "x-ai/grok", { scope: "model", ttlMs: 1000, reason: "该账号不允许使用此模型" }, now, client);
    expect((await listBlocks(now + 10, client)).sort((a, b) => a.keyId - b.keyId)).toEqual([
      { keyId: 3, model: "x-ai/grok", until: now + 1000, reason: "该账号不允许使用此模型" },
      { keyId: 7, model: "*", until: now + 1000, reason: "余额不足" },
    ]);
    expect(await listBlocks(now + 2000, client)).toEqual([]);
    await clearBlocks(client);
    expect(await listBlocks(now, client)).toEqual([]);
  });

  it("splits GEO spend per account", async () => {
    const { db, client } = makeDb();
    db.exec(`INSERT INTO collections (status, provider, timestamp, costUsd, billingKeyId, billingFallback) VALUES
      ('success', 'openrouter', 100, '0.01', 7, NULL),
      ('success', 'openrouter', 100, '0.02', 3, 'OpenRouter 公用余额不足'),
      ('success', 'openrouter', 100, '0.03', NULL, NULL),
      ('failed', 'openrouter', 100, NULL, 7, NULL),
      ('success', 'openrouter', 1, '9', 7, NULL)`);
    const usage = await usageByAccount(50, client);
    expect(usage.find(u => u.keyId === 7)).toMatchObject({ rows: 1, usd: 0.01, fallbackRows: 0 });
    expect(usage.find(u => u.keyId === 3)).toMatchObject({ rows: 1, usd: 0.02, fallbackRows: 1 });
    expect(usage.find(u => u.keyId == null)).toMatchObject({ rows: 1 });
  });
});

describe("balance", () => {
  it("takes the smaller of the key limit and account credits", () => {
    expect(summarizeBalance({ data: { usage: 12, limit: 50, limit_remaining: 38 } }, { data: { total_credits: 100, total_usage: 90 } }))
      .toMatchObject({ ok: true, usage: 12, limit: 50, limitRemaining: 38, accountRemaining: 10, remaining: 10 });
    expect(summarizeBalance({ data: { usage: 3, limit: null, limit_remaining: null } }, null))
      .toMatchObject({ remaining: null, limit: null });
  });
});

describe("invokeOpenRouter", () => {
  afterEach(() => vi.restoreAllMocks());

  async function setup() {
    const { db, client } = makeDb();
    db.exec(`INSERT INTO globalApiKeys VALUES
      (3, '个人', 'sk-3', 'https://openrouter.ai/api/v1', 1, 2),
      (7, '公用', 'sk-7', 'https://openrouter.ai/api/v1', 1, 1)`);
    holder.client = client;
    await clearBlocks(); // also drops the per-isolate pause cache left by the previous test
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const auth: string[] = [];
    return { db, client, auth };
  }

  it("moves to the backup on no credits and pauses the primary", async () => {
    const { client, auth } = await setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init: any) => {
      auth.push(init.headers.authorization);
      if (init.headers.authorization === "Bearer sk-7") return new Response('{"error":{"message":"Insufficient credits"}}', { status: 402, statusText: "Payment Required" });
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    });
    const result = await orAccounts.invokeOpenRouter({ model: "m", messages: [{ role: "user", content: "hi" }] }, "test");
    expect(auth).toEqual(["Bearer sk-7", "Bearer sk-3"]);
    expect(result.billing).toMatchObject({ keyId: 3, role: "backup", fallbackReason: "公用余额不足" });
    const blocks = await listBlocks(Date.now(), client);
    expect(blocks).toMatchObject([{ keyId: 7, model: "*", reason: "余额不足" }]);
    // Next call goes straight to the backup.
    auth.length = 0;
    await orAccounts.invokeOpenRouter({ model: "m", messages: [{ role: "user", content: "hi" }] }, "test");
    expect(auth).toEqual(["Bearer sk-3"]);
  });

  it("does not switch accounts on a moderation error", async () => {
    const { auth } = await setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init: any) => {
      auth.push(init.headers.authorization);
      return new Response("Input was flagged by moderation", { status: 403, statusText: "Forbidden" });
    });
    await expect(orAccounts.invokeOpenRouter({ model: "m2", messages: [{ role: "user", content: "hi" }] }, "test")).rejects.toThrow("403");
    expect(auth).toEqual(["Bearer sk-7"]);
  });
});
