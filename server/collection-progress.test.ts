// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBatchPoller } from "../client/src/hooks/useBatchPoller";

const query = vi.hoisted(() => ({ data: undefined as any, error: null as any, options: {} as any, dataUpdatedAt: 0 }));
vi.mock("../client/src/lib/trpc", () => ({ trpc: { collections: { batchProgress: {
  useQuery: (_input: unknown, options: unknown) => {
    query.options = options;
    return query;
  },
} } } }));

describe("batch progress is independent from execution", () => {
  let root: Root;
  let poller: ReturnType<typeof useBatchPoller>;
  const fetchMock = vi.fn();
  function Probe() { poller = useBatchPoller(); return null; }
  const render = async () => { await act(async () => root.render(createElement(Probe))); };
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset().mockImplementation(() => new Promise(() => {}));
    query.data = undefined; query.error = null;
    query.dataUpdatedAt = Date.now();
    root = createRoot(document.createElement("div"));
    await render();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers(); vi.unstubAllGlobals();
  });

  it("updates cumulative totals while execution is still unresolved", async () => {
    await act(async () => poller.start("existing-batch", 341));
    expect(query.options.refetchInterval).toBe(3000);
    expect(query.options.refetchIntervalInBackground).toBe(true);
    query.data = { total: 341, completed: 146, failed: 0, pending: 195 };
    await render();
    expect(poller).toMatchObject({ done: 146, failed: 0, pct: 43, isRunning: true });
    query.data = { total: 341, completed: 150, failed: 1, pending: 190 };
    await render();
    expect(poller).toMatchObject({ done: 150, failed: 1, total: 341 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("restores read-only observation without triggering collection", async () => {
    await act(async () => poller.start("existing-batch", 0, false));
    query.data = { total: 341, completed: 146, failed: 0, pending: 195 };
    await render();
    expect(poller.total).toBe(341);
    expect(fetchMock).not.toHaveBeenCalled();
    query.error = new Error("Network failure");
    await render();
    expect(poller).toMatchObject({ done: 146, isRunning: true, syncError: true });
  });

  it("counts terminal timeouts and completes only from authoritative progress", async () => {
    await act(async () => poller.start("existing-batch", 9, false));
    query.data = { total: 9, completed: 7, failed: 1, pending: 0 };
    await render();
    expect(poller).toMatchObject({ done: 7, failed: 2, pct: 100, isRunning: false });
  });

  it("does not treat an HTTP error as completion", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: { json: { message: "Server error" } } }) });
    await act(async () => poller.start("existing-batch", 341));
    expect(poller.isRunning).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it("ignores late execution responses from a stopped generation", async () => {
    let resolve!: (value: unknown) => void;
    fetchMock.mockImplementation(() => new Promise(r => { resolve = r; }));
    await act(async () => poller.start("old-batch", 341));
    await act(async () => poller.start("new-batch", 10, false));
    await act(async () => resolve({ ok: true, json: async () => ({ result: { data: { json: { remaining: 200 } } } }) }));
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(poller.batchId).toBe("new-batch");
  });

  it("does not finish a restarted batch from stale cached progress", async () => {
    query.data = { total: 9, completed: 9, failed: 0, pending: 0 };
    query.dataUpdatedAt = Date.now() - 1000;
    await act(async () => poller.start("restarted-batch", 9));
    expect(poller).toMatchObject({ done: 0, isRunning: true });
    query.data = { total: 9, completed: 7, failed: 0, pending: 2 };
    query.dataUpdatedAt = Date.now();
    await render();
    expect(poller).toMatchObject({ done: 7, isRunning: true });
  });
});
