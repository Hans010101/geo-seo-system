// Cloudflare Workers AI is preferred when its binding is present; Node/Cloud Run keeps the OpenRouter path.
// Prompt structure mirrors the production analyzeCollection, extended for monitoring.
// threatLevel is computed deterministically from source authority × sentiment intensity × stance × relevance.
import { invokeLLM, type Message } from "../_core/llm";
import { calcCostUsd } from "@shared/llm-pricing";
import * as db from "../db";
import { domainOf } from "./util";

const ANALYSIS_MODEL = "deepseek/deepseek-chat";
const CLOUDFLARE_ANALYSIS_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const CLOUDFLARE_MAX_TOKENS = 512;

type WorkersAiBinding = {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
};

type CloudflareRuntimeEnv = {
  AI?: WorkersAiBinding;
  CLOUDFLARE_AI_MODEL?: string;
  CLOUDFLARE_AI_MAX_TOKENS?: string;
};

const ANALYSIS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    relevance: { type: "string", enum: ["high", "medium", "low", "irrelevant"] },
    relevance_reason: { type: "string" },
    sentiment_score: { type: "integer", minimum: 1, maximum: 5 },
    summary: { type: "string" },
    key_entities: { type: "array", maxItems: 5, items: { type: "string" } },
  },
  required: ["relevance", "relevance_reason", "sentiment_score", "summary", "key_entities"],
} as const;

export type Relevance = "high" | "medium" | "low" | "irrelevant";
export type ThreatLevel = "high" | "medium" | "low" | "none";

export type MonitorAnalysis = {
  relevance: Relevance;
  relevanceReason: string;
  sentimentScore: number;
  threatLevel: ThreatLevel;
  summary: string;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
  provider: "cloudflare_workers_ai" | "openrouter";
  model: string;
  neurons: number | null;
};

type ParsedAnalysis = {
  relevance: Relevance;
  relevanceReason: string;
  sentimentScore: number;
  summary: string;
  keyEntities: string[];
};

function runtimeEnv(): CloudflareRuntimeEnv | undefined {
  return (globalThis as any).__CF_ENV__ as CloudflareRuntimeEnv | undefined;
}

function boundedMaxTokens(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return CLOUDFLARE_MAX_TOKENS;
  return Math.min(1024, Math.max(128, parsed));
}

function parseJsonText(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("分析响应无法解析为 JSON");
    return JSON.parse(match[0]);
  }
}

