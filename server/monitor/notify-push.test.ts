import { describe, expect, it } from "vitest";
import { meetsPushFloor } from "./notify";

describe("meetsPushFloor", () => {
  it("pushes everything without a floor and only high+ with a high floor", () => {
    expect(meetsPushFloor("medium")).toBe(true);
    expect(meetsPushFloor("medium", "high")).toBe(false);
    expect(meetsPushFloor("high", "high")).toBe(true);
    expect(meetsPushFloor("critical", "high")).toBe(true);
    expect(meetsPushFloor("high", "critical")).toBe(false);
  });
});
