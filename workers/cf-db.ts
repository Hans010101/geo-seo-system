/**
 * Cloudflare Workers compatible database connection.
 *
 * Uses mysql2 via the nodejs_compat flag. The connection URL is injected
 * per-request from the Worker's env bindings (optionally via Hyperdrive).
 */

import { drizzle } from "drizzle-orm/mysql2";

let _db: ReturnType<typeof drizzle> | null = null;
let _currentUrl: string | null = null;

/**
 * Called per-request from the Hono middleware to set the database URL
 * from Cloudflare env bindings.
 */
export function setDatabaseUrl(url: string) {
  if (url && url !== _currentUrl) {
    _currentUrl = url;
    _db = null; // Force reconnect with new URL
  }
}

export async function getDb() {
  if (!_db && _currentUrl) {
    try {
      _db = drizzle(_currentUrl);
    } catch (error) {
      console.warn("[CF-Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}
