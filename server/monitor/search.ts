// Serper.dev search wrapper. Uses the 'news' vertical (dated, higher news purity than web).
// API key is read from globalApiKeys (name = 'Serper'); never hard-coded / env.
import * as db from "../db";
import { fetchWithTimeout } from "./util";

const SERPER_DEFAULT_BASE = "https://google.serper.dev";

export type SerperNewsItem = {
  url: string;
  title: string;
  snippet: string;
  date: string | null; // raw Serper date string, e.g. "3 hours ago" / "Mar 6, 2026"
  source: string | null;
};

export type SerperWebItem = SerperNewsItem;

async function getSerper(): Promise<{ apiKey: string; base: string }> {
  const key = await db.getGlobalApiKeyByName("Serper");
  if (!key?.apiKey) {
    throw new Error("Serper API key 未配置：请在「全局 API 配置」新增名称为 'Serper' 的条目");
  }
  return { apiKey: key.apiKey, base: (key.baseUrl || SERPER_DEFAULT_BASE).replace(/\/$/, "") };
}

// Search the news vertical for a keyword. tbs e.g. 'qdr:d' (past day) drives freshness.
export async function searchNews(
  keyword: string,
  opts?: { tbs?: string; num?: number; gl?: string; hl?: string }
): Promise<SerperNewsItem[]> {
  const { apiKey, base } = await getSerper();
  const body: Record<string, unknown> = { q: keyword, num: opts?.num ?? 10 };
  if (opts?.tbs) body.tbs = opts.tbs;
  if (opts?.gl) body.gl = opts.gl; // country: 'cn' for 中文舆情, 'us' for 英文
  if (opts?.hl) body.hl = opts.hl; // ui language: 'zh-cn' / 'en'
  const resp = await fetchWithTimeout(`${base}/news`, {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, 20000);
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Serper news ${resp.status}: ${t.slice(0, 200)}`);
  }
  const json: any = await resp.json();
  return (json.news || [])
    .filter((n: any) => n?.link)
    .map((n: any) => ({
      url: n.link as string,
      title: (n.title || "") as string,
      snippet: (n.snippet || "") as string,
      date: (n.date || null) as string | null,
      source: (n.source || null) as string | null,
    }));
}

// General web search is used for site-scoped sources whose pages are indexed by
// Google but whose origin blocks Cloudflare egress (for example Binance Square).
export async function searchWeb(
  keyword: string,
  opts?: { tbs?: string; num?: number; gl?: string; hl?: string },
): Promise<SerperWebItem[]> {
  const { apiKey, base } = await getSerper();
  const body: Record<string, unknown> = { q: keyword, num: opts?.num ?? 10 };
  if (opts?.tbs) body.tbs = opts.tbs;
  if (opts?.gl) body.gl = opts.gl;
  if (opts?.hl) body.hl = opts.hl;
  const resp = await fetchWithTimeout(`${base}/search`, {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, 20_000);
  if (!resp.ok) {
    const errorBody = await resp.text();
    throw new Error(`Serper search ${resp.status}: ${errorBody.slice(0, 200)}`);
  }
  const json = await resp.json() as { organic?: Array<Record<string, unknown>> };
  return (json.organic || [])
    .filter((item) => typeof item.link === "string" && item.link.length > 0)
    .map((item) => ({
      url: String(item.link),
      title: typeof item.title === "string" ? item.title : "",
      snippet: typeof item.snippet === "string" ? item.snippet : "",
      date: typeof item.date === "string" ? item.date : null,
      source: typeof item.source === "string" ? item.source : null,
    }));
}
