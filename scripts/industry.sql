-- 行业动态 (server/industry*.ts). Apply: wrangler d1 execute geo-seo-system-db --remote --file scripts/industry.sql
-- Feed items from the Mac collector; status new → done | dup | skip after LLM triage.
CREATE TABLE IF NOT EXISTS industryNews (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  excerpt TEXT,
  publishedAt INTEGER NOT NULL,
  fetchedAt INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  attempts INTEGER NOT NULL DEFAULT 0,
  category TEXT,
  importance INTEGER,
  entities TEXT,
  tron INTEGER,
  tronNote TEXT,
  summary TEXT,
  dupOf TEXT,
  sourceCount INTEGER NOT NULL DEFAULT 1,
  sources TEXT,
  alertedAt INTEGER
);
CREATE INDEX IF NOT EXISTS industryNews_status ON industryNews(status, publishedAt);
CREATE INDEX IF NOT EXISTS industryNews_published ON industryNews(publishedAt);
-- Daily numbers: DefiLlama stablecoins/TVL/fees per chain, issuer supply, Binance reserves, Fear & Greed.
CREATE TABLE IF NOT EXISTS industryMetrics (
  day TEXT NOT NULL,
  entity TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY (day, entity, metric)
);
-- Weekly LLM digest, id = Beijing end day.
CREATE TABLE IF NOT EXISTS industryWeekly (
  id TEXT PRIMARY KEY,
  generatedAt INTEGER NOT NULL,
  data TEXT NOT NULL
);
