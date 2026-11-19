import { describe, expect, it } from "vitest";
import { emptyAnswerError, shouldLimitReasoning } from "./llm-answer";

describe("GEO answer validation", () => {
  it("accepts any visible answer text", () => {
    expect(emptyAnswerError("孙宇晨是波场创始人。", "stop")).toBeNull();
    expect(emptyAnswerError("对不起，我还没有学会回答这个问题。", "stop")).toBeNull();
    expect(emptyAnswerError("长".repeat(3000), "length")).toBeNull();
  });

  it("rejects an answer cut at the limit after only a few characters", () => {
    expect(emptyAnswerError("在区块链领域，“公链”（Layer 1）是承载去中心化应用", "length")).toContain("被截断");
  });

  it("rejects empty answers instead of storing them as successes", () => {
    expect(emptyAnswerError("", "length")).toContain("推理过程耗尽");
    expect(emptyAnswerError("  \n", "stop")).toContain("finish_reason=stop");
    expect(emptyAnswerError("", null)).toContain("finish_reason=unknown");
  });

  it("limits reasoning only when reasoning exhausted the output budget", () => {
    expect(shouldLimitReasoning("length", "")).toBe(true);
    expect(shouldLimitReasoning("stop", "")).toBe(false);
    expect(shouldLimitReasoning("length", "some text")).toBe(true);
    expect(shouldLimitReasoning("length", "长".repeat(3000))).toBe(false);
    expect(shouldLimitReasoning("stop", "some text")).toBe(false);
  });
});
