// Pure parts of the daily 早报/晚报: windows, the LLM prompt and the validation of its JSON.
// The LLM only does editorial work (grouping negatives into events, the verdict and outlook);
// every number comes from the database and every source link is filled in from item ids.

export type BriefKind = "am" | "pm";
export const BRIEF_LABEL: Record<BriefKind, string> = { am: "早报", pm: "晚报" };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BJ = 8 * HOUR;
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export const bjDay = (ms: number) => new Date(ms + BJ).toISOString().slice(0, 10);
export const bjDayStart = (ms: number) => Math.floor((ms + BJ) / DAY) * DAY - BJ;
export const bjHHMM = (ms: number) => new Date(ms + BJ).toISOString().slice(11, 16);
export const bjMMDD = (ms: number) => new Date(ms + BJ).toISOString().slice(5, 10);
export const weekday = (ms: number) => WEEKDAYS[new Date(ms + BJ).getUTCDay()];

/** 早报 covers the night since the previous 晚报 cutoff (default 17:45); 晚报 covers today so far. */
export function briefWindow(kind: BriefKind, now: number, previousEnd?: number | null) {
  const dayStart = bjDayStart(now);
  const start = kind === "pm"
    ? dayStart
    : previousEnd && previousEnd < now && now - previousEnd < 30 * HOUR ? previousEnd : dayStart - DAY + 17.75 * HOUR;
  return { start, end: now, compareStart: start - DAY, compareEnd: now - DAY };
}

export type BriefItem = {
  id: number; publishedAt: number; sourcePlatform: string | null; domain: string | null; threatLevel: string | null;
  sentimentScore: number | null; title: string | null; summary: string | null; url: string;
};

export type BriefEventDraft = {
  key: string; short: string; level: "P1" | "P2" | "P3"; title: string;
  trend: "up" | "down" | "flat" | "new" | "closed";
  state: string; escalate: string; happened: string; view: string; unconfirmed: string; next: string;
  ids: number[]; sourceIds: number[];
};

export type BriefDraft = {
  level: "平稳" | "关注" | "警戒" | "危机"; change: "升" | "降" | "持平";
  lead: string; points: string[];
  events: BriefEventDraft[];
  others: { positive: string; narrative: string; watch: string; funds: string };
  outlook: string;
};

export type PreviousEvent = { key: string; title: string; count: number; level: string };

const PLATFORM_CN: Record<string, string> = {
  web: "网页", weibo: "微博", wechat: "公众号", x: "X", tieba: "贴吧", zhihu: "知乎", bilibili: "B站",
  douyin: "抖音", kuaishou: "快手", xiaohongshu: "小红书", binance_square: "币安广场", gate_square: "Gate广场",
  telegram: "Telegram", rss: "RSS", reddit: "Reddit", youtube: "YouTube",
};
export const platformCn = (p: string | null) => (p && PLATFORM_CN[p]) || p || "其他";

