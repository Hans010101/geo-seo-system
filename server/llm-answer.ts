// GEO answers must contain visible text. Reasoning models (e.g. Doubao Seed on OpenRouter) can spend
// the whole output budget on hidden reasoning and return an empty message with finish_reason
// "length"; storing that as a successful answer silently corrupts every GEO metric downstream.
export function emptyAnswerError(content: string, finishReason: string | null | undefined): string | null {
  if (reasoningExhausted(finishReason, content)) {
    return content.trim().length > 0
      ? `模型只返回了 ${content.trim().length} 字就被截断：输出上限几乎被推理过程耗尽（finish_reason=length）`
      : "模型未返回正文：输出上限被推理过程耗尽（finish_reason=length）";
  }
  if (content.trim().length > 0) return null;
  return `模型未返回正文（finish_reason=${finishReason || "unknown"}）`;
}

/**
 * Cut at the output limit with (almost) no visible text: the budget went to hidden reasoning. 2026-11-19
 * Kimi K2.6 returned 42 characters for 4,096 tokens and DeepSeek a one-line fragment; both used to be
 * stored as successful answers. A real answer cut at the limit is thousands of characters long.
 */
export const MIN_CUT_ANSWER_CHARS = 300;
function reasoningExhausted(finishReason: string | null | undefined, content: string): boolean {
  return finishReason === "length" && content.trim().length < MIN_CUT_ANSWER_CHARS;
}

// After a reasoning-exhausted answer, retry with low reasoning effort so the visible answer fits.
export function shouldLimitReasoning(finishReason: string | null | undefined, content: string): boolean {
  return reasoningExhausted(finishReason, content);
}

// Platforms whose OpenRouter model reasons by default and, at default effort, tends to spend the output
// budget on hidden reasoning. 2026-11-12: seed-2-1-turbo returned empty answers even with effort "low"
// (it does not support reasoning_effort) and ignored reasoning.max_tokens; doubao now runs on
// seed-2.0-lite, which supports reasoning_effort, with low effort and room for the answer.
export const REASONING_SETTINGS: Readonly<Record<string, { maxTokens: number; effort: "minimal" | "low" | "medium" }>> = {
  doubao: { maxTokens: 6_000, effort: "low" },
};
