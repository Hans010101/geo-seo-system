import { describe, expect, it } from "vitest";
import { cycleFailureReason } from "./cycle-failure";

const base = { discoveryExpected: 15, discoveryFailed: 0, discovered: 138, analyzed: 13, analysisFailed: 0, failed: 0 };

describe("cycleFailureReason", () => {
  it("stays quiet for one failed shard (e.g. a single RSS feed 403)", () => {
    expect(cycleFailureReason({ ...base, discoveryFailed: 1 })).toBeNull();
    expect(cycleFailureReason({ ...base, discoveryExpected: 2, discoveryFailed: 1 })).toBeNull();
    expect(cycleFailureReason({ ...base, analysisFailed: 2 })).toBeNull();
    expect(cycleFailureReason({ ...base, analysisFailed: 3, analyzed: 20 })).toBeNull();
  });
  it("notifies when the batch is broadly broken", () => {
    expect(cycleFailureReason({ ...base, discovered: 0 })).toBe("本批次所有信源都没有采到内容");
    expect(cycleFailureReason({ ...base, discoveryFailed: 8 })).toBe("8/15 个采集任务失败");
    expect(cycleFailureReason({ ...base, analyzed: 2, analysisFailed: 5 })).toBe("AI 分析大面积失败（5/7）");
    expect(cycleFailureReason({ ...base, failed: 3, discoveryFailed: 9 })).toBe("9/15 个采集任务失败；3 条内容处理失败");
  });
});
