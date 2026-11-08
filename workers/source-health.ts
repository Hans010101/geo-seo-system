// Source outage tracking: remembers when each monitor source last discovered anything and
// flags sources that keep running but have found nothing for OUTAGE_HOURS. Weibo went silent
// for two months (Sept–Nov 2026) before anyone noticed; this exists so that never repeats.
import type { SourceDiagnostic } from "./source-diagnostic";

export const SOURCE_HEALTH_KEY = "cf_source_health_state";
const HOUR = 3_600_000;
export const OUTAGE_HOURS = 48;
/** Only judge sources that actually ran recently; a source switched off is not an outage. */
export const ACTIVE_WITHIN_HOURS = 24;
/** While a source stays down, remind again after this long. */
export const REMIND_EVERY_HOURS = 7 * 24;

export const SOURCE_LABELS: Record<string, string> = {
  serper: "Serper 搜索新闻", rss: "RSS 媒体", wechat: "微信公众号",
  gate_square: "Gate 广场", telegram: "Telegram", x: "X / Twitter",
  binance_square: "币安广场", xiaohongshu: "小红书", douyin: "抖音",
  kuaishou: "快手", bilibili: "B站", weibo: "微博", tieba: "百度贴吧", zhihu: "知乎",
  local_weibo: "微博（本机采集）", local_tieba: "百度贴吧（本机采集）",
};

/** Diagnostic source name → monitor_articles.sourcePlatform, used once to seed history. */
const SEED_PLATFORM: Record<string, string> = { serper: "web" };

export type SourceHealthEntry = {
  firstTrackedAt: number;
  lastRunAt: number;
  lastDiscoveredAt?: number;
  lastStatus?: string;
  lastError?: string;
  alertedAt?: number;
  /** Fed by the Mac collector heartbeat; a stopped Mac must alert too, so no "active" gate. */
  external?: boolean;
};

export type LocalHealthEntry = { lastRunAt: number; lastDiscoveredAt?: number; lastError?: string };

export type SourceHealthState = {
  version: 1;
  seeded: boolean;
  sources: Record<string, SourceHealthEntry>;
};

export type OutageItem = {
  name: string;
  label: string;
  silentHours: number;
  lastDiscoveredAt?: number;
  lastError?: string;
};

export function parseSourceHealthState(raw: string | null | undefined): SourceHealthState {
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed?.version === 1 && parsed.sources && typeof parsed.sources === "object") {
      return { version: 1, seeded: Boolean(parsed.seeded), sources: parsed.sources };
    }
  } catch {
    // fall through to a fresh state
  }
  return { version: 1, seeded: false, sources: {} };
}

/**
 * Fold one finished cycle's diagnostics into the state. `seed` maps sourcePlatform → last
 * article time (ms) and is applied only to sources seen for the first time.
 */
export function recordDiagnostics(
  previous: SourceHealthState,
  diagnostics: Record<string, SourceDiagnostic>,
  now: number,
  seed: Record<string, number> = {},
): SourceHealthState {
  const sources = { ...previous.sources };
  for (const [name, diagnostic] of Object.entries(diagnostics)) {
    if (!diagnostic) continue;
    const before = sources[name];
    const seeded = before ? undefined : seed[SEED_PLATFORM[name] || name];
    const entry: SourceHealthEntry = before
      ? { ...before }
      : { firstTrackedAt: now, lastRunAt: now, ...(seeded ? { lastDiscoveredAt: seeded } : {}) };
    entry.lastRunAt = now;
    entry.lastStatus = diagnostic.status;
    if ((diagnostic.discovered || 0) > 0) entry.lastDiscoveredAt = now;
    const error = diagnostic.errors?.find(Boolean);
    if (error) entry.lastError = error.slice(0, 300);
    else if ((diagnostic.discovered || 0) > 0) delete entry.lastError;
    sources[name] = entry;
  }
  return { version: 1, seeded: true, sources };
}

/** Mirror the Mac collector heartbeat (cf_local_source_health) in as `local_<platform>`. */
export function mergeLocalHealth(
  previous: SourceHealthState,
  local: Record<string, LocalHealthEntry>,
  now: number,
): SourceHealthState {
  const sources = { ...previous.sources };
  for (const [platform, entry] of Object.entries(local)) {
    if (!entry || typeof entry.lastRunAt !== "number") continue;
    const name = `local_${platform}`;
    const before = sources[name];
    sources[name] = {
      firstTrackedAt: before?.firstTrackedAt ?? Math.min(now, entry.lastRunAt),
      lastRunAt: entry.lastRunAt,
      ...(entry.lastDiscoveredAt ? { lastDiscoveredAt: entry.lastDiscoveredAt } : {}),
      ...(entry.lastError ? { lastError: entry.lastError } : {}),
      ...(before?.alertedAt ? { alertedAt: before.alertedAt } : {}),
      external: true,
    };
  }
  return { ...previous, sources };
}

