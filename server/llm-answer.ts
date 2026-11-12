// GEO answers must contain visible text. Reasoning models (e.g. Doubao Seed on OpenRouter) can spend
// the whole output budget on hidden reasoning and return an empty message with finish_reason
// "length"; storing that as a successful answer silently corrupts every GEO metric downstream.
export function emptyAnswerError(content: string, finishReason: string | null | undefined): string | null {
  if (content.trim().length > 0) return null;
  if (finishReason === "length") {
    return "模型未返回正文：输出上限被推理过程耗尽（finish_reason=length）";
  }
  return `模型未返回正文（finish_reason=${finishReason || "unknown"}）`;
}

// After a reasoning-exhausted empty answer, retry with low reasoning effort so the visible answer fits.
export function shouldLimitReasoning(finishReason: string | null | undefined, content: string): boolean {
  return finishReason === "length" && content.trim().length === 0;
}

// Platforms whose OpenRouter model reasons by default and, within the normal 4096-token output budget,
// usually returns no visible answer (Seed: 26 of 31 empty on 2026-11-05; on 2026-11-12 every call was
// empty, also with reasoning effort "low" — seed-2-1-turbo does not support reasoning_effort). Cap the
// reasoning budget and give the output room for reasoning plus the answer.
export const REASONING_BUDGETS: Readonly<Record<string, { maxTokens: number; reasoningTokens: number }>> = {
  doubao: { maxTokens: 12_000, reasoningTokens: 2_048 },
};
