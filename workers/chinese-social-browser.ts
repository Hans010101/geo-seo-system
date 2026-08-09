import { WorkerEntrypoint } from "cloudflare:workers";
import {
  CHINESE_SOCIAL_PLATFORMS,
  type ChineseSocialPlatform,
} from "../server/monitor/sources/chinese-social-source";
import type { DiscoveredPost } from "../server/monitor/sources/types";
import {
  chineseSocialSearchUrl,
  mapBrowserScrapeResults,
  type BrowserScrapeElement,
} from "./chinese-social-browser-helpers";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MAX_KEYWORD_CHARS = 120;
const MAX_RESULTS = 5;

type PlatformKey = ChineseSocialPlatform["key"];

export type ChineseSocialBrowserRequest = {
  platform: PlatformKey;
  keyword: string;
  maxResults?: number;
};

export type ChineseSocialBrowserResult = {
  ok: boolean;
  status: "success" | "empty" | "failed";
  provider: "browser";
  platform: PlatformKey | "unknown";
  searchUrl?: string;
  posts: DiscoveredPost[];
  browserMs: number;
  durationMs: number;
  httpStatus?: number;
  error?: string;
};

function boundedInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(MAX_RESULTS, Math.trunc(value!)));
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function platformByKey(key: string): ChineseSocialPlatform | undefined {
  return CHINESE_SOCIAL_PLATFORMS.find(platform => platform.key === key);
}

export default class ChineseSocialBrowserWorker extends WorkerEntrypoint<ChineseSocialBrowserWorkerEnv> {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/search") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const startedAt = Date.now();
    let platformKey: PlatformKey | "unknown" = "unknown";
    try {
      const input = await request.json<ChineseSocialBrowserRequest>();
      const platform = platformByKey(String(input?.platform || ""));
      if (!platform) {
        return Response.json({ error: "unsupported platform" }, { status: 400 });
      }
      platformKey = platform.key;
      const keyword = String(input?.keyword || "").replace(/\s+/g, " ").trim();
      if (!keyword || keyword.length > MAX_KEYWORD_CHARS) {
        return Response.json({ error: "invalid keyword" }, { status: 400 });
      }
      const maxResults = boundedInt(input?.maxResults, 3);
      const searchUrl = chineseSocialSearchUrl(platform.key, keyword);
      const response = await this.env.BROWSER.quickAction("scrape", {
        url: searchUrl,
        elements: [{ selector: "a[href]" }],
        gotoOptions: {
          timeout: 30_000,
          waitUntil: "domcontentloaded",
        },
        waitForTimeout: 1_500,
        actionTimeout: 30_000,
        cacheTTL: 0,
        bestAttempt: true,
        userAgent: USER_AGENT,
        viewport: { width: 1440, height: 1000 },
        setExtraHTTPHeaders: {
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
        rejectResourceTypes: ["image", "media", "font"],
      });
      const browserMs = Math.max(0, Number(response.headers.get("X-Browser-Ms-Used")) || 0);
      const payload = await response.json<{
        success?: boolean;
        result?: Array<{
          selector: string;
          results: BrowserScrapeElement[];
        }>;
        errors?: Array<{ message?: string; detail?: string }>;
      }>();
      if (!response.ok || payload.success !== true || !Array.isArray(payload.result)) {
        const error = payload.errors
          ?.map(item => item.message || item.detail)
          .filter(Boolean)
          .join("; ");
        const result: ChineseSocialBrowserResult = {
          ok: false,
          status: "failed",
          provider: "browser",
          platform: platform.key,
          searchUrl,
          posts: [],
          browserMs,
          durationMs: Date.now() - startedAt,
          httpStatus: response.status,
          error: (error || `Browser Run HTTP ${response.status}`).slice(0, 300),
        };
        console.warn(JSON.stringify({ event: "chinese_social_browser.result", ...result }));
        return Response.json(result);
      }
      const posts = mapBrowserScrapeResults(
        platform,
        searchUrl,
        keyword,
        payload.result.flatMap(item => item.results || []),
        maxResults
      );
      const result: ChineseSocialBrowserResult = {
        ok: posts.length > 0,
        status: posts.length > 0 ? "success" : "empty",
        provider: "browser",
        platform: platform.key,
        searchUrl,
        posts,
        browserMs,
        durationMs: Date.now() - startedAt,
        httpStatus: response.status,
      };
      console.log(JSON.stringify({ event: "chinese_social_browser.result", ...result }));
      return Response.json(result);
    } catch (error) {
      const result: ChineseSocialBrowserResult = {
        ok: false,
        status: "failed",
        provider: "browser",
        platform: platformKey,
        posts: [],
        browserMs: 0,
        durationMs: Date.now() - startedAt,
        error: errorText(error),
      };
      console.error(JSON.stringify({ event: "chinese_social_browser.error", ...result }));
      return Response.json(result, { status: 400 });
    }
  }
}
