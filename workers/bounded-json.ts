// Status summaries are stored in sysConfigs and parsed back by the operations center.
// Cutting a JSON string at N characters leaves invalid JSON, so shrink the value instead.

export const STATUS_SUMMARY_MAX_CHARS = 16_000;

function shrink(value: unknown, maxString: number, maxArray: number): unknown {
  if (typeof value === "string") {
    return value.length > maxString ? `${value.slice(0, maxString)}…` : value;
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, maxArray).map(item => shrink(item, maxString, maxArray));
    return value.length > maxArray ? [...items, `…另有 ${value.length - maxArray} 项`] : items;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [key, shrink(item, maxString, maxArray)]),
    );
  }
  return value;
}

/** JSON.stringify that always returns valid JSON of at most maxChars characters. */
export function boundedJson(value: unknown, maxChars = STATUS_SUMMARY_MAX_CHARS): string {
  const full = JSON.stringify(value ?? null);
  if (full.length <= maxChars) return full;
  for (const [maxString, maxArray] of [[400, 20], [200, 8], [120, 4], [60, 2]] as const) {
    const text = JSON.stringify({ ...(shrink(value, maxString, maxArray) as object), truncated: true });
    if (text.length <= maxChars) return text;
  }
  const scalars = value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item === null || ["string", "number", "boolean"].includes(typeof item))
        .map(([key, item]) => [key, typeof item === "string" ? item.slice(0, 120) : item]),
    )
    : {};
  const fallback = JSON.stringify({ ...scalars, truncated: true });
  return fallback.length <= maxChars ? fallback : JSON.stringify({ truncated: true });
}
