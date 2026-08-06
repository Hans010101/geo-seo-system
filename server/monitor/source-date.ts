import { monitorPublishedAtFreshness } from "./util";

const MAX_HTML_BYTES = 256_000;
const REQUEST_TIMEOUT_MS = 12_000;
const GENERIC_DATE_STABILITY_DELAY_MS = 10 * 60_000;
const EARLIEST_REASONABLE_MS = Date.UTC(2000, 0, 1);
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SEARCH_INTERMEDIARY_DOMAINS = new Set([
  "google.com",
  "googleusercontent.com",
  "bing.com",
  "search.yahoo.com",
  "translate.goog",
  "webcache.googleusercontent.com",
]);

export type SourceDateEvidence =
  | "okx_app_state"
  | "article_meta"
  | "json_ld"
  | "time_element"
  | "url_path";

export type SourceDateVerification = {
  status: "verified" | "unverifiable" | "failed";
  publishedAt: number | null;
  evidence?: SourceDateEvidence;
  error?: string;
};

function publicHttpUrl(raw: string): URL {
  const url = new URL(raw);
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("only HTTP(S) source URLs are supported");
  }
  const ipv4 = hostname.split(".").map(Number);
  const privateIpv4 =
    ipv4.length === 4 &&
    ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    (
      ipv4[0] === 0 ||
      ipv4[0] === 10 ||
      ipv4[0] === 127 ||
      ipv4[0] >= 224 ||
      (ipv4[0] === 169 && ipv4[1] === 254) ||
      (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) ||
      (ipv4[0] === 192 && ipv4[1] === 168) ||
      (ipv4[0] === 100 && ipv4[1] >= 64 && ipv4[1] <= 127)
    );
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "::1" ||
    hostname.startsWith("[") ||
    privateIpv4
  ) {
    throw new Error("private or local source URLs are not allowed");
  }
  url.username = "";
  url.password = "";
  return url;
}

function isSearchIntermediary(url: URL): boolean {
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  return (
    SEARCH_INTERMEDIARY_DOMAINS.has(hostname) ||
    hostname.endsWith(".google.com") ||
    hostname.endsWith(".googleusercontent.com")
  );
}

function timestamp(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric)
    ? numeric < 10_000_000_000 ? numeric * 1000 : numeric
    : Date.parse(String(value));
  if (!Number.isFinite(parsed) || parsed < EARLIEST_REASONABLE_MS) return null;
  return parsed;
}

function tagAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of tag.matchAll(pattern)) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

function urlDate(url: URL): number | null {
  const match = url.pathname.match(
    /(?:^|\/)(20\d{2})[\/_-](0?[1-9]|1[0-2])[\/_-](0?[1-9]|[12]\d|3[01])(?:\/|$)/,
  );
  if (!match) return null;
  return timestamp(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

export function extractSourcePublishedAt(
  rawUrl: string,
  html: string,
): { publishedAt: number; evidence: SourceDateEvidence } | null {
  const url = publicHttpUrl(rawUrl);

  // OKX Orbit's generated JSON-LD incorrectly uses the current render time.
  // Its SSR app state contains the actual immutable post timestamp.
  if (/(^|\.)okx\.com$/i.test(url.hostname) && /\/orbit\/(?:insight|post)\//i.test(url.pathname)) {
    const okx = html.match(/"publishTime"\s*:\s*"?(1\d{9,12})"?/i);
    const publishedAt = timestamp(okx?.[1]);
    if (publishedAt != null) return { publishedAt, evidence: "okx_app_state" };
    return null;
  }

  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = tagAttributes(tag);
    const key = (attrs.property || attrs.name || attrs.itemprop || "").toLowerCase();
    if (
      [
        "article:published_time",
        "datepublished",
        "pubdate",
        "publishdate",
        "publication_date",
      ].includes(key)
    ) {
      const publishedAt = timestamp(attrs.content || attrs.datetime);
      if (publishedAt != null) return { publishedAt, evidence: "article_meta" };
    }
  }

  const jsonLd = html.match(/"datePublished"\s*:\s*"([^"]+)"/i);
  const jsonLdAt = timestamp(jsonLd?.[1]);
  if (jsonLdAt != null) return { publishedAt: jsonLdAt, evidence: "json_ld" };

  for (const tag of html.match(/<time\b[^>]*>/gi) || []) {
    const attrs = tagAttributes(tag);
    const marker = [
      attrs.itemprop,
      attrs.class,
      attrs.id,
      Object.prototype.hasOwnProperty.call(attrs, "pubdate") ? "pubdate" : "",
    ].filter(Boolean).join(" ").toLowerCase();
    if (!/(datepublished|pubdate|publish|article[-_ ]?date)/i.test(marker)) continue;
    const at = timestamp(attrs.datetime);
    if (at != null) return { publishedAt: at, evidence: "time_element" };
  }

  const pathAt = urlDate(url);
  return pathAt == null ? null : { publishedAt: pathAt, evidence: "url_path" };
}

async function limitedText(response: Response, maxBytes = MAX_HTML_BYTES): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let output = "";
  try {
    while (bytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const allowed = value.subarray(0, Math.max(0, maxBytes - bytes));
      bytes += allowed.byteLength;
      output += decoder.decode(allowed, { stream: true });
      if (allowed.byteLength < value.byteLength) break;
    }
    output += decoder.decode();
    return output;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function verifySourcePublishedAt(rawUrl: string): Promise<SourceDateVerification> {
  let url: URL;
  try {
    url = publicHttpUrl(rawUrl);
  } catch (error) {
    return {
      status: "failed",
      publishedAt: null,
      error: String(error).slice(0, 200),
    };
  }
  if (isSearchIntermediary(url)) {
    return {
      status: "unverifiable",
      publishedAt: null,
      error: "search intermediary is not an original source",
    };
  }

  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      return {
        status: "failed",
        publishedAt: null,
        error: `HTTP ${response.status}`,
      };
    }
    const contentType = response.headers.get("content-type") || "";
    if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      return {
        status: "unverifiable",
        publishedAt: null,
        error: `unsupported content-type ${contentType.slice(0, 80)}`,
      };
    }
    const extracted = extractSourcePublishedAt(url.toString(), await limitedText(response));
    if (!extracted) return { status: "unverifiable", publishedAt: null };
    if (
      extracted.evidence !== "okx_app_state" &&
      extracted.evidence !== "url_path" &&
      extracted.publishedAt > Date.now() - GENERIC_DATE_STABILITY_DELAY_MS
    ) {
      return {
        status: "unverifiable",
        publishedAt: null,
        error: "publication metadata is too close to render time to be stable",
      };
    }
    return { status: "verified", ...extracted };
  } catch (error) {
    return {
      status: "failed",
      publishedAt: null,
      error: String(error).slice(0, 200),
    };
  }
}

export function sourceDateFreshness(
  verification: SourceDateVerification,
  now = Date.now(),
): "fresh" | "missing" | "stale" | "future" {
  return monitorPublishedAtFreshness(verification.publishedAt, now);
}
