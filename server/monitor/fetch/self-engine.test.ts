import { afterEach, describe, expect, it, vi } from "vitest";
import { selfEngine } from "./self-engine";

afterEach(() => vi.unstubAllGlobals());
describe("L1 in a Worker without DOM globals", () => {
  it("extracts markdown without global document or DOMParser", async () => {
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("DOMParser", undefined);
    const body = "孙宇晨介绍波场 TRON 的支付网络，稳定币交易正在增加。".repeat(30);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(`<html><head><title>波场新闻</title></head><body><article><h1>波场新闻</h1><p>${body}</p></article></body></html>`)));
    const result = await selfEngine.fetch("https://example.org/story");
    expect(result).toMatchObject({ success: true, engine: "self", status: "full", costUsd: 0 });
    expect(result.contentMd).toContain(body);
  });
  it("blocks private redirects", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } }));
    vi.stubGlobal("fetch", fetch);
    expect(await selfEngine.fetch("https://example.org/story")).toMatchObject({ success: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("bounds response size", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("a".repeat(2_000_001))));
    expect(await selfEngine.fetch("https://example.org/story")).toMatchObject({ success: false, error: "HTML exceeds 2 MB limit" });
  });
});