export function parseMonitorAnalysisPayload(value: unknown): ParsedAnalysis {
  const parsed = typeof value === "string" ? parseJsonText(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("分析响应不是 JSON 对象");
  const record = parsed as Record<string, unknown>;
  const relevance = record.relevance;
  if (!(relevance === "high" || relevance === "medium" || relevance === "low" || relevance === "irrelevant")) {
    throw new Error("分析响应 relevance 无效");
  }
  const score = Number(record.sentiment_score ?? record.sentimentScore);
  if (!Number.isInteger(score) || score < 1 || score > 5) throw new Error("分析响应 sentiment_score 无效");
  const relevanceReason = String(record.relevance_reason ?? record.relevanceReason ?? "").trim();
  const summary = String(record.summary ?? "").trim();
  if (!relevanceReason || !summary) throw new Error("分析响应缺少 relevance_reason 或 summary");
  if (!Array.isArray(record.key_entities) || record.key_entities.some((item) => typeof item !== "string")) {
    throw new Error("分析响应 key_entities 无效");
  }
  return {
    relevance,
    relevanceReason: relevanceReason.slice(0, 500),
    sentimentScore: score,
    summary: summary.slice(0, 480),
    keyEntities: record.key_entities.slice(0, 5) as string[],
  };
}

function tokenCount(usage: Record<string, unknown>, primary: string, fallback: string): number | null {
  const value = usage[primary] ?? usage[fallback];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function estimateWorkersAiNeurons(model: string, promptTokens: number | null, completionTokens: number | null): number | null {
  if (promptTokens == null && completionTokens == null) return null;
  if (model !== CLOUDFLARE_ANALYSIS_MODEL && model !== "@cf/meta/llama-3.1-8b-instruct-fp8-fast") return null;
  return ((promptTokens || 0) * 4_119 + (completionTokens || 0) * 34_868) / 1_000_000;
}

function retryableWorkersAiError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return !/(quota|daily limit|rate limit|too many requests|429|exceeded.*neuron|authentication|permission)/.test(message);
}

async function analyzeWithWorkersAi(
  ai: WorkersAiBinding,
  env: CloudflareRuntimeEnv,
  messages: Message[],
): Promise<{ parsed: ParsedAnalysis; promptTokens: number | null; completionTokens: number | null; model: string; neurons: number | null }> {
  const model = env.CLOUDFLARE_AI_MODEL?.trim() || CLOUDFLARE_ANALYSIS_MODEL;
  const maxTokens = boundedMaxTokens(env.CLOUDFLARE_AI_MAX_TOKENS);
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await ai.run(model, {
        messages,
        max_tokens: maxTokens,
        temperature: 0.1,
        stream: false,
        response_format: { type: "json_schema", json_schema: ANALYSIS_JSON_SCHEMA },
      });
      const result = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const parsed = parseMonitorAnalysisPayload(result.response ?? raw);
      const usage = result.usage && typeof result.usage === "object" ? result.usage as Record<string, unknown> : {};
      const promptTokens = tokenCount(usage, "prompt_tokens", "input_tokens");
      const completionTokens = tokenCount(usage, "completion_tokens", "output_tokens");
      const reportedNeurons = typeof usage.neurons === "number" && Number.isFinite(usage.neurons) ? usage.neurons : null;
      return {
        parsed,
        promptTokens,
        completionTokens,
        model,
        neurons: reportedNeurons ?? estimateWorkersAiNeurons(model, promptTokens, completionTokens),
      };
    } catch (error) {
      lastError = error;
      if (attempt === 0 && retryableWorkersAiError(error)) continue;
      break;
    }
  }
  throw new Error(`Workers AI analysis failed after retry: ${String(lastError instanceof Error ? lastError.message : lastError).slice(0, 300)}`);
}

// Deterministic threat = negative-sentiment intensity × source authority × relevance weight, shifted by stance.
function computeThreat(
  sentimentScore: number,
  relevance: Relevance,
  authorityLevel: number,
  stance: "hostile" | "neutral" | "friendly"
): ThreatLevel {
  if (relevance === "irrelevant") return "none";
  const neg = sentimentScore <= 2 ? 3 - sentimentScore : 0; // 1→2, 2→1, ≥3→0 (only negatives threaten)
  if (neg === 0) return "none";
  const relWeight: Record<Relevance, number> = { high: 1, medium: 0.7, low: 0.4, irrelevant: 0 };
  let score = neg * authorityLevel * relWeight[relevance];
  if (stance === "hostile") score += 3;
  else if (stance === "friendly") score -= 2;
  if (score >= 13) return "high";
  if (score >= 6) return "medium";
  if (score > 0) return "low";
  return "none";
}

function buildPrompt(title: string, body: string, partial: boolean): string {
  return `你是一个专业的品牌声誉分析师。监控对象是"孙宇晨(Justin Sun) / 波场(TRON、TRX 及其官方项目)"。请判断这篇文章与监控对象的相关性、情感立场，并总结。

## 相关性(relevance)判定标准 —— 严格按"文章的主体/核心议题"判断，不是"有没有提到"：
- high: 文章的**主体/核心议题就是孙宇晨本人，或波场 TRON/TRX/其官方项目的重大声誉事件**（诉讼、监管、和解、上市、重大合作、安全事故、重大负面指控等）。标题或首段就在讲他们。
- medium: 孙宇晨/波场是文章的**重要角色之一，但不是唯一主体**（例如"特朗普加密项目遇冷，孙宇晨是主要投资人之一"）。
- low: 只是**顺带提及 / 背景引用 / 行情噪音**（讲整个加密行业时列举到名字；或 TRX 币价预测、涨跌、网络指标、交易量/活跃地址创新高这类纯行情文章）。
- irrelevant: 完全无关、同名误匹配、或仅在无关榜单/制裁名单里被列一笔。

## 判定示例(few-shot)：
- "Why one of Trump crypto's biggest backers is sounding the alarm"（主体是特朗普币，孙宇晨只是backer之一）→ medium
- "Justin Sun takes Trump family crypto firm to court"（主体就是孙宇晨的起诉行为）→ high
- "TRX Price Prediction: Treasury Tops 700M Tokens"（主体是币价/持仓预测，孙宇晨/波场顺带）→ low
- "US Treasury Sanctions 134 Wallets Linked to ISIS-K"（主体是反恐制裁，TRX 仅被列名）→ irrelevant

## 文章标题
${title || "(无标题)"}

## 文章正文${partial ? "（仅摘要，内容可能不完整，请据现有信息判断；主体不明时不要轻易判 high）" : ""}
${body}

## 请仅输出以下 JSON（不要输出其他任何内容）：
{
  "relevance": "<high|medium|low|irrelevant>",
  "relevance_reason": "<一句话说明为什么判这个等级，点明文章主体是谁>",
  "sentiment_score": <1-5的整数，对监控对象的立场：1=强负面，2=偏负面，3=中性，4=偏正面，5=强正面；若 irrelevant 填 3>,
  "summary": "<100字以内中文摘要，说明文章讲了什么、对品牌是利好还是利空>",
  "key_entities": ["<涉及的关键实体，最多5个>"]
}`;
}

