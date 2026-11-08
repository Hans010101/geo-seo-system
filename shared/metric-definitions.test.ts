import { describe, expect, it } from "vitest";
import { METRICS, metricTitle } from "./metric-definitions";

describe("metric definitions", () => {
  it("shows every metric with its time window", () => {
    expect(metricTitle("ownCitation", "week")).toBe("己方引用率 · 近 7 天");
    expect(metricTitle("factCoverage", "month")).toBe("事实覆盖率 · 近 4 周");
    expect(metricTitle("openAlerts", "all")).toBe("待处置预警 · 全部");
  });

  it("keeps metric names unique", () => {
    const names = Object.values(METRICS).map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
