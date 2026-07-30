import { DurableObject } from "cloudflare:workers";

export type BrowserShadowResultSummary = {
  token: string;
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

export type BrowserShadowBudgetState = {
  schemaVersion: 2;
  day: string;
  reserved: number;
  completed: number;
  successes: number;
  failed: number;
  browserMs: number;
  lastResult: BrowserShadowResultSummary | null;
};

type BrowserShadowBudgetEnv = Record<string, never>;

function dayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyState(): BrowserShadowBudgetState {
  return {
    schemaVersion: 2,
    day: dayUtc(),
    reserved: 0,
    completed: 0,
    successes: 0,
    failed: 0,
    browserMs: 0,
    lastResult: null,
  };
}

export class BrowserShadowBudget extends DurableObject<BrowserShadowBudgetEnv> {
  private async state(): Promise<BrowserShadowBudgetState> {
    const stored = await this.ctx.storage.get<Partial<BrowserShadowBudgetState>>("state");
    const state: BrowserShadowBudgetState = {
      ...emptyState(),
      ...stored,
      schemaVersion: 2,
    };
    if (state.day !== dayUtc()) {
      await this.ctx.storage.deleteAll();
      const reset = emptyState();
      await this.save(reset);
      return reset;
    }
    if (state.completed > state.reserved) {
      // Older deployments accepted record callbacks after a daily reset. Keep
      // the completed evidence but restore the budget invariant during upgrade.
      state.reserved = state.completed;
      await this.save(state);
    }
    return state;
  }

  private async save(state: BrowserShadowBudgetState): Promise<void> {
    await this.ctx.storage.put("state", state);
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const state = await this.state();
    if (request.method === "GET" && path === "/status") {
      return Response.json(state);
    }
    if (request.method !== "POST") {
      return Response.json({ error: "method not allowed" }, { status: 405 });
    }
    const body = await request.json<Record<string, unknown>>();
    if (path === "/reserve") {
      const maxPages = Math.max(1, Math.min(20, Number(body.maxPages) || 4));
      const maxBrowserMs = Math.max(60_000, Math.min(600_000, Number(body.maxBrowserMs) || 480_000));
      const requestKey = String(body.requestKey || "").slice(0, 128);
      if (!requestKey) {
        return Response.json({ error: "requestKey is required" }, { status: 400 });
      }
      const requestStorageKey = `request:${state.day}:${requestKey}`;
      const existingToken = await this.ctx.storage.get<string>(requestStorageKey);
      if (existingToken) {
        const recorded = await this.ctx.storage.get<boolean>(`record:${existingToken}`);
        return Response.json({
          accepted: !recorded,
          token: recorded ? undefined : existingToken,
          reason: recorded ? "already_recorded" : "existing_reservation",
          state,
        });
      }
      if (state.reserved >= maxPages || state.browserMs >= maxBrowserMs) {
        return Response.json({
          accepted: false,
          reason: state.reserved >= maxPages ? "daily_page_cap" : "daily_browser_ms_cap",
          state,
        });
      }
      state.reserved++;
      const token = `${state.day}:${state.reserved}:${crypto.randomUUID()}`;
      await this.ctx.storage.put({
        [requestStorageKey]: token,
        [`reservation:${token}`]: true,
        state,
      });
      return Response.json({ accepted: true, token, state });
    }
    if (path === "/record") {
      const result = body as unknown as BrowserShadowResultSummary;
      const recordKey = `record:${String(result.token || "").slice(0, 128)}`;
      if (!result.token) return Response.json({ error: "token is required" }, { status: 400 });
      if (!result.token.startsWith(`${state.day}:`)) {
        return Response.json({ error: "stale reservation token", state }, { status: 409 });
      }
      if (!(await this.ctx.storage.get<boolean>(`reservation:${result.token}`))) {
        return Response.json({ error: "unknown reservation token", state }, { status: 409 });
      }
      if (!(await this.ctx.storage.get<boolean>(recordKey))) {
        await this.ctx.storage.put(recordKey, true);
        state.completed++;
        state.browserMs += Math.max(0, Number(result.browserMs) || 0);
        if (result.usable) state.successes++;
        else state.failed++;
        state.lastResult = {
          ...result,
          error: result.error?.slice(0, 300),
        };
        await this.save(state);
      }
      return Response.json(state);
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }
}
