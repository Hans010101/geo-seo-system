import { AsyncLocalStorage } from "node:async_hooks";

export type WorkersAiBinding = {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
};

export type CloudflareRuntimeEnv = {
  AI?: WorkersAiBinding;
  JWT_SECRET?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_BASE_URL?: string;
  CLOUDFLARE_AI_MODEL?: string;
  CLOUDFLARE_AI_MAX_TOKENS?: string;
  CLOUDFLARE_OPENROUTER_FALLBACK_ENABLED?: string;
  CLOUDFLARE_OPENROUTER_FALLBACK_MODEL?: string;
  [key: string]: unknown;
};

const cloudflareEnvStore = new AsyncLocalStorage<CloudflareRuntimeEnv>();

export function withCloudflareEnv<T>(
  env: CloudflareRuntimeEnv,
  work: () => T,
): T {
  return cloudflareEnvStore.run(env, work);
}

export function getCloudflareEnv(): CloudflareRuntimeEnv {
  return cloudflareEnvStore.getStore() || {};
}
