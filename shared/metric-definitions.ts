// One name, one definition and an explicit time window for every headline metric, shared by the
// workbench and the GEO overview so the same number is never shown under two names (and two
// different numbers are never shown under one name without saying their windows differ).
export const METRICS = {
  geoSentiment: { name: "GEO 情感均值", help: "AI 回答情感评分（1–5 分）的平均值" },
  friendlySource: { name: "友好来源率", help: "AI 回答引用来源中，被标记为友好来源的占比" },
  factCoverage: { name: "事实覆盖率", help: "AI 回答中提及目标事实的比例（目标事实在「目标事实」页维护）" },
  ownCitation: { name: "己方引用率", help: "AI 回答引用来源中，来自己方 URL 库的占比" },
  highThreat: { name: "高威胁舆情", help: "近 30 天被判定为高威胁的舆情条数" },
  openAlerts: { name: "待处置预警", help: "当前仍为活跃状态（未处置、未忽略）的预警总数，不限时间" },
  newAlerts: { name: "期间新增预警", help: "所选时间范围内新产生的预警数，包含已处置和已忽略的" },
} as const;

export type MetricKey = keyof typeof METRICS;

export const ROLLING_WINDOW_LABELS = {
  week: "近 7 天",
  month: "近 4 周",
  quarter: "近 12 周",
  days30: "近 30 天",
  all: "全部",
} as const;

export function metricTitle(key: MetricKey, window: keyof typeof ROLLING_WINDOW_LABELS): string {
  return `${METRICS[key].name} · ${ROLLING_WINDOW_LABELS[window]}`;
}
