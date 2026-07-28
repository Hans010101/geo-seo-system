import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getGlobalApiKeyByName: vi.fn(),
  getMonitorSourceRuleByDomain: vi.fn(),
}));

vi.mock("../db", () => dbMocks);

import { analyzeArticle, parseMonitorAnalysisPayload } from "./analyzer";

const validPayload = {
  relevance: "high",
  relevance_reason: "文章主体是孙宇晨与 TRON 的合作公告",
  sentiment_score: 4,
  summary: "该合作对 TRON 品牌偏正面。",
  key_entities: ["孙宇晨", "TRON"],
};

describe("monitor analyzer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.getMonitorSourceRuleByDomain.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete (globalThis as any).__CF_ENV__;
    vi.unstubAllGlobals();
  });

  it("validates structured analysis payloads", () => {
    expect(parseMonitorAnalysisPayload(validPayload)).toMatchObject({
      relevance: "high",
      sentimentScore: 4,
      keyEntities: ["孙宇晨", "TRON"],
    });
    expect(() =>
      parseMonitorAnalysisPayload({ ...validPayload, sentiment_score: 8 })
    ).toThrow("sentiment_score");
    expect(() =>
      parseMonitorAnalysisPayload({ ...validPayload, key_entities: "TRON" })
    ).toThrow("key_entities");
  });

  it("uses the Workers AI binding without reading the OpenRouter key", async () => {
    const run = vi.fn().mockResolvedValue({
      response: validPayload,
      usage: { prompt_tokens: 1_000, completion_tokens: 100, neurons: 1.23 },
    });
    (globalThis as any).__CF_ENV__ = {
      AI: { run },
      CLOUDFLARE_AI_MODEL: "@cf/meta/llama-3.1-8b-instruct-fast",
      CLOUDFLARE_AI_MAX_TOKENS: "512",
    };

    const result = await analyzeArticle({
      url: "https://example.com/tron",
      title: "TRON announces a new partnership",
      contentMd: "孙宇晨宣布 TRON 达成新的合作。",
      snippet: "",
      fetchStatus: "full",
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      "@cf/meta/llama-3.1-8b-instruct-fast",
      expect.objectContaining({
        max_tokens: 512,
        response_format: expect.objectContaining({ type: "json_schema" }),
      })
    );
    expect(dbMocks.getGlobalApiKeyByName).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      provider: "cloudflare_workers_ai",
      model: "@cf/meta/llama-3.1-8b-instruct-fast",
      relevance: "high",
      sentimentScore: 4,
      promptTokens: 1_000,
      completionTokens: 100,
    });
    expect(result.neurons).toBe(1.23);
  });

  it("retries one schema failure and then succeeds", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ response: { relevance: "invalid" } })
      .mockResolvedValueOnce({ response: validPayload });
    (globalThis as any).__CF_ENV__ = { AI: { run } };

    const result = await analyzeArticle({
      url: "https://example.com/tron-retry",
      title: "TRON update",
      contentMd: "TRON update content",
      snippet: "",
      fetchStatus: "full",
    });

    expect(run).toHaveBeenCalledTimes(2);
    expect(result.provider).toBe("cloudflare_workers_ai");
  });

  it("falls back to OpenRouter when Workers AI quota is exhausted", async () => {
    const run = vi.fn().mockRejectedValue(new Error("daily quota exceeded: 10000 neurons"));
    dbMocks.getGlobalApiKeyByName.mockResolvedValue({
      apiKey: "or-test-key",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: "deepseek/deepseek-chat",
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(validPayload) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 800, completion_tokens: 90, total_tokens: 890 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    (globalThis as any).__CF_ENV__ = {
      AI: { run },
      CLOUDFLARE_OPENROUTER_FALLBACK_ENABLED: "true",
      CLOUDFLARE_OPENROUTER_FALLBACK_MODEL: "deepseek/deepseek-chat",
      CLOUDFLARE_AI_MAX_TOKENS: "512",
    };

    const result = await analyzeArticle({
      url: "https://example.com/tron-fallback",
      title: "TRON update",
      contentMd: "TRON update content",
      snippet: "",
      fetchStatus: "full",
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(requestBody.max_tokens).toBe(512);
    expect(result).toMatchObject({
      provider: "openrouter",
      model: "deepseek/deepseek-chat",
      fallbackReason: expect.stringContaining("quota exceeded"),
      promptTokens: 800,
      completionTokens: 90,
    });
  });
});
