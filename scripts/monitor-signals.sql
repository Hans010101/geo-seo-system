-- Spread signals (server/monitor/signals.ts): engagement/author fields, simhash near-duplicate folding,
-- and the alert severity timeline. Additive only. Apply once, before deploying the code that uses it:
--   npx wrangler d1 execute geo-seo-system-db --remote --file scripts/monitor-signals.sql
ALTER TABLE monitor_articles ADD COLUMN authorName TEXT;
ALTER TABLE monitor_articles ADD COLUMN authorFollowers INTEGER;
ALTER TABLE monitor_articles ADD COLUMN authorVerified TEXT;
ALTER TABLE monitor_articles ADD COLUMN likeCount INTEGER;
ALTER TABLE monitor_articles ADD COLUMN commentCount INTEGER;
ALTER TABLE monitor_articles ADD COLUMN shareCount INTEGER;
ALTER TABLE monitor_articles ADD COLUMN viewCount INTEGER;
ALTER TABLE monitor_articles ADD COLUMN simHash TEXT;
ALTER TABLE monitor_articles ADD COLUMN similarCount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE monitor_articles ADD COLUMN lastSimilarAt INTEGER;
ALTER TABLE monitor_articles ADD COLUMN similarPlatforms TEXT;
ALTER TABLE alerts ADD COLUMN escalations TEXT;
