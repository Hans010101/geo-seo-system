import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { searchPublishers } from "./publisher-search";
import { serperSource } from "./serper-source";
import { searchNews } from "../search";

vi.mock("../search", () => ({ searchNews: vi.fn() }));
const now = Date.parse("2026-10-20T04:00:00Z");
const article = (origin: string, patch = {}) => ({
  link: `${origin}/tron-stablecoin/`, date_gmt: "2026-10-19T10:00:00",
  title: {rendered:"TRON stablecoin network grows"},
  excerpt: {rendered:"<p>TRON handles stablecoin transfers on its blockchain.</p>"}, ...patch,
});
beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(now); vi.mocked(searchNews).mockReset(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("uses bounded, dated public queries and preserves publisher provenance", async () => {
  const fetcher = vi.fn(async (input: string) => {
    const url = new URL(input);
    expect(url.searchParams.get("search")).toBe("TRON");
    expect(url.searchParams.get("per_page")).toBe("10");
    expect(url.searchParams.get("after")).toBe("2026-10-13T04:00:00.000");
    return Response.json([article(url.origin)]);
  });
  vi.stubGlobal("fetch", fetcher);
  const posts = await searchPublishers("TRON");
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(posts).toHaveLength(2);
  expect(posts[0]).toMatchObject({sourceName:"publisher_search", sourcePlatform:"web", publishedAt:Date.parse("2026-10-19T10:00:00Z")});
  expect(posts[0].contentSnippet).not.toContain("<p>");
});

it("rejects stale, missing-date, unrelated and off-site articles", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const origin = new URL(input).origin;
    return Response.json([
      article(origin, {date_gmt:"2026-09-01T00:00:00"}), article(origin, {date_gmt:null}),
      article(origin, {date_gmt:"2026-12-01T00:00:00"}), article(origin, {link:"https://example.com/tron"}),
      article(origin, {title:{rendered:"Tron movie"},excerpt:{rendered:"New film soundtrack"}}),
    ]);
  }));
  expect(await searchPublishers("TRON")).toEqual([]);
});

it("retains one healthy publisher and fails visibly when both fail", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: string) => input.includes("newsbtc")
    ? new Response("down", {status:503}) : Response.json([article("https://crypto.news")])));
  expect(await searchPublishers("TRON")).toHaveLength(1);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("down", {status:503})));
  await expect(searchPublishers("TRON")).rejects.toThrow("Public news search unavailable");
});

it("falls back on Serper failure without changing successful paid discovery", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: string) => Response.json([article(new URL(input).origin)])));
  vi.mocked(searchNews).mockRejectedValueOnce(new Error("Not enough credits"));
  expect(await serperSource.search("TRON")).toHaveLength(2);
  vi.mocked(searchNews).mockResolvedValueOnce([{url:"https://example.com/a",title:"TRON",snippet:"",date:null,source:null}]);
  expect((await serperSource.search("TRON"))[0].sourceName).toBe("serper");
  expect(fetch).toHaveBeenCalledTimes(2);
});
