import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(), getKey: vi.fn(), hasBudget: vi.fn(), queuedUsage: vi.fn(), usage: vi.fn(),
}));
vi.mock("../../db", () => ({
  getGlobalApiKeyByName: mocks.getKey,
  getSysConfig: vi.fn(async () => null),
}));
vi.mock("../budget", () => ({
  hasXBudget: mocks.hasBudget, addQueuedXUsage: mocks.queuedUsage, addXUsage: mocks.usage,
  X_USD_PER_TWEET: 0.00015,
}));
vi.mock("../util", async (importOriginal) => ({
  ...await importOriginal<typeof import("../util")>(),
  fetchWithTimeout: mocks.fetch,
  log: { warn: vi.fn(), info: vi.fn() },
}));
import { __resetXCache, getXErrors, xSource } from "./x-source";

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const tweet = { id: "1", text: "孙宇晨谈波场 TRON 最新发展", author: { userName: "justinsuntron" }, likeCount: 5 };

describe("X collection error reporting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T08:00:00Z"));
    vi.clearAllMocks();
    __resetXCache();
    mocks.getKey.mockResolvedValue({ apiKey: "test-secret" });
    mocks.hasBudget.mockReturnValue(true);
    mocks.fetch.mockImplementation(async () => response({ tweets: [] }));
  });
  afterEach(() => vi.useRealTimers());

  it("shares one successful pull and bills complete pages, not repeated keyword matches", async () => {
    mocks.fetch.mockImplementation(async () => response({ tweets: [tweet] }));
    await expect(xSource.search("孙宇晨", { budgetReserved: true })).resolves.toHaveLength(1);
    await expect(xSource.search("Justin Sun", { budgetReserved: true })).resolves.toHaveLength(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(4);
    expect(mocks.queuedUsage).toHaveBeenCalledTimes(1);
    expect(mocks.queuedUsage).toHaveBeenCalledWith(4);
    expect(getXErrors()).toEqual([]);
  });

  it.each([200, 402])("reports insufficient balance at HTTP %s instead of successful empty results", async (status) => {
    mocks.fetch.mockImplementation(async () => response({ status: "error", message: "Insufficient credits test-secret", tweets: [] }, status));
    await expect(xSource.search("孙宇晨")).rejects.toThrow("余额不足");
    await expect(xSource.search("TRON")).rejects.toThrow("余额不足");
    expect(mocks.fetch).toHaveBeenCalledTimes(4);
    expect(getXErrors()).toHaveLength(4);
    expect(getXErrors().join()).not.toContain("test-secret");
    expect(mocks.usage).toHaveBeenCalledTimes(1);
    expect(mocks.usage).toHaveBeenCalledWith(0);
  });

  it("retries after the short failure cache expires", async () => {
    mocks.fetch.mockImplementation(async () => response({}, 503));
    await expect(xSource.search("孙宇晨")).rejects.toThrow("接口返回错误");
    vi.advanceTimersByTime(8 * 60 * 1000 + 1);
    mocks.fetch.mockImplementation(async () => response({ tweets: [tweet] }));
    await expect(xSource.search("孙宇晨")).resolves.toHaveLength(1);
    expect(getXErrors()).toEqual([]);
  });

  it("rejects malformed API responses but accepts genuine empty tweet arrays", async () => {
    mocks.fetch.mockImplementation(async () => response({ status: "success" }));
    await expect(xSource.search("孙宇晨")).rejects.toThrow("缺少 tweets 数组");
    __resetXCache();
    mocks.fetch.mockImplementation(async () => response({ tweets: [] }));
    await expect(xSource.search("孙宇晨")).resolves.toEqual([]);
    expect(getXErrors()).toEqual([]);
  });

  it("retains successful search results and exposes partial failures for the queue alarm", async () => {
    mocks.fetch.mockImplementation(async (url: string) => url.includes("last_tweets")
      ? response({}, 429) : response({ tweets: [tweet] }));
    await expect(xSource.search("孙宇晨")).resolves.toHaveLength(1);
    expect(getXErrors()).toEqual([expect.stringContaining("接口限流")]);
    expect(mocks.usage).toHaveBeenCalledTimes(1);
    expect(mocks.usage).toHaveBeenCalledWith(3);
  });

  it("makes missing credentials and the local budget visible without paid requests", async () => {
    mocks.getKey.mockResolvedValue(null);
    await expect(xSource.search("孙宇晨")).rejects.toThrow("未配置 API Key");
    mocks.getKey.mockResolvedValue({ apiKey: "test-secret" });
    mocks.hasBudget.mockReturnValue(false);
    await expect(xSource.search("孙宇晨")).rejects.toThrow("额度已用完");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
