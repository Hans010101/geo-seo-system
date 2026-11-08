import { beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "../server/db";
import { reserveQueuedBudget } from "../server/monitor/budget";
import { processMonitorQueue, type QueueEnv, type QueueTask } from "./monitor-queue";

vi.mock("../server/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("../server/db")>(),
  getSchedulerConfig: vi.fn(),
  listMonitorKeywords: vi.fn(async () => [{ keyword: "孙宇晨", priority: 10 }]),
  setSysConfig: vi.fn(),
  withHyperdriveDatabase: (_binding: unknown, work: () => unknown) => work(),
}));
vi.mock("../server/monitor/budget", async (importOriginal) => ({
  ...await importOriginal<typeof import("../server/monitor/budget")>(),
  reserveQueuedBudget: vi.fn(async (requested: { firecrawl: number; serper: number }) => ({
    ...requested, xAvailable: true,
  })),
}));

async function runAt(hour: number, options: {
  minute?: number; forceGate?: boolean; news?: boolean; fallbackOnly?: boolean;
} = {}) {
  const sendBatch = vi.fn(async (_items: Array<{ body: QueueTask }>) => undefined);
  const start = vi.fn(async (_url: string, init: RequestInit) => Response.json({
    ...JSON.parse(String(init.body)), status: "running", startedAt: Date.now(),
  }));
  const env = {
    HYPERDRIVE: {},
    MONITOR_QUEUE: { sendBatch },
    MONITOR_COORDINATOR: { idFromName: (name: string) => name, get: () => ({ fetch: start }) },
    CLOUDFLARE_WECHAT_ENABLED: "false",
    CLOUDFLARE_GATE_FIRECRAWL_ENABLED: options.fallbackOnly ? "false" : "true",
  } as unknown as QueueEnv;
  const ack = vi.fn(), retry = vi.fn();
  const body: QueueTask = {
    kind: "bootstrap", cycleId: "gate-schedule-test",
    profile: options.news ? "monitor_primary_news" : "monitor_primary_social",
    scheduledTime: Date.UTC(2026, 9, 15, hour - 8, options.minute ?? 40),
    forceGate: options.forceGate,
  };
  await processMonitorQueue({ messages: [{ body, ack, retry }] } as unknown as MessageBatch<QueueTask>, env);
  expect(ack).toHaveBeenCalledOnce();
  expect(retry).not.toHaveBeenCalled();
  const tasks = (sendBatch.mock.calls[0]?.[0] ?? []).map((item: { body: QueueTask }) => item.body);
  const sources = start.mock.calls[0] ? JSON.parse(String(start.mock.calls[0][1].body)).sources : [];
  return { tasks, sources };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.getSchedulerConfig).mockResolvedValue({ monitorEnabled: true } as Awaited<ReturnType<typeof db.getSchedulerConfig>>);
});

describe("Gate automatic collection every 12 hours", () => {
  it("keeps free news discovery scheduled when the Serper allowance is exhausted", async () => {
    vi.mocked(reserveQueuedBudget).mockResolvedValueOnce({firecrawl:0, serper:0, xAvailable:true});
    const { tasks } = await runAt(9, {news:true});
    expect(tasks).toContainEqual(expect.objectContaining({sourceName:"serper",budgetReserved:false}));
  });
  it.each([1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23])("dispatches and reserves budget correctly at Beijing %i:40", async (hour) => {
    const { tasks, sources } = await runAt(hour);
    const due = hour === 9 || hour === 21;
    expect(tasks.filter((t) => t.kind === "discovery" && t.sourceName === "gate_square")).toHaveLength(due ? 2 : 0);
    expect(sources.includes("gate_square")).toBe(due);
    expect(reserveQueuedBudget).toHaveBeenCalledWith({ firecrawl: due ? 2 : 0, serper: 0 });
    expect(tasks.filter((t) => t.kind === "discovery" && t.sourceName === "telegram")).toHaveLength(6);
    expect(tasks.filter((t) => t.kind === "discovery" && t.sourceName === "x")).toHaveLength(1);
  });

  it("does not run early, but preserves explicitly requested manual collection", async () => {
    expect((await runAt(9, { minute: 39 })).sources).not.toContain("gate_square");
    expect((await runAt(10, { minute: 0, forceGate: true })).sources).toContain("gate_square");
    expect(reserveQueuedBudget).toHaveBeenLastCalledWith({ firecrawl: 2, serper: 0 });
  });

  it("applies the cadence to fallback discovery without reserving Firecrawl", async () => {
    expect((await runAt(7, { fallbackOnly: true })).sources).not.toContain("gate_square");
    const { tasks } = await runAt(9, { fallbackOnly: true });
    expect(tasks.filter((t) => t.kind === "discovery" && t.sourceName === "gate_square")).toEqual([
      expect.objectContaining({ fallbackOnly: true }),
    ]);
    expect(reserveQueuedBudget).toHaveBeenLastCalledWith({ firecrawl: 0, serper: 0 });
  });

  it("keeps news collection and the global pause unchanged", async () => {
    expect((await runAt(9, { news: true, forceGate: true })).sources).toEqual(["serper", "rss"]);
    expect(reserveQueuedBudget).toHaveBeenLastCalledWith({ firecrawl: 0, serper: 1 });
    vi.mocked(db.getSchedulerConfig).mockResolvedValue(null);
    vi.mocked(reserveQueuedBudget).mockClear();
    expect((await runAt(9)).tasks).toEqual([]);
    expect(reserveQueuedBudget).not.toHaveBeenCalled();
  });
});
