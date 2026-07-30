import { launch, type Response as PlaywrightResponse } from "@cloudflare/playwright";
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  isBinanceSquarePayload,
  parseBinanceSquareResponse,
  type BinanceBrowserQueryDiagnostic,
  type BinanceBrowserSearchRequest,
  type BinanceBrowserSearchResult,
} from "./binance-square-browser";

const MAX_QUERIES = 4;
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 20;
const NAVIGATION_TIMEOUT_MS = 22_000;
const NETWORK_SETTLE_MS = 6_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function cleanQueries(values: string[]): string[] {
  return Array.from(new Set(
    values
      .map((value) => value.trim())
      .filter(Boolean),
  )).slice(0, MAX_QUERIES);
}

function pageSize(value: number | undefined): number {
  if (!Number.isInteger(value) || !value) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, value));
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

export default class BinanceBrowserWorker extends WorkerEntrypoint<BinanceWorkerEnv> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/search") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    try {
      const input = await request.json<BinanceBrowserSearchRequest>();
      return Response.json(await this.search(input));
    } catch (error) {
      console.error(JSON.stringify({
        event: "binance_browser.error",
        error: errorText(error),
      }));
      return Response.json({ error: errorText(error) }, { status: 502 });
    }
  }

  async search(input: BinanceBrowserSearchRequest): Promise<BinanceBrowserSearchResult> {
    const startedAt = Date.now();
    const queries = cleanQueries(Array.isArray(input?.queries) ? input.queries : []);
    if (queries.length === 0) throw new Error("at least one Binance search query is required");

    const diagnostics: BinanceBrowserQueryDiagnostic[] = [];
    const postsByUrl = new Map<string, ReturnType<typeof parseBinanceSquareResponse>[number]>();
    const browser = await launch(this.env.BROWSER, { keep_alive: 60_000 });
    let sessionId = "";

    try {
      sessionId = browser.sessionId();
      const context = await browser.newContext({
        locale: "zh-CN",
        userAgent: USER_AGENT,
        viewport: { width: 1365, height: 900 },
      });
      try {
        const page = await context.newPage();
        await page.setExtraHTTPHeaders({
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        });

        for (const query of queries) {
          const apiResponses: PlaywrightResponse[] = [];
          const captureResponse = (response: PlaywrightResponse) => {
            try {
              const url = new URL(response.url());
              if (url.hostname.endsWith("binance.com") && url.pathname.startsWith("/bapi/")) {
                apiResponses.push(response);
              }
            } catch {
              // Ignore malformed third-party response URLs.
            }
          };
          page.on("response", captureResponse);
          let navigationError = "";
          try {
            await page.goto(
              `https://www.binance.com/zh-CN/square/search?q=${encodeURIComponent(query)}`,
              { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS },
            );
          } catch (error) {
            navigationError = errorText(error);
          }

          try {
            await page.waitForTimeout(NETWORK_SETTLE_MS);
            let matchedResponse: PlaywrightResponse | null = null;
            let payload: unknown = null;
            for (const response of apiResponses.slice(-40)) {
              if (!response.ok()) continue;
              try {
                const candidate = await response.json();
                if (isBinanceSquarePayload(candidate)) {
                  matchedResponse = response;
                  payload = candidate;
                  break;
                }
              } catch {
                // Many BAPI responses are not JSON or are unrelated to Square search.
              }
            }
            const pageTitle = (await page.title()).slice(0, 160);
            const pageUrl = page.url().slice(0, 300);
            const bodyPreview = (await page.locator("body").innerText({ timeout: 3_000 }))
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 240);
            const apiUrls = Array.from(new Set(apiResponses.map((response) => response.url())))
              .slice(-8)
              .map((url) => url.slice(0, 300));
            if (!matchedResponse) {
              diagnostics.push({
                query,
                status: "failed",
                posts: 0,
                error: navigationError || "no Binance Square search payload observed",
                pageUrl,
                pageTitle,
                bodyPreview,
                apiUrls,
              });
              continue;
            }
            const parsed = parseBinanceSquareResponse(payload);
            for (const post of parsed) postsByUrl.set(post.url, post);
            diagnostics.push({
              query,
              status: parsed.length > 0 ? "success" : "empty",
              httpStatus: matchedResponse.status(),
              posts: parsed.length,
              pageUrl,
              pageTitle,
              apiUrls,
              ...(navigationError ? { error: `navigation: ${navigationError}` } : {}),
            });
          } catch (error) {
            diagnostics.push({
              query,
              status: "failed",
              posts: 0,
              error: navigationError || errorText(error),
            });
          } finally {
            page.off("response", captureResponse);
          }
        }
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }

    const queriesSucceeded = diagnostics.filter(
      (item) => item.status === "success" || item.status === "empty",
    ).length;
    const result: BinanceBrowserSearchResult = {
      ok: queriesSucceeded > 0,
      posts: Array.from(postsByUrl.values()),
      durationMs: Date.now() - startedAt,
      sessionId,
      queriesAttempted: queries.length,
      queriesSucceeded,
      diagnostics,
    };
    console.log(JSON.stringify({
      event: "binance_browser.search",
      ok: result.ok,
      posts: result.posts.length,
      durationMs: result.durationMs,
      sessionId: result.sessionId,
      diagnostics: result.diagnostics,
    }));
    return result;
  }
}
