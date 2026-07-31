export function browserCooldownRemainingMs(nextAllowedAt: number, now = Date.now()): number {
  return Math.max(0, Math.floor(Number(nextAllowedAt) || 0) - now);
}
