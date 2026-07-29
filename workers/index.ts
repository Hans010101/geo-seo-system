/**
 * Cloudflare Workers / Pages Functions entry point.
 *
 * This module creates a Hono application that mirrors the Express server in
 * server/_core/index.ts but runs on the Cloudflare Workers runtime.
 *
 * Key adaptations from Express → Hono/Workers:
 * - Express → Hono (Web-standard Request/Response)
 * - @trpc/server/adapters/express → @trpc/server/adapters/fetch
 * - node:crypto → Web Crypto API
 * - node-cron → Cloudflare Cron Triggers (scheduled handler)
 * - process.env → c.env (Cloudflare bindings)
 */

// Polyfill MessagePort for undici in Cloudflare Workers environment
if (typeof MessagePort === "undefined") {
  (globalThis as any).MessagePort = class MessagePort {};
}

import { Hono } from "hono";
import { deleteCookie } from "hono/cookie";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { sql } from "drizzle-orm";
import { COOKIE_NAME } from "../shared/const";
import {
  appRouter,
  runCloudflareGeoWeeklyShard,
  runScheduledCollection,
  runScheduledMonitorCycle,
} from "../server/routers";
import { getBootErrors, getBootInfo } from "../server/_core/boot";
import { withCloudflareEnv } from "../server/_core/cloudflare-env";
import {
  getDb,
  getSchedulerConfig,
  getSysConfig,
  setSysConfig,
  withHyperdriveDatabase,
  type HyperdriveBinding,
} from "../server/db";
import {
  authenticateRequestCf,
  registerAuthRoutesCf,
} from "./cf-auth";

// ─── Types ───
export interface Env {
  DATABASE_URL: string;
  JWT_SECRET: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_BASE_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  AUTH_ALLOWED_EMAIL?: string;
  ENABLE_CLOUDFLARE_CRON?: string;
  CLOUDFLARE_CRON_MODE?: string;
  CLOUDFLARE_MONITOR_CRON?: string;
  CLOUDFLARE_CANARY_MAX_KEYWORDS?: string;
  CLOUDFLARE_CANARY_MAX_ARTICLES?: string;
  CLOUDFLARE_CANARY_SOURCES?: string;
  CLOUDFLARE_PRIMARY_MAX_KEYWORDS?: string;
  CLOUDFLARE_PRIMARY_CRON?: string;
  CLOUDFLARE_PRIMARY_NEWS_MAX_ARTICLES?: string;
  CLOUDFLARE_PRIMARY_NEWS_SOURCES?: string;
  CLOUDFLARE_PRIMARY_SOCIAL_MAX_ARTICLES?: string;
  CLOUDFLARE_PRIMARY_SOCIAL_SOURCES?: string;
  CLOUDFLARE_AI_MODEL?: string;
  CLOUDFLARE_AI_MAX_TOKENS?: string;
  CLOUDFLARE_OPENROUTER_FALLBACK_ENABLED?: string;
  CLOUDFLARE_OPENROUTER_FALLBACK_MODEL?: string;
  CLOUDFLARE_GEO_WEEKLY_ENABLED?: string;
  CLOUDFLARE_GEO_WEEKLY_ALL_PLATFORMS?: string;
  CLOUDFLARE_GEO_WEEKLY_MAX_CELLS?: string;
  CLOUDFLARE_GEO_WEEKLY_CONCURRENCY?: string;
  CLOUDFLARE_MAINTENANCE_OFFSET_MINUTES?: string;
  AI?: {
    run(model: string, input: Record<string, unknown>): Promise<unknown>;
  };
  HYPERDRIVE?: HyperdriveBinding;
}

// ─── App ───
export const app = new Hono<{ Bindings: Env }>();

// Scope one Hyperdrive-backed mysql2 connection to each API request. Static
// assets bypass this Worker at the Cloudflare routing layer.
app.use("*", async (c, next) => {
  await withCloudflareEnv(c.env, async () => {
    if (!c.env.HYPERDRIVE) {
      await next();
      return;
    }
    await withHyperdriveDatabase(c.env.HYPERDRIVE, async () => {
      await next();
    });
  });
});

