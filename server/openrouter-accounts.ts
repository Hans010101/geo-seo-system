// OpenRouter 主号 / 副号.
//
// Every active OpenRouter record in 全局 API 配置 (globalApiKeys, baseUrl contains openrouter.ai) is an
// account; the lowest sortOrder is the 主号, the rest are 副号 in order. The OPENROUTER_API_KEY secret is
// kept as a last-resort account when it is not already one of them.
//
// A call goes to the 主号 and only moves to the next account on errors that another account can fix:
// invalid / revoked key (401), no credits (402), key limit reached (403 limit), model not allowed for
// this account (404 no endpoints / guardrail / data policy), rate limited (429). Empty answers, timeouts,
// moderation and upstream 5xx stay on the same account — another account would fail (and bill) the same.
//
// Account-wide failures pause that account for ACCOUNT_COOLDOWN_MS, model-specific ones only that model
// for MODEL_BLOCK_MS, so later calls go straight to the 副号 instead of failing on the 主号 first. Blocks
// live in sysConfigs (or_block:<keyId>:<model|*>) so every isolate and the cron Worker share them.

import { d1 } from "./external";
import { getCloudflareEnv } from "./_core/cloudflare-env";
import { ENV } from "./_core/env";
import { invokeLLM, type InvokeParams, type InvokeResult } from "./_core/llm";

export const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
export const ACCOUNT_COOLDOWN_MS = 30 * 60_000;
export const MODEL_BLOCK_MS = 24 * 3600_000;
export const RATE_LIMIT_BLOCK_MS = 2 * 60_000;
// The 主号 is flagged on the pages when its remaining credit falls below this.
export const LOW_BALANCE_USD = 5;
/** keyId used for the OPENROUTER_API_KEY secret account. */
export const ENV_KEY_ID = 0;

export type AccountRole = "primary" | "backup";
export type OpenRouterAccount = { keyId: number; name: string; apiKey: string; baseUrl: string; role: AccountRole };

type Stmt = { bind(...values: unknown[]): { run(): Promise<unknown>; all<T = unknown>(): Promise<{ results?: T[] }> } };
export type AccountsClient = { prepare(sql: string): Stmt };

async function client(): Promise<AccountsClient> {
  return (await d1()) as unknown as AccountsClient;
}

// ---------------------------------------------------------------- failover rules

export type Failover = { scope: "account" | "model"; ttlMs: number; reason: string };

/** Whether an OpenRouter HTTP error should move the call to the next account (null = it should not). */
export function classifyFailover(status: number, body: string): Failover | null {
  const text = (body || "").toLowerCase();
  if (status === 401) return { scope: "account", ttlMs: ACCOUNT_COOLDOWN_MS, reason: "key 无效或已吊销" };
  if (status === 402) return { scope: "account", ttlMs: ACCOUNT_COOLDOWN_MS, reason: "余额不足" };
  if (status === 403) {
    if (/limit|quota|disabled|credit/.test(text)) return { scope: "account", ttlMs: ACCOUNT_COOLDOWN_MS, reason: "key 额度已用完或已停用" };
    return null; // moderation: the same input is flagged on any account
  }
  if (status === 404 && /endpoint|guardrail|policy|allow|privacy|provider/.test(text)) {
    return { scope: "model", ttlMs: MODEL_BLOCK_MS, reason: "该账号不允许使用此模型" };
  }
  if (status === 429) return { scope: "model", ttlMs: RATE_LIMIT_BLOCK_MS, reason: "被限流" };
  return null;
}

/** invokeLLM throws `LLM invoke failed: <status> <statusText> – <body>`. */
export function failoverFromError(error: unknown): Failover | null {
  const message = String((error as Error)?.message || error || "");
  const m = message.match(/LLM invoke failed: (\d{3})\b/);
  return m ? classifyFailover(Number(m[1]), message) : null;
}

// ---------------------------------------------------------------- accounts

export async function listOpenRouterAccounts(c?: AccountsClient): Promise<OpenRouterAccount[]> {
  const db = c ?? await client();
  const rows = (await db.prepare(`SELECT id, name, apiKey, baseUrl FROM globalApiKeys
    WHERE isActive = 1 AND apiKey IS NOT NULL AND apiKey <> '' AND baseUrl LIKE '%openrouter.ai%'
    ORDER BY sortOrder, id`).bind().all<{ id: number; name: string; apiKey: string; baseUrl: string }>()).results ?? [];
  const accounts: OpenRouterAccount[] = rows.map((r, i) => ({
    keyId: Number(r.id), name: r.name, apiKey: r.apiKey.trim(), baseUrl: r.baseUrl, role: i === 0 ? "primary" : "backup",
  }));
  const env = getCloudflareEnv();
  const envKey = (env?.OPENROUTER_API_KEY as string | undefined)?.trim() || ENV.openrouterApiKey;
  if (envKey && !accounts.some(a => a.apiKey === envKey)) {
    accounts.push({
      keyId: ENV_KEY_ID, name: "OPENROUTER_API_KEY（服务器密钥）", apiKey: envKey,
      baseUrl: (env?.OPENROUTER_BASE_URL as string | undefined)?.trim() || ENV.openrouterBaseUrl || OPENROUTER_API_BASE,
      role: accounts.length ? "backup" : "primary",
    });
  }
  return accounts;
}

