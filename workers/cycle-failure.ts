// A batch ends partial_failure whenever any single shard fails (one RSS feed returning 403 is
// enough), which pushed ~13 "batch failed" notices a day. Per-source problems are covered by the
// source outage alert (source-health.ts); this decides when a whole batch is worth a push.

export type CycleCounts = {
  discoveryExpected: number;
  discoveryFailed: number;
  discovered: number;
  analyzed: number;
  analysisFailed: number;
  failed: number;
};

/** A human-readable reason when the batch failed badly enough to notify, else null. */
export function cycleFailureReason(c: CycleCounts): string | null {
  const reasons: string[] = [];
  if (c.discoveryExpected > 0 && c.discovered === 0) {
    reasons.push("本批次所有信源都没有采到内容");
  } else if (c.discoveryFailed >= Math.max(2, Math.ceil(c.discoveryExpected / 2))) {
    reasons.push(`${c.discoveryFailed}/${c.discoveryExpected} 个采集任务失败`);
  }
  if (c.analysisFailed >= 3 && c.analysisFailed * 2 >= c.analyzed + c.analysisFailed) {
    reasons.push(`AI 分析大面积失败（${c.analysisFailed}/${c.analyzed + c.analysisFailed}）`);
  }
  if (c.failed >= 3) reasons.push(`${c.failed} 条内容处理失败`);
  return reasons.length > 0 ? reasons.join("；") : null;
}
