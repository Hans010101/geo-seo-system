export type CloudflareFeatureEnv = {
  ENABLE_CLOUDFLARE_CRON?: string;
  CLOUDFLARE_MONITOR_NEWS_ENABLED?: string;
  CLOUDFLARE_MONITOR_SOCIAL_ENABLED?: string;
  CLOUDFLARE_CHINESE_SOCIAL_ENABLED?: string;
  CLOUDFLARE_BINANCE_SHADOW_ENABLED?: string;
  CLOUDFLARE_BINANCE_WRITE_ENABLED?: string;
  CLOUDFLARE_CLEANUP_ENABLED?: string;
  CLOUDFLARE_WEEKLY_REPORT_ENABLED?: string;
  CLOUDFLARE_MONTHLY_REPORT_ENABLED?: string;
  CLOUDFLARE_GEO_DAILY_ENABLED?: string;
  CLOUDFLARE_GEO_WEEKLY_ENABLED?: string;
  CLOUDFLARE_REALTIME_ALERTS_ENABLED?: string;
  CLOUDFLARE_BRIEFING_ENABLED?: string;
  CLOUDFLARE_FAILURE_NOTIFICATIONS_ENABLED?: string;
  CLOUDFLARE_FETCH_OBSERVABILITY_ENABLED?: string;
  CLOUDFLARE_BROWSER_FULLTEXT_SHADOW_ENABLED?: string;
  CLOUDFLARE_OPENROUTER_FALLBACK_ENABLED?: string;
  CLOUDFLARE_OPENROUTER_PREFLIGHT_ENABLED?: string;
};

function enabled(value: string | undefined, fallback = false): boolean {
  if (value == null || value === "") return fallback;
  return value === "true";
}

/**
 * Single source of truth for Cloudflare migration rollouts.
 *
 * Existing production jobs default to enabled so an omitted variable never
 * changes the current schedule. Features that are not yet wired into the
 * queue-backed runtime default to disabled.
 */
export function getCloudflareFeatureFlags(env: CloudflareFeatureEnv) {
  return {
    scheduler: enabled(env.ENABLE_CLOUDFLARE_CRON),
    monitorNews: enabled(env.CLOUDFLARE_MONITOR_NEWS_ENABLED, true),
    monitorSocial: enabled(env.CLOUDFLARE_MONITOR_SOCIAL_ENABLED, true),
    chineseSocial: enabled(env.CLOUDFLARE_CHINESE_SOCIAL_ENABLED),
    binanceShadow: enabled(env.CLOUDFLARE_BINANCE_SHADOW_ENABLED),
    binanceWrite: enabled(env.CLOUDFLARE_BINANCE_WRITE_ENABLED),
    cleanup: enabled(env.CLOUDFLARE_CLEANUP_ENABLED, true),
    weeklyReport: enabled(env.CLOUDFLARE_WEEKLY_REPORT_ENABLED, true),
    monthlyReport: enabled(env.CLOUDFLARE_MONTHLY_REPORT_ENABLED, true),
    geoDaily: enabled(env.CLOUDFLARE_GEO_DAILY_ENABLED),
    geoWeekly: enabled(env.CLOUDFLARE_GEO_WEEKLY_ENABLED),
    realtimeAlerts: enabled(env.CLOUDFLARE_REALTIME_ALERTS_ENABLED),
    briefing: enabled(env.CLOUDFLARE_BRIEFING_ENABLED),
    failureNotifications: enabled(env.CLOUDFLARE_FAILURE_NOTIFICATIONS_ENABLED),
    fetchObservability: enabled(env.CLOUDFLARE_FETCH_OBSERVABILITY_ENABLED),
    browserFullTextShadow: enabled(env.CLOUDFLARE_BROWSER_FULLTEXT_SHADOW_ENABLED),
    openRouterFallback: enabled(env.CLOUDFLARE_OPENROUTER_FALLBACK_ENABLED),
    openRouterPreflight: enabled(env.CLOUDFLARE_OPENROUTER_PREFLIGHT_ENABLED),
  } as const;
}
