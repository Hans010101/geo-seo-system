import type {
  FetchTelemetryStats,
  MonitorProfile,
  SourceDiagnostic,
} from "./monitor-coordinator";

export type AcceptanceCycleRecord = {
  cycleId: string;
  profile: MonitorProfile;
  status: "success" | "partial_failure";
  startedAt: number;
  finishedAt: number;
  discovered: number;
  accepted: number;
  completed: number;
  inserted: number;
  analyzed: number;
  analysisFailed: number;
  failed: number;
  analysisNeurons: number;
  analysisFallbacks: number;
  analysisCostUsd: number;
  analysisProviderDist: Record<string, number>;
  sourceDist: Record<string, number>;
  insertedSourceDist: Record<string, number>;
  dedupExisting: number;
  dedupConflicts: number;
  sourceDiagnostics: Record<string, SourceDiagnostic>;
  fetchTelemetry: FetchTelemetryStats;
};

export type BinanceAcceptanceRecord = {
  runId: string;
  mode: "shadow" | "write";
  provider: "browser" | "serper";
  status: "success" | "empty" | "partial" | "failed";
  startedAt: number;
  finishedAt: number;
  rawPosts: number;
  matchedPosts: number;
  enqueued: number;
  queriesAttempted: number;
  queriesSucceeded: number;
  validSampleUrls: number;
  invalidSampleUrls: number;
  errors: string[];
};

export type BrowserAcceptanceRecord = {
  urlHash: string;
  domain: string;
  sourcePlatform: string;
  status: "success" | "short" | "failed";
  originalChars: number;
  browserChars: number;
  browserMs: number;
  durationMs: number;
  gainRatio: number;
  usable: boolean;
  httpStatus?: number;
  error?: string;
  finishedAt: number;
};

export type NotificationAcceptanceRecord = {
  cycleId: string;
  profile: MonitorProfile;
  briefingAttempted: boolean;
  briefingSent: boolean;
  briefingReason?: string;
  failureNotificationAttempted: boolean;
  failureNotificationSent: boolean;
  error?: string;
  finishedAt: number;
};

function sum(values: number[]): number {
  return values.reduce((total, value) => total + (Number(value) || 0), 0);
}

function distribution(
  records: Array<Record<string, number>>,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      result[key] = (result[key] || 0) + (Number(value) || 0);
    }
  }
  return result;
}

function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

export function summarizeMigrationAcceptance(input: {
  windowStart: number;
  now: number;
  cycles: AcceptanceCycleRecord[];
  binance: BinanceAcceptanceRecord[];
  browser: BrowserAcceptanceRecord[];
  notifications: NotificationAcceptanceRecord[];
}) {
  const cycles = input.cycles.filter((item) => item.finishedAt >= input.windowStart);
  const binance = input.binance.filter((item) => item.finishedAt >= input.windowStart);
  const browser = input.browser.filter((item) => item.finishedAt >= input.windowStart);
  const notifications = input.notifications.filter((item) => item.finishedAt >= input.windowStart);
  const elapsedMs = Math.max(0, input.now - input.windowStart);
  const stage3TimeGatePassed = elapsedMs >= 7 * 86_400_000;
  const operationalSuccesses = binance.filter(
    (item) => item.status !== "failed" && item.queriesSucceeded > 0,
  ).length;
  const contentSuccesses = binance.filter(
    (item) => item.matchedPosts > 0 && item.validSampleUrls > 0,
  ).length;
  const invalidSampleUrls = sum(binance.map((item) => item.invalidSampleUrls));
  const operationalSuccessRatePct = pct(operationalSuccesses, binance.length);
  const contentSuccessRatePct = pct(contentSuccesses, binance.length);
  const stage3Verdict =
    !stage3TimeGatePassed
      ? "observing"
      : binance.length === 0 ||
          operationalSuccessRatePct < 90 ||
          contentSuccesses === 0 ||
          invalidSampleUrls > 0
        ? "fail"
        : "pass";
  const writeCycles = cycles.filter(
    (item) => item.sourceDiagnostics.binance_square?.mode === "write",
  );
  const providerDist: Record<string, number> = {};
  for (const item of binance) {
    providerDist[item.provider] = (providerDist[item.provider] || 0) + 1;
  }

  return {
    windowStart: input.windowStart,
    elapsedHours: Math.round((elapsedMs / 3_600_000) * 10) / 10,
    cycles: {
      total: cycles.length,
      successes: cycles.filter((item) => item.status === "success").length,
      partialFailures: cycles.filter((item) => item.status === "partial_failure").length,
      discovered: sum(cycles.map((item) => item.discovered)),
      inserted: sum(cycles.map((item) => item.inserted)),
      analyzed: sum(cycles.map((item) => item.analyzed)),
      analysisFailed: sum(cycles.map((item) => item.analysisFailed)),
      failed: sum(cycles.map((item) => item.failed)),
      analysisNeurons: sum(cycles.map((item) => item.analysisNeurons)),
      analysisFallbacks: sum(cycles.map((item) => item.analysisFallbacks)),
      analysisCostUsd: sum(cycles.map((item) => item.analysisCostUsd)),
      analysisProviderDist: distribution(cycles.map((item) => item.analysisProviderDist)),
    },
    stage3Binance: {
      requiredDays: 7,
      timeGatePassed: stage3TimeGatePassed,
      verdict: stage3Verdict,
      runs: binance.length,
      operationalSuccesses,
      operationalSuccessRatePct,
      contentSuccesses,
      contentSuccessRatePct,
      validSampleUrls: sum(binance.map((item) => item.validSampleUrls)),
      invalidSampleUrls,
      providerDist,
      errors: binance.filter((item) => item.errors.length > 0).length,
    },
    stage4Write: {
      writeRuns: writeCycles.length,
      enqueued: sum(binance.filter((item) => item.mode === "write").map((item) => item.enqueued)),
      inserted: sum(cycles.map((item) => item.insertedSourceDist.binance_square || 0)),
      duplicatesPrevented:
        sum(cycles.map((item) => item.dedupExisting)) +
        sum(cycles.map((item) => item.dedupConflicts)),
      uniqueUrlConstraint: true,
    },
    browserShadow: {
      attempts: browser.length,
      usable: browser.filter((item) => item.usable).length,
      failed: browser.filter((item) => item.status === "failed").length,
      browserMs: sum(browser.map((item) => item.browserMs)),
      averageGainRatio:
        browser.length > 0
          ? Math.round(
              (sum(browser.map((item) => item.gainRatio)) / browser.length) * 100,
            ) / 100
          : 0,
    },
    stage5Notifications: {
      records: notifications.length,
      briefingsAttempted: notifications.filter((item) => item.briefingAttempted).length,
      briefingsSent: notifications.filter((item) => item.briefingSent).length,
      failureNotificationsAttempted: notifications.filter(
        (item) => item.failureNotificationAttempted,
      ).length,
      failureNotificationsSent: notifications.filter(
        (item) => item.failureNotificationSent,
      ).length,
    },
    stage6Parallel: {
      requiredDays: 14,
      startedAt: null,
      verdict: "not_started",
    },
  } as const;
}
