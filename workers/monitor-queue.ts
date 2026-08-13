import * as db from "../server/db";
import { withHyperdriveDatabase } from "../server/db";
import { withCloudflareEnv, type CloudflareRuntimeEnv } from "../server/_core/cloudflare-env";
import { analyzeArticle } from "../server/monitor/analyzer";
import {
  alertThresholdMet,
  dispatchHighThreatAlert,
  sendBriefing,
} from "../server/monitor/notify";
import { sendEmailAlert } from "../server/monitor/email-alert";
import { dispatchNotification } from "../server/_core/notification";
import * as budget from "../server/monitor/budget";
import { enabledSources } from "../server/monitor/sources/registry";
import { RSS_FEEDS } from "../server/monitor/sources/rss-source";
import {
  GATE_LIST_URLS,
  getGateRenderDiagnostic,
  parseGateFeed,
} from "../server/monitor/sources/gate-source";
import { TELEGRAM_CHANNELS } from "../server/monitor/sources/telegram-source";
import {
  CHINESE_SOCIAL_PLATFORMS,
  CHINESE_SOCIAL_SOURCE_NAMES,
} from "../server/monitor/sources/chinese-social-source";
import type { DiscoveredPost } from "../server/monitor/sources/types";
import { searchWeb } from "../server/monitor/search";
import {
  detectContentLang,
  domainOf,
  hasCJK,
  keywordMatchesText,
  monitorContentHash,
  monitorPublishedAtFreshness,
  normalizeUrl,
  parseSerperDate,
  sha256,
} from "../server/monitor/util";
import {
  isSearchIntermediaryUrl,
  sourceDateFreshness,
  verifySourcePublishedAt,
  type SourceDateVerification,
} from "../server/monitor/source-date";
import {
  cleanupOldArticles,
} from "../server/monitor/cleanup";
import { recordFetchAttempt } from "../server/monitor/fetch/observability";
import {
  generateMonitorReport,
  monthlyPeriodOf,
  weeklyPeriodOf,
} from "../server/monitor/report";
import type {
  CoordinatorStats,
  MonitorProfile,
  SourceDiagnostic,
} from "./monitor-coordinator";
import type {
  BrowserShadowBudgetState,
  BrowserShadowResultSummary,
} from "./browser-shadow-budget";
import type { FulltextBrowserResult } from "./fulltext-browser";
import type { ChineseSocialBrowserResult } from "./chinese-social-browser";
import type {
  AcceptanceCycleRecord,
  BinanceAcceptanceRecord,
  BrowserAcceptanceRecord,
  GeoAcceptanceRecord,
  NotificationAcceptanceRecord,
} from "./migration-acceptance-types";
import {
  binanceBrowserNeedsFallback,
  type BinanceBrowserSearchResult,
} from "./binance-square-browser";
import {
  getCloudflareFeatureFlags,
  type CloudflareFeatureEnv,
} from "./feature-flags";
import {
  runCloudflareGeoDailyShard,
  runCloudflareGeoWeeklyShard,
} from "../server/routers";
import {
  isFreshHealthyOpenRouter,
  probeOpenRouter,
  type OpenRouterPreflightResult,
} from "./openrouter-preflight";

type CronBindings = Pick<
  CronWorkerEnv,
  | "BINANCE_BROWSER"
  | "CHINESE_SOCIAL_BROWSER"
  | "BROWSER_SHADOW_BUDGET"
  | "FULLTEXT_BROWSER"
  | "HYPERDRIVE"
  | "MIGRATION_ACCEPTANCE"
  | "MONITOR_COORDINATOR"
  | "BROWSER_SHADOW_QUEUE"
  | "MONITOR_QUEUE"
>;

export type QueueEnv = CloudflareRuntimeEnv & CronBindings & CloudflareFeatureEnv & {
  ENABLE_CLOUDFLARE_CRON?: string;
  CLOUDFLARE_CRON_MODE?: string;
  CLOUDFLARE_PRIMARY_MAX_KEYWORDS?: string;
  CLOUDFLARE_PRIMARY_NEWS_MAX_ARTICLES?: string;
  CLOUDFLARE_PRIMARY_SOCIAL_MAX_ARTICLES?: string;
  CLOUDFLARE_CHINESE_SOCIAL_ENABLED?: string;
  CLOUDFLARE_CHINESE_SOCIAL_INTERVAL_HOURS?: string;
  CLOUDFLARE_CHINESE_SOCIAL_MAX_KEYWORDS?: string;
  CLOUDFLARE_CHINESE_SOCIAL_KEYWORDS?: string;
  CLOUDFLARE_CHINESE_SOCIAL_PLATFORMS?: string;
  CLOUDFLARE_CHINESE_SOCIAL_BROWSER_ENABLED?: string;
  CLOUDFLARE_CHINESE_SOCIAL_BROWSER_MAX_CALLS_PER_RUN?: string;
  CLOUDFLARE_BINANCE_SHADOW_ENABLED?: string;
  CLOUDFLARE_BINANCE_WRITE_ENABLED?: string;
  CLOUDFLARE_BINANCE_MAX_QUERIES?: string;
  CLOUDFLARE_BINANCE_QUERY_TERMS?: string;
  CLOUDFLARE_BINANCE_INTERVAL_HOURS?: string;
  CLOUDFLARE_BROWSER_FULLTEXT_MAX_PAGES_PER_DAY?: string;
  CLOUDFLARE_BROWSER_FULLTEXT_MAX_MS_PER_DAY?: string;
  CLOUDFLARE_BROWSER_FULLTEXT_TIMEOUT_MS?: string;
  CLOUDFLARE_BROWSER_FULLTEXT_COOLDOWN_SECONDS?: string;
  CLOUDFLARE_GATE_FIRECRAWL_ENABLED?: string;
  CLOUDFLARE_GATE_BROWSER_INTERVAL_HOURS?: string;
  CLOUDFLARE_GATE_SERPER_QUERY_TERMS?: string;
  CLOUDFLARE_ACCEPTANCE_WINDOW_START?: string;
  CLOUDFLARE_STAGE3_REQUIRED_DAYS?: string;
  CLOUDFLARE_GEO_DAILY_MAX_CELLS?: string;
  CLOUDFLARE_GEO_DAILY_TOTAL_CELLS?: string;
  CLOUDFLARE_GEO_DAILY_CONCURRENCY?: string;
  CLOUDFLARE_GEO_DAILY_START_HOUR?: string;
  CLOUDFLARE_GEO_DAILY_REQUIRE_OPENROUTER_PREFLIGHT?: string;
  CLOUDFLARE_GEO_WEEKLY_ALL_PLATFORMS?: string;
  CLOUDFLARE_GEO_WEEKLY_MAX_CELLS?: string;
  CLOUDFLARE_GEO_WEEKLY_CONCURRENCY?: string;
  CLOUDFLARE_GEO_WEEKLY_MAX_TOKENS?: string;
  CLOUDFLARE_GEO_WEEKLY_START_HOUR?: string;
  CLOUDFLARE_OPENROUTER_PREFLIGHT_MODEL?: string;
  CLOUDFLARE_OPENROUTER_PREFLIGHT_MAX_AGE_HOURS?: string;
  CLOUDFLARE_BRIEFING_MODE?: string;
  CLOUDFLARE_STAGE6_WINDOW_START?: string;
  CLOUDFLARE_STAGE6_REQUIRED_DAYS?: string;
  CLOUDFLARE_GEO_CATCHUP_DELAY_SECONDS?: string;
};

type Keyword = { keyword: string; priority: number };

type BootstrapTask = {
  kind: "bootstrap";
  cycleId: string;
  profile: MonitorProfile;
  scheduledTime: number;
  forceChineseSocial?: boolean;
};

type DiscoveryTask = {
  kind: "discovery";
  cycleId: string;
  profile: MonitorProfile;
  taskId: string;
  sourceName: string;
  shard?: string;
  keywords: Keyword[];
  budgetReserved?: boolean;
  serperFallbacksReserved?: number;
  fallbackOnly?: boolean;
  browserPreferred?: boolean;
};

type CandidateTask = {
  kind: "candidate";
  cycleId: string;
  profile: MonitorProfile;
  deliveryId: string;
  urlHash: string;
  normalizedUrl: string;
  post: DiscoveredPost;
  matchedKeywords: string[];
};

type MaintenanceTask = {
  kind: "maintenance";
  task: "cleanup" | "weekly_report" | "monthly_report";
  scheduledTime: number;
};

type FreshnessAuditTask = {
  kind: "freshness_audit";
  auditId: string;
  scheduledTime: number;
  cursor?: number;
  checked?: number;
  deleted?: number;
  corrected?: number;
  unverifiable?: number;
  failed?: number;
};

type BinanceProbeTask = {
  kind: "binance_probe";
  scheduledTime: number;
};

type GeoDailyShardTask = {
  kind: "geo_daily_shard";
  scheduledTime: number;
  catchUp?: boolean;
};

type GeoWeeklyShardTask = {
  kind: "geo_weekly_shard";
  scheduledTime: number;
  catchUp?: boolean;
};

type OpenRouterPreflightTask = {
  kind: "openrouter_preflight";
  scheduledTime: number;
};

export type BrowserShadowTask = {
  kind: "browser_shadow";
  urlHash: string;
  url: string;
  sourcePlatform: string;
  originalChars: number;
};

type PostCycleTask = {
  kind: "post_cycle";
  cycleId: string;
  profile: MonitorProfile;
  status: "success" | "partial_failure";
  keywords: number;
  sourceCount: number;
  inserted: number;
  briefingItems: CoordinatorStats["briefingItems"];
};

export type QueueTask =
  | BootstrapTask
  | DiscoveryTask
  | CandidateTask
  | MaintenanceTask
  | FreshnessAuditTask
  | BinanceProbeTask
  | GeoDailyShardTask
  | GeoWeeklyShardTask
  | OpenRouterPreflightTask
  | BrowserShadowTask
  | PostCycleTask;

const SOURCE_LIMITS: Record<string, number> = {
  serper: 5,
  rss: 5,
  gate_square: 8,
  telegram: 5,
  x: 20,
  binance_square_browser: 15,
  xiaohongshu_serper: 10,
  douyin_serper: 10,
  kuaishou_serper: 10,
  bilibili_serper: 10,
  weibo_serper: 10,
  tieba_serper: 10,
  zhihu_serper: 10,
};

const BINANCE_BROWSER_SOURCE = "binance_square_browser";

const CF_STATUS_KEYS = {
  mode: "cf_cron_mode",
  task: "cf_cron_last_task",
  status: "cf_cron_last_status",
  startedAt: "cf_cron_last_started_at",
  finishedAt: "cf_cron_last_finished_at",
  summary: "cf_cron_last_summary",
  error: "cf_cron_last_error",
} as const;

const BINANCE_STATUS_KEYS = {
  status: "cf_binance_last_status",
  provider: "cf_binance_last_provider",
  mode: "cf_binance_last_mode",
  startedAt: "cf_binance_last_started_at",
  finishedAt: "cf_binance_last_finished_at",
  summary: "cf_binance_last_summary",
  error: "cf_binance_last_error",
} as const;

const GEO_DAILY_STATUS_KEYS = {
  mode: "cf_geo_daily_mode",
  task: "cf_geo_daily_last_task",
  status: "cf_geo_daily_last_status",
  startedAt: "cf_geo_daily_last_started_at",
  finishedAt: "cf_geo_daily_last_finished_at",
  summary: "cf_geo_daily_last_summary",
  error: "cf_geo_daily_last_error",
} as const;

