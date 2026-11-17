import { describe, expect, it } from "vitest";
import { catchUpKind } from "./brief";

describe("brief catch-up rounds", () => {
  it("re-tries the 早报 at 11/13/15 and the 晚报 at 19/21, only on the :15 round", () => {
    expect([9, 11, 13, 15, 17, 19, 21, 3].map(h => catchUpKind(h, 15))).toEqual([null, "am", "am", "am", null, "pm", "pm", null]);
    expect(catchUpKind(11, 40)).toBeNull();
  });
});
