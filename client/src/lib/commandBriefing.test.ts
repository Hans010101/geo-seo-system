import { describe, expect, it } from "vitest";
import { briefingState, buildBriefingText } from "./commandBriefing";

const base = { sentimentLoaded: true, alertsLoaded: true, failed: false, highThreat: 0, activeAlertTotal: 0 };

describe("workbench briefing", () => {
  it("never reports an all-clear before risk data has loaded", () => {
    const text = buildBriefingText({ ...base, sentimentLoaded: false, alertsLoaded: false });
    expect(text).not.toContain("未发现");
    expect(briefingState({ ...base, alertsLoaded: false })).toBe("loading");
  });

  it("reports a load failure instead of a conclusion", () => {
    expect(buildBriefingText({ ...base, failed: true })).toContain("加载失败");
  });

  it("summarises loaded risk and open alerts", () => {
    expect(buildBriefingText({ ...base, highThreat: 1, activeAlertTotal: 1752 })).toBe(
      "过去 30 天仍有 1 条高威胁舆情，当前 1752 项预警事件待处置。",
    );
    expect(buildBriefingText({ ...base, activeAlertTotal: 3 })).toContain("仍有 3 项");
    expect(buildBriefingText(base)).toBe("当前未发现高威胁舆情，暂无待处置预警。");
  });
});
