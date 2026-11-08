import { z } from "zod";

const TZ_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;

export type ReportType = "weekly" | "monthly";
export interface ReportPeriod {
  reportType: ReportType;
  reportPeriod: string;
  startMs: number; // inclusive, Beijing midnight
  endMs: number; // exclusive
}

export const reportDateRangeSchema = z.object({
  startDate: z.iso.date(),
  endDate: z.iso.date(),
}).refine(v => v.startDate <= v.endDate, {
  message: "结束日期不能早于开始日期",
  path: ["endDate"],
});
export type ReportDateRange = z.infer<typeof reportDateRangeSchema>;

export const formatReportDate = (ms: number) => new Date(ms + TZ_MS).toISOString().slice(0, 10);
export const reportPeriodDates = (p: ReportPeriod): ReportDateRange => ({
  startDate: formatReportDate(p.startMs),
  endDate: formatReportDate(p.endMs - 1),
});

export function dateRangePeriod(range: ReportDateRange): ReportPeriod {
  const { startDate, endDate } = reportDateRangeSchema.parse(range);
  return {
    reportType: "weekly",
    reportPeriod: `${startDate} ~ ${endDate}`,
    startMs: Date.parse(`${startDate}T00:00:00+08:00`),
    endMs: Date.parse(`${endDate}T00:00:00+08:00`) + DAY_MS,
  };
}

// A reporting week runs from Friday 00:00 through Thursday 23:59:59.999 in Beijing.
export function weeklyPeriodOf(refMs: number): ReportPeriod {
  const d = new Date(refMs + TZ_MS);
  const daysSinceFriday = (d.getUTCDay() + 2) % 7;
  const startMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceFriday) - TZ_MS;
  return dateRangePeriod({
    startDate: formatReportDate(startMs),
    endDate: formatReportDate(startMs + 6 * DAY_MS),
  });
}

export function monthlyPeriodOf(refMs: number): ReportPeriod {
  const d = new Date(refMs + TZ_MS);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return {
    reportType: "monthly",
    reportPeriod: `${y}-${String(m + 1).padStart(2, "0")}`,
    startMs: Date.UTC(y, m, 1) - TZ_MS,
    endMs: Date.UTC(y, m + 1, 1) - TZ_MS,
  };
}

export function parsePeriod(reportType: ReportType, period: string): ReportPeriod {
  if (reportType === "monthly") {
    const m = period.match(/^(\d{4})-(\d{2})$/);
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new Error("月报周期格式应为 YYYY-MM");
    return monthlyPeriodOf(Date.parse(`${period}-15T00:00:00+08:00`));
  }
  const dates = period.match(/^(\d{4}-\d{2}-\d{2}) ~ (\d{4}-\d{2}-\d{2})$/);
  if (dates) return dateRangePeriod({ startDate: dates[1], endDate: dates[2] });

  // Legacy ISO labels still accepted: use that ISO week's Friday as the new start.
  const m = period.match(/^(\d{4})-W(\d{1,2})$/i);
  if (!m) throw new Error("周报周期格式应为起止日期或 YYYY-Wnn");
  const year = Number(m[1]);
  const week = Number(m[2]);
  const jan4 = Date.UTC(year, 0, 4);
  const monday = jan4 - (new Date(jan4).getUTCDay() + 6) % 7 * DAY_MS + (week - 1) * 7 * DAY_MS;
  const thursday = new Date(monday + 3 * DAY_MS);
  const isoWeek = Math.ceil(((thursday.getTime() - Date.UTC(thursday.getUTCFullYear(), 0, 1)) / DAY_MS + 1) / 7);
  if (thursday.getUTCFullYear() !== year || isoWeek !== week) throw new Error(`无效的周报周期: ${period}`);
  return weeklyPeriodOf(monday + 4 * DAY_MS - TZ_MS);
}

// Fits the existing 16-character GEO report key and keeps different date ranges separate.
export const geoReportKey = (p: ReportPeriod) => p.reportPeriod.replace(/\D/g, "");
