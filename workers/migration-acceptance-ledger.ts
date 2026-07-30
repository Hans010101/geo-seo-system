import { DurableObject } from "cloudflare:workers";
import {
  summarizeMigrationAcceptance,
  type AcceptanceCycleRecord,
  type BinanceAcceptanceRecord,
  type BrowserAcceptanceRecord,
  type GeoAcceptanceRecord,
  type NotificationAcceptanceRecord,
} from "./migration-acceptance-types";

const RETENTION_MS = 35 * 86_400_000;

type MigrationAcceptanceEnv = Record<string, never>;

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function key(prefix: string, timestamp: number, id: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 180);
  return `${prefix}${String(timestamp).padStart(13, "0")}:${safeId}`;
}

export class MigrationAcceptanceLedger extends DurableObject<MigrationAcceptanceEnv> {
  private async prune(prefix: string): Promise<void> {
    const pruneKey = `meta:pruned:${prefix}`;
    const lastPrunedAt = (await this.ctx.storage.get<number>(pruneKey)) || 0;
    if (Date.now() - lastPrunedAt < 6 * 3_600_000) return;
    const cutoff = Date.now() - RETENTION_MS;
    const records = await this.ctx.storage.list({ prefix, limit: 500 });
    const expired: string[] = [];
    for (const recordKey of records.keys()) {
      const timestamp = Number(recordKey.slice(prefix.length, prefix.length + 13));
      if (timestamp > 0 && timestamp < cutoff) expired.push(recordKey);
    }
    if (expired.length > 0) await this.ctx.storage.delete(expired);
    await this.ctx.storage.put(pruneKey, Date.now());
  }

  private async put(prefix: string, timestamp: number, id: string, value: unknown): Promise<void> {
    await this.ctx.storage.put(key(prefix, timestamp, id), value);
    await this.prune(prefix);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/status") {
      const windowStart = Math.max(
        0,
        Number(url.searchParams.get("windowStart")) || Date.now() - 7 * 86_400_000,
      );
      const stage6WindowStart = Math.max(
        0,
        Number(url.searchParams.get("stage6WindowStart")) || 0,
      );
      const [cycleMap, binanceMap, browserMap, notificationMap, geoMap] = await Promise.all([
        this.ctx.storage.list<AcceptanceCycleRecord>({ prefix: "cycle:", limit: 500 }),
        this.ctx.storage.list<BinanceAcceptanceRecord>({ prefix: "binance:", limit: 500 }),
        this.ctx.storage.list<BrowserAcceptanceRecord>({ prefix: "browser:", limit: 500 }),
        this.ctx.storage.list<NotificationAcceptanceRecord>({ prefix: "notification:", limit: 500 }),
        this.ctx.storage.list<GeoAcceptanceRecord>({ prefix: "geo:", limit: 500 }),
      ]);
      const cycles = Array.from(cycleMap.values());
      const binance = Array.from(binanceMap.values());
      const browser = Array.from(browserMap.values());
      const notifications = Array.from(notificationMap.values());
      const geo = Array.from(geoMap.values());
      return json({
        summary: summarizeMigrationAcceptance({
          windowStart,
          now: Date.now(),
          cycles,
          binance,
          browser,
          notifications,
          geo,
          stage6WindowStart,
        }),
        recent: {
          cycles: cycles.sort((a, b) => b.finishedAt - a.finishedAt).slice(0, 6),
          binance: binance.sort((a, b) => b.finishedAt - a.finishedAt).slice(0, 6),
          browser: browser.sort((a, b) => b.finishedAt - a.finishedAt).slice(0, 6),
          notifications: notifications
            .sort((a, b) => b.finishedAt - a.finishedAt)
            .slice(0, 6),
          geo: geo.sort((a, b) => b.finishedAt - a.finishedAt).slice(0, 12),
        },
      });
    }
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    const body = await request.json<Record<string, unknown>>();
    if (url.pathname === "/record-cycle") {
      const record = body as AcceptanceCycleRecord;
      if (!record.cycleId || !Number.isFinite(record.finishedAt)) {
        return json({ error: "invalid cycle record" }, 400);
      }
      await this.put("cycle:", record.finishedAt, record.cycleId, record);
      return json({ ok: true });
    }
    if (url.pathname === "/record-binance") {
      const record = body as BinanceAcceptanceRecord;
      if (!record.runId || !Number.isFinite(record.finishedAt)) {
        return json({ error: "invalid Binance record" }, 400);
      }
      await this.put("binance:", record.finishedAt, record.runId, record);
      return json({ ok: true });
    }
    if (url.pathname === "/record-browser") {
      const record = body as BrowserAcceptanceRecord;
      if (!record.urlHash || !Number.isFinite(record.finishedAt)) {
        return json({ error: "invalid Browser record" }, 400);
      }
      await this.put("browser:", record.finishedAt, record.urlHash, record);
      return json({ ok: true });
    }
    if (url.pathname === "/record-notification") {
      const record = body as NotificationAcceptanceRecord;
      if (!record.cycleId || !Number.isFinite(record.finishedAt)) {
        return json({ error: "invalid notification record" }, 400);
      }
      await this.put("notification:", record.finishedAt, record.cycleId, record);
      return json({ ok: true });
    }
    if (url.pathname === "/record-geo") {
      const record = body as GeoAcceptanceRecord;
      if (!record.runId || !Number.isFinite(record.finishedAt)) {
        return json({ error: "invalid GEO record" }, 400);
      }
      await this.put("geo:", record.finishedAt, record.runId, record);
      return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  }
}
