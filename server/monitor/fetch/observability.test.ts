import { describe, expect, it } from "vitest";
import { attemptFromResult, classifyFetchFailure } from "./observability";

describe("fetch observability", () => {
  it("classifies anti-bot and timeout failures", () => {
    expect(classifyFetchFailure({
      success: false,
      engine: "self",
      costUsd: 0,
      httpStatus: 403,
    })).toBe("http_403");
    expect(classifyFetchFailure({
      success: false,
      engine: "self",
      costUsd: 0,
      error: "request timeout after 25000ms",
    })).toBe("timeout");
  });

  it("records duration, size, status and cost from an engine result", () => {
    expect(attemptFromResult({
      success: false,
      engine: "firecrawl",
      costUsd: 0.00083,
      status: "failed",
      error: "content too short",
      contentChars: 42,
    }, 321)).toEqual({
      engine: "firecrawl",
      outcome: "failed",
      reason: "short_content",
      durationMs: 321,
      contentChars: 42,
      costUsd: 0.00083,
    });
  });
});
