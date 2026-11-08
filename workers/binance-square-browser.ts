import type { DiscoveredPost } from "../server/monitor/sources/types";

const POST_CARD_TYPES = new Set(["BUZZ_SHORT", "BUZZ_LONG"]);

export type BinanceBrowserSearchRequest = {
  queries: string[];
  pageSize?: number;
};

export type BinanceBrowserQueryDiagnostic = {
  query: string;
  status: "success" | "empty" | "failed";
  httpStatus?: number;
  posts: number;
  error?: string;
  pageUrl?: string;
  pageTitle?: string;
  bodyPreview?: string;
  apiUrls?: string[];
};

export type BinanceBrowserSearchResult = {
  ok: boolean;
  posts: DiscoveredPost[];
  durationMs: number;
  sessionId: string;
  queriesRequested: number;
  queriesExecuted: number;
  queriesTruncated: number;
  queriesAttempted: number;
  queriesSucceeded: number;
  diagnostics: BinanceBrowserQueryDiagnostic[];
};

export function binanceBrowserNeedsFallback(result: BinanceBrowserSearchResult): boolean {
  return !result.ok || result.posts.length === 0;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numericTimestamp(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
}

function firstNumericTimestamp(values: unknown[]): number | null {
  for (const value of values) {
    const timestamp = numericTimestamp(value);
    if (timestamp != null) return timestamp;
  }
  return null;
}

export function binanceQueryBatches(queries: string[], concurrency = 2): string[][] {
  const batchSize = Math.max(1, Math.floor(concurrency));
  const batches: string[][] = [];
  for (let index = 0; index < queries.length; index += batchSize) {
    batches.push(queries.slice(index, index + batchSize));
  }
  return batches;
}

function responseItems(payload: unknown): unknown[] {
  const root = record(payload);
  const data = record(root?.data);
  const nested = record(data?.data);
  for (const value of [data?.vos, data?.list, nested?.vos, nested?.list]) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

export function isBinanceSquarePayload(payload: unknown): boolean {
  const root = record(payload);
  if (root?.code !== undefined && String(root.code) !== "000000") return false;
  const data = record(root?.data);
  const nested = record(data?.data);
  return [data?.vos, data?.list, nested?.vos, nested?.list].some(Array.isArray);
}

export function parseBinanceSquareResponse(payload: unknown): DiscoveredPost[] {
  const root = record(payload);
  const code = root?.code;
  if (code !== undefined && String(code) !== "000000") return [];

  const posts: DiscoveredPost[] = [];
  for (const raw of responseItems(payload)) {
    const item = record(raw);
    if (!item || !POST_CARD_TYPES.has(text(item.cardType))) continue;
    const content = text(item.content);
    if (content.length < 10) continue;
    const id = text(item.id) || text(item.postId);
    const webLink = text(item.webLink);
    if (!webLink && !id) continue;
    posts.push({
      url: webLink || `https://www.binance.com/zh-CN/square/post/${id}`,
      title: content.replace(/\s+/g, " ").slice(0, 80),
      fullContent: content.slice(0, 20_000),
      author: text(item.authorName) || text(item.username) || null,
      publishedAt: firstNumericTimestamp([
        item.date,
        item.publishTime,
        item.publish_time,
        item.createTime,
        item.create_time,
        item.postTime,
      ]),
      sourceName: "binance_square",
      sourcePlatform: "binance_square",
      fetchEngineHint: "cloudflare_browser",
      fetchCostUsdHint: 0,
    });
  }
  return posts;
}

export function isBinanceSearchResponse(url: string): boolean {
  if (!url.startsWith("https://www.binance.com/bapi/")) return false;
  return /\/(?:feed\/)?search\/list(?:\?|$)/.test(url);
}

export function binanceSearchUrl(query: string): string {
  return `https://www.binance.com/zh-CN/square/search?s=${encodeURIComponent(query)}`;
}

export function isBinancePostSearch(url: string, body: string | null, query: string): boolean {
  if (!isBinanceSearchResponse(url) || !body) return false;
  try {
    const request = JSON.parse(body);
    // The same endpoint serves creators (2), hashtags (3), and posts (1).
    return request?.type === 1 && request.searchContent === query;
  } catch {
    return false;
  }
}
