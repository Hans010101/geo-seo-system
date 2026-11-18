import { describe, expect, it } from "vitest";
import { extractJsonArray, parseTriage } from "./industry-calc";

const item = (i: number) => ({ i, keep: true, category: "security", importance: 3, entities: ["binance"], tron: 0, tronNote: "", summary: `第${i}条，含 "引号" 与 ] 括号`, event: `e-${i}` });

describe("triage answer parsing", () => {
  it("parses a complete array", () => {
    expect(extractJsonArray(`说明\n${JSON.stringify([item(0), item(1)])}`)).toHaveLength(2);
  });

  it("keeps every complete item of an answer cut off at max_tokens", () => {
    const full = JSON.stringify([item(0), item(1), item(2)]);
    const cut = full.slice(0, full.indexOf('"i":2') + 30); // mid third object, after an inner "]"
    const got = parseTriage(cut, new Set([0, 1, 2]));
    expect(got.map(t => t.i)).toEqual([0, 1]);
    expect(got[0].summary).toContain("引号");
  });

  it("still fails when nothing usable came back", () => {
    expect(() => extractJsonArray("抱歉，我无法完成")).toThrow("no JSON array");
    expect(() => extractJsonArray('[{"i":0, "keep": tr')).toThrow("no JSON array");
  });
});
