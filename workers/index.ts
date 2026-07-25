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
  runScheduledCollection,
  runScheduledMonitorCycle,
} from "../server/routers";
import { getBootErrors, getBootInfo } from "../server/_core/boot";
import {
  getDb,
  getSchedulerConfig,
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
  HYPERDRIVE?: HyperdriveBinding;
}

// ─── App ───
export const app = new Hono<{ Bindings: Env }>();

// Scope one Hyperdrive-backed mysql2 connection to each API request. Static
// assets bypass this Worker at the Cloudflare routing layer.
app.use("*", async (c, next) => {
  (globalThis as any).__CF_ENV__ = c.env;
  if (!c.env.HYPERDRIVE) {
    await next();
    return;
  }
  await withHyperdriveDatabase(c.env.HYPERDRIVE, async () => {
    await next();
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

export async function runCloudflareScheduledTasks(event: ScheduledEvent, env: Env) {
  if (!env.HYPERDRIVE) throw new Error("HYPERDRIVE binding is required for scheduled work");

  await withHyperdriveDatabase(env.HYPERDRIVE, async () => {
    const time = shanghaiParts(event.scheduledTime);
    const saved = await getSchedulerConfig();

    if (saved?.enabled && cronMatches(saved.cronExpression, event.scheduledTime)) {
      await runScheduledCollection(saved.concurrency);
    }
    if (saved?.monitorEnabled && cronMatches(saved.monitorCron, event.scheduledTime)) {
      await runScheduledMonitorCycle();
    }

    if (time.hour === 4 && time.minute === 30) {
      const { cleanupOldArticles } = await import("../server/monitor/cleanup");
      await cleanupOldArticles();
    }
    if (time.hour === 8 && time.minute === 30 && time.weekday === 1) {
      const { generateMonitorReport, weeklyPeriodOf } = await import("../server/monitor/report");
      const lastWeek = weeklyPeriodOf(weeklyPeriodOf(Date.now()).startMs - 1);
      await generateMonitorReport("weekly", lastWeek.reportPeriod);
    }
    if (time.hour === 8 && time.minute === 40 && time.day === 1) {
      const { generateMonitorReport, monthlyPeriodOf } = await import("../server/monitor/report");
      const lastMonth = monthlyPeriodOf(monthlyPeriodOf(Date.now()).startMs - 1);
      await generateMonitorReport("monthly", lastMonth.reportPeriod);
    }
  });
}

export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    (globalThis as any).__CF_ENV__ = env;
    if (env.ENABLE_CLOUDFLARE_CRON !== "true") return;
    ctx.waitUntil(
      runCloudflareScheduledTasks(event, env).catch((error) => {
        console.error(`[Cloudflare Cron] ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }),
    );
  },
};
