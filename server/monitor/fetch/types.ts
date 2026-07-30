// Pluggable fetch-engine contract. New tiers (L2/L3 stealth, etc.) implement this and register in
// router.ts — callers (pipeline) never change.
export interface FetchResult {
  success: boolean;
  contentMd?: string;
  title?: string | null;
  engine: string; // engine that produced the result ('self' | 'firecrawl' | ... | 'snippet' when all fail)
  costUsd: number; // fetch cost: L1 self = 0, L4 firecrawl = credit 折算
  status?: "full" | "partial" | "failed";
  error?: string;
  httpStatus?: number;
  contentChars?: number;
  failureReason?: FetchFailureReason;
  attempts?: FetchAttempt[];
}

export type FetchFailureReason =
  | "http_403"
  | "http_429"
  | "http_error"
  | "timeout"
  | "short_content"
  | "js_shell"
  | "budget_exhausted"
  | "missing_key"
  | "empty_content"
  | "engine_error"
  | "gate_disabled"
  | "snippet_fallback";

export interface FetchAttempt {
  engine: string;
  outcome: "success" | "failed" | "skipped" | "fallback";
  reason: "success" | FetchFailureReason;
  durationMs: number;
  contentChars: number;
  costUsd: number;
  httpStatus?: number;
}

export interface FetchEngine {
  name: string; // 'self' | 'firecrawl' | (future 'scrapling' ...)
  level: number; // L1=1 … L4=4; router tries ascending (cheapest-capable first)
  costPerPage: number; // USD estimate per page, for accounting/UI
  canHandle?(url: string): boolean | Promise<boolean>; // optional gate: budget / url suitability
  fetch(url: string): Promise<FetchResult>;
}