// ---------------------------------------------------------------- blocks (circuit breaker)

export type Block = { keyId: number; model: string; until: number; reason: string };
const BLOCK_PREFIX = "or_block:";
let blockCache: { at: number; blocks: Block[] } | null = null;
const BLOCK_CACHE_MS = 15_000;

export function parseBlocks(rows: { configKey: string; configValue: string | null }[], now: number): Block[] {
  const out: Block[] = [];
  for (const r of rows) {
    const rest = r.configKey.slice(BLOCK_PREFIX.length);
    const sep = rest.indexOf(":");
    if (sep < 0) continue;
    const [untilText, ...reason] = String(r.configValue || "").split("|");
    const until = Number(untilText);
    if (!(until > now)) continue;
    out.push({ keyId: Number(rest.slice(0, sep)), model: rest.slice(sep + 1), until, reason: reason.join("|") });
  }
  return out;
}

export async function listBlocks(now = Date.now(), c?: AccountsClient): Promise<Block[]> {
  if (!c && blockCache && now - blockCache.at < BLOCK_CACHE_MS) return blockCache.blocks.filter(b => b.until > now);
  const db = c ?? await client();
  const rows = (await db.prepare(`SELECT configKey, configValue FROM sysConfigs WHERE configKey LIKE ?`)
    .bind(`${BLOCK_PREFIX}%`).all<{ configKey: string; configValue: string | null }>()).results ?? [];
  const blocks = parseBlocks(rows, now);
  if (!c) blockCache = { at: now, blocks };
  return blocks;
}

async function setSys(db: AccountsClient, key: string, value: string, now: number) {
  await db.prepare(`INSERT INTO sysConfigs (configKey, configValue, updatedAt) VALUES (?, ?, ?)
    ON CONFLICT(configKey) DO UPDATE SET configValue = excluded.configValue, updatedAt = excluded.updatedAt`)
    .bind(key, value, Math.floor(now / 1000)).run();
}

export async function recordBlock(account: OpenRouterAccount, model: string, failover: Failover, now = Date.now(), c?: AccountsClient) {
  const db = c ?? await client();
  const target = failover.scope === "account" ? "*" : model;
  await setSys(db, `${BLOCK_PREFIX}${account.keyId}:${target}`, `${now + failover.ttlMs}|${failover.reason}`, now);
  if (!c) blockCache = null;
}

export async function clearBlocks(c?: AccountsClient) {
  const db = c ?? await client();
  await db.prepare(`DELETE FROM sysConfigs WHERE configKey LIKE ?`).bind(`${BLOCK_PREFIX}%`).run();
  if (!c) blockCache = null;
}

/** Give `ids` consecutive sortOrders starting at `base` (first id = 主号). */
export async function setKeyOrder(ids: number[], base: number, c?: AccountsClient) {
  const db = c ?? await client();
  for (let i = 0; i < ids.length; i++) {
    await db.prepare(`UPDATE globalApiKeys SET sortOrder = ? WHERE id = ?`).bind(base + i, ids[i]).run();
  }
}

export type AccountUsage ={ keyId: number | null; rows: number; usd: number; fallbackRows: number };

/** GEO collection spend per account since `since` (keyId null = rows from before billing was recorded). */
export async function usageByAccount(since: number, c?: AccountsClient): Promise<AccountUsage[]> {
  const db = c ?? await client();
  const res = await db.prepare(`SELECT billingKeyId AS keyId, COUNT(*) AS rows, COALESCE(SUM(CAST(costUsd AS REAL)), 0) AS usd,
      SUM(CASE WHEN billingFallback IS NOT NULL THEN 1 ELSE 0 END) AS fallbackRows
    FROM collections WHERE status = 'success' AND provider = 'openrouter' AND timestamp >= ?
    GROUP BY billingKeyId`).bind(since).all<AccountUsage>();
  return (res.results ?? []).map(r => ({
    keyId: r.keyId == null ? null : Number(r.keyId), rows: Number(r.rows), usd: Number(r.usd), fallbackRows: Number(r.fallbackRows),
  }));
}

export type FailoverEvent ={ at: number; from: string; to: string | null; model: string; reason: string; purpose: string };
export const LAST_FAILOVER_KEY = "or_last_failover";

async function recordFailoverEvent(event: FailoverEvent, c?: AccountsClient) {
  try { await setSys(c ?? await client(), LAST_FAILOVER_KEY, JSON.stringify(event), event.at); } catch {}
}

export function isBlocked(blocks: Block[], account: OpenRouterAccount, model: string): Block | undefined {
  return blocks.find(b => b.keyId === account.keyId && (b.model === "*" || b.model === model));
}

