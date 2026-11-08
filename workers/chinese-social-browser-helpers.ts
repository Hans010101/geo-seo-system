import {
  chineseSocialKeywordMatchesText,
  type ChineseSocialPlatform,
} from "../server/monitor/sources/chinese-social-source";
import type { DiscoveredPost } from "../server/monitor/sources/types";

const SOCIAL_STATE_MAGIC = "CSS1";
const textEncoder = new TextEncoder();

function stateKeyBytes(base64: string): Uint8Array<ArrayBuffer> {
  try {
    const value = atob(base64);
    const bytes = new Uint8Array(new ArrayBuffer(value.length));
    for (let index = 0; index < value.length; index++) bytes[index] = value.charCodeAt(index);
    return bytes;
  } catch {
    return new Uint8Array(new ArrayBuffer(0));
  }
}

async function socialStateKey(base64: string): Promise<CryptoKey> {
  const raw = stateKeyBytes(base64);
  if (raw.length !== 32) throw new Error("SOCIAL_STATE_ENCRYPTION_KEY must be 32-byte base64");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSocialState(body: string, base64Key: string): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await socialStateKey(base64Key),
    textEncoder.encode(body),
  ));
  const output = new Uint8Array(4 + iv.length + cipher.length);
  output.set(textEncoder.encode(SOCIAL_STATE_MAGIC));
  output.set(iv, 4);
  output.set(cipher, 16);
  return output;
}

export async function decryptSocialState(body: ArrayBuffer, base64Key: string): Promise<string> {
  const input = new Uint8Array(body);
  if (input.length < 33 || new TextDecoder().decode(input.slice(0, 4)) !== SOCIAL_STATE_MAGIC) {
    throw new Error("invalid social state archive");
  }
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: input.slice(4, 16) },
    await socialStateKey(base64Key),
    input.slice(16),
  );
  return new TextDecoder().decode(plain);
}

export function xiaohongshuStorageState(cookieHeader: string) {
  if (!cookieHeader || cookieHeader.length > 16_384) throw new Error("Cookie 内容无效");
  const trimmed = cookieHeader.trim();
  const normalized = !trimmed.includes("=") && /^[0-9A-Za-z._~-]{16,512}$/.test(trimmed)
    ? `web_session=${trimmed}`
    : trimmed;
  const cookies = new Map<string, string>();
  for (const part of normalized.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) && value) cookies.set(name, value);
  }
  if (!cookies.has("web_session")) throw new Error("请输入完整 Cookie，或单独粘贴 web_session 的 Value");
  return {
    cookies: Array.from(cookies, ([name, value]) => ({
      name,
      value,
      domain: ".xiaohongshu.com",
      path: "/",
      secure: true,
      httpOnly: false,
      sameSite: "Lax" as const,
      expires: -1,
    })),
    origins: [],
  };
}

export function isXiaohongshuIpRiskUrl(value: string): boolean {
  try {
    return new URL(value).searchParams.get("error_code") === "300012";
  } catch {
    return false;
  }
}

type PlatformKey = ChineseSocialPlatform["key"];

export type BrowserScrapeElement = {
  text: string;
  anchorText?: string;
  html: string;
  attributes: Array<{ name: string; value: string }>;
};

export type SogouWeChatSearchItem = {
  title: string;
  snippet: string;
  author: string | null;
  publishedAt: number | null;
  redirectUrl: string;
};

const WECHAT_CORE_QUERIES = ["孙宇晨", "波场 OR TRON"] as const;
const WECHAT_DEFAULT_LONG_TAIL_QUERIES = [
  "Justin Sun", "孙哥", "孙割", "孙宇晨 火币", "孙宇晨 HTX",
] as const;

function isWeChatCoreQuery(query: string): boolean {
  const normalized = query.toLowerCase();
  return normalized === "孙宇晨" || normalized === "波场" || normalized === "tron" ||
    normalized === "波场 or tron" || normalized === "波场/tron";
}

