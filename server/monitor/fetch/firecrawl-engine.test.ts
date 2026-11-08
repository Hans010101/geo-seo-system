import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ key: vi.fn(), reserve: vi.fn(), request: vi.fn() }));
vi.mock("../../db", () => ({ getGlobalApiKeyByName: mocks.key }));
vi.mock("../budget", () => ({ tryConsumeFirecrawl: mocks.reserve, FIRECRAWL_USD_PER_CREDIT: 0.00083 }));
vi.mock("../util", () => ({ fetchWithTimeout: mocks.request }));
import { firecrawlEngine } from "./firecrawl-engine";
beforeEach(() => vi.resetAllMocks());
describe("paid scraping guard", () => {
  it("does not reserve without an active key", async () => {
    expect(await firecrawlEngine.fetch("https://example.org")).toMatchObject({ failureReason: "missing_key", costUsd: 0 });
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it("awaits the shared budget and makes no request when exhausted", async () => {
    mocks.key.mockResolvedValue({ apiKey: "test", isActive: true });
    mocks.reserve.mockResolvedValue(false);
    expect(await firecrawlEngine.fetch("https://example.org")).toMatchObject({ failureReason: "budget_exhausted", costUsd: 0 });
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("uses the existing key and records a successful full body", async () => {
    mocks.key.mockResolvedValue({ apiKey: "test", isActive: true });
    mocks.reserve.mockResolvedValue(true);
    mocks.request.mockResolvedValue(Response.json({ success: true, data: { markdown: "正文".repeat(150), metadata: { title: "标题" } } }));
    expect(await firecrawlEngine.fetch("https://example.org")).toMatchObject({ success: true, status: "full", engine: "firecrawl", costUsd: 0.00083 });
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
  });
});