// ─── Health ───
app.get("/api/health", async (c) => {
  let dbOk = false;
  try {
    const db = await getDb();
    if (db) {
      await Promise.race([
        db.execute(sql`SELECT 1`),
        new Promise((_r, rej) => setTimeout(() => rej(new Error("db health timeout")), 3000)),
      ]);
      dbOk = true;
    }
  } catch {
    dbOk = false;
  }
  const bootErrors = getBootErrors();
  const ok = dbOk && bootErrors.length === 0;
  return c.json({ ok, db: dbOk, ...getBootInfo(), bootErrors }, ok ? 200 : 503);
});

// ─── Auth Routes (register, login, Google OAuth) ───
registerAuthRoutesCf(app);

// ─── Telegram Webhook ───
app.post("/api/telegram/webhook", async (c) => {
  try {
    const body = await c.req.json();
    const secretToken = c.req.header("x-telegram-bot-api-secret-token");
    const { handleTelegramUpdate } = await import("../server/monitor/telegram-connect");
    await handleTelegramUpdate(body, secretToken || undefined);
  } catch (e: any) {
    console.warn("[telegram webhook]", e?.message || e);
  }
  return c.json({ ok: true });
});

// ─── tRPC ───
app.all("/api/trpc/*", async (c) => {
  const env = c.env;
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext: async () => {
      // Authenticate from cookie
      const user = await authenticateRequestCf(c);
      return {
        req: c.req.raw,
        res: null,
        user,
        clearSessionCookie: () => {
          deleteCookie(c, COOKIE_NAME, {
            path: "/",
            sameSite: "None",
            secure: true,
          });
        },
      };
    },
  });
});

// ─── Cloudflare Cron Triggers ───
// A once-per-minute dispatcher preserves the user-configurable cron expressions
// stored in MySQL. ENABLE_CLOUDFLARE_CRON remains false while Cloud Run is the
// active scheduler, preventing duplicate collection/report jobs during migration.

function matchesCronField(field: string, value: number, min: number, max: number): boolean {
  return field.split(",").some((entry) => {
    const [rangePart, stepPart] = entry.trim().split("/");
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step < 1) return false;

    let start = min;
    let end = max;
    if (rangePart !== "*") {
      if (rangePart.includes("-")) {
        const [rawStart, rawEnd] = rangePart.split("-");
        start = Number(rawStart);
        end = Number(rawEnd);
      } else {
        start = Number(rangePart);
        end = start;
      }
    }
    if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
    if (value < start || value > end) return false;
    return (value - start) % step === 0;
  });
}

function shanghaiParts(timestamp: number) {
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
    parts.find((part) => part.type === type)?.value ?? "";
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

export function cronMatches(expression: string, timestamp: number): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const time = shanghaiParts(timestamp);
  return (
    matchesCronField(fields[0], time.minute, 0, 59) &&
    matchesCronField(fields[1], time.hour, 0, 23) &&
    matchesCronField(fields[2], time.day, 1, 31) &&
    matchesCronField(fields[3], time.month, 1, 12) &&
    matchesCronField(fields[4].replace(/^7$/, "0"), time.weekday, 0, 6)
  );
}

const CF_CRON_STATUS_KEYS = {
  mode: "cf_cron_mode",
  task: "cf_cron_last_task",
  status: "cf_cron_last_status",
  startedAt: "cf_cron_last_started_at",
  finishedAt: "cf_cron_last_finished_at",
  summary: "cf_cron_last_summary",
  error: "cf_cron_last_error",
} as const;

const CF_GEO_WEEKLY_STATUS_KEYS = {
  mode: "cf_geo_weekly_mode",
  task: "cf_geo_weekly_last_task",
  status: "cf_geo_weekly_last_status",
  startedAt: "cf_geo_weekly_last_started_at",
  finishedAt: "cf_geo_weekly_last_finished_at",
  summary: "cf_geo_weekly_last_summary",
  error: "cf_geo_weekly_last_error",
} as const;

type CloudflareStatusField = keyof typeof CF_CRON_STATUS_KEYS;
type CloudflareStatusKeys = Record<CloudflareStatusField, string>;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function recordCloudflareCronStatus(
  values: Partial<Record<CloudflareStatusField, string>>,
  keys: CloudflareStatusKeys = CF_CRON_STATUS_KEYS,
) {
  await Promise.all(
    Object.entries(values).map(([key, value]) =>
      setSysConfig(keys[key as CloudflareStatusField], value ?? ""),
    ),
  );
}