export function planWeChatQueries(requestedQueries: string[], now = Date.now()): {
  requested: string[];
  executed: string[];
  truncated: string[];
} {
  const requested = Array.from(new Set(requestedQueries
    .map(value => String(value || "").replace(/\s+/g, " ").trim())
    .filter(value => value.length > 0 && value.length <= 120)));
  const requestedLongTails = requested.filter(query => !isWeChatCoreQuery(query));
  const longTails = requestedLongTails.length > 0
    ? requestedLongTails
    : Array.from(WECHAT_DEFAULT_LONG_TAIL_QUERIES);
  const shanghaiTwoHourSlot = Math.floor((now + 8 * 3_600_000) / (2 * 3_600_000));
  const selectedLongTail = longTails[shanghaiTwoHourSlot % longTails.length];
  return {
    requested,
    executed: [...WECHAT_CORE_QUERIES, selectedLongTail],
    truncated: requestedLongTails.filter(query => query !== selectedLongTail),
  };
}

export function allocateWeChatQueryQuotas(maxResults: number, queryCount: number): number[] {
  if (queryCount < 1) return [];
  const total = Math.max(queryCount, Math.trunc(maxResults));
  const base = Math.floor(total / queryCount);
  const remainder = total % queryCount;
  return Array.from({ length: queryCount }, (_, index) => base + (index < remainder ? 1 : 0));
}

export function isSogouWeChatSearchPage(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname === "weixin.sogou.com" && url.pathname === "/weixin" && Boolean(url.searchParams.get("query"));
  } catch {
    return false;
  }
}

