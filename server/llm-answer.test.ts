import { describe, expect, it } from "vitest";
import { emptyAnswerError, shouldLimitReasoning } from "./llm-answer";

describe("GEO answer validation", () => {
  it("accepts any visible answer text", () => {
    expect(emptyAnswerError("孙宇晨是波场创始人。", "stop")).toBeNull();
    expect(emptyAnswerError("partial answer", "length")).toBeNull();
  });

  it("rejects empty answers instead of storing them as successes", () => {
    expect(emptyAnswerError("", "length")).toContain("推理过程耗尽");
    expect(emptyAnswerError("  \n", "stop")).toContain("finish_reason=stop");
    expect(emptyAnswerError("", null)).toContain("finish_reason=unknown");
  });

  it("limits reasoning only when reasoning exhausted the output budget", () => {
    expect(shouldLimitReasoning("length", "")).toBe(true);
    expect(shouldLimitReasoning("stop", "")).toBe(false);
    expect(shouldLimitReasoning("length", "some text")).toBe(false);
  });
});
