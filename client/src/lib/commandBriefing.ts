// Workbench headline. It must never state "no risk" before the risk data has actually loaded:
// an empty first render used to read "当前未发现高威胁舆情，暂无待处置预警" while 1,700+ alerts were open.
export type BriefingInput = {
  sentimentLoaded: boolean;
  alertsLoaded: boolean;
  failed: boolean;
  highThreat: number;
  activeAlertTotal: number;
};

export type BriefingState = "loading" | "error" | "ready";

export function briefingState(input: Pick<BriefingInput, "sentimentLoaded" | "alertsLoaded" | "failed">): BriefingState {
  if (input.failed) return "error";
  return input.sentimentLoaded && input.alertsLoaded ? "ready" : "loading";
}

export function buildBriefingText(input: BriefingInput): string {
  const state = briefingState(input);
  if (state === "error") return "风险数据加载失败，暂无法判断今日风险，请刷新或进入运行中心检查。";
  if (state === "loading") return "正在汇总今日舆情与预警…";
  if (input.highThreat > 0) {
    return `过去 30 天仍有 ${input.highThreat} 条高威胁舆情，当前 ${input.activeAlertTotal} 项预警事件待处置。`;
  }
  return input.activeAlertTotal > 0
    ? `当前未发现高威胁舆情，仍有 ${input.activeAlertTotal} 项预警事件待处置。`
    : "当前未发现高威胁舆情，暂无待处置预警。";
}
