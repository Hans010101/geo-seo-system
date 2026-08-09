import { DurableObject } from "cloudflare:workers";

export type MonitorProfile = "monitor_primary_news" | "monitor_primary_social";

export type BriefingRecord = {
  title: string;
  url: string;
  sourcePlatform: string;
  domain: string | null;
  relevance: "high" | "medium";
  sentimentScore: number;
  threatLevel: "high" | "medium" | "low" | "none";
};

export type SourceDiagnostic = {
  status: "success" | "empty" | "partial" | "failed";
  mode?: "shadow" | "write";
  provider?: "browser" | "serper";
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

export type FetchTelemetryStats = {
  attempts: number;
  successes: number;
  fallbacks: number;
  durationMs: number;
  contentChars: number;
  costUsd: number;
  engineDist: Record<string, number>;
  failureReasons: Record<string, number>;
  domains: Record<string, {
    attempts: number;
    successes: number;
    fallbacks: number;
  }>;
};

export type CoordinatorStats = {
  cycleId: string;
  profile: MonitorProfile;
  status: "queued" | "running" | "success" | "partial_failure";
  startedAt: number;
  finishedAt: number | null;
  maxArticles: number;
  keywords: number;
  sources: string[];
  discoveryExpected: number;
  discoveryCompleted: number;
  discoveryFailed: number;
  discovered: number;
  candidateExpected: number;
  candidateSettled: number;
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
  analysisFallbackReasons: string[];
  sourceDist: Record<string, number>;
  insertedSourceDist: Record<string, number>;
  dedupExisting: number;
  dedupConflicts: number;
  rejected: number;
  rejectionReasons: Record<string, number>;
  rejectedSourceDist: Record<string, number>;
  realtimeAlerts: number;
  sourceDiagnostics: Record<string, SourceDiagnostic>;
  fetchTelemetry: FetchTelemetryStats;
  briefingItems: BriefingRecord[];
};

type CoordinatorEnv = Record<string, never>;

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function emptyFetchTelemetry(): FetchTelemetryStats {
  return {
    attempts: 0,
    successes: 0,
    fallbacks: 0,
    durationMs: 0,
    contentChars: 0,
    costUsd: 0,
    engineDist: {},
    failureReasons: {},
    domains: {},
  };
}

function emptyState(body: {
  cycleId: string;
  profile: MonitorProfile;
  maxArticles: number;
  keywords: number;
  sources: string[];
  discoveryExpected: number;
}): CoordinatorStats {
  return {
    ...body,
    status: "queued",
    startedAt: Date.now(),
    finishedAt: null,
    discoveryCompleted: 0,
    discoveryFailed: 0,
    discovered: 0,
    candidateExpected: 0,
    candidateSettled: 0,
    accepted: 0,
    completed: 0,
    inserted: 0,
    analyzed: 0,
    analysisFailed: 0,
    failed: 0,
    analysisNeurons: 0,
    analysisFallbacks: 0,
    analysisCostUsd: 0,
    analysisProviderDist: {},
    analysisFallbackReasons: [],
    sourceDist: {},
    insertedSourceDist: {},
    dedupExisting: 0,
    dedupConflicts: 0,
    rejected: 0,
    rejectionReasons: {},
    rejectedSourceDist: {},
    realtimeAlerts: 0,
    sourceDiagnostics: {},
    fetchTelemetry: emptyFetchTelemetry(),
    briefingItems: [],
  };
}

export class MonitorCoordinator extends DurableObject<CoordinatorEnv> {
  private async state(): Promise<CoordinatorStats | null> {
    return (await this.ctx.storage.get<CoordinatorStats>("state")) || null;
  }

  private async save(state: CoordinatorStats): Promise<void> {
    await this.ctx.storage.put("state", state);
  }

  private finalize(state: CoordinatorStats): CoordinatorStats {
    if (
      state.discoveryCompleted >= state.discoveryExpected &&
      state.candidateSettled >= state.candidateExpected
    ) {
      state.status =
        state.discoveryFailed > 0 || state.analysisFailed > 0 || state.failed > 0
          ? "partial_failure"
          : "success";
      state.finishedAt = Date.now();
    } else {
      state.status = "running";
    }
    return state;
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/status") {
      return json((await this.state()) || { status: "idle" });
    }

    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    const body = (await request.json()) as Record<string, any>;

    if (path === "/start") {
      await this.ctx.storage.deleteAll();
      const state = emptyState(body as Parameters<typeof emptyState>[0]);
      await this.save(state);
      return json(state);
    }

    const state = await this.state();
    if (!state || body.cycleId !== state.cycleId) {
      return json({ accepted: false, stale: true, state }, 409);
    }

    if (path === "/discovery-done") {
      const taskKey = `discovery:${String(body.taskId)}`;
      if (!(await this.ctx.storage.get<boolean>(taskKey))) {
        await this.ctx.storage.put(taskKey, true);
        state.discoveryCompleted++;
        state.discovered += Math.max(0, Number(body.discovered) || 0);
        state.candidateExpected += Math.max(0, Number(body.enqueued) || 0);
        if (body.failed) state.discoveryFailed++;
        state.sourceDiagnostics ||= {};
        if (body.sourceName && body.diagnostic) {
          state.sourceDiagnostics[String(body.sourceName)] =
            body.diagnostic as SourceDiagnostic;
        }
        this.finalize(state);
        await this.save(state);
      }
      return json(state);
    }

    if (path === "/claim") {
      const hash = String(body.urlHash || "");
      const deliveryId = String(body.deliveryId || "");
      const key = `candidate:${hash}`;
      const existing = await this.ctx.storage.get<{ deliveryId: string; done: boolean; claimedAt: number }>(key);
      if (existing) {
        const retryLeaseExpired =
          existing.deliveryId === deliveryId &&
          !existing.done &&
          Date.now() - existing.claimedAt > 30_000;
        if (retryLeaseExpired) {
          await this.ctx.storage.put(key, { ...existing, claimedAt: Date.now() });
        }
        return json({
          accepted: retryLeaseExpired,
          duplicate: existing.deliveryId !== deliveryId,
          inFlight: existing.deliveryId === deliveryId && !retryLeaseExpired && !existing.done,
          state,
        });
      }
      if (state.accepted >= state.maxArticles) {
        return json({ accepted: false, capped: true, state });
      }
      await this.ctx.storage.put(key, { deliveryId, done: false, claimedAt: Date.now() });
      state.accepted++;
      state.status = "running";
      await this.save(state);
      return json({ accepted: true, state });
    }

    if (path === "/settle") {
      const deliveryId = String(body.deliveryId || "");
      const settleKey = `settled:${deliveryId}`;
      if (!(await this.ctx.storage.get<boolean>(settleKey))) {
        await this.ctx.storage.put(settleKey, true);
        state.candidateSettled++;
        if (body.rejectionReason) {
          state.rejected = (state.rejected || 0) + 1;
          state.rejectionReasons ||= {};
          const reason = String(body.rejectionReason).slice(0, 64);
          state.rejectionReasons[reason] =
            (state.rejectionReasons[reason] || 0) + 1;
          state.rejectedSourceDist ||= {};
          const source = String(body.sourcePlatform || "").slice(0, 64);
          if (source) {
            state.rejectedSourceDist[source] =
              (state.rejectedSourceDist[source] || 0) + 1;
          }
        }
        state.dedupExisting =
          (state.dedupExisting || 0) + (body.dedupExisting ? 1 : 0);
        this.finalize(state);
        await this.save(state);
      }
      return json(state);
    }

    if (path === "/claim-post-cycle") {
      if (state.status !== "success" && state.status !== "partial_failure") {
        return json({ accepted: false, reason: "cycle_not_terminal", state }, 409);
      }
      const claimKey = "post-cycle-claimed";
      if (await this.ctx.storage.get<boolean>(claimKey)) {
        return json({ accepted: false, duplicate: true, state });
      }
      await this.ctx.storage.put(claimKey, true);
      return json({ accepted: true, state });
    }

    if (path === "/complete") {
      const hash = String(body.urlHash || "");
      const key = `candidate:${hash}`;
      const claimed = await this.ctx.storage.get<{ deliveryId: string; done: boolean; claimedAt: number }>(key);
      if (!claimed || claimed.done) return json(this.finalize(state));
      await this.ctx.storage.put(key, { ...claimed, done: true });
      state.completed++;
      state.candidateSettled++;
      state.inserted += body.inserted ? 1 : 0;
      state.analyzed += body.analyzed ? 1 : 0;
      state.analysisFailed += body.analysisFailed ? 1 : 0;
      state.failed += body.failed ? 1 : 0;
      state.dedupExisting = (state.dedupExisting || 0) + (body.dedupExisting ? 1 : 0);
      state.dedupConflicts = (state.dedupConflicts || 0) + (body.dedupConflict ? 1 : 0);
      state.realtimeAlerts = (state.realtimeAlerts || 0) + (body.realtimeAlertCreated ? 1 : 0);
      state.analysisNeurons += Number(body.analysisNeurons) || 0;
      state.analysisCostUsd += Number(body.analysisCostUsd) || 0;
      state.analysisProviderDist ||= {};
      const provider = String(body.analysisProvider || "");
      if (provider) {
        state.analysisProviderDist[provider] =
          (state.analysisProviderDist[provider] || 0) + 1;
      }
      state.sourceDist ||= {};
      const source = String(body.sourcePlatform || "");
      if (source && (body.inserted || body.analyzed)) {
        state.sourceDist[source] = (state.sourceDist[source] || 0) + 1;
      }
      state.insertedSourceDist ||= {};
      if (source && body.inserted) {
        state.insertedSourceDist[source] = (state.insertedSourceDist[source] || 0) + 1;
      }
      if (body.fetchAttempt) {
        const attempt = body.fetchAttempt as Record<string, unknown>;
        state.fetchTelemetry ||= emptyFetchTelemetry();
        const telemetry = state.fetchTelemetry;
        const engine = String(attempt.engine || "unknown").slice(0, 64);
        const outcome = String(attempt.outcome || "failed");
        const reason = String(attempt.reason || "engine_error").slice(0, 64);
        const domain = String(attempt.domain || "unknown").slice(0, 128);
        telemetry.attempts++;
        if (outcome === "success") telemetry.successes++;
        if (outcome === "fallback") telemetry.fallbacks++;
        telemetry.durationMs += Math.max(0, Number(attempt.durationMs) || 0);
        telemetry.contentChars += Math.max(0, Number(attempt.contentChars) || 0);
        telemetry.costUsd += Math.max(0, Number(attempt.costUsd) || 0);
        telemetry.engineDist[engine] = (telemetry.engineDist[engine] || 0) + 1;
        if (reason !== "success") {
          telemetry.failureReasons[reason] = (telemetry.failureReasons[reason] || 0) + 1;
        }
        const domainStats = telemetry.domains[domain] ||= {
          attempts: 0,
          successes: 0,
          fallbacks: 0,
        };
        domainStats.attempts++;
        if (outcome === "success") domainStats.successes++;
        if (outcome === "fallback") domainStats.fallbacks++;
      }
      if (body.fallbackReason) {
        state.analysisFallbacks++;
        state.analysisFallbackReasons ||= [];
        const reason = String(body.fallbackReason).slice(0, 300);
        if (
          state.analysisFallbackReasons.length < 3 &&
          !state.analysisFallbackReasons.includes(reason)
        ) {
          state.analysisFallbackReasons.push(reason);
        }
      }
      state.briefingItems ||= [];
      if (body.briefingItem && state.briefingItems.length < state.maxArticles) {
        state.briefingItems.push(body.briefingItem as BriefingRecord);
      }
      this.finalize(state);
      await this.save(state);
      return json(state);
    }

    return json({ error: "not found" }, 404);
  }
}
