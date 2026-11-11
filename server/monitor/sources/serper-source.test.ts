import { beforeEach, describe, expect, it, vi } from "vitest";

const searchNews = vi.fn(async () => { throw new Error('Serper search 400: {"message":"Not enough credits"}'); });
const serperDisabled = vi.fn(async () => false);
vi.mock("../search", () => ({ searchNews: (...args: unknown[]) => searchNews(...(args as [])) }));
vi.mock("../budget", () => ({ serperDisabled: () => serperDisabled() }));
vi.mock("./publisher-search", () => ({
  searchPublishers: vi.fn(async () => [
    { url: "https://a.test/1", title: "t", sourceName: "publisher_search", sourcePlatform: "web", publishedAt: 1 },
  ]),
}));

describe("serper news source", () => {
  beforeEach(() => { searchNews.mockClear(); });

  it("reports the publisher fallback when Serper fails", async () => {
    serperDisabled.mockResolvedValue(false);
    const { serperSource } = await import("./serper-source");
    const reasons: string[] = [];
    const posts = await serperSource.search("孙宇晨", { onFallback: r => reasons.push(r) });
    expect(posts).toHaveLength(1);
    expect(reasons).toEqual(['Serper search 400: {"message":"Not enough credits"}']);
  });

  it("goes straight to publisher search, without a fallback note, when Serper is switched off", async () => {
    serperDisabled.mockResolvedValue(true);
    const { serperSource } = await import("./serper-source");
    const reasons: string[] = [];
    const posts = await serperSource.search("孙宇晨", { onFallback: r => reasons.push(r) });
    expect(posts).toHaveLength(1);
    expect(searchNews).not.toHaveBeenCalled();
    expect(reasons).toEqual([]);
  });
});
