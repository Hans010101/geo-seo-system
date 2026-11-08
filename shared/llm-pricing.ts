// OpenRouter per-model pricing snapshot (refreshed 2026-08-22 from https://openrouter.ai/api/v1/models).
// Units: USD per single token (so cost = tokens × rate, no million-token conversion needed).
// Source of truth is OpenRouter's catalog; refresh by re-curling the endpoint and updating these values
// whenever a model id in PLATFORM_OPENROUTER_MODELS changes or quarterly hygiene.
export type Pricing = { input: number; output: number };

export const OPENROUTER_PRICING: Record<string, Pricing> = {
  "openai/gpt-5.6-luna":                 { input: 0.0000002,    output: 0.0000012 },
  "google/gemini-3.5-flash":             { input: 0.0000015,    output: 0.000009 },
  "baidu/ernie-4.5-vl-424b-a47b":        { input: 0.00000042,   output: 0.00000125 },
  "anthropic/claude-sonnet-5":           { input: 0.000002,     output: 0.00001 },
  "bytedance-seed/seed-2-1-turbo":       { input: 0.0000005,    output: 0.0000025 },
  "moonshotai/kimi-k2.6":                { input: 0.0000005415, output: 0.00000228 },
  "deepseek/deepseek-v4-flash-0731":     { input: 0.00000008,   output: 0.00000018 },
  "minimax/minimax-m2.5":                { input: 0.00000027,   output: 0.00000108 },
  "qwen/qwen3.7-plus":                   { input: 0.00000032,   output: 0.00000128 },
  "z-ai/glm-5.2":                        { input: 0.000000966,  output: 0.000003036 },
  "x-ai/grok-4.6":                       { input: 0.000002,     output: 0.000006 },
};

// Compute USD cost for a single LLM invocation. Returns null when model is unknown or tokens are missing.
export function calcCostUsd(
  model: string | null | undefined,
  promptTokens: number | null | undefined,
  completionTokens: number | null | undefined
): number | null {
  if (!model || promptTokens == null || completionTokens == null) return null;
  const price = OPENROUTER_PRICING[model];
  if (!price) return null;
  // Decimal(10,6) → 6 decimal places, ample for fractions of a cent
  return Math.round((promptTokens * price.input + completionTokens * price.output) * 1_000_000) / 1_000_000;
}

// Identify provider from baseUrl. Mirrors detectProvider in server/routers.ts but lives in shared land
// so the seed/price tables stay co-located with provider naming.
export function detectProviderFromBaseUrl(baseUrl: string | null | undefined): "openrouter" | "bai" | "bailian" | "other" {
  if (!baseUrl) return "other";
  if (baseUrl.includes("b.ai")) return "bai";
  if (baseUrl.includes("openrouter.ai")) return "openrouter";
  if (baseUrl.includes("dashscope.aliyuncs.com") || baseUrl.includes("bailian")) return "bailian";
  return "other";
}
