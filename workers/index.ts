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

import { Hono } from "hono";
import { cors } from "hono/cors";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { sql } from "drizzle-orm";
import { appRouter } from "../server/routers";
import { getBootErrors, getBootInfo } from "../server/_core/boot";
import { getDb, setDatabaseUrl } from "./cf-db";
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
  // Hyperdrive binding (optional, for connection pooling)
  HYPERDRIVE?: { connectionString: string };
}

// ─── App ───
const app = new Hono<{ Bindings: Env }>();

// Inject env into global-like state so existing server modules can read it
app.use("*", async (c, next) => {
  // Make DATABASE_URL available to the db module
  const dbUrl = c.env.HYPERDRIVE?.connectionString ?? c.env.DATABASE_URL;
  setDatabaseUrl(dbUrl);

  // Populate process.env shims for modules that read them directly
  (globalThis as any).__CF_ENV__ = c.env;

  await next();
});

// CORS
app.use("/api/*", cors({
  origin: (origin) => origin || "*",
  credentials: true,
}));

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
        res: null, // Workers don't have Express res; cookie setting handled differently
        user,
        // Hono context for setting cookies in mutations that need it
        honoCtx: c,
      };
    },
  });
});

// ─── Cloudflare Cron Triggers ───
// These replace node-cron schedules from the Express version.
// Configure in wrangler.toml:
//   [triggers]
//   crons = ["30 20 * * *", "30 0 * * 1", "40 0 1 * *"]
//   # 04:30 CST = 20:30 UTC (data cleanup)
//   # 08:30 CST Mon = 00:30 UTC Mon (weekly report)
//   # 08:40 CST 1st = 00:40 UTC 1st (monthly report)

export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    setDatabaseUrl(env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL);
    (globalThis as any).__CF_ENV__ = env;

    const hour = new Date(event.scheduledTime).getUTCHours();
    const minute = new Date(event.scheduledTime).getUTCMinutes();
    const dayOfWeek = new Date(event.scheduledTime).getUTCDay();
    const dayOfMonth = new Date(event.scheduledTime).getUTCDate();

    // 04:30 CST daily = 20:30 UTC previous day → data cleanup
    if (hour === 20 && minute === 30) {
      const { cleanupOldArticles } = await import("../server/monitor/cleanup");
      ctx.waitUntil(cleanupOldArticles().catch(e => console.error(`Cleanup failed: ${e.message}`)));
    }

    // 08:30 CST Monday = 00:30 UTC Monday → weekly report
    if (hour === 0 && minute === 30 && dayOfWeek === 1) {
      const { generateMonitorReport, weeklyPeriodOf } = await import("../server/monitor/report");
      const lastWeek = weeklyPeriodOf(weeklyPeriodOf(Date.now()).startMs - 1);
      ctx.waitUntil(
        generateMonitorReport("weekly", lastWeek.reportPeriod).catch(e =>
          console.error(`Weekly report failed: ${e.message}`)
        )
      );
    }

    // 08:40 CST 1st = 00:40 UTC 1st → monthly report
    if (hour === 0 && minute === 40 && dayOfMonth === 1) {
      const { generateMonitorReport, monthlyPeriodOf } = await import("../server/monitor/report");
      const lastMonth = monthlyPeriodOf(monthlyPeriodOf(Date.now()).startMs - 1);
      ctx.waitUntil(
        generateMonitorReport("monthly", lastMonth.reportPeriod).catch(e =>
          console.error(`Monthly report failed: ${e.message}`)
        )
      );
    }
  },
};
