import { acquire, connect, endpointURLString, launch } from "@cloudflare/playwright";
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  CHINESE_SOCIAL_PLATFORMS,
  type ChineseSocialPlatform,
} from "../server/monitor/sources/chinese-social-source";
import type { DiscoveredPost } from "../server/monitor/sources/types";
import {
  chineseSocialSearchUrl,
  decryptSocialState,
  encryptSocialState,
  extractBilibiliPageState,
  extractWeChatUrlFromSogouHtml,
  isSogouWeChatSearchPage,
  isXiaohongshuIpRiskUrl,
  allocateWeChatQueryQuotas,
  mapBrowserScrapeResults,
  mapNativeSearchPayload,
  planWeChatQueries,
  toWeChatBrowserPost,
  xiaohongshuStorageState,
  type BrowserScrapeElement,
  type SogouWeChatSearchItem,
} from "./chinese-social-browser-helpers";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MAX_KEYWORD_CHARS = 120;
const MAX_RESULTS = 5;
const MAX_WECHAT_QUERIES = 3;
const MAX_WECHAT_RESULTS = 20;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const AUTH_PLATFORMS = ["xiaohongshu", "weibo"] as const;
const AUTH_STATE_PREFIX = "social-auth";
const SMS_INPUT_SELECTOR =
  'input[placeholder*="验证码"]:visible,input[placeholder*="短信"]:visible,input[placeholder*="verification" i]:visible,input[autocomplete="one-time-code"]:visible';

type PlatformKey = ChineseSocialPlatform["key"];
type AuthPlatform = typeof AUTH_PLATFORMS[number];

const AUTH_CONFIG: Record<AuthPlatform, { url: string; cookie: string; qr: string }> = {
  xiaohongshu: { url: "https://www.xiaohongshu.com/explore", cookie: "web_session", qr: "img.qrcode-img" },
  weibo: {
    url: "https://passport.weibo.com/sso/signin?entry=miniblog&source=miniblog&disp=popup&url=https%3A%2F%2Fweibo.com",
    cookie: "SUB",
    qr: "img[src*='v2.qr.weibo.cn']",
  },
};
type ChineseSocialEnv = ChineseSocialBrowserWorkerEnv & { SOCIAL_STATE_ENCRYPTION_KEY: string };

export type ChineseSocialBrowserRequest = {
  platform: PlatformKey;
  keyword: string;
  maxResults?: number;
};