const GEO_WEEKLY_STATUS_KEYS = {
  mode: "cf_geo_weekly_mode",
  task: "cf_geo_weekly_last_task",
  status: "cf_geo_weekly_last_status",
  startedAt: "cf_geo_weekly_last_started_at",
  finishedAt: "cf_geo_weekly_last_finished_at",
  summary: "cf_geo_weekly_last_summary",
  error: "cf_geo_weekly_last_error",
} as const;

const OPENROUTER_PREFLIGHT_STATUS_KEYS = {
  status: "cf_openrouter_preflight_status",
  checkedAt: "cf_openrouter_preflight_checked_at",
  summary: "cf_openrouter_preflight_summary",
  error: "cf_openrouter_preflight_error",
} as const;

const CLEANUP_STATUS_KEYS = {
  status: "cf_cleanup_last_status",
  startedAt: "cf_cleanup_last_started_at",
  finishedAt: "cf_cleanup_last_finished_at",
  summary: "cf_cleanup_last_summary",
  error: "cf_cleanup_last_error",
} as const;

const FRESHNESS_AUDIT_STATUS_KEYS = {
  status: "cf_freshness_audit_last_status",
  startedAt: "cf_freshness_audit_last_started_at",
  finishedAt: "cf_freshness_audit_last_finished_at",
  summary: "cf_freshness_audit_last_summary",
  error: "cf_freshness_audit_last_error",
} as const;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function binanceEnabled(env: QueueEnv): boolean {
  const flags = getCloudflareFeatureFlags(env);
  return flags.binanceShadow || flags.binanceWrite;
}

function binanceDue(cycle: BootstrapTask, env: QueueEnv): boolean {
  if (cycle.profile !== "monitor_primary_social" || !binanceEnabled(env)) return false;
  const interval = Math.max(2, positiveInt(env.CLOUDFLARE_BINANCE_INTERVAL_HOURS, 6));
  return shanghaiParts(cycle.scheduledTime).hour % interval === 3 % interval;
}

function configuredChineseSocialSources(env: QueueEnv): string[] {
  const allowed = new Set(CHINESE_SOCIAL_SOURCE_NAMES);
  return (env.CLOUDFLARE_CHINESE_SOCIAL_PLATFORMS ||
    CHINESE_SOCIAL_PLATFORMS.map((platform) => platform.key).join(","))
    .split(",")
    .map((value) => `${value.trim().replace(/_serper$/, "")}_serper`)
    .filter((value, index, values) => allowed.has(value) && values.indexOf(value) === index);
}