export async function analyzeArticle(input: {
  url: string;
  title: string | null;
  contentMd: string;
  snippet: string;
  fetchStatus: "full" | "partial" | "failed";
}): Promise<MonitorAnalysis> {
  const body = (input.contentMd || input.snippet || "").slice(0, 6000);
  const partial = input.fetchStatus !== "full";
  const messages: Message[] = [
    { role: "system", content: "You are a professional brand reputation analyst. Always respond with valid JSON only." },
    { role: "user", content: buildPrompt(input.title || "", body, partial) },
  ];
  const env = runtimeEnv();
  let parsed: ParsedAnalysis;
  let promptTokens: number | null;
  let completionTokens: number | null;
  let costUsd: number | null;
  let provider: MonitorAnalysis["provider"];
  let model: string;
  let neurons: number | null;

  if (env?.AI) {
    const result = await analyzeWithWorkersAi(env.AI, env, messages);
    parsed = result.parsed;
    promptTokens = result.promptTokens;
    completionTokens = result.completionTokens;
    costUsd = null;
    provider = "cloudflare_workers_ai";
    model = result.model;
    neurons = result.neurons;
  } else {
    const orKey = await db.getGlobalApiKeyByName("OpenRouter");
    if (!orKey?.apiKey || !orKey.baseUrl) {
      throw new Error("OpenRouter key 未配置：舆情分析需要「全局 API 配置」中名为 'OpenRouter' 的有效条目");
    }
    const result = await invokeLLM({
      apiKey: orKey.apiKey,
      baseUrl: orKey.baseUrl,
      model: ANALYSIS_MODEL,
      messages,
      response_format: { type: "json_object" },
      timeoutMs: 60000,
    });
    const content = typeof result.choices?.[0]?.message?.content === "string"
      ? result.choices[0].message.content as string
      : "";
    parsed = parseMonitorAnalysisPayload(content);
    const usage: any = result.usage || {};
    promptTokens = usage.prompt_tokens ?? null;
    completionTokens = usage.completion_tokens ?? null;
    costUsd = typeof usage.cost === "number"
      ? usage.cost
      : calcCostUsd(ANALYSIS_MODEL, promptTokens, completionTokens);
    provider = "openrouter";
    model = ANALYSIS_MODEL;
    neurons = null;
  }

  const domain = domainOf(input.url);
  const rule = domain ? await db.getMonitorSourceRuleByDomain(domain) : undefined;
  const threatLevel = computeThreat(
    parsed.sentimentScore,
    parsed.relevance,
    rule?.authorityLevel ?? 5,
    (rule?.stance as any) ?? "neutral"
  );

  const entities = parsed.keyEntities.join("、");
  const summary = `${parsed.summary}${entities ? `\n关键实体: ${entities}` : ""}`;

  return {
    relevance: parsed.relevance,
    relevanceReason: parsed.relevanceReason,
    sentimentScore: parsed.sentimentScore,
    threatLevel,
    summary,
    promptTokens,
    completionTokens,
    costUsd,
    provider,
    model,
    neurons,
  };
}
