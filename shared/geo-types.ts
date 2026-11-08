// Platform types - 11 monitored AI platforms
export const PLATFORMS = [
  "chatgpt",
  "gemini",
  "claude",
  "copilot",
  "doubao",
  "kimi",
  "deepseek",
  "minimax",
  "tongyi",
  "zhipu",
  "grok",
] as const;
export type Platform = (typeof PLATFORMS)[number];

// Retain Wenxin's display metadata for historical collection records.
export const PLATFORM_LABELS: Record<Platform | "wenxin", string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  wenxin: "文心一言",
  claude: "Claude",
  copilot: "Copilot",
  doubao: "豆包",
  kimi: "Kimi",
  deepseek: "DeepSeek",
  minimax: "MiniMax",
  tongyi: "通义千问",
  zhipu: "智谱清言",
  grok: "Grok",
};

export const PLATFORM_COLORS: Record<Platform | "wenxin", string> = {
  chatgpt: "#10a37f",
  gemini: "#8e44ad",
  wenxin: "#2080f0",
  claude: "#d97706",
  copilot: "#0078d4",
  doubao: "#ff6a00",
  kimi: "#6366f1",
  deepseek: "#0ea5e9",
  minimax: "#ec4899",
  tongyi: "#7c3aed",
  zhipu: "#059669",
  grok: "#000000",
};

// OpenRouter model mapping for each platform
export const PLATFORM_OPENROUTER_MODELS: Record<Platform, string> = {
  // Free users' default model: representative of the broadest public ChatGPT experience.
  chatgpt: "openai/gpt-5.6-luna",
  // Stable Flash track: representative of Gemini's mainstream consumer experience, not the newest flagship.
  gemini: "google/gemini-3.5-flash",
  // Sonnet is Claude's default Free/Pro tier; Opus is intentionally excluded.
  claude: "anthropic/claude-sonnet-5",
  // Microsoft Copilot uses an undisclosed dynamic router. Luna is the closest broad-consumer proxy.
  copilot: "openai/gpt-5.6-luna",
  doubao: "bytedance-seed/seed-2-1-turbo",
  kimi: "moonshotai/kimi-k2.6",
  // Flash matches the public Instant experience; Pro is intentionally excluded.
  deepseek: "deepseek/deepseek-v4-flash-0731",
  minimax: "minimax/minimax-m2.5",
  tongyi: "qwen/qwen3.7-plus",
  zhipu: "z-ai/glm-5.2",
  grok: "x-ai/grok-4.6",
};

// Platforms that are better served by Bailian (百炼) than OpenRouter
// doubao on OpenRouter uses Seed models (not actual Doubao), results may differ
export const PLATFORM_RECOMMENDED_PROVIDER: Partial<Record<Platform, string>> = {
  doubao: "百炼",
  tongyi: "百炼",
};

// Bailian (阿里百炼) model names — used when baseUrl contains dashscope/bailian
export const PLATFORM_BAILIAN_MODELS: Partial<Record<Platform, string>> = {
  doubao: "doubao-1.5-pro-32k",
  deepseek: "deepseek-v3.1",
  kimi: "moonshot-v1-auto",
  tongyi: "qwen-plus",
  zhipu: "glm-4-plus",
  minimax: "minimax-01",
  gemini: "gemini-2.0-flash",
};

// ==================== LLM Provider Routing ====================
// We support two LLM providers as a primary/hot-standby pair:
//   - bai (B.AI)       — primary (preferred for the 7 platforms it covers)
//   - openrouter       — hot standby + fallback for the 5 platforms BAI doesn't cover
// The active "primary" is stored in sysConfigs (key=llm_primary_provider). Default 'bai'.
// BAI-uncovered platforms always use OpenRouter — enforced in resolveProviderForPlatform.
export type LLMProvider = "bai" | "openrouter";