const clip = (s: string | null | undefined, n: number) => {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

export function buildPrompt(input: {
  kind: BriefKind; windowLabel: string; facts: string[]; items: BriefItem[];
  previous: PreviousEvent[]; asks: string[];
  /** A few positive items (titles only) so the 正面 line has material. */
  positives?: BriefItem[];
}): { system: string; user: string } {
  const system = `你是 TRON（波场）舆情负责人的编辑。读者是非技术的负责人，要在 1 分钟内判断“有没有事、要不要我管”。
只输出一个 JSON 对象，不要任何其他文字。所有文字用简体中文，平实、具体，不用内部术语（UGC、落盘、SERP 等）。
口径红线：不把指控写成事实；不写脱锚/资不抵债/跑路已成立；链上路径经过波场 ≠ 协议被攻破 ≠ 孙宇晨涉案。
只能依据给你的条目和数字，不得编造事实、数字或来源。条目编号（#数字）只用于 ids / sourceIds，正文里不要写编号。`;
  const items = input.items.map(i =>
    `#${i.id} | ${bjHHMM(i.publishedAt)} | ${platformCn(i.sourcePlatform)} | ${i.threatLevel || "-"} | ${clip(i.title, 56)} | ${clip(i.summary, 40)}`).join("\n");
  const positives = (input.positives || []).map(i => `- ${platformCn(i.sourcePlatform)}：${clip(i.title, 56)}`).join("\n");
  const previous = input.previous.length
    ? input.previous.map(e => `- key=${e.key} | ${e.level} | ${e.title} | 上期 ${e.count} 条`).join("\n")
    : "（无，上期没有事件）";
  const user = `这是 TRON 舆情${BRIEF_LABEL[input.kind]}，监测时段 ${input.windowLabel}。

【系统数字（可直接引用）】
${input.facts.join("\n")}

【需要负责人处理的事项】
${input.asks.length ? input.asks.map(a => `- ${a}`).join("\n") : "（无）"}

【上期在跟事件】
${previous}

【本时段相关负面条目】（#编号 | 发布时间 | 平台 | 威胁 | 标题 | AI 摘要）
${items}

【本时段正面条目（仅供 others.positive 概括）】
${positives || "（无）"}

请输出 JSON：
{
  "level": "平稳|关注|警戒|危机",          // 总体态势：有高威胁或官方/执法一手信息才用 警戒/危机
  "change": "升|降|持平",                  // 较上期
  "lead": "一句话结论，≤50 字，必须说明是否需要负责人决定或处理；有【需要负责人处理的事项】时要点名",
  "points": ["≤3 条，每条以“事件名：”开头，≤60 字"],
  "events": [                              // 2–5 个，按重要性排序；同一件事只出现一次
    {
      "key": "沿用上期相同事件的 key；新事件用简短英文小写短横线，如 jingtian-lawsuit",
      "short": "≤8 字的事件简称，用于推送",
      "level": "P1|P2|P3",                  // P1 有官方/执法一手或明显影响币价；P2 持续发酵或口径敏感；P3 零散
      "title": "≤25 字标题",
      "trend": "up|down|flat|new|closed",  // 结合上期条数与本期条数判断；上期有、本期基本消失用 closed
      "state": "当前状态一句话",
      "escalate": "可判断的升级条件",
      "happened": "发生了什么（≤2 行，可引用条数）",
      "view": "怎么看（≤2 行）",
      "unconfirmed": "还没确认的说法（没有就空字符串）",
      "next": "下一期看什么",
      "ids": [属于这个事件的全部条目编号],
      "sourceIds": [最有代表性的 2–3 个编号，优先官方/媒体]
    }
  ],
  "others": {
    "positive": "依据【本时段正面条目】概括正面动态一行（没有写“无”）",
    "narrative": "其他负面叙事一行（不重复事件卡内容）",
    "watch": "需要观察的一行（不要写 AI 回答负面率，系统会单独列出）",
    "funds": "资金或链上线索一行（没有写“无”）"
  },
  "outlook": "${input.kind === "pm" ? "明日预判" : "今日预判"}，2–3 句"
}`;
  return { system, user };
}

const LEVELS = new Set(["平稳", "关注", "警戒", "危机"]);
const CHANGES = new Set(["升", "降", "持平"]);
const ELEVELS = new Set(["P1", "P2", "P3"]);
const TRENDS = new Set(["up", "down", "flat", "new", "closed"]);
// Item numbers (#17597) are for the model's ids fields only; strip any that leak into prose.
const str = (v: unknown, n: number) =>
  (typeof v === "string" ? v.replace(/[（(]?\s*#\d+(?:\s*[、,，/]\s*#\d+)*\s*[）)]?/g, "").replace(/\s{2,}/g, " ").trim().slice(0, n) : "");

/** Parse and sanitize the model's JSON; ids not in this window are dropped. */
export function parseDraft(text: string, validIds: Set<number>): BriefDraft {
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(json); } catch { throw new Error("模型未返回有效 JSON"); }
  const ids = (v: unknown) => (Array.isArray(v) ? v : []).map(Number).filter(n => validIds.has(n));
  const events = (Array.isArray(raw.events) ? raw.events : []).slice(0, 6).map((e: any) => ({
    key: str(e?.key, 48).toLowerCase().replace(/[^a-z0-9-]/g, "-") || "event",
    short: str(e?.short, 12), level: ELEVELS.has(e?.level) ? e.level : "P3", title: str(e?.title, 40),
    trend: TRENDS.has(e?.trend) ? e.trend : "flat",
    state: str(e?.state, 120), escalate: str(e?.escalate, 120), happened: str(e?.happened, 200),
    view: str(e?.view, 200), unconfirmed: str(e?.unconfirmed, 160), next: str(e?.next, 160),
    ids: Array.from(new Set(ids(e?.ids))), sourceIds: Array.from(new Set(ids(e?.sourceIds))).slice(0, 3),
  })).filter((e: BriefEventDraft) => e.title && (e.ids.length > 0 || e.trend === "closed"));
  const others = (raw.others || {}) as Record<string, unknown>;
  return {
    level: LEVELS.has(raw.level as string) ? raw.level as BriefDraft["level"] : "关注",
    change: CHANGES.has(raw.change as string) ? raw.change as BriefDraft["change"] : "持平",
    lead: str(raw.lead, 120) || "本时段无需负责人决定的事项。",
    points: (Array.isArray(raw.points) ? raw.points : []).map(p => str(p, 90)).filter(Boolean).slice(0, 3),
    events,
    others: { positive: str(others.positive, 200), narrative: str(others.narrative, 200), watch: str(others.watch, 200), funds: str(others.funds, 200) },
    outlook: str(raw.outlook, 300),
  };
}

const MEDIA_DOMAINS = /(^|\.)(163\.com|sina\.com\.cn|sina\.cn|qq\.com|ifeng\.com|people\.com\.cn|xinhuanet\.com|thepaper\.cn|caixin\.com|yicai\.com|36kr\.com|jiemian\.com|chinanews\.com|cls\.cn|wallstreetcn\.com|coindesk\.com|theblock\.co|reuters\.com|bloomberg\.com|cointelegraph\.com|odaily\.news|panewslab\.com|chaincatcher\.com|blockbeats\.info|foresightnews\.pro)$/;

export type BriefSource = { kind: "媒体" | "公众号" | "网帖"; label: string; url: string };

export function toSource(item: BriefItem): BriefSource {
  const domain = (item.domain || "").toLowerCase();
  const kind = item.sourcePlatform === "wechat" ? "公众号" : MEDIA_DOMAINS.test(domain) ? "媒体" : "网帖";
  return { kind, label: `${platformCn(item.sourcePlatform)}：${clip(item.title, 34)}`, url: item.url };
}

/** The fixed 5-line Telegram message (decision-zone text version). */
export function pushText(input: {
  kind: BriefKind; at: number; level: string; change: string; lead: string;
  events: { short: string; title: string; trend: string }[];
  trxPrice: number | null; trx24h: number | null; excess24h: number | null; asks: string[]; link: string;
}): { title: string; content: string } {
  const light = { 平稳: "🟢", 关注: "🟡", 警戒: "🟠", 危机: "🔴" }[input.level] || "🟡";
  const arrow = { up: "▲", down: "▼", flat: "●", new: "◆", closed: "✓" } as Record<string, string>;
  const pct = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
  const title = `${light} TRON 舆情${BRIEF_LABEL[input.kind]}｜${bjMMDD(input.at)} ${weekday(input.at)}｜态势：${input.level}（${input.change}）`;
  const lines = [
    `结论：${input.lead}`,
    `${input.events.map(e => `${arrow[e.trend] || "●"}${e.short || e.title}`).join(" ")}｜TRX ${input.trxPrice ? `$${input.trxPrice.toFixed(4)}` : "—"}（24h ${pct(input.trx24h)}，相对大盘 ${pct(input.excess24h)}）`,
    ...(input.asks.length ? [`🔑 需处理：${input.asks.join("；")}`] : []),
    `📄 ${input.link}`,
  ];
  return { title, content: lines.join("\n") };
}
