import { getCloudflareEnv } from "../../_core/cloudflare-env";
import { domainOf, normalizeUrl, sha256 } from "../util";
import type {
  FetchAttempt,
  FetchFailureReason,
  FetchResult,
} from "./types";

export function classifyFetchFailure(result: FetchResult): FetchFailureReason {
  if (result.failureReason) return result.failureReason;
  if (result.httpStatus === 403) return "http_403";
  if (result.httpStatus === 429) return "http_429";
  if (result.httpStatus != null && result.httpStatus >= 400) return "http_error";
  const error = result.error || "";
  if (/403/.test(error)) return "http_403";
  if (/429/.test(error)) return "http_429";
  if (/abort|timeout|timed out/i.test(error)) return "timeout";
  if (/javascript|js shell|enable js/i.test(error)) return "js_shell";
  if (/too short/i.test(error)) return "short_content";
  if (/budget|quota|limit exhausted/i.test(error)) return "budget_exhausted";
  if (/no .*key|missing .*key/i.test(error)) return "missing_key";
  if (/empty/i.test(error)) return "empty_content";
  return "engine_error";
}

export function attemptFromResult(result: FetchResult, durationMs: number): FetchAttempt {
  return {
    engine: result.engine,
    outcome: result.success ? "success" : "failed",
    reason: result.success ? "success" : classifyFetchFailure(result),
    durationMs,
    contentChars: result.contentChars ?? result.contentMd?.length ?? 0,
    costUsd: result.costUsd || 0,
    ...(result.httpStatus == null ? {} : { httpStatus: result.httpStatus }),
  };
}

export function recordFetchAttempt(
  url: string,
  attempt: FetchAttempt,
  sourcePlatform = "unknown",
): void {
  const env = getCloudflareEnv();
  if (env.CLOUDFLARE_FETCH_OBSERVABILITY_ENABLED !== "true") return;
  const domain = domainOf(url) || "unknown";
  const event = {
    event: "fetch_attempt",
    domain,
    sourcePlatform,
    urlHash: sha256(normalizeUrl(url)),
    ...attempt,
  };
  console.log(JSON.stringify(event));
  env.FETCH_ANALYTICS?.writeDataPoint({
    // blob mapping is documented in docs/cloudflare-fetch-observability.md.
    blobs: [
      attempt.engine,
      attempt.outcome,
      attempt.reason,
      sourcePlatform,
      domain,
      event.urlHash,
    ],
    doubles: [
      1,
      attempt.durationMs,
      attempt.contentChars,
      attempt.costUsd,
      attempt.httpStatus || 0,
    ],
    indexes: [domain],
  });
}
