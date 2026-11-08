CREATE TABLE IF NOT EXISTS agentReachReceipts (
  urlHash TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  platform TEXT NOT NULL,
  status TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  result TEXT
);
CREATE INDEX IF NOT EXISTS agentReachReceipts_day ON agentReachReceipts(day);
