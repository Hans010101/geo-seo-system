import * as db from "../server/db";
import { withHyperdriveDatabase, type HyperdriveBinding } from "../server/db";
import { withCloudflareEnv, type CloudflareRuntimeEnv } from "../server/_core/cloudflare-env";
import { analyzeArticle } from "../server/monitor/analyzer";
import * as budget from "../server/monitor/budget";
import { enabledSources } from "../server/monitor/sources/registry";
import { RSS_FEEDS } from "../server/monitor/sources/rss-source";
import { GATE_LIST_URLS } from "../server/monitor/sources/gate-source";
import { TELEGRAM_CHANNELS } from "../server/monitor/sources/telegram-source";
import type { DiscoveredPost } from "../server/monitor/sources/types";
import {
  detectContentLang,
  domainOf,
  hasCJK,
  normalizeUrl,
  sha256,
} from "../server/monitor/util";
import {
  cleanupOldArticles,
} from "../server/monitor/cleanup";
import {
  generateMonitorReport,
  monthlyPeriodOf,
  weeklyPeriodOf,
} from "../server/monitor/report";
import type {
  CoordinatorStats,
  MonitorProfile,
} from "./monitor-coordinator";

type QueueBinding = {
  send(body: QueueTask, options?: { delaySeconds?: number }): Promise<void>;
  sendBatch(messages: Array<{ body: QueueTask }>): Promise<void>;
};

type DurableObjectStub = {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
};

type DurableObjectNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
};

export type QueueEnv = CloudflareRuntimeEnv & {
  ENABLE_CLOUDFLARE_CRON?: string;
  CLOUDFLARE_CRON_MODE?: string;
  CLOUDFLARE_PRIMARY_MAX_KEYWORDS?: string;
  CLOUDFLARE_PRIMARY_NEWS_MAX_ARTICLES?: string;
  CLOUDFLARE_PRIMARY_SOCIAL_MAX_ARTICLES?: string;
  HYPERDRIVE?: HyperdriveBinding;
  MONITOR_QUEUE: QueueBinding;
  MONITOR_COORDINATOR: DurableObjectNamespace;
};

type Keyword = { keyword: string; priority: number };

