-- 早报 / 晚报 (server/brief.ts): one row per brief, id = YYYY-MM-DD-am|pm, data = BriefData JSON.
-- Apply: wrangler d1 execute geo-seo-system-db --remote --file scripts/daily-briefs.sql
CREATE TABLE IF NOT EXISTS dailyBriefs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  day TEXT NOT NULL,
  generatedAt INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS dailyBriefs_generated ON dailyBriefs(generatedAt);
-- 2026-11-11: scheduled sends (09:30 / 17:30) mark delivery so queue retries never mail twice.
-- (Run once on an existing table:) ALTER TABLE dailyBriefs ADD COLUMN deliveredAt INTEGER;
