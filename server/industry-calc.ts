// 行业动态 (crypto / web3 / macro / competitors): pure helpers shared by the ingest worker, the
// cron triage task and the API. The Mac collector fetches the feeds hourly (cloud egress is blocked
// by some sources) and posts raw items to /industry-news; the cron queue triages them with an LLM.

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export const INDUSTRY_SOURCES: Record<string, { label: string; lang: "zh" | "en"; official?: boolean }> = {
  chaincatcher: { label: "ChainCatcher", lang: "zh" },
  techflow: { label: "深潮 TechFlow", lang: "zh" },
  odaily: { label: "Odaily", lang: "zh" },
  wublock: { label: "吴说", lang: "zh" },
  theblock: { label: "The Block", lang: "en" },
  cointelegraph: { label: "Cointelegraph", lang: "en" },
  decrypt: { label: "Decrypt", lang: "en" },
  binance: { label: "Binance 公告", lang: "en", official: true },
  tether: { label: "Tether 官方", lang: "en", official: true },
};

export const CATEGORIES = [
  { key: "regulation", label: "监管政策" },
  { key: "macro", label: "宏观金融" },
  { key: "stablecoin", label: "稳定币与支付" },
  { key: "exchange", label: "交易所" },
  { key: "chain", label: "公链生态" },
  { key: "institution", label: "机构与 ETF" },
  { key: "tokenization", label: "代币化与预测市场" },
  { key: "security", label: "安全事件" },
  { key: "market", label: "行情数据" },
  { key: "other", label: "科技与其他" },
] as const;
export type CategoryKey = (typeof CATEGORIES)[number]["key"];
const CATEGORY_KEYS = new Set<string>(CATEGORIES.map(c => c.key));

/** Tracked players: TRON itself plus the competitors the user picked (2026-11-11). */
export const ENTITIES = [
  { key: "tron", label: "TRON" },
  { key: "binance", label: "Binance" },
  { key: "solana", label: "Solana" },
  { key: "tether", label: "Tether" },
  { key: "circle", label: "Circle" },
  { key: "ethereum", label: "以太坊" },
] as const;
export type EntityKey = (typeof ENTITIES)[number]["key"];
const ENTITY_KEYS = new Set<string>(ENTITIES.map(e => e.key));

export type RawIndustryItem = {
  source: string; url: string; title: string; excerpt: string; publishedAt: number;
};

const clean = (s: unknown, max: number) =>
  typeof s === "string" ? s.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";