type BootstrapTask = {
  kind: "bootstrap";
  cycleId: string;
  profile: MonitorProfile;
  scheduledTime: number;
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

export type QueueTask =
  | BootstrapTask
  | DiscoveryTask
  | CandidateTask
  | MaintenanceTask;

type QueueMessage = {
  body: QueueTask;
  attempts?: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
};

type QueueBatch = {
  messages: QueueMessage[];
};

const SOURCE_LIMITS: Record<string, number> = {
  serper: 3,
  rss: 3,
  gate_square: 5,
  telegram: 3,
  x: 20,
};

const CF_STATUS_KEYS = {
  mode: "cf_cron_mode",
  task: "cf_cron_last_task",
  status: "cf_cron_last_status",
  startedAt: "cf_cron_last_started_at",
  finishedAt: "cf_cron_last_finished_at",
  summary: "cf_cron_last_summary",
  error: "cf_cron_last_error",
} as const;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function coordinator(env: QueueEnv, profile: MonitorProfile): DurableObjectStub {
  return env.MONITOR_COORDINATOR.get(env.MONITOR_COORDINATOR.idFromName(profile));
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

async function syncLegacyStatus(state: CoordinatorStats): Promise<void> {
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
}

function buildDiscoveryTasks(
  cycle: BootstrapTask,
  keywords: Keyword[],
  budgetGrant: { firecrawl: number; serper: number; xAvailable: boolean },
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

  const gate = GATE_LIST_URLS.slice(0, budgetGrant.firecrawl).map((shard, index) => ({
    ...base,
    taskId: `gate_square:${index}`,
    sourceName: "gate_square",
    shard,
    keywords,
    budgetReserved: true,
  }));
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
  return [...gate, ...telegram, ...x];
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
  const budgetGrant = await budget.reserveQueuedBudget({
    serper: isNews ? keywords.length : 0,
    firecrawl: isNews ? 0 : GATE_LIST_URLS.length,
  });
  const discoveryTasks = buildDiscoveryTasks(task, keywords, budgetGrant);
  const maxArticles = isNews
    ? positiveInt(env.CLOUDFLARE_PRIMARY_NEWS_MAX_ARTICLES, 12)
    : positiveInt(env.CLOUDFLARE_PRIMARY_SOCIAL_MAX_ARTICLES, 14);
  const state = await coordinatorPost<CoordinatorStats>(env, task.profile, "/start", {
    cycleId: task.cycleId,
    profile: task.profile,
    maxArticles,
    keywords: keywords.length,
    sources: isNews ? ["serper", "rss"] : ["gate_square", "telegram", "x"],
    discoveryExpected: discoveryTasks.length,
  });
  await syncLegacyStatus(state);
  if (discoveryTasks.length === 0) return;
  await env.MONITOR_QUEUE.sendBatch(discoveryTasks.map((body) => ({ body })));
}

async function discover(task: DiscoveryTask, env: QueueEnv): Promise<void> {
  const source = enabledSources().find((candidate) => candidate.name === task.sourceName);
  if (!source) throw new Error(`unknown monitor source ${task.sourceName}`);
  const posts = new Map<string, {
    post: DiscoveredPost;
    normalizedUrl: string;
    matched: Set<string>;
  }>();
  for (const keyword of task.keywords) {
    const zh = hasCJK(keyword.keyword);
    const found = await source.search(keyword.keyword, {
      tbs: keyword.priority >= 8 ? "qdr:d" : "qdr:w",
      num: 10,
      gl: zh ? "cn" : "us",
      hl: zh ? "zh-cn" : "en",
      shard: task.shard,
      budgetReserved: task.budgetReserved,
    });
    for (const post of found) {
      if (!post.url) continue;
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
  const selected = Array.from(posts.entries()).slice(0, SOURCE_LIMITS[task.sourceName] || 3);
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
  const state = await coordinatorPost<CoordinatorStats>(
    env,
    task.profile,
    "/discovery-done",
    {
      cycleId: task.cycleId,
      taskId: task.taskId,
      discovered: posts.size,
      failed: false,
    },
  );
  if (state.status === "success" || state.status === "partial_failure") {
    await syncLegacyStatus(state);
  }
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
    await syncLegacyStatus(state);
  }
}

async function candidate(task: CandidateTask, env: QueueEnv): Promise<void> {
  const claim = await coordinatorPost<{ accepted: boolean }>(
    env,
    task.profile,
    "/claim",
    {
      cycleId: task.cycleId,
      urlHash: task.urlHash,
      deliveryId: task.deliveryId,
    },
  );
  if (!claim.accepted) return;

  if (await db.getMonitorArticleByUrlHash(task.urlHash)) {
    await completeCandidate(env, task, {});
    return;
  }

  const post = task.post;
  const windowDays = Math.max(
    1,
    Number(await db.getSysConfig("monitor_collect_window_days")) || 7,
  );
  const rssWindowDays = Math.max(
    windowDays,
    Number(await db.getSysConfig("monitor_collect_window_days_rss")) || 30,
  );
  const ageWindow = post.sourcePlatform === "rss" ? rssWindowDays : windowDays;
  if (post.publishedAt && post.publishedAt < Date.now() - ageWindow * 86_400_000) {
    await completeCandidate(env, task, {});
    return;
  }
  if (!detectContentLang(`${post.title || ""} ${post.fullContent || post.contentSnippet || ""}`).allowed) {
    await completeCandidate(env, task, {});
    return;
  }

  const contentMd = (post.fullContent || post.contentSnippet || "").slice(0, 20_000);
  const title = (post.title || contentMd.slice(0, 80)).slice(0, 512);
  const fetchEngine = post.fullContent
    ? (post.fetchEngineHint || "source_api")
    : "snippet";
  const fetchStatus = post.fullContent ? "full" : contentMd ? "partial" : "failed";
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
  try {
    inserted = Boolean(await db.createMonitorArticle({
      url: task.normalizedUrl.slice(0, 768),
      urlHash: task.urlHash,
      domain: domain ? domain.slice(0, 128) : null,
      title: title || null,
      contentMd: contentMd || null,
      contentHash: contentMd ? sha256(contentMd) : null,
      publishedAt: post.publishedAt ?? null,
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
  } catch (error) {
    // A concurrent shard can win the unique URL race. Treat that as a clean
    // dedup outcome; unexpected database failures still retry the queue message.
    if (!/duplicate|unique/i.test(String(error))) throw error;
  }

  const briefingItem =
    analysis?.relevance === "high" || analysis?.relevance === "medium"
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
    analyzed: Boolean(analysis),
    analysisFailed,
    analysisNeurons: analysis?.neurons || 0,
    analysisCostUsd: analysis?.costUsd || 0,
    analysisProvider: analysis?.provider || "",
    fallbackReason: analysis?.fallbackReason || "",
    sourcePlatform: post.sourcePlatform,
    briefingItem,
  });
}

async function maintenance(task: MaintenanceTask): Promise<void> {
  if (task.task === "cleanup") {
    await cleanupOldArticles();
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
  return maintenance(task);
}

export async function processMonitorQueue(batch: QueueBatch, env: QueueEnv): Promise<void> {
  if (!env.HYPERDRIVE) throw new Error("HYPERDRIVE binding is required for queued monitor work");
  for (const message of batch.messages) {
    try {
      await withCloudflareEnv(env, () =>
        withHyperdriveDatabase(env.HYPERDRIVE!, () => processTask(message.body, env)),
      );
      message.ack();
    } catch (error) {
      console.error(`[Monitor Queue] ${message.body.kind}: ${String(error).slice(0, 500)}`);
      const finalAttempt = (message.attempts || 1) >= 4;
      if (!finalAttempt) {
        message.retry({ delaySeconds: 30 });
        continue;
      }
      try {
        if (message.body.kind === "discovery") {
          const state = await withCloudflareEnv(env, () =>
            withHyperdriveDatabase(env.HYPERDRIVE!, () =>
              coordinatorPost<CoordinatorStats>(
                env,
                message.body.profile,
                "/discovery-done",
                {
                  cycleId: message.body.cycleId,
                  taskId: message.body.taskId,
                  discovered: 0,
                  failed: true,
                },
              ),
            ),
          );
          if (state.status === "success" || state.status === "partial_failure") {
            await withCloudflareEnv(env, () =>
              withHyperdriveDatabase(env.HYPERDRIVE!, () => syncLegacyStatus(state)),
            );
          }
        } else if (message.body.kind === "candidate") {
          await withCloudflareEnv(env, () =>
            withHyperdriveDatabase(env.HYPERDRIVE!, () =>
              completeCandidate(env, message.body, { failed: true }),
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
  const messages: Array<{ body: QueueTask }> = [];
  const profile: MonitorProfile | null =
    local.minute === 15
      ? "monitor_primary_news"
      : local.minute === 40
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
  if (local.hour === 3 && local.minute === 40) {
    messages.push({ body: { kind: "maintenance", task: "cleanup", scheduledTime } });
    if (local.weekday === 1) {
      messages.push({ body: { kind: "maintenance", task: "weekly_report", scheduledTime } });
    }
    if (local.day === 1) {
      messages.push({ body: { kind: "maintenance", task: "monthly_report", scheduledTime } });
    }
  }
  if (messages.length > 0) await env.MONITOR_QUEUE.sendBatch(messages);
}
