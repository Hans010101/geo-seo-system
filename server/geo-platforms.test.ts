import { describe, expect, it } from "vitest";
import { PLATFORMS, PLATFORM_LABELS, PLATFORM_OPENROUTER_MODELS, PLATFORM_BAILIAN_MODELS } from "@shared/geo-types";

describe("GEO platforms", () => {
  it("excludes retired monitoring platforms", () => {
    for (const platform of ["hunyuan", "perplexity", "llama", "wenxin"]) {
      expect(PLATFORMS).not.toContain(platform);
    }
    expect(PLATFORMS).toHaveLength(11);
    expect(PLATFORM_OPENROUTER_MODELS).not.toHaveProperty("wenxin");
    expect(PLATFORM_BAILIAN_MODELS).not.toHaveProperty("wenxin");
    expect(PLATFORM_LABELS.wenxin).toBe("文心一言");
  });
});
