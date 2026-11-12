-- GEO batch execution claims (server/collection-claims.ts).
-- Run once on the existing collections table:
ALTER TABLE collections ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collections ADD COLUMN claimedAt INTEGER;
