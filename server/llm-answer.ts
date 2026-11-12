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

// Platforms whose OpenRouter model reasons by default and, at full effort, usually returns no visible
// answer within the output budget (Seed: 26 of 31 answers empty on 2026-11-05). Ask for low effort
// from the first attempt instead of paying for an empty answer and retrying.
export const LOW_REASONING_PLATFORMS: ReadonlySet<string> = new Set(["doubao"]);
