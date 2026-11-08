// L1: self-hosted scrape — plain fetch + readability + turndown. Free. Wins on most 中文 stations.
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import type { FetchEngine, FetchResult } from "./types";
import { parseHTML } from "linkedom";
import { validatePublicHttpUrl } from "../../../workers/fulltext-browser-guard";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MIN_FULL_CHARS = 200; // extracted text length that counts as a usable full fetch
const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

async function timedFetch(url: string, ms = 25000): Promise<{ status: number; ok: boolean; html: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    let target = validatePublicHttpUrl(url);
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await fetch(target.href, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      redirect: "manual",
      signal: ctl.signal,
      });
      if (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
        await response.body?.cancel();
        target = validatePublicHttpUrl(new URL(response.headers.get("location")!, target).href);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        return { status: response.status, ok: false, html: "" };
      }
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let html = "", size = 0;
      if (reader) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 2_000_000) throw new Error("HTML exceeds 2 MB limit");
            html += decoder.decode(value, { stream: true });
          }
          html += decoder.decode();
        } finally { await reader.cancel(); }
      }
      return { status: response.status, ok: true, html };
    }
    throw new Error("Too many redirects");
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
      const html = resp.html;
      const doc = parseHTML(html).document as unknown as Document;
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
      // Passing a DOM node avoids Turndown's browser-only DOMParser in Workers.
      const md = article?.content
        ? turndown.turndown(parseHTML(`<html><body>${article.content}</body></html>`).document.body as unknown as HTMLElement).trim()
        : text;
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
