import { describe, expect, it } from "vitest";
import { boundedJson } from "./bounded-json";
import {
  buildOutageMessage,
  evaluateOutages,
  markNotified,
  mergeLocalHealth,
  parseSourceHealthState,
  recordDiagnostics,
} from "./source-health";
import type { SourceDiagnostic } from "./source-diagnostic";

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 8, 12, 0);
const diag = (discovered: number, errors: string[] = []): SourceDiagnostic => ({
  status: discovered > 0 ? "success" : "failed",
  discovered,
  enqueued: discovered,
  errors,
  updatedAt: 0,
});

describe("boundedJson", () => {
  it("keeps small values unchanged", () => {
    expect(boundedJson({ a: 1 })).toBe('{"a":1}');
  });

  it("always returns parseable JSON within the limit", () => {
    const big = {
      cycleId: "c1",
      status: "partial_failure",
      sourceDiagnostics: Object.fromEntries(
        Array.from({ length: 12 }, (_, i) => [`s${i}`, { errors: Array(6).fill("x".repeat(500)) }]),
      ),
    };
    for (const limit of [4000, 1500, 200]) {
      const text = boundedJson(big, limit);
      expect(text.length).toBeLessThanOrEqual(limit);
      const parsed = JSON.parse(text);
      expect(parsed.truncated).toBe(true);
      expect(parsed.cycleId).toBe("c1");
    }
  });
});

describe("source health", () => {
  it("seeds history for new sources and alerts a long-silent one at once", () => {
    const state = recordDiagnostics(
      parseSourceHealthState(null),
      { weibo: diag(0, ["weibo/波场: redirected to login"]), x: diag(20) },
      T0,
      { weibo: T0 - 28 * 24 * H, x: T0 - H },
    );
    const { down, due, recovered } = evaluateOutages(state, T0);
    expect(due.map(i => i.name)).toEqual(["weibo"]);
    expect(down[0].silentHours).toBe(28 * 24);
    expect(recovered).toEqual([]);
    const message = buildOutageMessage(down, recovered);
    expect(message.title).toBe("信源断流提醒 · 微博");
    expect(message.content).toContain("已 28 天无内容");
    expect(message.content).toContain("redirected to login");
  });

  it("waits 48 hours before alerting a source with no history", () => {
    let state = recordDiagnostics(parseSourceHealthState(null), { douyin: diag(0) }, T0);
    expect(evaluateOutages(state, T0 + 47 * H).due).toEqual([]);
    state = recordDiagnostics(state, { douyin: diag(0) }, T0 + 48 * H);
    const { due } = evaluateOutages(state, T0 + 48 * H);
    expect(due.map(i => i.name)).toEqual(["douyin"]);
    expect(buildOutageMessage(due, []).content).toContain("开始监测以来从未采到");
  });

  it("does not repeat until the reminder interval, then reports recovery once", () => {
    let state = recordDiagnostics(parseSourceHealthState(null), { weibo: diag(0) }, T0, { weibo: T0 - 72 * H });
    state = markNotified(state, ["weibo"], [], T0);
    state = recordDiagnostics(state, { weibo: diag(0) }, T0 + 2 * H);
    expect(evaluateOutages(state, T0 + 2 * H).due).toEqual([]);
    state = recordDiagnostics(state, { weibo: diag(0) }, T0 + 7 * 24 * H);
    expect(evaluateOutages(state, T0 + 7 * 24 * H).due.map(i => i.name)).toEqual(["weibo"]);

    state = recordDiagnostics(state, { weibo: diag(5) }, T0 + 8 * 24 * H);
    const after = evaluateOutages(state, T0 + 8 * 24 * H);
    expect(after.down).toEqual([]);
    expect(after.recovered.map(i => i.name)).toEqual(["weibo"]);
    expect(buildOutageMessage(after.down, after.recovered).title).toBe("信源已恢复 · 微博");
    state = markNotified(state, [], ["weibo"], T0 + 8 * 24 * H);
    expect(evaluateOutages(state, T0 + 8 * 24 * H).recovered).toEqual([]);
  });

  it("ignores sources that stopped running (switched off, not broken)", () => {
    const state = recordDiagnostics(parseSourceHealthState(null), { wechat: diag(0) }, T0, { wechat: T0 - 90 * 24 * H });
    expect(evaluateOutages(state, T0 + 25 * H).down).toEqual([]);
  });

  it("maps the news Serper source to the 'web' platform when seeding", () => {
    const state = recordDiagnostics(parseSourceHealthState(null), { serper: diag(0) }, T0, { web: T0 - 3 * H });
    expect(state.sources.serper.lastDiscoveredAt).toBe(T0 - 3 * H);
  });

  it("recovers from a corrupt stored state", () => {
    expect(parseSourceHealthState("{not json").sources).toEqual({});
  });
  it("alerts when the Mac collector stops reporting, with a local hint", () => {
    let state = mergeLocalHealth(parseSourceHealthState(null), { weibo: { lastRunAt: T0, lastDiscoveredAt: T0 } }, T0);
    expect(evaluateOutages(state, T0 + 47 * H).down).toEqual([]);
    // No heartbeat for 49 hours (Mac asleep): still judged, unlike a switched-off cloud source.
    state = mergeLocalHealth(state, { weibo: { lastRunAt: T0, lastDiscoveredAt: T0 } }, T0 + 49 * H);
    const { due, down } = evaluateOutages(state, T0 + 49 * H);
    expect(due.map(i => i.name)).toEqual(["local_weibo"]);
    const message = buildOutageMessage(down, []);
    expect(message.title).toBe("信源断流提醒 · 微博（本机采集）");
    expect(message.content).toContain("collector.py login weibo");
    // alertedAt survives the next heartbeat merge
    state = markNotified(state, ["local_weibo"], [], T0 + 49 * H);
    state = mergeLocalHealth(state, { weibo: { lastRunAt: T0 + 50 * H } }, T0 + 50 * H);
    expect(state.sources.local_weibo.alertedAt).toBe(T0 + 49 * H);
  });
});