export function extractWeChatUrlFromSogouHtml(html: string): string | null {
  const parts = Array.from(html.matchAll(/url \+= '([^']*)'/g), match => match[1]);
  const value = parts.join("").replaceAll("@", "");
  if (!value) return null;
  const url = value.startsWith("http") ? value : `https://mp.${value}`;
  try {
    const parsed = new URL(url);
    return parsed.hostname === "mp.weixin.qq.com" && parsed.pathname === "/s"
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

export function toWeChatBrowserPost(
  item: SogouWeChatSearchItem,
  articleUrl: string,
): DiscoveredPost | null {
  try {
    const url = new URL(articleUrl);
    if (url.hostname !== "mp.weixin.qq.com" || url.pathname !== "/s") return null;
    return {
      url: url.toString(),
      title: item.title.slice(0, 512),
      contentSnippet: item.snippet.slice(0, 4000),
      author: item.author,
      publishedAt: item.publishedAt,
      sourceName: "wechat_search",
      sourcePlatform: "wechat",
      fetchEngineHint: "sogou_browser",
      fetchCostUsdHint: 0,
    };
  } catch {
    return null;
  }
}

const SEARCH_URLS: Record<PlatformKey, (keyword: string) => string> = {
  xiaohongshu: keyword =>
    `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&source=web_search_result_notes`,
  douyin: keyword =>
    `https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=video`,
  kuaishou: keyword =>
    `https://www.kuaishou.com/search/video?searchKey=${encodeURIComponent(keyword)}`,
  bilibili: keyword =>
    `https://search.bilibili.com/all?keyword=${encodeURIComponent(keyword)}&order=pubdate`,
  weibo: keyword =>
    `https://s.weibo.com/weibo?q=${encodeURIComponent(keyword)}&Refer=SWeibo_box`,
  tieba: keyword =>
    `https://tieba.baidu.com/f/search/res?ie=utf-8&qw=${encodeURIComponent(keyword)}`,
  zhihu: keyword =>
    `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(keyword)}`,
};

export function chineseSocialSearchUrl(
  platform: PlatformKey,
  keyword: string
): string {
  return SEARCH_URLS[platform](keyword);
}

function hrefOf(element: BrowserScrapeElement): string | null {
  return element.attributes.find(attribute => attribute.name.toLowerCase() === "href")?.value || null;
}

function publishedAtOf(element: BrowserScrapeElement): number | null {
  const value = element.attributes.find(attribute =>
    ["datetime", "data-time", "data-timestamp"].includes(attribute.name.toLowerCase())
  )?.value || element.html.match(/<time\b[^>]*\bdatetime=["']([^"']+)["']/i)?.[1];
  if (value) {
    const numeric = Number(value);
    const parsed = Number.isFinite(numeric)
      ? numeric * (numeric < 1e12 ? 1000 : 1)
      : Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return parseChinesePublishedAt(`${element.text} ${element.html}`);
}

export function parseChinesePublishedAt(text: string, now = Date.now()): number | null {
  const normalized = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const relative = normalized.match(/(\d+)\s*(秒|分钟|小时|天)前/);
  if (relative) {
    const amount = Number(relative[1]);
    const unitMs = relative[2] === "秒" ? 1_000 : relative[2] === "分钟" ? 60_000 :
      relative[2] === "小时" ? 3_600_000 : 86_400_000;
    return now - amount * unitMs;
  }
  if (/刚刚/.test(normalized)) return now;
  const dayWord = normalized.match(/(今天|昨天|前天)(?:\s*(\d{1,2}):(\d{2}))?/);
  if (dayWord) {
    const date = new Date(now);
    date.setHours(Number(dayWord[2] || 0), Number(dayWord[3] || 0), 0, 0);
    if (dayWord[1] === "昨天") date.setDate(date.getDate() - 1);
    if (dayWord[1] === "前天") date.setDate(date.getDate() - 2);
    return date.getTime();
  }
  const absolute = normalized.match(/(20\d{2})[年\/-](\d{1,2})[月\/-](\d{1,2})(?:日)?(?:\s+(\d{1,2}):(\d{2}))?/);
  if (absolute) {
    const parsed = Date.parse(
      `${absolute[1]}-${absolute[2].padStart(2, "0")}-${absolute[3].padStart(2, "0")}` +
      `T${(absolute[4] || "0").padStart(2, "0")}:${(absolute[5] || "0").padStart(2, "0")}:00+08:00`,
    );
    return Number.isFinite(parsed) ? parsed : null;
  }
  const monthDay = normalized.match(/(?:^|\s|·)(\d{1,2})(?:-|月)(\d{1,2})(?:日)?(?:\s+(\d{1,2}):(\d{2}))?(?:\s|$)/);
  if (monthDay) {
    const chinaNow = new Date(now + 8 * 3_600_000);
    let year = chinaNow.getUTCFullYear();
    let parsed = Date.parse(
      `${year}-${monthDay[1].padStart(2, "0")}-${monthDay[2].padStart(2, "0")}` +
      `T${(monthDay[3] || "0").padStart(2, "0")}:${(monthDay[4] || "0").padStart(2, "0")}:00+08:00`,
    );
    if (parsed > now + 86_400_000) {
      year--;
      parsed = Date.parse(
        `${year}-${monthDay[1].padStart(2, "0")}-${monthDay[2].padStart(2, "0")}` +
        `T${(monthDay[3] || "0").padStart(2, "0")}:${(monthDay[4] || "0").padStart(2, "0")}:00+08:00`,
      );
    }
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function plainText(value: unknown): string {
  return String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export function extractBilibiliPageState(html: string): unknown[] {
  const items: unknown[] = [];
  const pattern = /bvid:"(BV[a-zA-Z0-9]+)"([\s\S]{0,8000}?)pubdate:(\d+)/g;
  for (const match of html.matchAll(pattern)) {
    const decode = (value: string) => {
      try { return JSON.parse(`"${value}"`); } catch { return value; }
    };
    const title = decode(match[2].match(/title:"((?:\\.|[^"\\])*)"/)?.[1] || "");
    const author = decode(match[2].match(/author:"((?:\\.|[^"\\])*)"/)?.[1] || "");
    items.push({ bvid: match[1], title, author, pubdate: Number(match[3]) });
  }
  return items;
}

export function mapNativeSearchPayload(
  platform: ChineseSocialPlatform,
  keyword: string,
  payload: unknown,
  maxResults = 3,
): DiscoveredPost[] {
  const objects: Record<string, unknown>[] = [];
  const visit = (value: unknown, depth = 0): void => {
    if (!value || depth > 8 || objects.length > 2_000) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    objects.push(object);
    for (const child of Object.values(object)) visit(child, depth + 1);
  };
  visit(payload);

  const posts = new Map<string, DiscoveredPost>();
  const add = (url: string, title: unknown, snippet: unknown, author: unknown, time: unknown): void => {
    if (!url) return;
    const cleanTitle = plainText(title);
    const cleanSnippet = plainText(snippet);
    const cleanAuthor = plainText(author);
    if (!chineseSocialKeywordMatchesText(keyword, `${cleanTitle} ${cleanSnippet} ${cleanAuthor}`)) return;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return;
    }
    if (!platform.matches(parsedUrl)) return;
    const numeric = Number(time);
    const dated = Date.parse(String(time || ""));
    const publishedAt = Number.isFinite(numeric) && numeric > 0
      ? numeric * (numeric < 1e12 ? 1000 : 1)
      : parseChinesePublishedAt(String(time || "")) ?? (Number.isFinite(dated) ? dated : null);
    parsedUrl.hash = "";
    posts.set(parsedUrl.toString(), {
      url: parsedUrl.toString(),
      title: cleanTitle.slice(0, 512),
      contentSnippet: (cleanSnippet || cleanTitle).slice(0, 4000),
      author: cleanAuthor || null,
      publishedAt,
      sourceName: `${platform.key}_browser`,
      sourcePlatform: platform.key,
      fetchEngineHint: "social_browser",
    });
  };

  for (const object of objects) {
    if (platform.key === "xiaohongshu" && object.note_id) {
      const user = object.user as Record<string, unknown> | undefined;
      add(
        `https://www.xiaohongshu.com/explore/${object.note_id}`,
        object.title, object.desc, user?.nickname, object.time || object.last_update_time,
      );
    } else if (platform.key === "douyin" && object.aweme_id) {
      const author = object.author as Record<string, unknown> | undefined;
      add(
        `https://www.douyin.com/video/${object.aweme_id}`,
        object.desc, object.desc, author?.nickname, object.create_time,
      );
    } else if (platform.key === "kuaishou" && object.photo) {
      const photo = object.photo as Record<string, unknown>;
      const author = object.author as Record<string, unknown> | undefined;
      if (photo.id) add(
        `https://www.kuaishou.com/short-video/${photo.id}`,
        photo.caption, photo.caption, author?.name, photo.timestamp,
      );
    } else if (platform.key === "weibo" && object.mblog) {
      const mblog = object.mblog as Record<string, unknown>;
      const user = mblog.user as Record<string, unknown> | undefined;
      if (mblog.id) add(
        `https://m.weibo.cn/detail/${mblog.id}`,
        mblog.text, mblog.text, user?.screen_name, mblog.created_at,
      );
    } else if (platform.key === "bilibili" && object.bvid) {
      add(
        `https://www.bilibili.com/video/${object.bvid}`,
        object.title, object.description || object.desc, object.author || object.uname,
        object.pubdate || object.pubstr,
      );
    } else if (platform.key === "zhihu" && ["answer", "article", "zvideo"].includes(String(object.type))) {
      const type = String(object.type);
      const question = object.question as Record<string, unknown> | undefined;
      const url = type === "answer"
        ? `https://www.zhihu.com/question/${question?.id}/answer/${object.id}`
        : type === "article"
          ? `https://zhuanlan.zhihu.com/p/${object.id}`
          : `https://www.zhihu.com/zvideo/${object.id}`;
      const author = object.author as Record<string, unknown> | undefined;
      add(url, object.title, object.excerpt || object.description || object.content, author?.name,
        object.created_time || object.created || object.created_at || object.published_at);
    } else if (platform.key === "tieba" && (object.tid || object.thread_id)) {
      const user = object.user as Record<string, unknown> | undefined;
      add(
        `https://tieba.baidu.com/p/${object.tid || object.thread_id}`,
        object.title, object.content || object.abstract,
        user?.show_nickname || user?.user_name || object.author,
        object.time || object.create_time,
      );
    }
  }
  return Array.from(posts.values())
    .sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0))
    .slice(0, Math.max(1, Math.min(5, Math.trunc(maxResults) || 3)));
}

export function mapBrowserScrapeResults(
  platform: ChineseSocialPlatform,
  searchUrl: string,
  keyword: string,
  elements: BrowserScrapeElement[],
  maxResults = 3
): DiscoveredPost[] {
  const byUrl = new Map<string, DiscoveredPost>();
  for (const element of elements) {
    const href = hrefOf(element);
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(href, searchUrl);
    } catch {
      continue;
    }
    if (!platform.matches(url)) continue;
    url.hash = "";
    const canonicalUrl = url.toString();
    const text = (element.anchorText?.trim() || element.text)
      .replace(/\s+/g, " ").trim().slice(0, 4000);
    if (!chineseSocialKeywordMatchesText(keyword, text)) continue;
    const current = byUrl.get(canonicalUrl);
    if (current && (current.contentSnippet?.length || 0) >= text.length) continue;
    byUrl.set(canonicalUrl, {
      url: canonicalUrl,
      title: text.slice(0, 512),
      contentSnippet: text,
      author: null,
      publishedAt: publishedAtOf(element),
      sourceName: `${platform.key}_browser`,
      sourcePlatform: platform.key,
      fetchEngineHint: "social_browser",
    });
  }
  const limit = Math.max(1, Math.min(5, Math.trunc(maxResults) || 3));
  return Array.from(byUrl.values()).slice(0, limit);
}
