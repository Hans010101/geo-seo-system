import "dotenv/config";
import "./preload"; // installs process-level guards BEFORE routers.ts boot IIFEs execute
import express from "express";
import { createServer } from "http";
import net from "net";
import { sql } from "drizzle-orm";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerAuthRoutes } from "../auth";
import { appRouter, beginShutdown, cleanupStaleCollections } from "../routers";
import { createContext } from "./context";
import { serveStatic } from "./static";
import { getBootErrors, getBootInfo } from "./boot";
import { getDb } from "../db";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  // Session cookies are HS256-signed with JWT_SECRET. An empty secret means anyone can forge
  // a session for any user (incl. admin). Refuse to boot in production; loudly warn elsewhere.
  if (!process.env.JWT_SECRET) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "JWT_SECRET must be set in production — an empty signing key allows session forgery."
      );
    }
    console.warn(
      "[security] JWT_SECRET is not set; sessions are signed with an empty key. Set JWT_SECRET before deploying."
    );
  }

  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  // Auth routes (register + login)
  registerAuthRoutes(app);
  // Runtime health for post-deploy smoke tests + external probes (no auth; registered before the
  // static "*" catch-all). ok=false (503) when DB is unreachable OR any boot-guard recorded an
  // init failure — "deployed but degraded" becomes machine-detectable.
  app.get("/api/health", async (_req, res) => {
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
    res.status(ok ? 200 : 503).json({ ok, db: dbOk, ...getBootInfo(), bootErrors });
  });

  // Telegram bot webhook (public; verified inside via secret_token header). Always 200 so Telegram
  // doesn't retry; the handler ignores anything without a valid secret / bind code.
  app.post("/api/telegram/webhook", async (req, res) => {
    try {
      const { handleTelegramUpdate } = await import("../monitor/telegram-connect");
      await handleTelegramUpdate(req.body, req.header("x-telegram-bot-api-secret-token") || undefined);
    } catch (e: any) {
      console.warn("[telegram webhook]", e?.message || e);
    }
    res.status(200).json({ ok: true });
  });

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    const { setupVite } = await import("./vite");
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });

  // Periodically fail collections abandoned in "pending" (e.g. by a previous crash) so they
  // don't linger forever and they show up in health stats.
  const staleTimer = setInterval(() => {
    cleanupStaleCollections().catch(() => {});
  }, 5 * 60 * 1000);
  staleTimer.unref?.();

  // Graceful shutdown: stop accepting new connections and stop starting new collection work,
  // letting in-flight requests drain before exit.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down gracefully...`);
    beginShutdown();
    clearInterval(staleTimer);
    server.close(() => {
      console.log("HTTP server closed, exiting.");
      process.exit(0);
    });
    // Hard cap so a hung connection can't block termination forever.
    setTimeout(() => process.exit(0), 15000).unref?.();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// A server that fails to start must FAIL FAST (exit 1) so Cloud Run kills the instance and
// retries/keeps traffic on healthy ones — not linger as a zombie process that never listens.
startServer().catch((err) => {
  console.error("[BOOT] Fatal: server failed to start:", err);
  process.exit(1);
});