/** Validates a /industry-news batch from the Mac collector. */
export function parseIndustryBatch(value: unknown, now = Date.now()): RawIndustryItem[] {
  const items = (value as { items?: unknown } | null)?.items;
  if (!Array.isArray(items) || items.length > 3000) throw new Error("Expected 0-3000 items");
  const out: RawIndustryItem[] = [];
  for (const raw of items) {
    const r = (raw || {}) as Record<string, unknown>;
    const source = String(r.source || "");
    if (!INDUSTRY_SOURCES[source]) throw new Error("Unknown source");
    const url = clean(r.url, 500);
    const title = clean(r.title, 300);
    const publishedAt = Number(r.publishedAt);
    if (!/^https?:\/\//.test(url) || !title) continue;
    if (!Number.isFinite(publishedAt) || publishedAt > now + HOUR || publishedAt < now - 7 * DAY) continue;
    out.push({ source, url, title, excerpt: clean(r.excerpt, 600), publishedAt: Math.floor(publishedAt) });
  }
  return out;
}

/** Stable short id per URL (FNV-1a, 2×32 bit). */
export function itemId(url: string) {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return a.toString(36) + b.toString(36);
}

// ------------------------------------------------------------------ near-duplicate detection
/** Character bigrams of a normalized title (works for Chinese and English alike). */
export function bigrams(text: string) {
  const s = text.toLowerCase().replace(/^(数据|快讯|消息|市场消息|知情人士|据报道)[:：]/, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
  const set = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

export function similarity(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  small.forEach(g => { if (large.has(g)) inter++; });
  return inter / (a.size + b.size - inter);
}

export const DUP_THRESHOLD = 0.55;

/**
 * Bigrams plus the numbers and price direction of a text. Template newsflashes ("BTC 突破 75000 美元"
 * vs "BTC 跌破 74000 美元", token-unlock notices) look alike but differ exactly there.
 */
export type Fingerprint = { grams: Set<string>; nums: Set<string>; dir: "up" | "down" | null };
export function fingerprint(text: string): Fingerprint {
  const nums = new Set((text.replace(/(\d),(?=\d{3})/g, "$1").match(/\d+(?:\.\d+)?/g) || []).filter(n => n !== "24"));
  const up = /突破|涨破|上涨|升至|surge|rise/i.test(text);
  const down = /跌破|下跌|跌至|plunge|fall/i.test(text);
  return { grams: bigrams(text), nums, dir: up && !down ? "up" : down && !up ? "down" : null };
}

function sameFacts(a: Fingerprint, b: Fingerprint) {
  if (a.dir && b.dir && a.dir !== b.dir) return false;
  if (!a.nums.size || !b.nums.size) return true;
  let shared = 0;
  a.nums.forEach(n => { if (b.nums.has(n)) shared++; });
  return shared > 0;
}

/** Index of the first candidate this text duplicates, or -1. */
export function findDuplicate(text: string, candidates: Fingerprint[], threshold = DUP_THRESHOLD) {
  const fp = fingerprint(text);
  if (fp.grams.size < 6) return -1; // too short to judge
  for (let i = 0; i < candidates.length; i++) {
    if (similarity(fp.grams, candidates[i].grams) >= threshold && sameFacts(fp, candidates[i])) return i;
  }
  return -1;
}

// ------------------------------------------------------------------ LLM triage
export type TriageInput = { i: number; source: string; title: string; excerpt: string };
export type Triage = {
  i: number; keep: boolean; category: CategoryKey; importance: number;
  entities: EntityKey[]; tron: 0 | 1 | 2; tronNote: string; summary: string;
};

export function triagePrompt(items: TriageInput[]) {
  const system = `你是加密行业情报编辑，为 TRON（波场）团队筛选每日「行业动态」。关注：加密/web3 行业大事，以及会影响加密市场的重大全球金融事件（美联储利率、非农/CPI、美股科技股暴跌、美债收益率、重大地缘事件），并重点跟踪 Binance、Solana、Tether、Circle、以太坊等竞品动向。
逐条判断，只输出 JSON 数组，每条一个对象，字段：
- i：原编号
- keep：与加密/web3 或影响加密的重大金融事件无关（体育、普通公司财报、纯 AI 模型发布但与加密无关、广告/活动推广）则 false
- category：${CATEGORIES.map(c => `${c.key}(${c.label})`).join("、")} 之一
- importance：1-5。5=行业级重大事件（头部交易所被盗/暂停提现、主流稳定币脱锚、美联储利率决议、重大加密法案通过或否决、BTC 单日涨跌超 8%、头部机构破产）；4=重要（主要国家监管动作、头部公司重大产品/融资/IPO、竞品重大动向、非农/CPI 等关键宏观数据、单笔超 1 亿美元的安全事件）；3=值得关注（一般产品发布、机构增持、有代表性的链上数据）；2=一般；1=噪音或小项目
- entities：从 ${ENTITIES.map(e => e.key).join("/")} 中选涉及的（可为空数组；Binance 含币安、CZ/赵长鹏、BNB Chain；Tether 含 USDT；Circle 含 USDC、Arc）
- tron：2=直接涉及 TRON/TRX/孙宇晨/波场/JUST/USDD/HTX；1=间接影响 TRON（稳定币监管、USDT/Tether 动向、竞品稳定币链、交易所对 TRX 的动作）；0=无关
- tronNote：tron≥1 时用一句话（≤30 字）说明与 TRON 的关系，否则为空字符串
- summary：一句话中文快讯（≤60 字），保留关键数字、主体和动作，不加评论；英文原文请翻译`;
  const user = items.map(it => `[${it.i}] (${it.source}) ${it.title}${it.excerpt && it.excerpt !== it.title ? ` —— ${it.excerpt.slice(0, 220)}` : ""}`).join("\n");
  return { system, user };
}

function extractJsonArray(text: string): unknown[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("no JSON array");
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("not an array");
  return parsed;
}

export function parseTriage(text: string, ids: Set<number>): Triage[] {
  const out: Triage[] = [];
  for (const raw of extractJsonArray(text)) {
    const r = (raw || {}) as Record<string, unknown>;
    const i = Number(r.i);
    if (!ids.has(i)) continue;
    const importance = Math.min(5, Math.max(1, Math.round(Number(r.importance) || 1)));
    const tron = [0, 1, 2].includes(Number(r.tron)) ? (Number(r.tron) as 0 | 1 | 2) : 0;
    const category = (CATEGORY_KEYS.has(String(r.category)) ? r.category : "other") as CategoryKey;
    const entities = Array.isArray(r.entities)
      ? Array.from(new Set(r.entities.map(e => String(e).toLowerCase()).filter(e => ENTITY_KEYS.has(e)))) as EntityKey[] : [];
    if (tron === 2 && !entities.includes("tron")) entities.unshift("tron");
    out.push({
      i, keep: r.keep !== false, category, importance, entities, tron,
      tronNote: tron ? clean(r.tronNote, 80) : "",
      summary: clean(r.summary, 160),
    });
  }
  return out;
}

// ------------------------------------------------------------------ selection (brief / digest)
export type IndustryRow = {
  id: string; source: string; url: string; title: string; summary: string | null; publishedAt: number;
  category: string | null; importance: number | null; entities: string | null; tron: number | null;
  tronNote: string | null; sourceCount: number;
};

/** Score for "what matters most": importance first, then corroboration and TRON relevance. */
export const rankScore = (r: Pick<IndustryRow, "importance" | "sourceCount" | "tron" | "publishedAt">) =>
  (r.importance ?? 1) * 10 + Math.min(4, (r.sourceCount || 1) - 1) * 1.5 + (r.tron ?? 0) * 2 + r.publishedAt / 1e13;

/** Top N with at most `perCategory` per category, so one hot topic cannot take the whole section. */
export function pickTop(rows: IndustryRow[], n: number, perCategory = 3, minImportance = 3) {
  const sorted = rows.filter(r => (r.importance ?? 0) >= minImportance).sort((a, b) => rankScore(b) - rankScore(a));
  const used = new Map<string, number>();
  const out: IndustryRow[] = [];
  for (const r of sorted) {
    const c = r.category || "other";
    if ((used.get(c) || 0) >= perCategory) continue;
    used.set(c, (used.get(c) || 0) + 1);
    out.push(r);
    if (out.length >= n) break;
  }
  return out;
}

// ------------------------------------------------------------------ 早晚报「行业动态」板块
export type BriefIndustry = {
  macro: { label: string; value: string; change: string; dir: "up" | "down" | "flat" }[];
  items: {
    summary: string; category: string; categoryLabel: string; importance: number; tron: number; tronNote: string;
    url: string; source: string; sourceCount: number; publishedAt: number;
  }[];
  total: number;
};

type MacroInput = { symbol: string; name: string; unit: string | null; price: number | null; change1d: number | null }[];
type FedInput = { events: { title: string; outcomes: { label: string; prob: number }[] }[] } | null;

const FED_LABELS: Record<string, string> = {
  "No change": "维持", "25 bps increase": "加息 25bp", "50+ bps increase": "加息 50bp+",
  "25 bps decrease": "降息 25bp", "50+ bps decrease": "降息 50bp+",
};
const MONTHS: Record<string, string> = {
  January: "1 月", February: "2 月", March: "3 月", April: "4 月", May: "5 月", June: "6 月", July: "7 月",
  August: "8 月", September: "9 月", October: "10 月", November: "11 月", December: "12 月",
};

/** Pure: the 5–8 items and the one-line macro strip for a brief window. */
export function briefIndustrySection(rows: IndustryRow[], macro: MacroInput, fed: FedInput, fng: number | null, n = 8): BriefIndustry {
  const pick = pickTop(rows, n, 3, 3);
  const dir = (v: number | null) => (v === null || v === 0 ? "flat" : v > 0 ? "up" : "down") as "up" | "down" | "flat";
  const strip: BriefIndustry["macro"] = [];
  for (const symbol of ["NASDAQ", "US10Y", "DXY", "GOLD"]) {
    const m = macro.find(x => x.symbol === symbol);
    if (!m || m.price === null) continue;
    const bp = m.unit === "%";
    strip.push({
      label: symbol === "US10Y" ? "10Y 美债" : m.name,
      value: bp ? `${m.price.toFixed(2)}%` : m.price >= 1000 ? Math.round(m.price).toLocaleString("en-US") : m.price.toFixed(2),
      change: m.change1d === null ? "" : bp ? `${m.change1d > 0 ? "+" : ""}${m.change1d.toFixed(0)}bp` : `${m.change1d > 0 ? "+" : ""}${m.change1d.toFixed(2)}%`,
      dir: dir(m.change1d),
    });
  }
  const meeting = fed?.events?.[0];
  if (meeting?.outcomes?.length) {
    const top = meeting.outcomes[0];
    const month = Object.keys(MONTHS).find(k => meeting.title.includes(k));
    strip.push({ label: `${month ? MONTHS[month] : "下次"}议息`, value: `${FED_LABELS[top.label] || top.label} ${Math.round(top.prob)}%`, change: "", dir: "flat" });
  }
  if (fng !== null) strip.push({ label: "恐慌贪婪", value: String(Math.round(fng)), change: "", dir: "flat" });
  return {
    macro: strip,
    total: rows.length,
    items: pick.map(r => ({
      summary: r.summary || r.title, category: r.category || "other",
      categoryLabel: CATEGORIES.find(c => c.key === r.category)?.label || "其他",
      importance: r.importance ?? 3, tron: r.tron ?? 0, tronNote: r.tronNote || "", url: r.url,
      source: INDUSTRY_SOURCES[r.source]?.label || r.source, sourceCount: r.sourceCount || 1, publishedAt: Number(r.publishedAt),
    })),
  };
}
