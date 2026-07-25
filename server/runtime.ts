export function isCloudflareRuntime(): boolean {
  return typeof (globalThis as Record<string, unknown>).WebSocketPair !== "undefined";
}
