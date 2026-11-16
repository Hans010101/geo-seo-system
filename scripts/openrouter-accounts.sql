-- OpenRouter 主号/副号 billing columns (server/openrouter-accounts.ts). Apply once:
--   npx wrangler d1 execute geo-seo-system-db --remote --file scripts/openrouter-accounts.sql
ALTER TABLE collections ADD COLUMN billingKeyId INTEGER;
ALTER TABLE collections ADD COLUMN billingFallback TEXT;
