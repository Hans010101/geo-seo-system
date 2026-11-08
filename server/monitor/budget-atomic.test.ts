import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { resetMonitorBudgetMonth, reserveSysConfigCredit, withHyperdriveDatabase } from "../db";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
const sqlite = new DatabaseSync(":memory:");
sqlite.exec("CREATE TABLE sysConfigs (configKey TEXT UNIQUE, configValue TEXT)");
afterEach(() => sqlite.exec("DELETE FROM sysConfigs"));
// Exercise the production prepared SQL against SQLite, including batch transaction semantics.
const client = {
  prepare(sql: string) {
    return { bind(...params: any[]) {
      return { first: async () => sqlite.prepare(sql).get(...params) ?? null,
        run: () => sqlite.prepare(sql).run(...params) };
    } };
  },
  async batch(statements: any[]) {
    sqlite.exec("BEGIN");
    try { const results = statements.map(s => s.run()); sqlite.exec("COMMIT"); return results; }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  },
};

describe("D1 paid budget SQL", () => {
  it("grants only the final credit to simultaneous callers", async () => {
    await withHyperdriveDatabase(client as any, async () => {
      await resetMonitorBudgetMonth("2026-10");
      sqlite.exec("INSERT INTO sysConfigs VALUES ('monitor_firecrawl_monthly_limit', '800'); UPDATE sysConfigs SET configValue='799' WHERE configKey='monitor_firecrawl_used_this_month'");
      const results = await Promise.all(Array.from({ length: 10 }, () => reserveSysConfigCredit("monitor_firecrawl_used_this_month", "monitor_firecrawl_monthly_limit", 800)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(sqlite.prepare("SELECT configValue FROM sysConfigs WHERE configKey='monitor_firecrawl_used_this_month'").get()?.configValue).toBe("800");
    });
  });
  it("does not wipe usage when another isolate already rolled the month", async () => {
    await withHyperdriveDatabase(client as any, async () => {
      await resetMonitorBudgetMonth("2026-10");
      expect(await reserveSysConfigCredit("monitor_firecrawl_used_this_month", "monitor_firecrawl_monthly_limit", 800)).toBe(true);
      await resetMonitorBudgetMonth("2026-10");
      expect(sqlite.prepare("SELECT configValue FROM sysConfigs WHERE configKey='monitor_firecrawl_used_this_month'").get()?.configValue).toBe("1");
      await resetMonitorBudgetMonth("2026-11");
      expect(sqlite.prepare("SELECT configValue FROM sysConfigs WHERE configKey='monitor_firecrawl_used_this_month'").get()?.configValue).toBe("0");
    });
  });
});
