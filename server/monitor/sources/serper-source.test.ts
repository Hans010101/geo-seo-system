import { describe, expect, it, vi } from "vitest";

vi.mock("../search", () => ({
  searchNews: vi.fn(async () => { throw new Error('Serper search 400: {"message":"Not enough credits"}'); }),
}));
vi.mock("./publisher-search", () => ({
  searchPublishers: vi.fn(async () => [
    { url: "https://a.test/1", title: "t", sourceName: "publisher_search", sourcePlatform: "web", publishedAt: 1 },
  ]),
}));

describe("serper news source", () => {
  it("reports the publisher fallback when Serper fails", async () => {
    const { serperSource } = await import("./serper-source");
    const reasons: string[] = [];
    const posts = await serperSource.search("孙宇晨", { onFallback: r => reasons.push(r) });
    expect(posts).toHaveLength(1);
    expect(reasons).toEqual(['Serper search 400: {"message":"Not enough credits"}']);
  });
});
