import { WorkerEntrypoint } from "cloudflare:workers";
import { validatePublicHttpUrl } from "./fulltext-browser-guard";

const MAX_CONTENT_CHARS = 25_000;
const DEFAULT_CONTENT_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 22_000;
const MAX_TIMEOUT_MS = 30_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export type FulltextBrowserRequest = {
  url: string;
  maxChars?: number;
  timeoutMs?: number;
};

export type FulltextBrowserResult = {
  ok: boolean;
  status: "success" | "short" | "failed";
  url: string;
  contentMd?: string;
  contentChars: number;
  browserMs: number;
  durationMs: number;
  httpStatus?: number;
  error?: string;
};

function boundedInt(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value!)));
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

export default class FulltextBrowserWorker extends WorkerEntrypoint<FulltextBrowserWorkerEnv> {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/extract") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const startedAt = Date.now();
    let sourceUrl = "";
    try {
      const input = await request.json<FulltextBrowserRequest>();
      const url = validatePublicHttpUrl(String(input?.url || ""));
      sourceUrl = url.toString();
      const maxChars = boundedInt(input?.maxChars, DEFAULT_CONTENT_CHARS, 500, MAX_CONTENT_CHARS);
      const timeoutMs = boundedInt(input?.timeoutMs, DEFAULT_TIMEOUT_MS, 5_000, MAX_TIMEOUT_MS);
      const response = await this.env.BROWSER.quickAction("markdown", {
        url: sourceUrl,
        gotoOptions: {
          timeout: timeoutMs,
          waitUntil: "domcontentloaded",
        },
        waitForTimeout: 1_200,
        actionTimeout: timeoutMs,
        cacheTTL: 0,
        bestAttempt: true,
        userAgent: USER_AGENT,
        setExtraHTTPHeaders: {
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
        rejectResourceTypes: ["image", "media", "font"],
      });
      const browserMs = Math.max(0, Number(response.headers.get("X-Browser-Ms-Used")) || 0);
      const httpStatus = response.status;
      const payload = await response.json<{
        success?: boolean;
        result?: string;
        errors?: Array<{ message?: string; detail?: string }>;
      }>();
      if (!response.ok || payload.success !== true || typeof payload.result !== "string") {
        const message = payload.errors?.map((item) => item.message || item.detail).filter(Boolean).join("; ");
        const result: FulltextBrowserResult = {
          ok: false,
          status: "failed",
          url: sourceUrl,
          contentChars: 0,
          browserMs,
          durationMs: Date.now() - startedAt,
          httpStatus,
          error: (message || `Browser Run HTTP ${httpStatus}`).slice(0, 300),
        };
        console.warn(JSON.stringify({ event: "fulltext_browser.result", ...result }));
        return Response.json(result, { status: 200 });
      }
      const contentMd = payload.result.trim().slice(0, maxChars);
      const status = contentMd.length >= 500 ? "success" : "short";
      const result: FulltextBrowserResult = {
        ok: status === "success",
        status,
        url: sourceUrl,
        contentMd,
        contentChars: contentMd.length,
        browserMs,
        durationMs: Date.now() - startedAt,
        httpStatus,
      };
      console.log(JSON.stringify({
        event: "fulltext_browser.result",
        ...result,
        contentMd: undefined,
      }));
      return Response.json(result);
    } catch (error) {
      const result: FulltextBrowserResult = {
        ok: false,
        status: "failed",
        url: sourceUrl,
        contentChars: 0,
        browserMs: 0,
        durationMs: Date.now() - startedAt,
        error: errorText(error),
      };
      console.error(JSON.stringify({ event: "fulltext_browser.error", ...result }));
      return Response.json(result, { status: 400 });
    }
  }
}
