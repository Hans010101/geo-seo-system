import { describe, expect, it } from "vitest";
import { browserCooldownRemainingMs } from "./browser-shadow-cooldown";

describe("Browser Shadow cooldown", () => {
  it("returns only the remaining non-negative duration", () => {
    expect(browserCooldownRemainingMs(175_000, 100_000)).toBe(75_000);
    expect(browserCooldownRemainingMs(99_999, 100_000)).toBe(0);
    expect(browserCooldownRemainingMs(Number.NaN, 100_000)).toBe(0);
  });
});
