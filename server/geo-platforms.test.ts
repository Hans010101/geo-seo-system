import { describe, expect, it } from "vitest";
import { PLATFORMS } from "@shared/geo-types";

describe("GEO platforms", () => {
  it("excludes retired monitoring platforms", () => {
    expect(PLATFORMS).not.toEqual(expect.arrayContaining(["hunyuan", "perplexity", "llama"]));
    expect(PLATFORMS).toHaveLength(12);
  });
});
