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
  briefingItems: BriefingRecord[];
};

type CoordinatorEnv = Record<string, never>;

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
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
        this.finalize(state);
        await this.save(state);
      }
      return json(state);
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
      state.analysisNeurons += Number(body.analysisNeurons) || 0;
      state.analysisCostUsd += Number(body.analysisCostUsd) || 0;
      const provider = String(body.analysisProvider || "");
      if (provider) {
        state.analysisProviderDist[provider] =
          (state.analysisProviderDist[provider] || 0) + 1;
      }
      const source = String(body.sourcePlatform || "");
      if (source) state.sourceDist[source] = (state.sourceDist[source] || 0) + 1;
      if (body.fallbackReason) {
        state.analysisFallbacks++;
        const reason = String(body.fallbackReason).slice(0, 300);
        if (
          state.analysisFallbackReasons.length < 3 &&
          !state.analysisFallbackReasons.includes(reason)
        ) {
          state.analysisFallbackReasons.push(reason);
        }
      }
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
