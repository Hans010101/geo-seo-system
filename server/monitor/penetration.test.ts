import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

// Loaded at runtime: Vite's resolver drops the "node:" prefix of node:sqlite (Node 22+ built-in).
type SqliteDb = {
  prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[]; run(...args: unknown[]): unknown };
  exec(sql: string): void;
};
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => SqliteDb;
};

vi.mock("../db", () => ({
  getDb: vi.fn(),
  getMonitorArticleById: vi.fn(),
}));

import {
  aggregateSharedReach,
  citationReachSql,
  monitoredPostsByKeySql,
  normSql,
  sharedCitationKeysSql,
  urlKeySql,
} from "./penetration";
import { isSharedPlatformDomain, normalizeDomain, urlKey } from "./util";

const sqlite = () => new DatabaseSync(":memory:");
const evalSql = (db: SqliteDb, expr: string, value: string) =>
  (db.prepare(`SELECT ${expr} AS v FROM (SELECT ? AS c)`).get(value) as { v: string }).v;

describe("domain normalization", () => {
  const cases = [
    "weibo.com",
    "www.weibo.com",
    "wsj.com",
    "https://www.WSJ.com/articles/x?y=1",
    "WWW.Bloomberg.com:443",
    "http://x.com/user/status/1",
    "彭博社",
    "w.wiki",
  ];

  it("keeps the SQL twin identical to normalizeDomain and only strips a www. prefix", () => {
    const db = sqlite();
    for (const raw of cases) expect(evalSql(db, normSql("c"), raw)).toBe(normalizeDomain(raw));
    expect(normalizeDomain("weibo.com")).toBe("weibo.com");
    expect(evalSql(db, normSql("c"), "wsj.com")).toBe("wsj.com");
  });

  it("builds identical URL keys in JS and SQL", () => {
    const db = sqlite();
    const urls = [
      "https://x.com/Yell0w_GG/status/2118267895293804919",
      "https://twitter.com/Yell0w_GG/status/2118267895293804919?s=20",
      "HTTPS://WWW.Bilibili.com/video/BV1xx/#reply",
      "https://www.coindesk.com/policy/2026/11/05/story/",
    ];
    for (const raw of urls) expect(evalSql(db, urlKeySql("c"), raw)).toBe(urlKey(raw));
    expect(urlKey(urls[0])).toBe(urlKey(urls[1]));
  });

  it("treats social and community hosts as shared platforms", () => {
    expect(isSharedPlatformDomain("https://x.com/a/status/1")).toBe(true);
    expect(isSharedPlatformDomain("www.binance.com")).toBe(true);
    expect(isSharedPlatformDomain("coindesk.com")).toBe(false);
  });
});

describe("AI citation reach", () => {
  const seed = () => {
    const db = sqlite();
    db.exec(`
      CREATE TABLE collections (id INTEGER PRIMARY KEY, platform TEXT, timestamp INTEGER);
      CREATE TABLE citations (id INTEGER PRIMARY KEY, collectionId INTEGER, url TEXT, domain TEXT);
      CREATE TABLE monitor_articles (id INTEGER PRIMARY KEY, url TEXT, domain TEXT);
      CREATE TABLE platformConfigs (platform TEXT, isEnabled INTEGER);
      INSERT INTO platformConfigs VALUES ('chatgpt', 1), ('kimi', 1), ('perplexity', 1), ('hunyuan', 0);
    `);
    const now = Date.now();
    const old = now - 120 * 86_400_000;
    const insertCollection = db.prepare("INSERT INTO collections VALUES (?, ?, ?)");
    insertCollection.run(1, "chatgpt", now);
    insertCollection.run(2, "kimi", now);
    insertCollection.run(3, "perplexity", old);
    insertCollection.run(4, "hunyuan", now);
    const insertCitation = db.prepare("INSERT INTO citations (collectionId, url, domain) VALUES (?, ?, ?)");
    insertCitation.run(1, "https://twitter.com/Cited/status/1?s=20", "twitter.com");
    insertCitation.run(2, "https://x.com/unmonitored/status/9", "x.com");
    insertCitation.run(1, "https://www.coindesk.com/a", "www.coindesk.com");
    insertCitation.run(2, "https://coindesk.com/b", "coindesk.com");
    insertCitation.run(3, "https://weibo.com/123/abc", "weibo.com");
    insertCitation.run(3, "https://theblock.co/x", "theblock.co");
    insertCitation.run(4, "https://decrypt.co/retired-platform", "decrypt.co");
    const insertArticle = db.prepare("INSERT INTO monitor_articles (url, domain) VALUES (?, ?)");
    insertArticle.run("https://x.com/Cited/status/1", "x.com");
    insertArticle.run("https://x.com/other/status/2", "x.com");
    insertArticle.run("https://weibo.com/123/abc", "weibo.com");
    return db;
  };

  it("counts ordinary sites per domain and ignores stale answers and shared platforms", () => {
    const db = seed();
    const rows = db.prepare(`SELECT * FROM ${citationReachSql()} c ORDER BY domain`).all() as Array<{
      domain: string;
      aiCitations: number;
      aiPlatforms: number;
    }>;
    expect(rows.map((r) => r.domain)).toEqual(["coindesk.com"]);
    expect(rows[0]).toMatchObject({ aiCitations: 2, aiPlatforms: 2 });
  });

  it("matches shared platforms per monitored post URL", () => {
    const db = seed();
    const citations = db.prepare(sharedCitationKeysSql()).all() as { u: string; platform: string }[];
    expect(citations.map((c) => c.u).sort()).toEqual([
      "https://x.com/cited/status/1",
      "https://x.com/unmonitored/status/9",
    ]);
    const posts = db
      .prepare(monitoredPostsByKeySql(citations.map((c) => c.u)))
      .all() as { domain: string; u: string }[];
    const reach = aggregateSharedReach(citations, posts);
    expect(reach.get("x.com")).toEqual({ aiCitations: 1, aiPlatforms: 1, platformList: ["chatgpt"] });
    expect(reach.has("weibo.com")).toBe(false);
  });
});