function configuredChineseSocialKeywords(
  env: QueueEnv,
  activeKeywords: Keyword[],
): Keyword[] {
  const configured = (env.CLOUDFLARE_CHINESE_SOCIAL_KEYWORDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter((value, index, values) => Boolean(value) && values.indexOf(value) === index);
  const max = Math.min(10, positiveInt(env.CLOUDFLARE_CHINESE_SOCIAL_MAX_KEYWORDS, 5));
  if (configured.length > 0) {
    return configured.slice(0, max).map((keyword) => ({ keyword, priority: 10 }));
  }
  return activeKeywords.slice(0, max);
}

function chineseSocialDue(cycle: BootstrapTask, env: QueueEnv): boolean {
  if (cycle.profile !== "monitor_primary_social") return false;
  if (cycle.forceChineseSocial) return true;
  const flags = getCloudflareFeatureFlags(env);
  if (!flags.chineseSocial) return false;
  const interval = Math.max(2, positiveInt(env.CLOUDFLARE_CHINESE_SOCIAL_INTERVAL_HOURS, 2));
  return shanghaiParts(cycle.scheduledTime).hour % interval === 3 % interval;
}

function chineseSocialBrowserEnabled(env: QueueEnv): boolean {
  return env.CLOUDFLARE_CHINESE_SOCIAL_BROWSER_ENABLED !== "false";
}

function coordinator(env: QueueEnv, profile: MonitorProfile) {
  return env.MONITOR_COORDINATOR.get(env.MONITOR_COORDINATOR.idFromName(profile));
}

function browserShadowBudget(env: QueueEnv) {
  return env.BROWSER_SHADOW_BUDGET.get(
    env.BROWSER_SHADOW_BUDGET.idFromName("fulltext-browser-shadow"),
  );
}

function acceptanceLedger(env: QueueEnv) {
  return env.MIGRATION_ACCEPTANCE.get(
    env.MIGRATION_ACCEPTANCE.idFromName("cloudflare-migration-acceptance"),
  );
}

async function recordAcceptance(
  env: QueueEnv,
  path: string,
  record: unknown,
): Promise<void> {
  try {
    const response = await acceptanceLedger(env).fetch(`https://acceptance${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(record),
    });
    if (!response.ok) {
      console.warn(JSON.stringify({
        event: "migration_acceptance.record_failed",
        path,
        status: response.status,
      }));
    }
  } catch (error) {
    // Acceptance telemetry must never fail a production collection task.
    console.warn(JSON.stringify({
      event: "migration_acceptance.record_failed",
      path,
      error: String(error).slice(0, 300),
    }));
  }
}

export async function getMigrationAcceptanceStatus(env: QueueEnv): Promise<unknown> {
  const windowStart = Math.max(
    0,
    Number(env.CLOUDFLARE_ACCEPTANCE_WINDOW_START) || Date.now() - 7 * 86_400_000,
  );
  const response = await acceptanceLedger(env).fetch(
    `https://acceptance/status?windowStart=${windowStart}&stage6WindowStart=${
      Math.max(0, Number(env.CLOUDFLARE_STAGE6_WINDOW_START) || 0)
    }&stage3RequiredDays=${
      Math.max(0, Number(env.CLOUDFLARE_STAGE3_REQUIRED_DAYS ?? "7") || 0)
    }&stage6RequiredDays=${
      Math.max(0, Number(env.CLOUDFLARE_STAGE6_REQUIRED_DAYS ?? "14") || 0)
    }`,
  );
  if (!response.ok) throw new Error(`migration acceptance status HTTP ${response.status}`);
  return response.json();
}

export async function getBrowserShadowStatus(
  env: QueueEnv,
): Promise<BrowserShadowBudgetState | { status: "idle" }> {
  const response = await browserShadowBudget(env).fetch("https://browser-shadow-budget/status");
  if (!response.ok) throw new Error(`browser shadow budget status HTTP ${response.status}`);
  return response.json();
}

async function coordinatorPost<T>(
  env: QueueEnv,
  profile: MonitorProfile,
  path: string,
  body: unknown,
): Promise<T> {
  const response = await coordinator(env, profile).fetch(`https://coordinator${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`coordinator ${path} HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return response.json<T>();
}

export async function getCoordinatorStatus(
  env: QueueEnv,
  profile: MonitorProfile,
): Promise<CoordinatorStats | { status: "idle" }> {
  const response = await coordinator(env, profile).fetch("https://coordinator/status");
  if (!response.ok) throw new Error(`coordinator status HTTP ${response.status}`);
  return response.json();
}

function statusSummary(state: CoordinatorStats): string {
  const { briefingItems: _briefingItems, ...summary } = state;
  return JSON.stringify(summary).slice(0, 4000);
}

function cycleAcceptanceRecord(
  state: CoordinatorStats,
  env: QueueEnv,
): AcceptanceCycleRecord {
  const flags = getCloudflareFeatureFlags(env);
  return {
    cycleId: state.cycleId,
    profile: state.profile,
    status: state.status === "partial_failure" ? "partial_failure" : "success",
    startedAt: state.startedAt,
    finishedAt: state.finishedAt || Date.now(),
    discovered: state.discovered,
    accepted: state.accepted,
    completed: state.completed,
    inserted: state.inserted,
    analyzed: state.analyzed,
    analysisFailed: state.analysisFailed,
    failed: state.failed,
    analysisNeurons: state.analysisNeurons,
    analysisFallbacks: state.analysisFallbacks,
    analysisCostUsd: state.analysisCostUsd,
    analysisProviderDist: state.analysisProviderDist || {},
    sourceDist: state.sourceDist || {},
    insertedSourceDist: state.insertedSourceDist || {},
    dedupExisting: state.dedupExisting || 0,
    dedupConflicts: state.dedupConflicts || 0,
    realtimeAlerts: state.realtimeAlerts || 0,
    featureFlags: {
      realtimeAlerts: flags.realtimeAlerts,
      briefing: flags.briefing,
      failureNotifications: flags.failureNotifications,
    },
    sourceDiagnostics: state.sourceDiagnostics || {},
    fetchTelemetry: state.fetchTelemetry || {
      attempts: 0,
      successes: 0,
      fallbacks: 0,
      durationMs: 0,
      contentChars: 0,
      costUsd: 0,
      engineDist: {},
      failureReasons: {},
      domains: {},
    },
  };
}

async function enqueuePostCycleIfEnabled(
  env: QueueEnv,
  state: CoordinatorStats,
): Promise<void> {
  const flags = getCloudflareFeatureFlags(env);
  if (
    !flags.briefing &&
    !(flags.failureNotifications && state.status === "partial_failure")
  ) {
    return;
  }
  const claim = await coordinatorPost<{
    accepted: boolean;
  }>(env, state.profile, "/claim-post-cycle", { cycleId: state.cycleId });
  if (!claim.accepted) return;
  await env.MONITOR_QUEUE.send({
    kind: "post_cycle",
    cycleId: state.cycleId,
    profile: state.profile,
    status: state.status,
    keywords: state.keywords,
    sourceCount: state.sources.length,
    inserted: state.inserted,
    briefingItems: state.briefingItems,
  } satisfies PostCycleTask);
}

async function syncLegacyStatus(env: QueueEnv, state: CoordinatorStats): Promise<void> {
  const terminal = state.status === "success" || state.status === "partial_failure";
  const error = state.status === "partial_failure"
    ? `${state.discoveryFailed} discovery failures; ${state.analysisFailed} analysis failures; ${state.failed} item failures`
    : "";
  await Promise.all([
    db.setSysConfig(CF_STATUS_KEYS.mode, "primary"),
    db.setSysConfig(CF_STATUS_KEYS.task, state.profile),
    db.setSysConfig(CF_STATUS_KEYS.status, state.status),
    db.setSysConfig(CF_STATUS_KEYS.startedAt, String(state.startedAt)),
    db.setSysConfig(CF_STATUS_KEYS.finishedAt, terminal ? String(state.finishedAt || Date.now()) : ""),
    db.setSysConfig(CF_STATUS_KEYS.summary, statusSummary(state)),
    db.setSysConfig(CF_STATUS_KEYS.error, error),
  ]);
  if (terminal) {
    await recordAcceptance(env, "/record-cycle", cycleAcceptanceRecord(state, env));
    await enqueuePostCycleIfEnabled(env, state);
  }
}

function buildDiscoveryTasks(
  cycle: BootstrapTask,
  keywords: Keyword[],
  budgetGrant: { firecrawl: number; serper: number; xAvailable: boolean },
  env: QueueEnv,
): DiscoveryTask[] {
  const base = {
    kind: "discovery" as const,
    cycleId: cycle.cycleId,
    profile: cycle.profile,
  };
  if (cycle.profile === "monitor_primary_news") {
    const serper = keywords.slice(0, budgetGrant.serper).map((keyword, index) => ({
      ...base,
      taskId: `serper:${index}`,
      sourceName: "serper",
      keywords: [keyword],
      budgetReserved: true,
    }));
    const rss = RSS_FEEDS.map((shard, index) => ({
      ...base,
      taskId: `rss:${index}`,
      sourceName: "rss",
      shard,
      keywords,
    }));
    return [...serper, ...rss];
  }

  const gateFirecrawlEnabled = env.CLOUDFLARE_GATE_FIRECRAWL_ENABLED !== "false";
  const gate = gateFirecrawlEnabled
    ? GATE_LIST_URLS.map((shard, index) => ({
        ...base,
        taskId: `gate_square:${index}`,
        sourceName: "gate_square",
        shard,
        keywords,
        budgetReserved: index < budgetGrant.firecrawl,
        fallbackOnly: false,
      }))
    : [{
        ...base,
        taskId: "gate_square:serper",
        sourceName: "gate_square",
        keywords,
        fallbackOnly: true,
      }];
  const telegram = TELEGRAM_CHANNELS.map((shard, index) => ({
    ...base,
    taskId: `telegram:${index}`,
    sourceName: "telegram",
    shard,
    keywords,
  }));
  const x = budgetGrant.xAvailable
    ? [{
        ...base,
        taskId: "x:0",
        sourceName: "x",
        keywords,
        budgetReserved: true,
      }]
    : [];
  const binance = binanceDue(cycle, env)
    ? [{
        ...base,
        taskId: `${BINANCE_BROWSER_SOURCE}:0`,
        sourceName: BINANCE_BROWSER_SOURCE,
        keywords,
        budgetReserved: budgetGrant.serper > 0,
      }]
    : [];
  const chineseSocialKeywords = configuredChineseSocialKeywords(env, keywords);
  let remainingSerper = Math.max(
    0,
    budgetGrant.serper - (binance.length > 0 ? 1 : 0),
  );
  let remainingBrowserCalls = chineseSocialBrowserEnabled(env)
    ? Math.min(50, positiveInt(env.CLOUDFLARE_CHINESE_SOCIAL_BROWSER_MAX_CALLS_PER_RUN, 35))
    : 0;
  const chineseSocial: DiscoveryTask[] = [];
  if (chineseSocialDue(cycle, env) && chineseSocialKeywords.length > 0) {
    for (const sourceName of configuredChineseSocialSources(env)) {
      const browserKeywordCount = Math.min(chineseSocialKeywords.length, remainingBrowserCalls);
      const fallbackKeywordCount = Math.min(chineseSocialKeywords.length, remainingSerper);
      const taskKeywordCount = Math.max(browserKeywordCount, fallbackKeywordCount);
      const taskKeywords = chineseSocialKeywords.slice(0, taskKeywordCount);
      if (taskKeywords.length === 0) break;
      chineseSocial.push({
        ...base,
        taskId: `${sourceName}:0`,
        sourceName,
        keywords: taskKeywords,
        budgetReserved: fallbackKeywordCount > 0,
        serperFallbacksReserved: fallbackKeywordCount,
        browserPreferred: browserKeywordCount === taskKeywords.length,
      });
      remainingBrowserCalls = Math.max(0, remainingBrowserCalls - browserKeywordCount);
      remainingSerper = Math.max(0, remainingSerper - fallbackKeywordCount);
    }
  }
  return [...gate, ...telegram, ...x, ...binance, ...chineseSocial];
}

async function bootstrap(task: BootstrapTask, env: QueueEnv): Promise<void> {
  const scheduler = await db.getSchedulerConfig();
  if (!scheduler?.monitorEnabled) return;
  const allKeywords = await db.listMonitorKeywords(true);
  const maxKeywords = positiveInt(env.CLOUDFLARE_PRIMARY_MAX_KEYWORDS, 100);
  const keywords = allKeywords.slice(0, maxKeywords).map((item) => ({
    keyword: item.keyword,
    priority: item.priority,
  }));
  const isNews = task.profile === "monitor_primary_news";
  const runBinance = binanceDue(task, env);
  const runChineseSocial = chineseSocialDue(task, env);
  const chineseSocialKeywordCount = configuredChineseSocialKeywords(env, keywords).length;
  const chineseSocialSerperCalls = runChineseSocial
    && !chineseSocialBrowserEnabled(env)
    ? configuredChineseSocialSources(env).length * chineseSocialKeywordCount
    : 0;
  const gateFirecrawlEnabled = env.CLOUDFLARE_GATE_FIRECRAWL_ENABLED !== "false";
  const budgetGrant = await budget.reserveQueuedBudget({
    serper: isNews
      ? keywords.length
      : (runBinance ? 1 : 0) + chineseSocialSerperCalls,
    firecrawl: isNews || !gateFirecrawlEnabled ? 0 : GATE_LIST_URLS.length,
  });
  const discoveryTasks = buildDiscoveryTasks(task, keywords, budgetGrant, env);
  const maxArticles = isNews
    ? positiveInt(env.CLOUDFLARE_PRIMARY_NEWS_MAX_ARTICLES, 12)
    : positiveInt(env.CLOUDFLARE_PRIMARY_SOCIAL_MAX_ARTICLES, 14);
  const state = await coordinatorPost<CoordinatorStats>(env, task.profile, "/start", {
    cycleId: task.cycleId,
    profile: task.profile,
    maxArticles,
    keywords: keywords.length,
    sources: isNews
      ? ["serper", "rss"]
      : [
          "gate_square",
          "telegram",
          "x",
          ...(discoveryTasks.some((item) => item.sourceName === BINANCE_BROWSER_SOURCE)
            ? ["binance_square"]
            : []),
          ...configuredChineseSocialSources(env)
            .filter((sourceName) =>
              discoveryTasks.some((item) => item.sourceName === sourceName),
            )
            .map((sourceName) => sourceName.replace(/_serper$/, "")),
        ],
    discoveryExpected: discoveryTasks.length,
  });
  await syncLegacyStatus(env, state);
  if (discoveryTasks.length === 0) return;
  await env.MONITOR_QUEUE.sendBatch(discoveryTasks.map((body) => ({ body })));
}

function configuredBinanceTerms(env: QueueEnv): string[] {
  return (env.CLOUDFLARE_BINANCE_QUERY_TERMS || "孙宇晨,TRON")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 4);
}

function binanceQueries(env: QueueEnv): string[] {
  const max = Math.min(4, positiveInt(env.CLOUDFLARE_BINANCE_MAX_QUERIES, 1));
  return configuredBinanceTerms(env).slice(0, max);
}

function sourceDiagnostic(
  result: BinanceBrowserSearchResult,
  mode: "shadow" | "write",
  provider: "browser" | "serper",
  enqueued: number,
): SourceDiagnostic {
  const errors = result.diagnostics
    .filter((item) => item.error)
    .map((item) => `${item.query}: ${item.error}`)
    .slice(0, 3);
  const status =
    !result.ok
      ? "failed"
      : errors.length > 0
        ? "partial"
        : result.posts.length > 0
          ? "success"
          : "empty";
  return {
    status,
    mode,
    provider,
    discovered: result.posts.length,
    enqueued,
    durationMs: result.durationMs,
    queriesAttempted: result.queriesAttempted,
    queriesSucceeded: result.queriesSucceeded,
    ...(errors.length > 0 ? { errors } : {}),
    updatedAt: Date.now(),
  };
}

function binanceAcceptanceRecord(input: {
  runId: string;
  mode: "shadow" | "write";
  provider: "browser" | "serper";
  result: BinanceBrowserSearchResult;
  matched: Map<string, MatchedPost>;
  enqueued: number;
  startedAt: number;
}): BinanceAcceptanceRecord {
  const diagnostic = sourceDiagnostic(
    input.result,
    input.mode,
    input.provider,
    input.enqueued,
  );
  const sampleUrls = Array.from(input.matched.values())
    .slice(0, 3)
    .map((item) => item.post.url);
  return {
    runId: input.runId,
    mode: input.mode,
    provider: input.provider,
    status: diagnostic.status,
    startedAt: input.startedAt,
    finishedAt: Date.now(),
    rawPosts: input.result.posts.length,
    matchedPosts: input.matched.size,
    enqueued: input.enqueued,
    queriesAttempted: input.result.queriesAttempted,
    queriesSucceeded: input.result.queriesSucceeded,
    validSampleUrls: sampleUrls.filter((url) => binancePostUrl(url) != null).length,
    invalidSampleUrls: sampleUrls.filter((url) => binancePostUrl(url) == null).length,
    errors: diagnostic.errors || [],
  };
}

function binancePostUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!/(^|\.)binance\.com$/i.test(url.hostname)) return null;
    if (!/\/square\/post\/[^/]+/i.test(url.pathname)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

async function searchBinanceViaSerper(env: QueueEnv): Promise<DiscoveredPost[]> {
  const queryTerms = configuredBinanceTerms(env)
    .map((term) => /\s/.test(term) ? `"${term}"` : term)
    .join(" OR ");
  const results = await searchWeb(
    `site:binance.com/zh-CN/square/post (${queryTerms})`,
    { tbs: "qdr:w", num: 10, gl: "us", hl: "zh-cn" },
  );
  const posts: DiscoveredPost[] = [];
  const seen = new Set<string>();
  for (const item of results) {
    const url = binancePostUrl(item.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    posts.push({
      url,
      title: item.title,
      contentSnippet: item.snippet,
      author: item.source,
      publishedAt: parseSerperDate(item.date),
      sourceName: "binance_square_serper",
      sourcePlatform: "binance_square",
      fetchEngineHint: "serper_site_search",
      fetchCostUsdHint: 0,
    });
  }
  return posts;
}

async function fetchBinancePosts(
  env: QueueEnv,
  serperBudgetReserved: boolean,
): Promise<{ result: BinanceBrowserSearchResult; provider: "browser" | "serper" }> {
  const startedAt = Date.now();
  let browserResult: BinanceBrowserSearchResult;
  try {
    const response = await env.BINANCE_BROWSER.fetch("https://binance-browser/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        queries: binanceQueries(env),
        pageSize: 20,
      }),
      signal: AbortSignal.timeout(55_000),
    });
    if (!response.ok) {
      throw new Error(
        `Binance Browser Worker HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`,
      );
    }
    browserResult = await response.json<BinanceBrowserSearchResult>();
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    browserResult = {
      ok: false,
      posts: [],
      durationMs: Date.now() - startedAt,
      sessionId: "",
      queriesAttempted: binanceQueries(env).length,
      queriesSucceeded: 0,
      diagnostics: [{
        query: "browser",
        status: "failed",
        posts: 0,
        error: message,
      }],
    };
  }
  if (!binanceBrowserNeedsFallback(browserResult) || !serperBudgetReserved) {
    return { result: browserResult, provider: "browser" };
  }

  try {
    const posts = await searchBinanceViaSerper(env);
    return {
      provider: "serper",
      result: {
        ...browserResult,
        ok: true,
        posts,
        durationMs: Date.now() - startedAt,
        queriesAttempted: browserResult.queriesAttempted + 1,
        queriesSucceeded: 1,
        diagnostics: [
          ...browserResult.diagnostics,
          {
            query: "serper_site_search",
            status: posts.length > 0 ? "success" : "empty",
            posts: posts.length,
          },
        ],
      },
    };
  } catch (error) {
    return {
      provider: "serper",
      result: {
        ...browserResult,
        durationMs: Date.now() - startedAt,
        queriesAttempted: browserResult.queriesAttempted + 1,
        diagnostics: [
          ...browserResult.diagnostics,
          {
            query: "serper_site_search",
            status: "failed",
            posts: 0,
            error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
          },
        ],
      },
    };
  }
}

type MatchedPost = {
  post: DiscoveredPost;
  normalizedUrl: string;
  matched: Set<string>;
};