async function runObservedCloudflareTask<T>(
  mode: string,
  task: string,
  work: () => Promise<T>,
  statusKeys: CloudflareStatusKeys = CF_CRON_STATUS_KEYS,
): Promise<T> {
  await recordCloudflareCronStatus({
    mode,
    task,
    status: "running",
    startedAt: String(Date.now()),
    error: "",
  }, statusKeys);
  try {
    const result = await work();
    const resultRecord = result && typeof result === "object"
      ? result as Record<string, unknown>
      : null;
    const analysisFailed = Number(resultRecord?.analysisFailed || 0);
    const itemFailed = Number(resultRecord?.failed || 0);
    const partialFailure = analysisFailed > 0 || itemFailed > 0;
    await recordCloudflareCronStatus({
      status: partialFailure ? "partial_failure" : "success",
      finishedAt: String(Date.now()),
      summary: JSON.stringify(result ?? null).slice(0, 4000),
      error: partialFailure
        ? `${analysisFailed} analysis failures; ${itemFailed} pipeline failures`
        : "",
    }, statusKeys);
    return result;
  } catch (error) {
    await recordCloudflareCronStatus({
      status: "failed",
      finishedAt: String(Date.now()),
      error: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
    }, statusKeys);
    throw error;
  }
}

export async function getCloudflareCronStatus() {
  const readStatus = async (keys: CloudflareStatusKeys) => Object.fromEntries(await Promise.all(
    Object.entries(keys).map(async ([name, key]) => [name, await getSysConfig(key)] as const),
  ));
  return {
    ...await readStatus(CF_CRON_STATUS_KEYS),
    weeklyGeo: await readStatus(CF_GEO_WEEKLY_STATUS_KEYS),
  };
}

