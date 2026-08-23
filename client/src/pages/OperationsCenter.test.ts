import { describe, expect, it } from "vitest";
import { readSummary } from "./OperationsCenter";

describe("readSummary", () => {
  it("accepts valid Worker summaries and safely rejects malformed payloads", () => {
    expect(readSummary('{"completed":4}')).toEqual({ completed: 4 });
    expect(readSummary("not-json")).toEqual({});
  });
});