export type ChineseSocialBrowserBatchResult = {
  ok: boolean;
  status: "success" | "empty" | "failed";
  provider: "browser";
  platform: PlatformKey | "unknown";
  results: Array<{ keyword: string; posts: DiscoveredPost[]; error?: string }>;
  requestedKeywords: number;
  executedKeywords: number;
  truncatedKeywords: string[];
  browserMs: number;
  durationMs: number;
  error?: string;
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

export type WeChatBrowserSearchResult = {
  ok: boolean;
  status: "success" | "empty" | "failed";
  provider: "sogou_browser";
  posts: DiscoveredPost[];
  browserMs: number;
  durationMs: number;
  queriesAttempted: number;
  queriesSucceeded: number;
  requested: string[];
  executed: string[];
  truncated: string[];
  errors: string[];
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

function authPlatform(value: unknown): AuthPlatform | null {
  const platform = String(value || "") as AuthPlatform;
  return AUTH_PLATFORMS.includes(platform) ? platform : null;
}

function screenshotDataUrl(bytes: Uint8Array, mime = "image/jpeg"): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

export default class ChineseSocialBrowserWorker extends WorkerEntrypoint<ChineseSocialEnv> {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/auth/status") {
      return Response.json(await this.authStatus());
    }
    if (request.method === "POST" && ["/auth/start", "/auth/poll", "/auth/verify", "/auth/import"].includes(path)) {
      try {
        const input = await request.json<{ platform?: string; sessionId?: string; code?: string; cookie?: string }>();
        const platform = authPlatform(input.platform);
        if (!platform) return Response.json({ error: "unsupported auth platform" }, { status: 400 });
        if (path === "/auth/start") return Response.json(await this.startAuth(platform));
        if (path === "/auth/import") {
          if (platform !== "xiaohongshu") return Response.json({ error: "unsupported import platform" }, { status: 400 });
          const state = xiaohongshuStorageState(String(input.cookie || ""));
          await this.env.SOCIAL_STATE.put(
            this.stateKey(platform),
            await encryptSocialState(JSON.stringify(state), this.env.SOCIAL_STATE_ENCRYPTION_KEY),
            { customMetadata: { verified: "true" } },
          );
          return Response.json({ platform, saved: true, savedAt: Date.now() });
        }
        if (!input.sessionId) return Response.json({ error: "sessionId is required" }, { status: 400 });
        if (path === "/auth/verify") {
          if (platform !== "xiaohongshu" || !/^\d{4,8}$/.test(String(input.code || ""))) {
            return Response.json({ error: "请输入有效的短信验证码" }, { status: 400 });
          }
          return Response.json(await this.verifySms(platform, input.sessionId, String(input.code)));
        }
        return Response.json(await this.pollAuth(platform, input.sessionId));
      } catch (error) {
        console.error(JSON.stringify({ event: "chinese_social_auth.error", error: errorText(error) }));
        return Response.json({ error: errorText(error) }, { status: 502 });
      }
    }
    if (request.method === "POST" && path === "/wechat/search") {
      try {
        return Response.json(await this.searchWeChat(await request.json<{
          queries?: string[];
          maxResults?: number;
        }>()));
      } catch (error) {
        return Response.json({ error: errorText(error) }, { status: 502 });
      }
    }
    if (request.method !== "POST" || !["/search", "/search-batch"].includes(path)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const startedAt = Date.now();
    let platformKey: PlatformKey | "unknown" = "unknown";
    try {
      const input = await request.json<ChineseSocialBrowserRequest & { keywords?: string[] }>();
      const platform = platformByKey(String(input?.platform || ""));
      if (!platform) {
        return Response.json({ error: "unsupported platform" }, { status: 400 });
      }
      platformKey = platform.key;
      const requestedKeywords = Array.from(new Set(
        (path === "/search-batch" ? input.keywords || [] : [input.keyword])
          .map(value => String(value || "").replace(/\s+/g, " ").trim())
          .filter(Boolean),
      ));
      const keywords = requestedKeywords.slice(0, 5);
      if (keywords.length === 0 || keywords.some(keyword => keyword.length > MAX_KEYWORD_CHARS)) {
        return Response.json({ error: "invalid keyword" }, { status: 400 });
      }
      const maxResults = boundedInt(input?.maxResults, 3);
      const batch = await this.searchPlatform(platform, keywords, maxResults);
      if (path === "/search-batch") return Response.json({
        ...batch,
        requestedKeywords: requestedKeywords.length,
        executedKeywords: keywords.length,
        truncatedKeywords: requestedKeywords.slice(5),
      });
      const first = batch.results[0];
      const result: ChineseSocialBrowserResult = {
        ok: (first?.posts.length || 0) > 0,
        status: first?.error ? "failed" : first?.posts.length ? "success" : "empty",
        provider: "browser",
        platform: platform.key,
        searchUrl: chineseSocialSearchUrl(platform.key, keywords[0]),
        posts: first?.posts || [],
        browserMs: batch.browserMs,
        durationMs: batch.durationMs,
        error: first?.error,
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

  private stateKey(platform: AuthPlatform): string {
    return `${AUTH_STATE_PREFIX}/${platform}.enc`;
  }

  private async storedState(platform: PlatformKey) {
    if (!authPlatform(platform)) return undefined;
    const object = await this.env.SOCIAL_STATE.get(this.stateKey(platform as AuthPlatform));
    if (!object) return undefined;
    if (platform === "xiaohongshu" && object.customMetadata?.verified !== "true") return undefined;
    try {
      return JSON.parse(await decryptSocialState(
        await object.arrayBuffer(),
        this.env.SOCIAL_STATE_ENCRYPTION_KEY,
      ));
    } catch (error) {
      console.warn(JSON.stringify({ event: "chinese_social_auth.invalid_state", platform, error: errorText(error) }));
      return undefined;
    }
  }

  private async authStatus() {
    return {
      platforms: Object.fromEntries(await Promise.all(AUTH_PLATFORMS.map(async platform => {
        const object = await this.env.SOCIAL_STATE.head(this.stateKey(platform));
        const saved = platform === "xiaohongshu"
          ? object?.customMetadata?.verified === "true"
          : Boolean(object);
        return [platform, { saved, savedAt: saved ? object?.uploaded.getTime() || null : null }];
      }))),
    };
  }

  private async startAuth(platform: AuthPlatform) {
    const { sessionId } = await acquire(this.env.BROWSER, { keep_alive: 600_000 });
    const endpoint = new URL(endpointURLString(this.env.BROWSER, { sessionId }));
    endpoint.searchParams.set("persistent", "true");
    const browser = await connect(endpoint);
    try {
      const storedState = await this.storedState(platform);
      const context = browser.contexts()[0] || await browser.newContext();
      if (storedState?.cookies?.length) await context.addCookies(storedState.cookies);
      const page = context.pages()[0] || await context.newPage();
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(AUTH_CONFIG[platform].url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      if (platform === "xiaohongshu") {
        await page.waitForFunction(
          () => Boolean(document.querySelector("img.qrcode-img")) || new URL(location.href).searchParams.get("error_code") === "300012",
          undefined,
          { timeout: 15_000 },
        );
        if (isXiaohongshuIpRiskUrl(page.url())) throw new Error("XHS_IP_RISK_300012");
      }
      const qr = page.locator(AUTH_CONFIG[platform].qr).first();
      await qr.waitFor({ state: "visible", timeout: 15_000 });
      return {
        platform,
        sessionId,
        screenshot: screenshotDataUrl(await qr.screenshot({ type: "png" }), "image/png"),
        expiresInSeconds: 600,
      };
    } finally {
      await browser.close();
    }
  }

  private async pollAuth(platform: AuthPlatform, sessionId: string) {
    const endpoint = new URL(endpointURLString(this.env.BROWSER, { sessionId }));
    endpoint.searchParams.set("persistent", "true");
    const browser = await connect(endpoint);
    const contexts = browser.contexts();
    const page = contexts
      .flatMap(context => context.pages())
      .find(candidate => candidate.url().includes(platform === "weibo" ? "weibo.com" : "xiaohongshu.com"));
    let context = page?.context();
    let cookies = context ? await context.cookies() : [];
    if (!context) {
      for (const candidate of contexts) {
        const candidateCookies = await candidate.cookies();
        if (candidateCookies.some(cookie => cookie.name === AUTH_CONFIG[platform].cookie && Boolean(cookie.value))) {
          context = candidate;
          cookies = candidateCookies;
          break;
        }
      }
    }
    if (!context) {
      await browser.close();
      throw new Error("login session expired; start again");
    }
    console.log(JSON.stringify({
      event: "chinese_social_auth.poll",
      platform,
      url: page?.url() || "(closed)",
      cookieNames: cookies.map(cookie => cookie.name),
    }));
    const smsInput = page?.locator(SMS_INPUT_SELECTOR).first();
    const smsRequired = platform === "xiaohongshu" && Boolean(smsInput) && await smsInput!.isVisible().catch(() => false);
    if (smsRequired) {
      const screenshot = screenshotDataUrl(await page!.screenshot({ type: "jpeg", quality: 75 }));
      await browser.close();
      return { platform, saved: false, challenge: "sms", screenshot };
    }
    const qrVisible = page
      ? await page.locator(AUTH_CONFIG[platform].qr).first().isVisible().catch(() => false)
      : false;
    const authenticated = cookies.some(cookie =>
      cookie.name === AUTH_CONFIG[platform].cookie && Boolean(cookie.value),
    ) && !qrVisible;
    if (authenticated) {
      const state = await context.storageState({ indexedDB: true });
      await this.env.SOCIAL_STATE.put(
        this.stateKey(platform),
        await encryptSocialState(JSON.stringify(state), this.env.SOCIAL_STATE_ENCRYPTION_KEY),
        { customMetadata: { verified: "true" } },
      );
      await browser.close();
      return { platform, saved: true, savedAt: Date.now() };
    }
    if (!page) {
      await browser.close();
      throw new Error("login session expired; start again");
    }
    const screenshot = screenshotDataUrl(
      await page.locator(AUTH_CONFIG[platform].qr).first().screenshot({ type: "png" }),
      "image/png",
    );
    await browser.close();
    return {
      platform,
      saved: false,
      screenshot,
    };
  }

  private async verifySms(platform: AuthPlatform, sessionId: string, code: string) {
    const endpoint = new URL(endpointURLString(this.env.BROWSER, { sessionId }));
    endpoint.searchParams.set("persistent", "true");
    const browser = await connect(endpoint);
    const page = browser.contexts().flatMap(context => context.pages())
      .find(candidate => candidate.url().includes("xiaohongshu.com"));
    if (!page) throw new Error("login session expired; start again");
    const input = page.locator(SMS_INPUT_SELECTOR).first();
    if (!await input.isVisible().catch(() => false)) throw new Error("未检测到短信验证码输入框，请重新扫码");
    let riskBlocked = false;
    const captureRisk = (response: { status(): number }) => { if (response.status() === 471) riskBlocked = true; };
    page.on("response", captureRisk);
    await input.fill(code);
    const submit = page.locator('button:visible,[role="button"]:visible')
      .filter({ hasText: /^\s*(Verify|确认|提交|验证)\s*$/i }).first();
    if (!await submit.isVisible().catch(() => false)) throw new Error("未检测到短信验证按钮，请重新扫码");
    await submit.click({ timeout: 10_000 });
    await input.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => undefined);
    page.off("response", captureRisk);
    if (await input.isVisible().catch(() => false)) {
      const screenshot = screenshotDataUrl(await page.screenshot({ type: "jpeg", quality: 75 }));
      await browser.close();
      return {
        platform,
        saved: false,
        challenge: "sms",
        screenshot,
        error: riskBlocked
          ? "小红书风控拦截了本次云端验证（HTTP 471），并非验证码填写错误；请重新扫码后再试"
          : "小红书未接受本次验证码，请使用最新收到的验证码重试",
      };
    }
    await browser.close();
    return this.pollAuth(platform, sessionId);
  }

  private async searchPlatform(
    platform: ChineseSocialPlatform,
    keywords: string[],
    maxResults: number,
  ): Promise<ChineseSocialBrowserBatchResult> {
    const startedAt = Date.now();
    const results: ChineseSocialBrowserBatchResult["results"] = [];
    const browser = await launch(this.env.BROWSER, { keep_alive: 60_000 });
    try {
      const context = await browser.newContext({
        locale: "zh-CN",
        userAgent: USER_AGENT,
        viewport: { width: 1440, height: 1000 },
        storageState: await this.storedState(platform.key),
      });
      try {
        const page = await context.newPage();
        await page.setExtraHTTPHeaders({ "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" });
        for (const keyword of keywords) {
          const searchUrl = chineseSocialSearchUrl(platform.key, keyword);
          const payloads: unknown[] = [];
          const pending: Promise<void>[] = [];
          const capture = (response: { url(): string; headers(): Record<string, string>; json(): Promise<unknown> }) => {
            if (
              !response.url().toLowerCase().includes("search") ||
              !String(response.headers()["content-type"] || "").includes("json")
            ) return;
            pending.push(response.json().then(value => { payloads.push(value); }).catch(() => undefined));
          };
          page.on("response", capture);
          try {
            await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
            await page.waitForTimeout(1_500);
            await Promise.allSettled(pending);
            if (platform.key === "bilibili") payloads.push(extractBilibiliPageState(await page.content()));
            const nativePosts = payloads.flatMap(payload =>
              mapNativeSearchPayload(platform, keyword, payload, maxResults),
            );
            const elements = await page.locator("a[href]").evaluateAll((anchors) => anchors.slice(0, 300).map(anchor => {
              const scope = anchor.closest(
                "article, li, [class*='SearchResult'], [class*='video-item'], [class*='bili-video-card'], [class*='s_post'], [class*='result'], [class*='card']",
              ) || anchor.parentElement || anchor;
              const time = scope.querySelector("time,[datetime],[data-time],[data-timestamp]");
              return {
                anchorText: (anchor.getAttribute("title") || anchor.textContent || "").replace(/\s+/g, " ").trim(),
                text: (scope.textContent || anchor.textContent || "").replace(/\s+/g, " ").trim(),
                html: scope.outerHTML.slice(0, 12_000),
                attributes: [
                  { name: "href", value: anchor.getAttribute("href") || "" },
                  ...(time?.getAttribute("datetime") ? [{ name: "datetime", value: time.getAttribute("datetime")! }] : []),
                  ...(time?.getAttribute("data-time") ? [{ name: "data-time", value: time.getAttribute("data-time")! }] : []),
                  ...(time?.getAttribute("data-timestamp") ? [{ name: "data-timestamp", value: time.getAttribute("data-timestamp")! }] : []),
                ],
              };
            })) as BrowserScrapeElement[];
            const byUrl = new Map<string, DiscoveredPost>();
            for (const post of [
              ...nativePosts,
              ...mapBrowserScrapeResults(platform, searchUrl, keyword, elements, maxResults),
            ]) {
              const current = byUrl.get(post.url);
              if (!current || (post.publishedAt != null && current.publishedAt == null)) byUrl.set(post.url, post);
            }
            results.push({ keyword, posts: Array.from(byUrl.values()).slice(0, maxResults) });
          } catch (error) {
            results.push({ keyword, posts: [], error: errorText(error) });
          } finally {
            page.off("response", capture);
          }
        }
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
    const successful = results.filter(result => result.posts.length > 0).length;
    const result: ChineseSocialBrowserBatchResult = {
      ok: successful > 0,
      status: successful > 0 ? "success" : results.some(item => item.error) ? "failed" : "empty",
      provider: "browser",
      platform: platform.key,
      results,
      requestedKeywords: keywords.length,
      executedKeywords: keywords.length,
      truncatedKeywords: [],
      browserMs: Date.now() - startedAt,
      durationMs: Date.now() - startedAt,
    };
    console.log(JSON.stringify({ event: "chinese_social_browser.batch", ...result }));
    return result;
  }

  private async searchWeChat(input: {
    queries?: string[];
    maxResults?: number;
  }): Promise<WeChatBrowserSearchResult> {
    const startedAt = Date.now();
    const queryPlan = planWeChatQueries(input.queries || []);
    const queries = queryPlan.executed.slice(0, MAX_WECHAT_QUERIES);
    const maxResults = Math.max(1, Math.min(MAX_WECHAT_RESULTS, Math.trunc(input.maxResults || 10)));
    const quotas = allocateWeChatQueryQuotas(maxResults, queries.length);
    const errors: string[] = [];
    const queryPosts = queries.map(() => new Map<string, DiscoveredPost>());
    let queriesSucceeded = 0;
    const browser = await launch(this.env.BROWSER, { keep_alive: 60_000 });
    try {
      const context = await browser.newContext({
        locale: "zh-CN",
        userAgent: USER_AGENT,
        viewport: { width: 1365, height: 900 },
      });
      try {
        const searchPage = await context.newPage();
        const resolverPage = await context.newPage();
        await searchPage.setExtraHTTPHeaders({ "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" });
        await resolverPage.setExtraHTTPHeaders({ "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" });
        for (const [queryIndex, query] of queries.entries()) {
          const posts = queryPosts[queryIndex];
          const queryQuota = quotas[queryIndex];
          try {
            const searchUrl = `https://weixin.sogou.com/weixin?type=2&s_from=input&ie=utf8&tsn=1&query=${encodeURIComponent(query)}`;
            await searchPage.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
            if (searchPage.url().includes("antispider")) throw new Error("Sogou anti-spider verification");
            if (!isSogouWeChatSearchPage(searchPage.url())) throw new Error("Sogou redirected search to homepage");
            const items = await searchPage.locator("ul.news-list > li").evaluateAll((nodes) => nodes.map((node) => {
              const title = node.querySelector("h3 > a");
              const timeText = node.querySelector("span.s2")?.textContent || "";
              const timestamp = timeText.match(/timeConvert\('(\d+)'\)/)?.[1];
              return {
                title: title?.textContent?.replace(/\s+/g, " ").trim() || "",
                snippet: node.querySelector("p.txt-info")?.textContent?.replace(/\s+/g, " ").trim() || "",
                author: node.querySelector("span.all-time-y2")?.textContent?.replace(/\s+/g, " ").trim() || null,
                publishedAt: timestamp ? Number(timestamp) * 1000 : null,
                redirectUrl: title?.getAttribute("href") || "",
              };
            })) as SogouWeChatSearchItem[];
            queriesSucceeded++;
            for (const item of items) {
              if (
                posts.size >= queryQuota ||
                !item.redirectUrl ||
                !item.publishedAt ||
                item.publishedAt < Date.now() - WEEK_MS ||
                item.publishedAt > Date.now() + 5 * 60_000
              ) continue;
              const redirectUrl = new URL(item.redirectUrl, "https://weixin.sogou.com").toString();
              try {
                await resolverPage.goto(redirectUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
                const directUrl = resolverPage.url().startsWith("https://mp.weixin.qq.com/s")
                  ? resolverPage.url()
                  : extractWeChatUrlFromSogouHtml(await resolverPage.content());
                const post = directUrl ? toWeChatBrowserPost(item, directUrl) : null;
                if (post) posts.set(post.url, post);
              } catch (error) {
                errors.push(`${query}: ${errorText(error)}`);
              }
              await resolverPage.waitForTimeout(300);
            }
            await searchPage.waitForTimeout(1_000);
          } catch (error) {
            errors.push(`${query}: ${errorText(error)}`);
          }
        }
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
    const posts = new Map<string, DiscoveredPost>();
    for (const result of queryPosts) {
      for (const post of result.values()) {
        if (posts.size < maxResults) posts.set(post.url, post);
      }
    }
    const result: WeChatBrowserSearchResult = {
      ok: queriesSucceeded > 0,
      status: queriesSucceeded === 0 ? "failed" : posts.size > 0 ? "success" : "empty",
      provider: "sogou_browser",
      posts: Array.from(posts.values()),
      browserMs: Date.now() - startedAt,
      durationMs: Date.now() - startedAt,
      queriesAttempted: queries.length,
      queriesSucceeded,
      requested: queryPlan.requested,
      executed: queryPlan.executed,
      truncated: queryPlan.truncated,
      errors: errors.slice(0, 8),
    };
    console.log(JSON.stringify({ event: "wechat_browser.search", ...result }));
    return result;
  }
}
