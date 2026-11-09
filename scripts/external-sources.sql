-- Vendor systems read by the Mac collector (tools/local-social-collector):
-- 智推时代 GenOptima AI answers and 百分点 Mediaforce daily totals.
-- Apply: wrangler d1 execute geo-seo-system-db --remote --file scripts/external-sources.sql
CREATE TABLE IF NOT EXISTS externalGeoAnswers (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  platform TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  sentiment TEXT,
  brandMentioned INTEGER,
  brandRank INTEGER,
  intentType INTEGER,
  refs TEXT NOT NULL DEFAULT '[]',
  referenceCount INTEGER NOT NULL DEFAULT 0,
  competitors TEXT NOT NULL DEFAULT '[]',
  queryTime INTEGER NOT NULL,
  queryDay TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS externalGeoAnswers_time ON externalGeoAnswers(queryTime);
CREATE INDEX IF NOT EXISTS externalGeoAnswers_day_platform ON externalGeoAnswers(queryDay, platform, sentiment);

CREATE TABLE IF NOT EXISTS externalDailyStats (
  source TEXT NOT NULL,
  day TEXT NOT NULL,
  stats TEXT NOT NULL,
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY (source, day)
);