function matchBinancePosts(
  sourcePosts: DiscoveredPost[],
  keywords: Keyword[],
): Map<string, MatchedPost> {
  const posts = new Map<string, MatchedPost>();
  for (const post of sourcePosts) {
    if (!post.url) continue;
    const content = `${post.title || ""} ${post.fullContent || post.contentSnippet || ""}`;
    const matched = keywords
      .filter((keyword) => keywordMatchesText(keyword.keyword, content))
      .map((keyword) => keyword.keyword);
    if (matched.length === 0) continue;
    const normalizedUrl = normalizeUrl(post.url);
    const urlHash = sha256(normalizedUrl);
    const current = posts.get(urlHash);
    if (current) matched.forEach((keyword) => current.matched.add(keyword));
    else posts.set(urlHash, {
      post,
      normalizedUrl,
      matched: new Set(matched),
    });
  }
  return posts;
}

export async function getBinanceProbeStatus(): Promise<Record<string, string | null>> {
  return Object.fromEntries(await Promise.all(
    Object.entries(BINANCE_STATUS_KEYS).map(async ([name, key]) => [
      name,
      await db.getSysConfig(key),
    ]),
  ));
}

export async function getGeoQueueStatus(): Promise<{
  daily: Record<string, string | null>;
  weekly: Record<string, string | null>;
}> {
  const read = async (keys: Record<string, string>) => Object.fromEntries(await Promise.all(
    Object.entries(keys).map(async ([name, key]) => [name, await db.getSysConfig(key)]),
  ));
  return {
    daily: await read(GEO_DAILY_STATUS_KEYS),
    weekly: await read(GEO_WEEKLY_STATUS_KEYS),
  };
}

export async function getOpenRouterPreflightStatus(): Promise<{
  status: string | null;
  checkedAt: string | null;
  summary: string | null;
  error: string | null;
}> {
  return {
    status: await db.getSysConfig(OPENROUTER_PREFLIGHT_STATUS_KEYS.status),
    checkedAt: await db.getSysConfig(OPENROUTER_PREFLIGHT_STATUS_KEYS.checkedAt),
    summary: await db.getSysConfig(OPENROUTER_PREFLIGHT_STATUS_KEYS.summary),
    error: await db.getSysConfig(OPENROUTER_PREFLIGHT_STATUS_KEYS.error),
  };
}

export async function getCleanupStatus(): Promise<Record<string, string | null>> {
  return Object.fromEntries(await Promise.all(
    Object.entries(CLEANUP_STATUS_KEYS).map(async ([name, key]) => [
      name,
      await db.getSysConfig(key),
    ]),
  ));
}

export async function getFreshnessAuditStatus(): Promise<Record<string, string | null>> {
  return Object.fromEntries(await Promise.all(
    Object.entries(FRESHNESS_AUDIT_STATUS_KEYS).map(async ([name, key]) => [
      name,
      await db.getSysConfig(key),
    ]),
  ));
}

async function readOpenRouterPreflightResult(): Promise<OpenRouterPreflightResult | null> {
  const summary = await db.getSysConfig(OPENROUTER_PREFLIGHT_STATUS_KEYS.summary);
  if (!summary) return null;
  try {
    return JSON.parse(summary) as OpenRouterPreflightResult;
  } catch {
    return null;
  }
}

async function runOpenRouterPreflight(
  task: OpenRouterPreflightTask,
  env: QueueEnv,
): Promise<void> {
  const result = await probeOpenRouter({
    apiKey: env.OPENROUTER_API_KEY,
    baseUrl: env.OPENROUTER_BASE_URL,
    model: env.CLOUDFLARE_OPENROUTER_PREFLIGHT_MODEL,
    checkedAt: task.scheduledTime,
  });
  await Promise.all([
    db.setSysConfig(OPENROUTER_PREFLIGHT_STATUS_KEYS.status, result.status),
    db.setSysConfig(OPENROUTER_PREFLIGHT_STATUS_KEYS.checkedAt, String(result.checkedAt)),
    db.setSysConfig(OPENROUTER_PREFLIGHT_STATUS_KEYS.summary, JSON.stringify(result).slice(0, 2000)),
    db.setSysConfig(OPENROUTER_PREFLIGHT_STATUS_KEYS.error, result.error || ""),
  ]);
  console.log(JSON.stringify({ event: "openrouter_preflight.result", ...result }));
}

async function runObservedGeoShard(
  env: QueueEnv,
  task: GeoDailyShardTask | GeoWeeklyShardTask,
): Promise<void> {
  const daily = task.kind === "geo_daily_shard";
  const keys = daily ? GEO_DAILY_STATUS_KEYS : GEO_WEEKLY_STATUS_KEYS;
  const name = daily ? "geo_daily_shard" : "geo_weekly_openrouter_shard";
  const startedAt = Date.now();
  if (
    !daily ||
    env.CLOUDFLARE_GEO_DAILY_REQUIRE_OPENROUTER_PREFLIGHT === "true"
  ) {
    const preflight = await readOpenRouterPreflightResult();
    const maxAgeHours = positiveInt(
      env.CLOUDFLARE_OPENROUTER_PREFLIGHT_MAX_AGE_HOURS,
      26,
    );
    if (!isFreshHealthyOpenRouter(preflight, startedAt, maxAgeHours)) {
      const cadence = daily ? "daily" : "weekly";
      const reason = preflight
        ? `OpenRouter preflight ${preflight.status}; ${cadence} GEO paused`
        : "OpenRouter preflight missing; GEO collection paused";
      await Promise.all([
        db.setSysConfig(keys.mode, "queue"),
        db.setSysConfig(keys.task, name),
        db.setSysConfig(keys.status, "blocked"),
        db.setSysConfig(keys.startedAt, String(startedAt)),
        db.setSysConfig(keys.finishedAt, String(Date.now())),
        db.setSysConfig(keys.summary, JSON.stringify({ preflight }).slice(0, 4000)),
        db.setSysConfig(keys.error, reason),
      ]);
      console.warn(JSON.stringify({
        event: `${daily ? "geo_daily" : "geo_weekly"}.blocked_by_openrouter_preflight`,
        reason,
      }));
      return;
    }
  }
  await Promise.all([
    db.setSysConfig(keys.mode, "queue"),
    db.setSysConfig(keys.task, name),
    db.setSysConfig(keys.status, "running"),
    db.setSysConfig(keys.startedAt, String(startedAt)),
    db.setSysConfig(keys.error, ""),
  ]);
  try {
    const result = daily
      ? await runCloudflareGeoDailyShard({
          maxCells: positiveInt(env.CLOUDFLARE_GEO_DAILY_MAX_CELLS, 4),
          maxTotalCells: positiveInt(env.CLOUDFLARE_GEO_DAILY_TOTAL_CELLS, 24),
          concurrency: positiveInt(env.CLOUDFLARE_GEO_DAILY_CONCURRENCY, 2),
          timestamp: task.scheduledTime,
        })
      : await runCloudflareGeoWeeklyShard({
          maxCells: positiveInt(env.CLOUDFLARE_GEO_WEEKLY_MAX_CELLS, 6),
          concurrency: positiveInt(env.CLOUDFLARE_GEO_WEEKLY_CONCURRENCY, 3),
          maxTokens: positiveInt(env.CLOUDFLARE_GEO_WEEKLY_MAX_TOKENS, 1536),
          timestamp: task.scheduledTime,
          allPlatforms: env.CLOUDFLARE_GEO_WEEKLY_ALL_PLATFORMS === "true",
        });
    await recordAcceptance(env, "/record-geo", {
      runId: `${name}:${task.scheduledTime}`,
      cadence: daily ? "daily" : "weekly",
      period: daily ? result.day : result.week,
      status: result.failed > 0 ? "partial_failure" : "success",
      batchId: result.batchId,
      totalCells: result.totalCells,
      cursorBefore: result.cursorBefore,
      cursorAfter: result.cursorAfter,
      attempted: result.attempted,
      completed: result.completed,
      failed: result.failed,
      remaining: result.remaining,
      done: result.done,
      provider: result.provider,
      finishedAt: Date.now(),
    } satisfies GeoAcceptanceRecord);
    await Promise.all([
      db.setSysConfig(keys.status, result.failed > 0 ? "partial_failure" : "success"),
      db.setSysConfig(keys.finishedAt, String(Date.now())),
      db.setSysConfig(keys.summary, JSON.stringify(result).slice(0, 4000)),
      db.setSysConfig(
        keys.error,
        result.failed > 0 ? `${result.failed} GEO cells failed` : "",
      ),
    ]);
    if (task.catchUp && result.failed === 0 && result.remaining > 0) {
      await env.MONITOR_QUEUE.send(
        { ...task },
        {
          delaySeconds: Math.min(
            60,
            Math.max(1, positiveInt(env.CLOUDFLARE_GEO_CATCHUP_DELAY_SECONDS, 5)),
          ),
        },
      );
    }
  } catch (error) {
    const message = String(error).slice(0, 1000);
    await recordAcceptance(env, "/record-geo", {
      runId: `${name}:${task.scheduledTime}`,
      cadence: daily ? "daily" : "weekly",
      period: "",
      status: "failed",
      batchId: null,
      totalCells: 0,
      cursorBefore: 0,
      cursorAfter: 0,
      attempted: 0,
      completed: 0,
      failed: 1,
      remaining: 0,
      done: false,
      provider: daily ? "routed" : "openrouter",
      error: message,
      finishedAt: Date.now(),
    } satisfies GeoAcceptanceRecord);
    await Promise.all([
      db.setSysConfig(keys.status, "failed"),
      db.setSysConfig(keys.finishedAt, String(Date.now())),
      db.setSysConfig(keys.error, message),
    ]);
    throw error;
  }
}

async function binanceProbe(task: BinanceProbeTask, env: QueueEnv): Promise<void> {
  const startedAt = Date.now();
  await Promise.all([
    db.setSysConfig(BINANCE_STATUS_KEYS.status, "running"),
    db.setSysConfig(BINANCE_STATUS_KEYS.mode, "shadow"),
    db.setSysConfig(BINANCE_STATUS_KEYS.startedAt, String(startedAt)),
    db.setSysConfig(BINANCE_STATUS_KEYS.error, ""),
  ]);
  try {
    const allKeywords = await db.listMonitorKeywords(true);
    const maxKeywords = positiveInt(env.CLOUDFLARE_PRIMARY_MAX_KEYWORDS, 100);
    const keywords = allKeywords.slice(0, maxKeywords).map((item) => ({
      keyword: item.keyword,
      priority: item.priority,
    }));
    const grant = await budget.reserveQueuedBudget({ serper: 1 });
    const { result, provider } = await fetchBinancePosts(env, grant.serper > 0);
    const matched = matchBinancePosts(result.posts, keywords);
    const diagnostic = {
      ...sourceDiagnostic(result, "shadow", provider, 0),
      discovered: matched.size,
    };
    await recordAcceptance(env, "/record-binance", binanceAcceptanceRecord({
      runId: `probe:${task.scheduledTime}`,
      mode: "shadow",
      provider,
      result,
      matched,
      enqueued: 0,
      startedAt,
    }));
    await Promise.all([
      db.setSysConfig(BINANCE_STATUS_KEYS.status, diagnostic.status),
      db.setSysConfig(BINANCE_STATUS_KEYS.provider, provider),
      db.setSysConfig(BINANCE_STATUS_KEYS.finishedAt, String(Date.now())),
      db.setSysConfig(BINANCE_STATUS_KEYS.summary, JSON.stringify({
        scheduledTime: task.scheduledTime,
        rawPosts: result.posts.length,
        matchedPosts: matched.size,
        samples: Array.from(matched.values()).slice(0, 3).map((item) => ({
          title: item.post.title.slice(0, 160),
          url: item.post.url.slice(0, 500),
        })),
        diagnostic,
      }).slice(0, 4000)),
      db.setSysConfig(BINANCE_STATUS_KEYS.error, (diagnostic.errors || []).join("; ").slice(0, 1000)),
    ]);
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    await recordAcceptance(env, "/record-binance", {
      runId: `probe:${task.scheduledTime}`,
      mode: "shadow",
      provider: "browser",
      status: "failed",
      startedAt,
      finishedAt: Date.now(),
      rawPosts: 0,
      matchedPosts: 0,
      enqueued: 0,
      queriesAttempted: binanceQueries(env).length,
      queriesSucceeded: 0,
      validSampleUrls: 0,
      invalidSampleUrls: 0,
      errors: [message],
    } satisfies BinanceAcceptanceRecord);
    await Promise.all([
      db.setSysConfig(BINANCE_STATUS_KEYS.status, "failed"),
      db.setSysConfig(BINANCE_STATUS_KEYS.finishedAt, String(Date.now())),
      db.setSysConfig(BINANCE_STATUS_KEYS.error, message),
    ]);
  }
}

