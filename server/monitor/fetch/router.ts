// Pluggable fetch router. Tries engines in ascending level order (cheapest-capable first); first success
// wins. To add a tier, implement FetchEngine and insert it into `engines` — router/pipeline/callers stay
// unchanged.
//
//   L1 self      — plain fetch + readability (free)                    [implemented]
//   L2 (预留)    — Scrapling Fetcher / Node stealth 库: TLS 指纹伪装，处理中等反爬
//   L3 (预留)    — Scrapling StealthyFetcher: 免费过 Cloudflare，需独立 Python 微服务或 Node rebrowser
//   L4 firecrawl — 付费 API 兜底 (budget-gated)                        [implemented]
//
// 引入 L2/L3 的条件: Phase 1 数据显示 >X% 站点卡在 Cloudflare/反爬时评估
// （依据 = monitor_articles 里 fetchEngine='snippet' 的占比 + 反复失败的域名）。
import type { FetchEngine, FetchResult } from "./types";
import { selfEngine } from "./self-engine";
import { firecrawlEngine } from "./firecrawl-engine";
import { log } from "../util";
import { attemptFromResult, recordFetchAttempt } from "./observability";
import type { FetchAttempt } from "./types";

const engines: FetchEngine[] = [selfEngine, firecrawlEngine].sort((a, b) => a.level - b.level);

export function registeredEngines() {
  return engines.map((e) => ({ name: e.name, level: e.level, costPerPage: e.costPerPage }));
}

// Try each engine in order; return the first success. All fail → keep the Serper snippet so the article
// stays analyzable (marked engine='snippet').
export async function fetchArticle(url: string, snippet: string): Promise<FetchResult> {
  const attempts: FetchAttempt[] = [];
  for (const engine of engines) {
    if (engine.canHandle) {
      const ok = await engine.canHandle(url);
      if (!ok) {
        const skipped: FetchAttempt = {
          engine: engine.name,
          outcome: "skipped",
          reason: "gate_disabled",
          durationMs: 0,
          contentChars: 0,
          costUsd: 0,
        };
        attempts.push(skipped);
        recordFetchAttempt(url, skipped);
        continue; // e.g. firecrawl budget exhausted → skip this engine
      }
    }
    const startedAt = Date.now();
    try {
      const result = await engine.fetch(url);
      const attempt = attemptFromResult(result, Date.now() - startedAt);
      attempts.push(attempt);
      recordFetchAttempt(url, attempt);
      if (result.success) return { ...result, attempts };
    } catch (e: any) {
      const attempt: FetchAttempt = {
        engine: engine.name,
        outcome: "failed",
        reason: /abort|timeout|timed out/i.test(String(e?.message || e))
          ? "timeout"
          : "engine_error",
        durationMs: Date.now() - startedAt,
        contentChars: 0,
        costUsd: engine.costPerPage,
      };
      attempts.push(attempt);
      recordFetchAttempt(url, attempt);
      log.warn(`fetch engine ${engine.name} threw for ${url}: ${String(e?.message || e).slice(0, 120)}`);
    }
  }
  const fallback: FetchAttempt = {
    engine: "snippet",
    outcome: "fallback",
    reason: "snippet_fallback",
    durationMs: 0,
    contentChars: snippet.length,
    costUsd: 0,
  };
  attempts.push(fallback);
  recordFetchAttempt(url, fallback);
  return {
    success: !!snippet,
    contentMd: snippet || "",
    title: null,
    engine: "snippet",
    costUsd: 0,
    status: snippet ? "partial" : "failed",
    contentChars: snippet.length,
    attempts,
  };
}
