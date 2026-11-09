-- 币价联动: hourly USD prices of TRON-ecosystem tokens and BTC/ETH/BNB/SOL (CoinGecko), kept 400 days.
-- Apply: wrangler d1 execute geo-seo-system-db --remote --file scripts/market-prices.sql
CREATE TABLE IF NOT EXISTS marketPrices (
  symbol TEXT NOT NULL,
  ts INTEGER NOT NULL,
  price REAL NOT NULL,
  marketCap REAL,
  volume REAL,
  PRIMARY KEY (symbol, ts)
);
CREATE INDEX IF NOT EXISTS marketPrices_ts ON marketPrices(ts);
