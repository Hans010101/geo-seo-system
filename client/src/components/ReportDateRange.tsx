import { useId } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  reportDateRangeSchema,
  reportPeriodDates,
  weeklyPeriodOf,
  type ReportDateRange as DateRange,
} from "@shared/report-period";

export function ReportDateRange({ value, onChange, disabled }: {
  value: DateRange;
  onChange: (value: DateRange) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const valid = reportDateRangeSchema.safeParse(value).success;
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-end gap-3">
        <label htmlFor={`${id}-start`} className="space-y-1 text-xs">
          <span>周报开始日期</span>
          <Input id={`${id}-start`} type="date" className="w-40" value={value.startDate}
            disabled={disabled} onChange={e => onChange({ ...value, startDate: e.target.value })} />
        </label>
        <label htmlFor={`${id}-end`} className="space-y-1 text-xs">
          <span>周报结束日期</span>
          <Input id={`${id}-end`} type="date" className="w-40" value={value.endDate}
            disabled={disabled} onChange={e => onChange({ ...value, endDate: e.target.value })} />
        </label>
        <Button variant="outline" size="sm" disabled={disabled}
          onClick={() => onChange(reportPeriodDates(weeklyPeriodOf(Date.now())))}>本周期</Button>
        <Button variant="outline" size="sm" disabled={disabled}
          onClick={() => onChange(reportPeriodDates(weeklyPeriodOf(weeklyPeriodOf(Date.now()).startMs - 1)))}>上一周期</Button>
      </div>
      <p className="text-xs text-muted-foreground">默认周五至次周周四，按北京时间统计，包含结束日期全天；可临时调整。</p>
      {!valid && <p role="alert" className="text-xs text-destructive">请选择有效日期，结束日期不能早于开始日期。</p>}
    </div>
  );
}