async function finishDiscovery(
  task: DiscoveryTask,
  env: QueueEnv,
  values: {
    discovered: number;
    enqueued: number;
    failed: boolean;
    sourceName?: string;
    diagnostic?: SourceDiagnostic;
  },
): Promise<void> {
  const state = await coordinatorPost<CoordinatorStats>(
    env,
    task.profile,
    "/discovery-done",
    {
      cycleId: task.cycleId,
      taskId: task.taskId,
      ...values,
    },
  );
  if (state.status === "success" || state.status === "partial_failure") {
    await syncLegacyStatus(env, state);
  }
}

async function discoverBinance(task: DiscoveryTask, env: QueueEnv): Promise<void> {
  const writeEnabled = env.CLOUDFLARE_BINANCE_WRITE_ENABLED === "true";
  const mode = writeEnabled ? "write" : "shadow";
  const { result, provider } = await fetchBinancePosts(
    env,
    task.budgetReserved === true,
  );

  const posts = matchBinancePosts(result.posts, task.keywords);

  const selected = writeEnabled
    ? Array.from(posts.entries()).slice(0, SOURCE_LIMITS[BINANCE_BROWSER_SOURCE])
    : [];
  if (selected.length > 0) {
    await env.MONITOR_QUEUE.sendBatch(selected.map(([urlHash, value]) => ({
      body: {
        kind: "candidate",
        cycleId: task.cycleId,
        profile: task.profile,
        deliveryId: `${task.taskId}:${urlHash}`,
        urlHash,
        normalizedUrl: value.normalizedUrl,
        post: value.post,
        matchedKeywords: Array.from(value.matched),
      },
    })));
  }
  const diagnostic = sourceDiagnostic(result, mode, provider, selected.length);
  await recordAcceptance(env, "/record-binance", binanceAcceptanceRecord({
    runId: `${task.cycleId}:${task.taskId}`,
    mode,
    provider,
    result,
    matched: posts,
    enqueued: selected.length,
    startedAt: Date.now() - result.durationMs,
  }));
  console.log(JSON.stringify({
    event: "binance_square.discovery",
    cycleId: task.cycleId,
    mode,
    provider,
    rawPosts: result.posts.length,
    matchedPosts: posts.size,
    enqueued: selected.length,
    diagnostic,
  }));
  await finishDiscovery(task, env, {
    discovered: posts.size,
    enqueued: selected.length,
    failed: writeEnabled && !result.ok,
    sourceName: "binance_square",
    diagnostic: {
      ...diagnostic,
      discovered: posts.size,
    },
  });
}

type GateSerperItem = {
  url: string;
  title: string;
  snippet: string;
  date: string | null;
  source: string | null;
};

export function mapGateSerperFallback(
  items: GateSerperItem[],
  keywords: Array<{ keyword: string }>,
): Array<{ post: DiscoveredPost; normalizedUrl: string; matchedKeywords: string[] }> {
  const matches = new Map<string, {
    post: DiscoveredPost;
    normalizedUrl: string;
    matchedKeywords: Set<string>;
  }>();
  for (const item of items) {
    let url: URL;
    try {
      url = new URL(item.url);
    } catch {
      continue;
    }
    if (
      !/(^|\.)gate\.com$/i.test(url.hostname) ||
      !/^\/post\/status\/\d+/.test(url.pathname)
    ) continue;
    const text = `${item.title || ""} ${item.snippet || ""}`.trim();
    const matchedKeywords = keywords
      .map((keyword) => keyword.keyword.trim())
      .filter((keyword) => keyword && keywordMatchesText(keyword, text));
    if (matchedKeywords.length === 0) continue;
    const normalizedUrl = normalizeUrl(item.url);
    const urlHash = sha256(normalizedUrl);
    const existing = matches.get(urlHash);
    if (existing) {
      for (const keyword of matchedKeywords) existing.matchedKeywords.add(keyword);
      continue;
    }
    matches.set(urlHash, {
      normalizedUrl,
      matchedKeywords: new Set(matchedKeywords),
      post: {
        url: normalizedUrl,
        title: (item.title || item.snippet || "Gate Square post").slice(0, 512),
        contentSnippet: (item.snippet || item.title || "").slice(0, 4000),
        author: item.source || null,
        publishedAt: parseSerperDate(item.date),
        sourceName: "gate_square_serper",
        sourcePlatform: "gate_square",
      },
    });
  }
  return Array.from(matches.values()).map((value) => ({
    post: value.post,
    normalizedUrl: value.normalizedUrl,
    matchedKeywords: Array.from(value.matchedKeywords),
  }));
}

async function discoverGateViaSerper(
  task: DiscoveryTask,
  env: QueueEnv,
  upstreamErrors: string[],
): Promise<void> {
  const startedAt = Date.now();
  const configuredTerms = (env.CLOUDFLARE_GATE_SERPER_QUERY_TERMS ||
    "TRON,TRX,孙宇晨,Justin Sun")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 4);
  const queryTerms = configuredTerms.length > 0 ? configuredTerms : ["TRON"];
  const grant = await budget.reserveQueuedBudget({ serper: queryTerms.length });
  if (grant.serper < 1) {
    const errors = [...upstreamErrors, "Serper monthly budget unavailable"];
    await finishDiscovery(task, env, {
      discovered: 0,
      enqueued: 0,
      failed: true,
      sourceName: "gate_square",
      diagnostic: {
        status: "failed",
        provider: "serper",
        discovered: 0,
        enqueued: 0,
        durationMs: Date.now() - startedAt,
        queriesAttempted: 0,
        queriesSucceeded: 0,
        errors,
        updatedAt: Date.now(),
      },
    });
    return;
  }
  const activeTerms = queryTerms.slice(0, grant.serper);
  try {
    const results = await Promise.allSettled(activeTerms.map((term) =>
      searchWeb(
        `site:gate.com/post/status "${term.replace(/"/g, "")}"`,
        {
          tbs: "qdr:w",
          num: 10,
          gl: hasCJK(term) ? "cn" : "us",
          hl: hasCJK(term) ? "zh-cn" : "en",
        },
      )
    ));
    const searchErrors: string[] = [];
    const items = results.flatMap((result, index) => {
      if (result.status === "fulfilled") return result.value;
      searchErrors.push(
        `${activeTerms[index]}: ${String(result.reason).slice(0, 160)}`,
      );
      return [];
    });
    const found = mapGateSerperFallback(items, task.keywords);
    const selected = found.slice(0, SOURCE_LIMITS.gate_square);
    if (selected.length > 0) {
      await env.MONITOR_QUEUE.sendBatch(selected.map((value) => ({
        body: {
          kind: "candidate",
          cycleId: task.cycleId,
          profile: task.profile,
          deliveryId: `${task.taskId}:${sha256(value.normalizedUrl)}`,
          urlHash: sha256(value.normalizedUrl),
          normalizedUrl: value.normalizedUrl,
          post: value.post,
          matchedKeywords: value.matchedKeywords,
        },
      })));
    }
    const diagnostic: SourceDiagnostic = {
      status:
        searchErrors.length > 0
          ? found.length > 0 ? "partial" : "failed"
          : found.length > 0 ? "success" : "empty",
      provider: "serper",
      discovered: found.length,
      enqueued: selected.length,
      durationMs: Date.now() - startedAt,
      queriesAttempted: activeTerms.length,
      queriesSucceeded: results.length - searchErrors.length,
      errors: [...upstreamErrors, ...searchErrors].slice(0, 6),
      updatedAt: Date.now(),
    };
    console.log(JSON.stringify({
      event: "gate_square.discovery",
      cycleId: task.cycleId,
      provider: "serper",
      queryTerms: activeTerms,
      rawResults: items.length,
      matchedPosts: found.length,
      enqueued: selected.length,
      upstreamErrors: [...upstreamErrors, ...searchErrors],
    }));
    await finishDiscovery(task, env, {
      discovered: found.length,
      enqueued: selected.length,
      failed: searchErrors.length === results.length,
      sourceName: "gate_square",
      diagnostic,
    });
  } catch (error) {
    const errors = [
      ...upstreamErrors,
      `Serper fallback: ${String(error).slice(0, 240)}`,
    ];
    await finishDiscovery(task, env, {
      discovered: 0,
      enqueued: 0,
      failed: true,
      sourceName: "gate_square",
      diagnostic: {
        status: "failed",
        provider: "serper",
        discovered: 0,
        enqueued: 0,
        durationMs: Date.now() - startedAt,
        queriesAttempted: 1,
        queriesSucceeded: 0,
        errors,
        updatedAt: Date.now(),
      },
    });
  }
}

const GATE_BROWSER_LAST_AT_KEY = "cf_gate_browser_last_at";

