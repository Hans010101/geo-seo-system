import { describe, expect, it } from "vitest";
import { mergeSourceDiagnostic } from "./source-diagnostic";

describe("source diagnostics", () => {
  it("keeps every shard instead of overwriting the last result", () => {
    const merged = mergeSourceDiagnostic({
      status: "success", provider: "rss", discovered: 3, enqueued: 2,
      queriesAttempted: 1, queriesSucceeded: 1, updatedAt: 10,
    }, {
      status: "failed", provider: "rss", discovered: 0, enqueued: 0,
      queriesAttempted: 1, queriesSucceeded: 0, errors: ["feed timeout"], updatedAt: 20,
    });
    expect(merged).toMatchObject({
      status: "partial", discovered: 3, enqueued: 2,
      queriesAttempted: 2, queriesSucceeded: 1, errors: ["feed timeout"], updatedAt: 20,
    });
  });
});
