export type SourceDiagnostic = {
  status: "success" | "empty" | "partial" | "failed";
  mode?: "shadow" | "write";
  provider?: string;
  discovered: number;
  enqueued: number;
  durationMs?: number;
  browserMs?: number;
  fallbacks?: number;
  queriesAttempted?: number;
  queriesSucceeded?: number;
  errors?: string[];
  updatedAt: number;
};

export function mergeSourceDiagnostic(
  previous: SourceDiagnostic | undefined,
  current: SourceDiagnostic,
): SourceDiagnostic {
  if (!previous) return current;
  const statuses = [previous.status, current.status];
  const status = statuses.every(value => value === "failed")
    ? "failed"
    : statuses.includes("failed") || statuses.includes("partial")
      ? "partial"
      : statuses.includes("success")
        ? "success"
        : "empty";
  const providers = Array.from(new Set(
    [previous.provider, current.provider]
      .flatMap(value => value?.split("+") || [])
      .filter(Boolean),
  ));
  return {
    status,
    mode: current.mode || previous.mode,
    ...(providers.length > 0 ? { provider: providers.join("+") } : {}),
    discovered: previous.discovered + current.discovered,
    enqueued: previous.enqueued + current.enqueued,
    durationMs: (previous.durationMs || 0) + (current.durationMs || 0),
    browserMs: (previous.browserMs || 0) + (current.browserMs || 0),
    fallbacks: (previous.fallbacks || 0) + (current.fallbacks || 0),
    queriesAttempted: (previous.queriesAttempted || 0) + (current.queriesAttempted || 0),
    queriesSucceeded: (previous.queriesSucceeded || 0) + (current.queriesSucceeded || 0),
    errors: Array.from(new Set([...(previous.errors || []), ...(current.errors || [])])).slice(0, 6),
    updatedAt: Math.max(previous.updatedAt, current.updatedAt),
  };
}
