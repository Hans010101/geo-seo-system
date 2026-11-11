import { expect, it } from "vitest";
import { dateRangePeriod, geoReportKey, monthlyPeriodOf, parsePeriod, reportPeriodDates, weeklyPeriodOf } from "../../shared/report-period";

it("uses Beijing Friday–Thursday weeks and validates custom ranges without changing calendar months", () => {
  const friday = Date.parse("2026-10-02T00:00:00+08:00");
  const current = weeklyPeriodOf(friday);
  expect(reportPeriodDates(current)).toEqual({ startDate: "2026-10-02", endDate: "2026-10-08" });
  expect(current.startMs).toBe(Date.parse("2026-10-01T16:00:00Z"));
  expect(current.endMs).toBe(Date.parse("2026-10-08T16:00:00Z"));
  expect(weeklyPeriodOf(current.endMs - 1)).toEqual(current);
  expect(weeklyPeriodOf(current.endMs).reportPeriod).toBe("2026-10-09 ~ 2026-10-15");
  expect(weeklyPeriodOf(friday - 1).reportPeriod).toBe("2026-09-25 ~ 2026-10-01");
  expect(weeklyPeriodOf(Date.parse("2027-01-01T00:00:00+08:00") - 1).reportPeriod).toBe("2026-12-25 ~ 2026-12-31");
  expect(parsePeriod("weekly", "2026-W34").reportPeriod).toBe("2026-08-21 ~ 2026-08-27");
  expect(parsePeriod("weekly", current.reportPeriod)).toEqual(current);
  expect(() => parsePeriod("weekly", "2026-W00")).toThrow();
  expect(() => parsePeriod("weekly", "2025-W53")).toThrow();
  const oneDay = dateRangePeriod({ startDate: "2024-02-29", endDate: "2024-02-29" });
  expect(oneDay.endMs - oneDay.startMs).toBe(86_400_000);
  expect(geoReportKey(current)).toBe("2026100220261008");
  expect(geoReportKey(dateRangePeriod({ startDate: "2026-10-02", endDate: "2026-10-09" }))).not.toBe(geoReportKey(current));
  expect(() => dateRangePeriod({ startDate: "2026-10-02", endDate: "2026-10-01" })).toThrow();
  expect(() => dateRangePeriod({ startDate: "2026-02-29", endDate: "2026-03-01" })).toThrow();
  const month = monthlyPeriodOf(friday);
  expect(month.reportPeriod).toBe("2026-10");
  expect(month.startMs).toBe(Date.parse("2026-10-01T00:00:00+08:00"));
  expect(month.endMs).toBe(Date.parse("2026-11-01T00:00:00+08:00"));
});

it("labels stored periods as weekly, monthly or custom", async () => {
  const { reportKindLabel } = await import("../../shared/report-period");
  expect(reportKindLabel("monthly", "2026-11")).toBe("月报");
  expect(reportKindLabel("weekly", "2026-11")).toBe("月报"); // GEO 月报 has no type column
  expect(geoReportKey(monthlyPeriodOf(Date.parse("2026-11-11T12:00:00+08:00")))).toBe("202611");
  expect(reportKindLabel("weekly", "2026-10-30 ~ 2026-11-05")).toBe("周报");
  expect(reportKindLabel("weekly", "2026-W40")).toBe("周报");
  expect(reportKindLabel("weekly", "2026-10-01 ~ 2026-10-31")).toBe("自定义");
  expect(reportKindLabel("weekly", "2026-10-01 ~ 2026-10-07")).toBe("自定义"); // 7 days, but starts on Thursday
});

it("compares a running period with the same elapsed stretch of the previous one", async () => {
  const { comparisonWindow } = await import("../../shared/report-period");
  const day = (d: string) => Date.parse(`${d}T00:00:00+08:00`);
  const nov = monthlyPeriodOf(day("2026-11-05"));
  const running = comparisonWindow(nov, Date.parse("2026-11-05T15:05:16+08:00"));
  expect(running.partial).toBe(true);
  expect(running.prevStartMs).toBe(day("2026-10-01"));
  expect(running.prevEndMs - running.prevStartMs).toBe(running.curEndMs - nov.startMs);

  const october = monthlyPeriodOf(day("2026-10-15"));
  const complete = comparisonWindow(october, day("2026-11-01") + 3 * 3_600_000);
  expect(complete.partial).toBe(false);
  expect(complete.prevStartMs).toBe(day("2026-09-01"));
  expect(complete.prevEndMs).toBe(day("2026-10-01"));

  const week = weeklyPeriodOf(day("2026-10-30"));
  const weekly = comparisonWindow(week, week.endMs + 1);
  expect([weekly.prevStartMs, weekly.prevEndMs]).toEqual([day("2026-10-23"), day("2026-10-30")]);
});