function silentHours(entry: SourceHealthEntry, now: number): number {
  return (now - (entry.lastDiscoveredAt ?? entry.firstTrackedAt)) / HOUR;
}

export function isDown(entry: SourceHealthEntry, now: number): boolean {
  return (entry.external || now - entry.lastRunAt <= ACTIVE_WITHIN_HOURS * HOUR)
    && silentHours(entry, now) >= OUTAGE_HOURS;
}

function item(name: string, entry: SourceHealthEntry, now: number): OutageItem {
  return {
    name,
    label: SOURCE_LABELS[name] || name,
    silentHours: Math.floor(silentHours(entry, now)),
    ...(entry.lastDiscoveredAt ? { lastDiscoveredAt: entry.lastDiscoveredAt } : {}),
    ...(entry.lastError ? { lastError: entry.lastError } : {}),
  };
}

/**
 * `due`: down sources never alerted or last alerted REMIND_EVERY_HOURS ago.
 * `down`: every source currently down (listed in the message for the full picture).
 * `recovered`: alerted sources that have discovered something since the alert.
 */
export function evaluateOutages(state: SourceHealthState, now: number) {
  const down: OutageItem[] = [];
  const due: OutageItem[] = [];
  const recovered: OutageItem[] = [];
  for (const [name, entry] of Object.entries(state.sources)) {
    if (isDown(entry, now)) {
      down.push(item(name, entry, now));
      if (!entry.alertedAt || now - entry.alertedAt >= REMIND_EVERY_HOURS * HOUR) {
        due.push(item(name, entry, now));
      }
    } else if (entry.alertedAt && (entry.lastDiscoveredAt || 0) > entry.alertedAt) {
      recovered.push(item(name, entry, now));
    }
  }
  const bySilence = (a: OutageItem, b: OutageItem) => b.silentHours - a.silentHours;
  return { down: down.sort(bySilence), due, recovered };
}

export function markNotified(
  state: SourceHealthState,
  alerted: string[],
  recovered: string[],
  now: number,
): SourceHealthState {
  const sources = { ...state.sources };
  for (const name of alerted) if (sources[name]) sources[name] = { ...sources[name], alertedAt: now };
  for (const name of recovered) {
    if (!sources[name]) continue;
    const { alertedAt: _alertedAt, ...rest } = sources[name];
    sources[name] = rest;
  }
  return { ...state, sources };
}

function duration(hours: number): string {
  return hours >= 72 ? `${Math.floor(hours / 24)} 天` : `${hours} 小时`;
}

function beijing(ms: number): string {
  const d = new Date(ms + 8 * HOUR);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function buildOutageMessage(
  down: OutageItem[],
  recovered: OutageItem[],
): { title: string; content: string } {
  const lines: string[] = [];
  if (down.length > 0) {
    lines.push(`以下信源仍在按计划运行，但已连续 ${OUTAGE_HOURS} 小时以上没有采集到任何内容：`);
    for (const source of down) {
      const last = source.lastDiscoveredAt ? `最近一次 ${beijing(source.lastDiscoveredAt)}` : "开始监测以来从未采到";
      lines.push(`· ${source.label}：已 ${duration(source.silentHours)}无内容（${last}）`);
      if (source.lastError) lines.push(`  最近错误：${source.lastError.slice(0, 140)}`);
    }
    lines.push("常见原因：登录失效、接口额度用尽、浏览器容量不足。请到运维中心查看。");
    if (down.some(source => source.name.startsWith("local_"))) {
      lines.push("本机采集：请确认 Mac 已开机未睡眠；微博若提示登录，运行 collector.py login weibo 重新扫码。");
    }
  }
  if (recovered.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`已恢复采集：${recovered.map(source => source.label).join("、")}`);
  }
  const title = down.length > 0
    ? `信源断流提醒 · ${down.map(source => source.label).join("、")}`
    : `信源已恢复 · ${recovered.map(source => source.label).join("、")}`;
  return { title, content: lines.join("\n") };
}
