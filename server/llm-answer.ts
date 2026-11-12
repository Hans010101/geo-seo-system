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

// Platforms whose OpenRouter model reasons by default and, at default effort, tends to spend the output
// budget on hidden reasoning. 2026-11-12: seed-2-1-turbo returned empty answers even with effort "low"
// (it does not support reasoning_effort) and ignored reasoning.max_tokens; doubao now runs on
// seed-2.0-lite, which supports reasoning_effort, with low effort and room for the answer.
export const REASONING_SETTINGS: Readonly<Record<string, { maxTokens: number; effort: "minimal" | "low" | "medium" }>> = {
  doubao: { maxTokens: 6_000, effort: "low" },
};