async function discoverGateViaCloudflareBrowser(
  task: DiscoveryTask,
  env: QueueEnv,
  upstreamErrors: string[],
): Promise<void> {
  const startedAt = Date.now();
  const intervalHours = Math.min(
    24,
    Math.max(1, positiveInt(env.CLOUDFLARE_GATE_BROWSER_INTERVAL_HOURS, 6)),
  );
  const lastAt = Number(await db.getSysConfig(GATE_BROWSER_LAST_AT_KEY)) || 0;
  if (startedAt - lastAt < intervalHours * 3_600_000) {
    await discoverGateViaSerper(task, env, [
      ...upstreamErrors,
      `Cloudflare Browser cooldown (${intervalHours}h)`,
    ]);
    return;
  }
  await db.setSysConfig(GATE_BROWSER_LAST_AT_KEY, String(startedAt));
  const errors = [...upstreamErrors];
  try {
    const response = await env.FULLTEXT_BROWSER.fetch("https://fulltext-browser/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: GATE_LIST_URLS[0],
        maxChars: 25_000,
        timeoutMs: 30_000,
      }),
    });
    const result = await response.json<FulltextBrowserResult>();
    if (!response.ok || !result.ok || !result.contentMd) {
      errors.push(`Cloudflare Browser: ${result.error || result.status || response.status}`);
      await discoverGateViaSerper(task, env, errors);
      return;
    }
    const parsed = parseGateFeed(result.contentMd);
    const found = parsed.flatMap((post) => {
      const matchedKeywords = task.keywords
        .filter((keyword) => keywordMatchesText(keyword.keyword, post.body))
        .map((keyword) => keyword.keyword);
      if (matchedKeywords.length === 0) return [];
      const normalizedUrl = normalizeUrl(post.url);
      return [{
        post: {
          url: normalizedUrl,
          title: post.body.replace(/\s+/g, " ").slice(0, 80),
          fullContent: post.body,
          author: post.author,
          publishedAt: post.publishedAt,
          sourceName: "gate_square",
          sourcePlatform: "gate_square",
          fetchEngineHint: "gate_cloudflare_browser",
        } satisfies DiscoveredPost,
        normalizedUrl,
        matchedKeywords,
      }];
    });
    const selected = found.slice(0, SOURCE_LIMITS.gate_square);
    if (selected.length > 0) {
      await env.MONITOR_QUEUE.sendBatch(selected.map((value) => ({
        body: {
          kind: "candidate",
          cycleId: task.cycleId,
          profile: task.profile,
          deliveryId: `${task.taskId}:${sha256(value.normalizedUrl)}`,
          urlHash: sha256(value.normalizedUrl),
          normalizedUrl: value.normalizedUrl,
          post: value.post,
          matchedKeywords: value.matchedKeywords,
        },
      })));
    }
    await finishDiscovery(task, env, {
      discovered: found.length,
      enqueued: selected.length,
      failed: false,
      sourceName: "gate_square",
      diagnostic: {
        status: found.length > 0 ? "success" : "empty",
        provider: "browser",
        discovered: found.length,
        enqueued: selected.length,
        durationMs: Date.now() - startedAt,
        queriesAttempted: 1,
        queriesSucceeded: 1,
        errors: errors.slice(0, 4),
        updatedAt: Date.now(),
      },
    });
  } catch (error) {
    errors.push(`Cloudflare Browser: ${String(error).slice(0, 240)}`);
    await discoverGateViaSerper(task, env, errors);
  }
}

async function discover(task: DiscoveryTask, env: QueueEnv): Promise<void> {
  const startedAt = Date.now();
  if (task.sourceName === BINANCE_BROWSER_SOURCE) {
    await discoverBinance(task, env);
    return;
  }
  if (task.sourceName === "gate_square" && task.fallbackOnly) {
    await discoverGateViaCloudflareBrowser(task, env, [
      "Firecrawl disabled after HTTP 402",
    ]);
    return;
  }
  const source = enabledSources().find((candidate) => candidate.name === task.sourceName);
  if (!source) throw new Error(`unknown monitor source ${task.sourceName}`);
  const posts = new Map<string, {
    post: DiscoveredPost;
    normalizedUrl: string;
    matched: Set<string>;
  }>();
  const chineseSocial = CHINESE_SOCIAL_SOURCE_NAMES.includes(task.sourceName);
  let browserMs = 0;
  let browserQueries = 0;
  let browserSuccesses = 0;
  let browserFallbacks = 0;
  const browserErrors: string[] = [];
  for (const [keywordIndex, keyword] of task.keywords.entries()) {
    const zh = hasCJK(keyword.keyword);
    let found: DiscoveredPost[] | null = null;
    if (chineseSocial && task.browserPreferred) {
      browserQueries++;
      try {
        const platform = task.sourceName.replace(/_serper$/, "");
        const response = await env.CHINESE_SOCIAL_BROWSER.fetch(
          "https://chinese-social-browser/search",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              platform,
              keyword: keyword.keyword,
              maxResults: SOURCE_LIMITS[task.sourceName] || 3,
            }),
          },
        );
        const result = await response.json<ChineseSocialBrowserResult>();
        browserMs += Math.max(0, Number(result.browserMs) || 0);
        if (response.ok && result.ok && result.posts.length > 0) {
          found = result.posts;
          browserSuccesses++;
        } else {
          browserFallbacks++;
          browserErrors.push(
            `${platform}: ${result.error || result.status || `HTTP ${response.status}`}`,
          );
        }
      } catch (error) {
        browserFallbacks++;
        browserErrors.push(
          `${task.sourceName.replace(/_serper$/, "")}: ${String(error).slice(0, 180)}`,
        );
      }
    }
    let serperFallbackAvailable =
      !chineseSocial || keywordIndex < (task.serperFallbacksReserved || 0);
    if (chineseSocial && !found && task.browserPreferred && !serperFallbackAvailable) {
      const fallbackGrant = await budget.reserveQueuedBudget({ serper: 1 });
      serperFallbackAvailable = fallbackGrant.serper > 0;
    }
    if (!found && serperFallbackAvailable) {
      found = await source.search(keyword.keyword, {
        tbs: keyword.priority >= 8 ? "qdr:d" : "qdr:w",
        num: 10,
        gl: zh ? "cn" : "us",
        hl: zh ? "zh-cn" : "en",
        shard: task.shard,
        budgetReserved: task.budgetReserved,
      });
    }
    if (!found) {
      found = [];
      if (chineseSocial) {
        browserErrors.push(
          `${task.sourceName.replace(/_serper$/, "")}: Serper budget unavailable`,
        );
      }
    }
    for (const post of found) {
      if (!post.url || isSearchIntermediaryUrl(post.url)) continue;
      const normalizedUrl = normalizeUrl(post.url);
      const urlHash = sha256(normalizedUrl);
      const current = posts.get(urlHash);
      if (current) current.matched.add(keyword.keyword);
      else posts.set(urlHash, {
        post,
        normalizedUrl,
        matched: new Set([keyword.keyword]),
      });
    }
  }
  if (task.sourceName === "gate_square" && posts.size === 0) {
    const gateDiagnostic = getGateRenderDiagnostic(task.shard);
    if (gateDiagnostic.errors.length > 0) {
      await discoverGateViaSerper(task, env, gateDiagnostic.errors);
      return;
    }
  }
  const selected = Array.from(posts.entries())
    .sort(([, a], [, b]) => {
      const freshnessRank = (post: DiscoveredPost) => {
        const freshness = monitorPublishedAtFreshness(post.publishedAt);
        return freshness === "fresh" ? 0 : freshness === "missing" ? 1 : 2;
      };
      return (
        freshnessRank(a.post) - freshnessRank(b.post) ||
        (b.post.publishedAt || 0) - (a.post.publishedAt || 0)
      );
    })
    .slice(0, SOURCE_LIMITS[task.sourceName] || 3);
  if (selected.length > 0) {
    await env.MONITOR_QUEUE.sendBatch(selected.map(([urlHash, value]) => ({
      body: {
        kind: "candidate",
        cycleId: task.cycleId,
        profile: task.profile,
        deliveryId: `${task.taskId}:${urlHash}`,
        urlHash,
        normalizedUrl: value.normalizedUrl,
        post: value.post,
        matchedKeywords: Array.from(value.matched),
      },
    })));
  }
  await finishDiscovery(task, env, {
    discovered: posts.size,
    enqueued: selected.length,
    failed: false,
    sourceName: task.sourceName.replace(/_serper$/, ""),
    diagnostic: {
      status: posts.size > 0 ? "success" : "empty",
      provider: chineseSocial && browserSuccesses > 0
        ? "browser"
        : task.sourceName.endsWith("_serper") ? "serper" : undefined,
      discovered: posts.size,
      enqueued: selected.length,
      durationMs: Date.now() - startedAt,
      browserMs,
      fallbacks: browserFallbacks,
      queriesAttempted: task.keywords.length,
      queriesSucceeded: task.keywords.length,
      ...(browserErrors.length > 0 ? { errors: browserErrors.slice(0, 4) } : {}),
      updatedAt: Date.now(),
    },
  });
}

function toFetchMethod(engine: string): "snippet_only" | null {
  return engine === "snippet" ? "snippet_only" : null;
}

async function completeCandidate(
  env: QueueEnv,
  task: CandidateTask,
  patch: Record<string, unknown>,
): Promise<void> {
  const state = await coordinatorPost<CoordinatorStats>(
    env,
    task.profile,
    "/complete",
    { cycleId: task.cycleId, urlHash: task.urlHash, ...patch },
  );
  if (state.status === "success" || state.status === "partial_failure") {
    await syncLegacyStatus(env, state);
  }
}

async function settleCandidate(
  env: QueueEnv,
  task: CandidateTask,
  rejectionReason: string,
  patch: Record<string, unknown> = {},
): Promise<void> {
  const state = await coordinatorPost<CoordinatorStats>(
    env,
    task.profile,
    "/settle",
    {
      cycleId: task.cycleId,
      deliveryId: task.deliveryId,
      rejectionReason,
      sourcePlatform: task.post.sourcePlatform,
      ...patch,
    },
  );
  if (state.status === "success" || state.status === "partial_failure") {
    await syncLegacyStatus(env, state);
  }
}