// BAI model names — used when baseUrl contains 'b.ai'.
// These are the documented model ids; the real list should be verified at runtime via
// GET https://api.b.ai/v1/models (call testProviderConnection from the UI).
export const PLATFORM_BAI_MODELS: Partial<Record<Platform, string>> = {
  chatgpt: "gpt-5.2",
  claude: "claude-sonnet-4.6",
  gemini: "gemini-3-flash",
  deepseek: "deepseek-v3.2",
  zhipu: "glm-5",
  kimi: "kimi-k2.5",
  minimax: "minimax-m2.5",
};

// Platforms covered by BAI. BAI-uncovered platforms always go through OpenRouter
// regardless of the primary-provider switch.
export const BAI_SUPPORTED_PLATFORMS: Platform[] = Object.keys(PLATFORM_BAI_MODELS) as Platform[];

export const BAI_BASE_URL = "https://api.b.ai/v1";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// Brand line types
// Legacy v2 lines (sun_yuchen / tron / competitor) kept for archived rows; v3 adds 4 new lines.
export const BRAND_LINES = [
  "sun_yuchen", "tron", "competitor",
  "syc_emo", "tron_emo", "tron_rec", "syc_rec",
] as const;
export type BrandLine = (typeof BRAND_LINES)[number];

export const BRAND_LINE_LABELS: Record<BrandLine, string> = {
  sun_yuchen: "孙宇晨IP线",
  tron: "波场TRON线",
  competitor: "竞品对标",
  syc_emo: "孙宇晨情绪类",
  tron_emo: "波场情绪类",
  tron_rec: "波场推荐类",
  syc_rec: "孙宇晨推荐类",
};

// Dimension types
export const DIMENSIONS = [
  "awareness",
  "evaluation",
  "investment",
  "compliance",
  "comparison",
  "ecosystem",
  "usage",
  "wealth",
  "industry_status",
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const DIMENSION_LABELS: Record<Dimension, string> = {
  awareness: "认知",
  evaluation: "评价",
  investment: "投资判断",
  compliance: "合规/法律",
  comparison: "技术对比",
  ecosystem: "生态数据",
  usage: "使用场景",
  wealth: "财富争议",
  industry_status: "行业地位",
};

// Sentiment types
export const SENTIMENT_LABELS: Record<number, string> = {
  1: "强负面",
  2: "偏负面",
  3: "中性",
  4: "偏正面",
  5: "强正面",
};

export const SENTIMENT_COLORS: Record<number, string> = {
  1: "#ef4444",
  2: "#f97316",
  3: "#eab308",
  4: "#22c55e",
  5: "#10b981",
};

// Source type
export const SOURCE_TYPE_LABELS: Record<string, string> = {
  our_content: "己方布局",
  friendly: "友好来源",
  neutral: "中性来源",
  unfriendly: "不友好来源",
  unknown: "未知来源",
};

export const SOURCE_TYPE_COLORS: Record<string, string> = {
  our_content: "#3b82f6",
  friendly: "#22c55e",
  neutral: "#6b7280",
  unfriendly: "#ef4444",
  unknown: "#9ca3af",
};

// Severity types
export const SEVERITY_LABELS: Record<string, string> = {
  critical: "紧急",
  high: "高",
  medium: "中",
  low: "低",
};

export const SEVERITY_COLORS: Record<string, string> = {
  critical: "#ef4444",
  high: "#f97316",
  medium: "#eab308",
  low: "#6b7280",
};

// Content type labels
export const CONTENT_TYPE_LABELS: Record<string, string> = {
  seo_article: "定向稿",
  wiki: "百科",
  zhihu_answer: "知乎回答",
  official_page: "官网页面",
  media_report: "媒体报道",
  social_media: "社交媒体",
  video: "视频内容",
  blog: "博客文章",
};

// Tone labels
export const TONE_LABELS: Record<string, string> = {
  hostile: "敌对",
  critical: "批评",
  neutral: "中性",
  favorable: "友好",
  promotional: "推广",
};