/**
 * Accounts to try for a model, in order: unblocked accounts by priority, then blocked ones (so a call
 * still goes out when every account is paused — a block can be stale once credits are topped up).
 */
export function orderAccounts(accounts: OpenRouterAccount[], blocks: Block[], model: string): OpenRouterAccount[] {
  const open = accounts.filter(a => !isBlocked(blocks, a, model));
  const paused = accounts.filter(a => isBlocked(blocks, a, model));
  return [...open, ...paused];
}

export async function accountsForModel(model: string, now = Date.now()): Promise<OpenRouterAccount[]> {
  const [accounts, blocks] = await Promise.all([listOpenRouterAccounts(), listBlocks(now).catch(() => [] as Block[])]);
  return orderAccounts(accounts, blocks, model);
}

/**
 * Note a failed account and say whether the call should move on. Records the block and, when the call
 * moves to another account, the last-failover event shown on the config page.
 */
export async function handleAccountFailure(opts: {
  account: OpenRouterAccount; next: OpenRouterAccount | undefined; model: string; failover: Failover; purpose: string;
}): Promise<void> {
  const now = Date.now();
  try { await recordBlock(opts.account, opts.model, opts.failover, now); } catch {}
  await recordFailoverEvent({
    at: now, from: opts.account.name, to: opts.next?.name ?? null, model: opts.model,
    reason: `${opts.account.name}${opts.failover.reason}`, purpose: opts.purpose,
  });
}

/** How a call was billed: the account used and, when it was not the first choice, why. */
export type Billing = { keyId: number; accountName: string; role: AccountRole; fallbackReason: string | null };

/** invokeLLM over the OpenRouter accounts (主号 first, 副号 on account-level failures). */
export async function invokeOpenRouter(
  params: Omit<InvokeParams, "apiKey" | "baseUrl">,
  purpose: string,
): Promise<InvokeResult & { billing: Billing }> {
  const model = params.model || "";
  const accounts = await accountsForModel(model);
  if (!accounts.length) throw new Error("未配置 OpenRouter API Key（全局 API 配置）");
  let fallbackReason: string | null = null;
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    try {
      const result = await invokeLLM({ ...params, apiKey: account.apiKey, baseUrl: account.baseUrl });
      return { ...result, billing: { keyId: account.keyId, accountName: account.name, role: account.role, fallbackReason } };
    } catch (error) {
      const failover = failoverFromError(error);
      if (!failover) throw error;
      const next = accounts[i + 1];
      await handleAccountFailure({ account, next, model, failover, purpose });
      if (!next) throw error;
      fallbackReason = `${account.name}${failover.reason}`;
      console.warn(JSON.stringify({ event: "openrouter.failover", purpose, model, from: account.name, to: next.name, reason: failover.reason }));
    }
  }
  throw new Error("OpenRouter 所有账号均不可用");
}

// ---------------------------------------------------------------- balance

export type KeyBalance = {
  ok: boolean;
  error?: string;
  label?: string | null;
  /** Spend on this key (USD). */
  usage?: number | null;
  /** Credit limit set on this key (USD), null = no limit. */
  limit?: number | null;
  limitRemaining?: number | null;
  /** Account credits left (total purchased − total used), when the key may read it. */
  accountRemaining?: number | null;
  /** What the page should treat as "money left": the smaller of the key limit and account credits. */
  remaining?: number | null;
};

const num = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

export function summarizeBalance(key: any, credits: any): KeyBalance {
  const d = key?.data ?? key ?? {};
  const limitRemaining = num(d.limit_remaining);
  const c = credits?.data ?? credits ?? null;
  const accountRemaining = c && num(c.total_credits) != null && num(c.total_usage) != null
    ? Number(c.total_credits) - Number(c.total_usage) : null;
  const candidates = [limitRemaining, accountRemaining].filter((v): v is number => v != null);
  return {
    ok: true,
    label: d.label ?? null,
    usage: num(d.usage),
    limit: num(d.limit),
    limitRemaining,
    accountRemaining,
    remaining: candidates.length ? Math.min(...candidates) : null,
  };
}

/** GET /key (+ /credits): verifies the key really authenticates and reads what is left on it. */
export async function fetchKeyBalance(apiKey: string, baseUrl = OPENROUTER_API_BASE): Promise<KeyBalance> {
  const base = baseUrl.replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${apiKey}` };
  try {
    const keyRes = await fetch(`${base}/key`, { headers, signal: AbortSignal.timeout(15_000) });
    if (!keyRes.ok) return { ok: false, error: `HTTP ${keyRes.status}: ${(await keyRes.text()).slice(0, 200)}` };
    const key = await keyRes.json();
    let credits: unknown = null;
    try {
      const cr = await fetch(`${base}/credits`, { headers, signal: AbortSignal.timeout(15_000) });
      if (cr.ok) credits = await cr.json();
    } catch {}
    return summarizeBalance(key, credits);
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message || error).slice(0, 200) };
  }
}
