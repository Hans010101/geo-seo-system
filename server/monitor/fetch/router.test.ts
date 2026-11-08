import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const engines = vi.hoisted(() => ({ self: vi.fn(), paid: vi.fn() }));
vi.mock("./self-engine", () => ({ selfEngine: { name: "self", level: 1, costPerPage: 0, fetch: engines.self } }));
vi.mock("./firecrawl-engine", () => ({ firecrawlEngine: { name: "firecrawl", level: 4, costPerPage: 0.00083, fetch: engines.paid } }));
vi.mock("./observability", async (original) => ({ ...await original<object>(), recordFetchAttempt: vi.fn() }));
import { fetchArticle } from "./router";

describe("full text routing", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());
  it("does not pay when L1 succeeds", async () => {
    engines.self.mockResolvedValue({ success: true, engine: "self", status: "full", contentMd: "body", costUsd: 0 });
    expect((await fetchArticle("https://example.org/article", "summary")).engine).toBe("self");
    expect(engines.paid).not.toHaveBeenCalled();
  });
  it("falls back to Firecrawl, retaining its cost and attempts", async () => {
    engines.self.mockResolvedValue({ success: false, engine: "self", costUsd: 0, httpStatus: 403 });
    engines.paid.mockResolvedValue({ success: true, engine: "firecrawl", status: "full", contentMd: "full body", costUsd: 0.00083 });
    expect(await fetchArticle("https://example.org/article", "summary")).toMatchObject({ engine: "firecrawl", costUsd: 0.00083, contentMd: "full body", attempts: [{ engine: "self" }, { engine: "firecrawl" }] });
  });
  it("preserves the summary and paid attempt cost after failure", async () => {
    engines.self.mockResolvedValue({ success: false, engine: "self", costUsd: 0 });
    engines.paid.mockResolvedValue({ success: false, engine: "firecrawl", costUsd: 0.00083 });
    expect(await fetchArticle("https://example.org/article", "summary")).toMatchObject({ engine: "snippet", status: "partial", costUsd: 0.00083, contentMd: "summary" });
  });
  it("rejects private destinations before any engine runs", async () => {
    await expect(fetchArticle("http://127.0.0.1/", "")).rejects.toThrow("private");
    expect(engines.self).not.toHaveBeenCalled();
    expect(engines.paid).not.toHaveBeenCalled();
  });
  it.each([
    "https://www.bilibili.com/video/BV1test",
    "https://www.douyin.com/video/123",
    "https://www.kuaishou.com/short-video/test",
  ])("does not pay for video recommendations instead of a transcript: %s", async url => {
    expect(await fetchArticle(url, "孙宇晨视频摘要")).toMatchObject({ engine: "snippet", status: "partial", contentMd: "孙宇晨视频摘要", costUsd: 0 });
    expect(engines.self).not.toHaveBeenCalled();
    expect(engines.paid).not.toHaveBeenCalled();
  });
});