async function candidate(task: CandidateTask, env: QueueEnv): Promise<void> {
  if (await db.getMonitorArticleByUrlHash(task.urlHash)) {
    await settleCandidate(env, task, "duplicate_url", {
      dedupExisting: true,
    });
    return;
  }

  const post = task.post;
  const searchDerived =
    post.sourceName === "serper" ||
    post.sourceName.endsWith("_serper") ||
    post.sourceName.endsWith("_browser");
  const browserDateVerified = post.fetchEngineHint === "social_browser" && post.publishedAt != null;
  let sourceDate: SourceDateVerification | null = null;
  let effectivePublishedAt = post.publishedAt ?? null;
  if (searchDerived && !browserDateVerified) {
    sourceDate = await verifySourcePublishedAt(post.url);
    if (sourceDate.status !== "verified" || sourceDate.publishedAt == null) {
      console.log(JSON.stringify({
        event: "monitor_candidate.source_date_rejected",
        sourcePlatform: post.sourcePlatform,
        sourceName: post.sourceName,
        urlHash: task.urlHash,
        status: sourceDate.status,
        error: sourceDate.error || "",
      }));
      await settleCandidate(env, task, `source_date_${sourceDate.status}`);
      return;
    }
    effectivePublishedAt = sourceDate.publishedAt;
  }
  const freshness = sourceDate
    ? sourceDateFreshness(sourceDate)
    : monitorPublishedAtFreshness(effectivePublishedAt);
  if (freshness !== "fresh") {
    console.log(JSON.stringify({
      event: "monitor_candidate.freshness_rejected",
      sourcePlatform: post.sourcePlatform,
      sourceName: post.sourceName,
      urlHash: task.urlHash,
      freshness,
      discoveredPublishedAt: post.publishedAt ?? null,
      sourcePublishedAt: effectivePublishedAt,
      sourceDateEvidence: sourceDate?.evidence || "",
    }));
    await settleCandidate(env, task, `freshness_${freshness}`);
    return;
  }
  if (!detectContentLang(`${post.title || ""} ${post.fullContent || post.contentSnippet || ""}`).allowed) {
    await settleCandidate(env, task, "language");
    return;
  }

  const contentMd = (post.fullContent || post.contentSnippet || "").slice(0, 20_000);
  const title = (post.title || contentMd.slice(0, 80)).slice(0, 512);
  const rawContentHash = contentMd ? sha256(contentMd) : "";
  const contentHash = contentMd ? monitorContentHash(contentMd) : "";
  if (
    contentMd &&
    await db.getRecentMonitorArticleDuplicate({
      contentHashes: [rawContentHash, contentHash],
      title,
    })
  ) {
    await settleCandidate(env, task, "duplicate_content", {
      dedupExisting: true,
    });
    return;
  }

  // Only verified, fresh, non-duplicate candidates consume the per-cycle AI
  // capacity. Previously the first queued items took all slots before these
  // checks, so stale results could starve later fresh sources.
  const claim = await coordinatorPost<{
    accepted: boolean;
    inFlight?: boolean;
    capped?: boolean;
    duplicate?: boolean;
  }>(
    env,
    task.profile,
    "/claim",
    {
      cycleId: task.cycleId,
      urlHash: task.urlHash,
      deliveryId: task.deliveryId,
    },
  );
  if (claim.inFlight) return;
  if (!claim.accepted) {
    await settleCandidate(
      env,
      task,
      claim.capped ? "capacity" : claim.duplicate ? "duplicate_candidate" : "not_accepted",
    );
    return;
  }
  const fetchEngine = post.fullContent
    ? (post.fetchEngineHint || "source_api")
    : "snippet";
  const fetchStatus = post.fullContent ? "full" : contentMd ? "partial" : "failed";
  const fetchAttempt = {
    engine: fetchEngine,
    outcome: post.fullContent ? "success" as const : "fallback" as const,
    reason: post.fullContent ? "success" as const : "snippet_fallback" as const,
    durationMs: 0,
    contentChars: contentMd.length,
    costUsd: post.fetchCostUsdHint || 0,
  };
  recordFetchAttempt(post.url, fetchAttempt, post.sourcePlatform);
  let analysis: Awaited<ReturnType<typeof analyzeArticle>> | null = null;
  let analysisFailed = false;
  if (contentMd) {
    try {
      analysis = await analyzeArticle({
        url: post.url,
        title,
        contentMd,
        snippet: post.contentSnippet || "",
        fetchStatus,
      });
    } catch (error) {
      analysisFailed = true;
      console.error(`[Monitor Queue] analyze ${post.url}: ${String(error).slice(0, 300)}`);
    }
  }

  const domain = domainOf(post.url);
  let inserted = false;
  let dedupConflict = false;
  try {
    inserted = Boolean(await db.createMonitorArticle({
      url: task.normalizedUrl.slice(0, 768),
      urlHash: task.urlHash,
      domain: domain ? domain.slice(0, 128) : null,
      title: title || null,
      contentMd: contentMd || null,
      contentHash: contentHash || null,
      publishedAt: effectivePublishedAt,
      firstSeenAt: Date.now(),
      fetchEngine,
      fetchMethod: toFetchMethod(fetchEngine),
      fetchStatus,
      fetchCostUsd: String(post.fetchCostUsdHint || 0),
      sourcePlatform: post.sourcePlatform,
      matchedKeywords: task.matchedKeywords,
      sentimentScore: analysis?.sentimentScore ?? null,
      relevance: analysis?.relevance ?? null,
      relevanceReason: analysis?.relevanceReason ?? null,
      threatLevel: analysis?.threatLevel ?? null,
      analysisSummary: analysis?.summary ?? null,
      analyzedAt: analysis ? Date.now() : null,
      promptTokens: analysis?.promptTokens ?? null,
      completionTokens: analysis?.completionTokens ?? null,
      costUsd: analysis?.costUsd != null ? String(analysis.costUsd) : null,
    }));
    if (!inserted) dedupConflict = true;
  } catch (error) {
    // A concurrent shard can win the unique URL race. Treat that as a clean
    // dedup outcome; unexpected database failures still retry the queue message.
    if (!/duplicate|unique/i.test(String(error))) throw error;
    dedupConflict = true;
  }

  let realtimeAlertCreated = false;
  if (
    inserted &&
    analysis &&
    getCloudflareFeatureFlags(env).realtimeAlerts &&
    await alertThresholdMet(analysis.threatLevel)
  ) {
    try {
      const alert = await dispatchHighThreatAlert({
        url: post.url,
        urlHash: task.urlHash,
        title,
        domain: domain || null,
        sentimentScore: analysis.sentimentScore,
        summary: analysis.summary,
        threatLevel: analysis.threatLevel,
      }, {
        deliveryEnabledOverride: true,
      });
      realtimeAlertCreated = alert.created;
    } catch (error) {
      console.error(JSON.stringify({
        event: "cloudflare_realtime_alert.failed",
        urlHash: task.urlHash,
        error: String(error).slice(0, 300),
      }));
    }
  }

  const briefingItem =
    inserted && (analysis?.relevance === "high" || analysis?.relevance === "medium")
      ? {
          title,
          url: post.url,
          sourcePlatform: post.sourcePlatform,
          domain: domain || null,
          relevance: analysis.relevance,
          sentimentScore: analysis.sentimentScore,
          threatLevel: analysis.threatLevel,
        }
      : undefined;
  await completeCandidate(env, task, {
    inserted,
    dedupConflict,
    realtimeAlertCreated,
    analyzed: Boolean(analysis),
    analysisFailed,
    analysisNeurons: analysis?.neurons || 0,
    analysisCostUsd: analysis?.costUsd || 0,
    analysisProvider: analysis?.provider || "",
    fallbackReason: analysis?.fallbackReason || "",
    sourcePlatform: post.sourcePlatform,
    fetchAttempt: {
      ...fetchAttempt,
      domain: domain || "unknown",
    },
    briefingItem,
  });
  if (
    !post.fullContent &&
    contentMd &&
    getCloudflareFeatureFlags(env).browserFullTextShadow
  ) {
    try {
      await env.BROWSER_SHADOW_QUEUE.send({
        kind: "browser_shadow",
        urlHash: task.urlHash,
        url: post.url,
        sourcePlatform: post.sourcePlatform,
        originalChars: contentMd.length,
      } satisfies BrowserShadowTask);
    } catch (error) {
      // Shadow work must never turn a completed production candidate into a
      // failed queue delivery.
      console.error(JSON.stringify({
        event: "browser_fulltext_shadow.enqueue_failed",
        urlHash: task.urlHash,
        error: String(error).slice(0, 300),
      }));
    }
  }
}

const FRESHNESS_AUDIT_BATCH_SIZE = 20;
const FRESHNESS_AUDIT_MAX_RECORDS = 1500;

async function freshnessAudit(task: FreshnessAuditTask, env: QueueEnv): Promise<void> {
  const startedAt = task.scheduledTime;
  const totals = {
    checked: task.checked || 0,
    deleted: task.deleted || 0,
    corrected: task.corrected || 0,
    unverifiable: task.unverifiable || 0,
    failed: task.failed || 0,
  };
  if (!task.cursor) {
    await Promise.all([
      db.setSysConfig(FRESHNESS_AUDIT_STATUS_KEYS.status, "running"),
      db.setSysConfig(FRESHNESS_AUDIT_STATUS_KEYS.startedAt, String(startedAt)),
      db.setSysConfig(FRESHNESS_AUDIT_STATUS_KEYS.error, ""),
    ]);
  }

  try {
    const rows = await db.listMonitorWebArticlesForFreshnessAudit({
      afterId: task.cursor || 0,
      firstSeenAfter: startedAt - 30 * 86_400_000,
      limit: FRESHNESS_AUDIT_BATCH_SIZE,
    });
    const results = await Promise.all(rows.map(async (row) => ({
      row,
      verification: await verifySourcePublishedAt(row.url),
    })));
    let cursor = task.cursor || 0;
    for (const { row, verification } of results) {
      cursor = Math.max(cursor, row.id);
      totals.checked++;
      if (verification.status === "failed") totals.failed++;
      if (verification.status === "unverifiable") totals.unverifiable++;

      // The same strict rule now used for new Serper candidates is applied to
      // the retained 100-day web dataset: no source-date evidence means the
      // record cannot be presented as current news.
      const freshness = sourceDateFreshness(verification, startedAt);
      if (verification.status !== "verified" || freshness !== "fresh") {
        if (await db.deleteMonitorArticleForFreshnessAudit(row.id)) totals.deleted++;
        continue;
      }
      if (
        verification.publishedAt != null &&
        Math.abs(verification.publishedAt - Number(row.publishedAt || 0)) > 60_000
      ) {
        await db.updateMonitorArticle(row.id, {
          publishedAt: verification.publishedAt,
        });
        totals.corrected++;
      }
    }

    const summary = {
      auditId: task.auditId,
      cursor,
      ...totals,
      finished: rows.length < FRESHNESS_AUDIT_BATCH_SIZE ||
        totals.checked >= FRESHNESS_AUDIT_MAX_RECORDS,
    };
    await db.setSysConfig(
      FRESHNESS_AUDIT_STATUS_KEYS.summary,
      JSON.stringify(summary).slice(0, 4000),
    );
    if (!summary.finished) {
      await env.MONITOR_QUEUE.send({
        ...task,
        cursor,
        ...totals,
      }, { delaySeconds: 1 });
      return;
    }
    await Promise.all([
      db.setSysConfig(FRESHNESS_AUDIT_STATUS_KEYS.status, "success"),
      db.setSysConfig(FRESHNESS_AUDIT_STATUS_KEYS.finishedAt, String(Date.now())),
    ]);
    console.log(JSON.stringify({
      event: "monitor_freshness_audit.complete",
      ...summary,
    }));
  } catch (error) {
    await Promise.all([
      db.setSysConfig(FRESHNESS_AUDIT_STATUS_KEYS.status, "failed"),
      db.setSysConfig(FRESHNESS_AUDIT_STATUS_KEYS.finishedAt, String(Date.now())),
      db.setSysConfig(
        FRESHNESS_AUDIT_STATUS_KEYS.error,
        String(error).slice(0, 1000),
      ),
    ]);
    throw error;
  }
}

function browserShadowGain(originalChars: number, browserChars: number): {
  gainRatio: number;
  usable: boolean;
} {
  const gainRatio = originalChars > 0
    ? Math.round((browserChars / originalChars) * 100) / 100
    : browserChars > 0 ? 1 : 0;
  return {
    gainRatio,
    usable: browserChars >= 500 && browserChars >= Math.max(500, originalChars * 1.25),
  };
}

class BrowserShadowCooldownError extends Error {
  constructor(readonly delaySeconds: number) {
    super(`browser shadow cooldown (${delaySeconds}s)`);
    this.name = "BrowserShadowCooldownError";
  }
}

