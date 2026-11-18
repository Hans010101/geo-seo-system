import { describe, expect, it } from "vitest";
import { catchUpKind } from "./brief";

describe("brief catch-up rounds", () => {
  it("re-tries the 早报 at 11/13/15 and the 晚报 at 19/21, only on the :15 round", () => {
    expect([9, 11, 13, 15, 17, 19, 21, 3].map(h => catchUpKind(h, 15))).toEqual([null, "am", "am", "am", null, "pm", "pm", null]);
    expect(catchUpKind(11, 40)).toBeNull();
  });
});

import { parseDraft } from "./brief-calc";

describe("brief draft parsing", () => {
  it("accepts JSON with trailing commas and full-width quoted keys", () => {
    const text = '```json\n{"level":"平稳","change":"降","lead":"无事",“points”:["a",],"events":[],"others":{},"outlook":"x",}\n```';
    const d = parseDraft(text, new Set());
    expect(d).toMatchObject({ level: "平稳", change: "降", lead: "无事", points: ["a"], outlook: "x" });
  });
  it("still rejects text without JSON", () => {
    expect(() => parseDraft("抱歉，无法生成", new Set())).toThrow("模型未返回有效 JSON");
  });
});
