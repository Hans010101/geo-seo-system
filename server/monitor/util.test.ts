import { describe, expect, it } from "vitest";
import {
  MONITOR_RETENTION_DAYS,
  monitorContentHash,
  monitorPublishedAtFreshness,
  parseSerperDate,
} from "./util";

describe("monitor freshness", () => {
  const now = Date.UTC(2026, 7, 4, 4, 0, 0);

  it("accepts only verifiable publication dates inside seven days", () => {
    expect(monitorPublishedAtFreshness(now - 7 * 86_400_000, now)).toBe("fresh");
    expect(monitorPublishedAtFreshness(now - 7 * 86_400_000 - 1, now)).toBe("stale");
    expect(monitorPublishedAtFreshness(null, now)).toBe("missing");
    expect(monitorPublishedAtFreshness(now + 86_400_000 + 1, now)).toBe("future");
  });

  it("retains verified monitor records for one hundred days", () => {
    expect(MONITOR_RETENTION_DAYS).toBe(100);
  });

  it("parses English and Chinese relative source timestamps", () => {
    expect(parseSerperDate("3 hours ago", now)).toBe(now - 3 * 3_600_000);
    expect(parseSerperDate("2天前", now)).toBe(now - 2 * 86_400_000);
    expect(parseSerperDate("刚刚", now)).toBe(now);
  });

  it("produces the same duplicate fingerprint for harmless text differences", () => {
    expect(monitorContentHash("TRON  Weekly\nReport")).toBe(
      monitorContentHash("tron weekly report"),
    );
    expect(monitorContentHash("ＴＲＯＮ")).toBe(monitorContentHash("tron"));
  });
});