async function browserShadow(task: BrowserShadowTask, env: QueueEnv): Promise<void> {
  if (!getCloudflareFeatureFlags(env).browserFullTextShadow) return;
  const budgetStub = browserShadowBudget(env);
  const reservationResponse = await budgetStub.fetch("https://browser-shadow-budget/reserve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requestKey: task.urlHash,
      maxPages: positiveInt(env.CLOUDFLARE_BROWSER_FULLTEXT_MAX_PAGES_PER_DAY, 4),
      maxBrowserMs: positiveInt(env.CLOUDFLARE_BROWSER_FULLTEXT_MAX_MS_PER_DAY, 480_000),
      cooldownSeconds: positiveInt(env.CLOUDFLARE_BROWSER_FULLTEXT_COOLDOWN_SECONDS, 75),
    }),
  });
  const reservation = await reservationResponse.json<{
    accepted: boolean;
    token?: string;
    reason?: string;
    retryAfterSeconds?: number;
  }>();
  if (!reservation.accepted || !reservation.token) {
    if (reservation.reason === "cooldown") {
      throw new BrowserShadowCooldownError(
        Math.max(1, Math.min(300, Number(reservation.retryAfterSeconds) || 75)),
      );
    }
    console.log(JSON.stringify({
      event: "browser_fulltext_shadow.skipped",
      urlHash: task.urlHash,
      reason: reservation.reason || "budget_rejected",
    }));
    return;
  }

  const startedAt = Date.now();
  let result: FulltextBrowserResult;
  try {
    const response = await env.FULLTEXT_BROWSER.fetch("https://fulltext-browser/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: task.url,
        maxChars: 20_000,
        timeoutMs: positiveInt(env.CLOUDFLARE_BROWSER_FULLTEXT_TIMEOUT_MS, 22_000),
      }),
    });
    result = await response.json<FulltextBrowserResult>();
    if (!response.ok && !result.error) result.error = `fulltext browser HTTP ${response.status}`;
  } catch (error) {
    result = {
      ok: false,
      status: "failed",
      url: task.url,
      contentChars: 0,
      browserMs: 0,
      durationMs: Date.now() - startedAt,
      error: String(error).slice(0, 300),
    };
  }
  const browserChars = Math.max(0, Number(result.contentChars) || 0);
  const gain = browserShadowGain(task.originalChars, browserChars);
  const summary: BrowserShadowResultSummary = {
    token: reservation.token,
    urlHash: task.urlHash,
    domain: domainOf(task.url) || "unknown",
    sourcePlatform: task.sourcePlatform,
    status: result.status,
    originalChars: task.originalChars,
    browserChars,
    browserMs: Math.max(0, Number(result.browserMs) || 0),
    durationMs: Math.max(0, Number(result.durationMs) || Date.now() - startedAt),
    ...gain,
    httpStatus: result.httpStatus,
    error: result.error,
    finishedAt: Date.now(),
  };
  await budgetStub.fetch("https://browser-shadow-budget/record", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(summary),
  });
  await recordAcceptance(env, "/record-browser", {
    urlHash: summary.urlHash,
    domain: summary.domain,
    sourcePlatform: summary.sourcePlatform,
    status: summary.status,
    originalChars: summary.originalChars,
    browserChars: summary.browserChars,
    browserMs: summary.browserMs,
    durationMs: summary.durationMs,
    gainRatio: summary.gainRatio,
    usable: summary.usable,
    httpStatus: summary.httpStatus,
    error: summary.error,
    finishedAt: summary.finishedAt,
  } satisfies BrowserAcceptanceRecord);
  console.log(JSON.stringify({
    event: "browser_fulltext_shadow.result",
    ...summary,
  }));
}

async function postCycle(task: PostCycleTask, env: QueueEnv): Promise<void> {
  const flags = getCloudflareFeatureFlags(env);
  const record: NotificationAcceptanceRecord = {
    cycleId: task.cycleId,
    profile: task.profile,
    briefingAttempted: false,
    briefingSent: false,
    failureNotificationAttempted: false,
    failureNotificationSent: false,
    finishedAt: Date.now(),
  };
  const errors: string[] = [];
  if (flags.briefing) {
    record.briefingAttempted = true;
    try {
      const result = await sendBriefing(task.briefingItems, {
        keywords: task.keywords,
        sourceCount: task.sourceCount,
        newArticles: task.inserted,
      }, {
        deliveryEnabledOverride: true,
        modeOverride:
          env.CLOUDFLARE_BRIEFING_MODE === "every"
            ? "every"
            : "negative_only",
        dedupKey: `cloudflare_briefing:${task.cycleId}`,
      });
      record.briefingSent = result.sent;
      record.briefingReason = result.reason;
    } catch (error) {
      errors.push(`briefing: ${String(error).slice(0, 200)}`);
    }
  }
  if (flags.failureNotifications && task.status === "partial_failure") {
    record.failureNotificationAttempted = true;
    try {
      const title = `Cloudflare 舆情批次异常 · ${task.profile}`;
      const content = `批次 ${task.cycleId} 以 partial_failure 结束，请检查 Worker 状态与日志。`;
      const [telegram, email] = await Promise.all([
        dispatchNotification({
          messageType: "alert",
          title,
          content,
          severity: "high",
          dedupKey: `cloudflare_cycle_failure:${task.cycleId}`,
        }),
        sendEmailAlert(
          title,
          `<p>${content}</p><p>该通知来自 Cloudflare 独立运行版本。</p>`,
        ),
      ]);
      record.failureNotificationSent = telegram.sent > 0 || email.sent;
    } catch (error) {
      errors.push(`failure notification: ${String(error).slice(0, 200)}`);
    }
  }
  record.finishedAt = Date.now();
  if (errors.length > 0) record.error = errors.join("; ").slice(0, 300);
  await recordAcceptance(env, "/record-notification", record);
  console.log(JSON.stringify({
    event: "cloudflare_post_cycle.result",
    ...record,
  }));
}

async function maintenance(task: MaintenanceTask): Promise<void> {
  if (task.task === "cleanup") {
    const startedAt = Date.now();
    await Promise.all([
      db.setSysConfig(CLEANUP_STATUS_KEYS.status, "running"),
      db.setSysConfig(CLEANUP_STATUS_KEYS.startedAt, String(startedAt)),
      db.setSysConfig(CLEANUP_STATUS_KEYS.error, ""),
    ]);
    try {
      const result = await cleanupOldArticles();
      await Promise.all([
        db.setSysConfig(CLEANUP_STATUS_KEYS.status, "success"),
        db.setSysConfig(CLEANUP_STATUS_KEYS.finishedAt, String(Date.now())),
        db.setSysConfig(CLEANUP_STATUS_KEYS.summary, JSON.stringify(result)),
      ]);
    } catch (error) {
      await Promise.all([
        db.setSysConfig(CLEANUP_STATUS_KEYS.status, "failed"),
        db.setSysConfig(CLEANUP_STATUS_KEYS.finishedAt, String(Date.now())),
        db.setSysConfig(CLEANUP_STATUS_KEYS.error, String(error).slice(0, 1000)),
      ]);
      throw error;
    }
    return;
  }
  if (task.task === "weekly_report") {
    const lastWeek = weeklyPeriodOf(weeklyPeriodOf(task.scheduledTime).startMs - 1);
    await generateMonitorReport("weekly", lastWeek.reportPeriod);
    return;
  }
  const lastMonth = monthlyPeriodOf(monthlyPeriodOf(task.scheduledTime).startMs - 1);
  await generateMonitorReport("monthly", lastMonth.reportPeriod);
}

async function processTask(task: QueueTask, env: QueueEnv): Promise<void> {
  if (task.kind === "bootstrap") return bootstrap(task, env);
  if (task.kind === "discovery") return discover(task, env);
  if (task.kind === "candidate") return candidate(task, env);
  if (task.kind === "freshness_audit") return freshnessAudit(task, env);
  if (task.kind === "binance_probe") return binanceProbe(task, env);
  if (task.kind === "geo_daily_shard" || task.kind === "geo_weekly_shard") {
    return runObservedGeoShard(env, task);
  }
  if (task.kind === "openrouter_preflight") return runOpenRouterPreflight(task, env);
  if (task.kind === "browser_shadow") return browserShadow(task, env);
  if (task.kind === "post_cycle") return postCycle(task, env);
  return maintenance(task);
}

export async function processMonitorQueue(
  batch: MessageBatch<QueueTask>,
  env: QueueEnv,
): Promise<void> {
  if (!env.HYPERDRIVE) throw new Error("HYPERDRIVE binding is required for queued monitor work");
  for (const message of batch.messages) {
    const task = message.body;
    try {
      if (task.kind === "browser_shadow") {
        await processTask(task, env);
      } else {
        await withCloudflareEnv(env, () =>
          withHyperdriveDatabase(env.HYPERDRIVE!, () => processTask(task, env)),
        );
      }
      message.ack();
    } catch (error) {
      console.error(`[Monitor Queue] ${task.kind}: ${String(error).slice(0, 500)}`);
      if (task.kind === "browser_shadow" && error instanceof BrowserShadowCooldownError) {
        message.retry({ delaySeconds: error.delaySeconds });
        continue;
      }
      const finalAttempt = (message.attempts || 1) >= 4;
      if (!finalAttempt) {
        message.retry({ delaySeconds: 30 });
        continue;
      }
      try {
        if (task.kind === "discovery") {
          const state = await withCloudflareEnv(env, () =>
            withHyperdriveDatabase(env.HYPERDRIVE!, () =>
              coordinatorPost<CoordinatorStats>(
                env,
                task.profile,
                "/discovery-done",
                {
                  cycleId: task.cycleId,
                  taskId: task.taskId,
                  discovered: 0,
                  enqueued: 0,
                  failed: true,
                },
              ),
            ),
          );
          if (state.status === "success" || state.status === "partial_failure") {
            await withCloudflareEnv(env, () =>
              withHyperdriveDatabase(env.HYPERDRIVE!, () => syncLegacyStatus(env, state)),
            );
          }
        } else if (task.kind === "candidate") {
          await withCloudflareEnv(env, () =>
            withHyperdriveDatabase(env.HYPERDRIVE!, () =>
              completeCandidate(env, task, { failed: true }),
            ),
          );
        }
      } catch (recordError) {
        console.error(`[Monitor Queue] could not record terminal failure: ${String(recordError).slice(0, 300)}`);
      }
      message.ack();
    }
  }
}

export function shanghaiParts(timestamp: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    minute: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    day: "2-digit",
    month: "2-digit",
    weekday: "short",
  }).formatToParts(new Date(timestamp));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value || "";
  const weekdays: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return {
    minute: Number(get("minute")),
    hour: Number(get("hour")),
    day: Number(get("day")),
    month: Number(get("month")),
    weekday: weekdays[get("weekday")] ?? 0,
  };
}

export async function enqueueScheduledMonitor(
  scheduledTime: number,
  env: QueueEnv,
): Promise<void> {
  const local = shanghaiParts(scheduledTime);
  const flags = getCloudflareFeatureFlags(env);
  const messages: Array<{ body: QueueTask }> = [];
  const profile: MonitorProfile | null =
    local.minute === 15 && flags.monitorNews
      ? "monitor_primary_news"
      : local.minute === 40 && flags.monitorSocial
        ? "monitor_primary_social"
        : null;
  if (profile) {
    messages.push({
      body: {
        kind: "bootstrap",
        cycleId: `${profile}:${scheduledTime}`,
        profile,
        scheduledTime,
      },
    });
  }
  if (local.minute === 40) {
    const dailyStartHour = Math.min(
      23,
      positiveInt(env.CLOUDFLARE_GEO_DAILY_START_HOUR, 9),
    );
    if (flags.geoDaily && local.hour >= dailyStartHour) {
      messages.push({ body: { kind: "geo_daily_shard", scheduledTime } });
    }
    const weeklyStartHour = Math.min(
      23,
      positiveInt(env.CLOUDFLARE_GEO_WEEKLY_START_HOUR, 3),
    );
    if (
      flags.openRouterPreflight &&
      (local.hour === 1 || local.hour === 9)
    ) {
      messages.push({ body: { kind: "openrouter_preflight", scheduledTime } });
    }
    if (flags.geoWeekly && local.hour >= weeklyStartHour) {
      messages.push({ body: { kind: "geo_weekly_shard", scheduledTime } });
    }
  }
  if (local.hour === 3 && local.minute === 40) {
    if (flags.cleanup) {
      messages.push({ body: { kind: "maintenance", task: "cleanup", scheduledTime } });
    }
    if (local.weekday === 1 && flags.weeklyReport) {
      messages.push({ body: { kind: "maintenance", task: "weekly_report", scheduledTime } });
    }
    if (local.day === 1 && flags.monthlyReport) {
      messages.push({ body: { kind: "maintenance", task: "monthly_report", scheduledTime } });
    }
  }
  if (messages.length > 0) await env.MONITOR_QUEUE.sendBatch(messages);
}
