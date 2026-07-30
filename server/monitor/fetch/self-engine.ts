// L1: self-hosted scrape — plain fetch + readability + turndown. Free. Wins on most 中文 stations.
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import type { FetchEngine, FetchResult } from "./types";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MIN_FULL_CHARS = 200; // extracted text length that counts as a usable full fetch
const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

async function timedFetch(url: string, ms = 25000): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      redirect: "follow",
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export const selfEngine: FetchEngine = {
  name: "self",
  level: 1,
  costPerPage: 0,
  async fetch(url: string): Promise<FetchResult> {
    try {
      const resp = await timedFetch(url);
      if (!resp.ok) {
        return {
          success: false,
          engine: "self",
          costUsd: 0,
          status: "failed",
          error: `HTTP ${resp.status}`,
          httpStatus: resp.status,
          failureReason:
            resp.status === 403 ? "http_403" : resp.status === 429 ? "http_429" : "http_error",
        };
      }
      const html = await resp.text();
      let doc: Document;
      try {
        const linkedom = await import("linkedom");
        doc = linkedom.parseHTML(html).document as unknown as Document;
      } catch {
        const pkg = "jsdom";
        const { JSDOM, VirtualConsole } = await import(/* @vite-ignore */ pkg);
        const vc = new VirtualConsole();
        doc = new JSDOM(html, { url, virtualConsole: vc }).window.document;
      }
      const article = new Readability(doc).parse();
      const text = (article?.textContent || "").replace(/\s+/g, " ").trim();
      if (text.length < MIN_FULL_CHARS) {
        const scriptCount = html.match(/<script\b/gi)?.length || 0;
        const jsShell = scriptCount >= 5 && text.length < 100;
        return {
          success: false,
          engine: "self",
          costUsd: 0,
          status: "failed",
          error: jsShell ? "js shell" : "content too short",
          contentChars: text.length,
          failureReason: jsShell ? "js_shell" : "short_content",
        };
      }
      const md = article?.content ? turndown.turndown(article.content).trim() : text;
      return {
        success: md.length > 0,
        contentMd: md,
        title: article?.title ?? null,
        engine: "self",
        costUsd: 0,
        status: "full",
        contentChars: md.length,
      };
    } catch (e: any) {
      const error = String(e?.message || e).slice(0, 120);
      return {
        success: false,
        engine: "self",
        costUsd: 0,
        status: "failed",
        error,
        failureReason: /abort|timeout|timed out/i.test(error) ? "timeout" : "engine_error",
      };
    }
  },
};