export async function runCloudflareScheduledTasks(event: ScheduledEvent, env: Env) {
  if (!env.HYPERDRIVE) throw new Error("HYPERDRIVE binding is required for scheduled work");

  await withHyperdriveDatabase(env.HYPERDRIVE, async () => {
    const mode = env.CLOUDFLARE_CRON_MODE === "full"
      ? "full"
      : env.CLOUDFLARE_CRON_MODE === "primary"
        ? "primary"
        : "canary";
    const maintenanceOffsetMinutes = positiveInt(env.CLOUDFLARE_MAINTENANCE_OFFSET_MINUTES, 15);
    const maintenanceTime = shanghaiParts(event.scheduledTime - maintenanceOffsetMinutes * 60_000);
    const saved = await getSchedulerConfig();

    if (mode === "full") {
      if (saved?.enabled && cronMatches(saved.cronExpression, event.scheduledTime)) {
        await runObservedCloudflareTask(mode, "collection", () =>
          runScheduledCollection(saved.concurrency),
        );
      }
      if (saved?.monitorEnabled && cronMatches(saved.monitorCron, event.scheduledTime)) {
        await runObservedCloudflareTask(mode, "monitor", () => runScheduledMonitorCycle());
      }
    } else if (mode === "primary") {
      // Free Workers are limited to 50 external subrequests per invocation.
      // Split news discovery (Serper/RSS + page fetches) from sources that
      // already provide full content, and run both ahead of unchanged Cloud Run.
      const profiles = [
        {
          task: "monitor_primary_news",
          minute: 15,
          maxArticles: positiveInt(env.CLOUDFLARE_PRIMARY_NEWS_MAX_ARTICLES, 12),
          sources: env.CLOUDFLARE_PRIMARY_NEWS_SOURCES || "serper,rss",
        },
        {
          task: "monitor_primary_social",
          minute: 40,
          maxArticles: positiveInt(env.CLOUDFLARE_PRIMARY_SOCIAL_MAX_ARTICLES, 14),
          // Binance currently rejects Cloudflare egress with HTTP 403; unchanged
          // Cloud Run remains its fallback during the parallel-observation period.
          sources: env.CLOUDFLARE_PRIMARY_SOCIAL_SOURCES || "gate_square,telegram,x",
        },
      ];
      const primaryCron = env.CLOUDFLARE_PRIMARY_CRON || "15,40 1-23/2 * * *";
      const localTime = shanghaiParts(event.scheduledTime);
      const profile = event.cron === primaryCron
        ? profiles.find((candidate) => candidate.minute === localTime.minute)
        : undefined;
      if (saved?.monitorEnabled && profile) {
        const sourceNames = profile.sources.split(",").map((value) => value.trim()).filter(Boolean);
        await runObservedCloudflareTask(mode, profile.task, () =>
          runScheduledMonitorCycle(undefined, {
            maxKeywords: positiveInt(env.CLOUDFLARE_PRIMARY_MAX_KEYWORDS, 100),
            maxArticles: profile.maxArticles,
            sourceNames,
            suppressNotifications: false,
            recordSchedulerRun: false,
          }),
        );
      }
      if (
        profile?.minute === 40 &&
        env.CLOUDFLARE_GEO_WEEKLY_ENABLED === "true"
      ) {
        await runObservedCloudflareTask(
          mode,
          "geo_weekly_openrouter_shard",
          () => runCloudflareGeoWeeklyShard({
            maxCells: positiveInt(env.CLOUDFLARE_GEO_WEEKLY_MAX_CELLS, 6),
            concurrency: positiveInt(env.CLOUDFLARE_GEO_WEEKLY_CONCURRENCY, 3),
            timestamp: event.scheduledTime,
            allPlatforms: env.CLOUDFLARE_GEO_WEEKLY_ALL_PLATFORMS === "true",
          }),
          CF_GEO_WEEKLY_STATUS_KEYS,
        );
      }
    } else {
      const canaryCron = env.CLOUDFLARE_MONITOR_CRON || "35 11 * * *";
      if (saved?.monitorEnabled && cronMatches(canaryCron, event.scheduledTime)) {
        const sourceNames = (env.CLOUDFLARE_CANARY_SOURCES || "serper")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        await runObservedCloudflareTask(mode, "monitor_canary", () =>
          runScheduledMonitorCycle("qdr:w", {
            maxKeywords: positiveInt(env.CLOUDFLARE_CANARY_MAX_KEYWORDS, 1),
            maxArticles: positiveInt(env.CLOUDFLARE_CANARY_MAX_ARTICLES, 2),
            sourceNames,
            suppressNotifications: true,
            recordSchedulerRun: false,
          }),
        );
      }
    }

    const localTime = shanghaiParts(event.scheduledTime);
    const primaryDailyMaintenance =
      mode === "primary" &&
      event.cron === (env.CLOUDFLARE_PRIMARY_CRON || "15,40 1-23/2 * * *") &&
      localTime.hour === 3 &&
      localTime.minute === 40;
    const maintenanceWindow =
      (maintenanceTime.hour === 4 && maintenanceTime.minute === 30) ||
      primaryDailyMaintenance;

    if (maintenanceWindow) {
      const { cleanupOldArticles } = await import("../server/monitor/cleanup");
      await runObservedCloudflareTask(mode, "cleanup", cleanupOldArticles);
    }
    // The primary social event also carries maintenance once per day, keeping
    // all of this Worker inside the account's one remaining Free-plan Cron slot.
    if (maintenanceWindow && localTime.weekday === 1) {
      const { generateMonitorReport, weeklyPeriodOf } = await import("../server/monitor/report");
      const lastWeek = weeklyPeriodOf(weeklyPeriodOf(Date.now()).startMs - 1);
      await runObservedCloudflareTask(mode, "weekly_report", () =>
        generateMonitorReport("weekly", lastWeek.reportPeriod),
      );
    }
    if (maintenanceWindow && localTime.day === 1) {
      const { generateMonitorReport, monthlyPeriodOf } = await import("../server/monitor/report");
      const lastMonth = monthlyPeriodOf(monthlyPeriodOf(Date.now()).startMs - 1);
      await runObservedCloudflareTask(mode, "monthly_report", () =>
        generateMonitorReport("monthly", lastMonth.reportPeriod),
      );
    }
  });
}

export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    if (env.ENABLE_CLOUDFLARE_CRON !== "true") return;
    ctx.waitUntil(
      withCloudflareEnv(env, () =>
        runCloudflareScheduledTasks(event, env).catch((error) => {
          console.error(`[Cloudflare Cron] ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }),
      ),
    );
  },
};
