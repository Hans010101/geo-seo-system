export type OpenRouterPreflightResult = {
  configured: boolean;
  available: boolean;
  status: "healthy" | "unconfigured" | "unauthorized" | "insufficient_credits" | "rate_limited" | "error";
  httpStatus: number | null;
  keyLimitRemaining: number | null;
  keyUsageDaily: number | null;
  model: string;
  checkedAt: number;
  error?: string;
};

type OpenRouterPreflightOptions = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  checkedAt?: number;
};

function finiteNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function statusFromHttp(httpStatus: number): OpenRouterPreflightResult["status"] {
  if (httpStatus === 401 || httpStatus === 403) return "unauthorized";
  if (httpStatus === 402) return "insufficient_credits";
  if (httpStatus === 429) return "rate_limited";
  return "error";
}

async function responseError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as {
    error?: { message?: string };
    message?: string;
  } | null;
  return String(
    body?.error?.message ||
    body?.message ||
    `OpenRouter HTTP ${response.status}`,
  ).slice(0, 300);
}

/**
 * A one-token paid probe is deliberate: GET /key proves that a key is valid,
 * but an unlimited key can still belong to an account with zero credits.
 * The tiny completion is the only reliable way to detect OpenRouter HTTP 402
 * before the 372-cell weekly GEO run starts.
 */
export async function probeOpenRouter(
  options: OpenRouterPreflightOptions,
): Promise<OpenRouterPreflightResult> {
  const apiKey = options.apiKey?.trim();
  const baseUrl = (options.baseUrl || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  const model = options.model || "openai/gpt-4o-mini";
  const checkedAt = options.checkedAt ?? Date.now();
  const fetchImpl = options.fetchImpl || fetch;
  const base = {
    configured: Boolean(apiKey),
    available: false,
    httpStatus: null,
    keyLimitRemaining: null,
    keyUsageDaily: null,
    model,
    checkedAt,
  };
  if (!apiKey) return { ...base, status: "unconfigured" };

  try {
    const keyResponse = await fetchImpl(`${baseUrl}/key`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": "geo-seo-system/1.0",
      },
    });
    if (!keyResponse.ok) {
      return {
        ...base,
        status: statusFromHttp(keyResponse.status),
        httpStatus: keyResponse.status,
        error: await responseError(keyResponse),
      };
    }
    const keyBody = await keyResponse.json().catch(() => null) as {
      data?: { limit_remaining?: number | null; usage_daily?: number | null };
    } | null;
    const keyLimitRemaining = finiteNumber(keyBody?.data?.limit_remaining);
    const keyUsageDaily = finiteNumber(keyBody?.data?.usage_daily);
    if (keyLimitRemaining !== null && keyLimitRemaining <= 0) {
      return {
        ...base,
        status: "insufficient_credits",
        httpStatus: 402,
        keyLimitRemaining,
        keyUsageDaily,
        error: "OpenRouter API key spending limit is exhausted",
      };
    }

    const completionResponse = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://geo-seo-system.pages.dev",
        "X-Title": "GEO SEO System preflight",
        "User-Agent": "geo-seo-system/1.0",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply OK." }],
        max_tokens: 1,
        temperature: 0,
      }),
    });
    if (!completionResponse.ok) {
      return {
        ...base,
        status: statusFromHttp(completionResponse.status),
        httpStatus: completionResponse.status,
        keyLimitRemaining,
        keyUsageDaily,
        error: await responseError(completionResponse),
      };
    }
    await completionResponse.body?.cancel();
    return {
      ...base,
      configured: true,
      available: true,
      status: "healthy",
      httpStatus: completionResponse.status,
      keyLimitRemaining,
      keyUsageDaily,
    };
  } catch (error) {
    return {
      ...base,
      status: "error",
      error: String(error).slice(0, 300),
    };
  }
}

export function isFreshHealthyOpenRouter(
  result: Partial<OpenRouterPreflightResult> | null,
  now: number,
  maxAgeHours: number,
): boolean {
  return Boolean(
    result?.available &&
    result.status === "healthy" &&
    Number(result.checkedAt) > 0 &&
    now - Number(result.checkedAt) <= Math.max(1, maxAgeHours) * 3_600_000,
  );
}
