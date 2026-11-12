// 事实与口径: how often self-test answers mention each target fact, per platform.
// analyses.targetFactsCheck holds {factKey: boolean} for every active fact on every answer, so a fact is
// measured only against its own brand line's questions (sun_* → 孙宇晨线, tron_* → TRON 线).
import { d1 } from "./external";

export type FactCoverageRow = {
  factKey: string;
  total: number;
  hit: number;
  platforms: { platform: string; total: number; hit: number }[];
};

type Raw = { factKey: string; platform: string; line: string; total: number; hit: number };

export const factLine = (factKey: string) => (factKey.startsWith("sun_") ? "sun" : factKey.startsWith("tron_") ? "tron" : null);

export function summarizeFactCoverage(rows: Raw[]): FactCoverageRow[] {
  const byFact = new Map<string, Map<string, { total: number; hit: number }>>();
  for (const row of rows) {
    const line = factLine(row.factKey);
    if (line && row.line !== line) continue;
    const platforms = byFact.get(row.factKey) ?? new Map();
    const cell = platforms.get(row.platform) ?? { total: 0, hit: 0 };
    cell.total += Number(row.total) || 0;
    cell.hit += Number(row.hit) || 0;
    platforms.set(row.platform, cell);
    byFact.set(row.factKey, platforms);
  }
  return [...byFact.entries()].map(([factKey, platforms]) => {
    const list = [...platforms.entries()].map(([platform, v]) => ({ platform, ...v })).sort((a, b) => a.platform.localeCompare(b.platform));
    return {
      factKey,
      total: list.reduce((s, p) => s + p.total, 0),
      hit: list.reduce((s, p) => s + p.hit, 0),
      platforms: list,
    };
  });
}

export async function getFactCoverage(days: number): Promise<FactCoverageRow[]> {
  const client = await d1();
  const rows = await client.prepare(`SELECT j.key AS factKey, c.platform AS platform,
      CASE WHEN q.brandLine LIKE 'tron%' THEN 'tron' WHEN q.brandLine LIKE 'sun%' OR q.brandLine LIKE 'syc%' THEN 'sun' ELSE 'other' END AS line,
      COUNT(*) AS total, SUM(j.value) AS hit
    FROM collections c
    JOIN analyses a ON a.collectionId = c.id
    LEFT JOIN questions q ON q.questionId = c.questionId,
    json_each(a.targetFactsCheck) j
    WHERE c.status = 'success' AND c.timestamp >= ? AND a.targetFactsCheck IS NOT NULL
    GROUP BY 1, 2, 3`).bind(Date.now() - days * 86400_000).all<Raw>();
  return summarizeFactCoverage(rows.results);
}
