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
