import { useRole } from "@/hooks/useRole";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useState } from "react";
import { ReportDateRange } from "@/components/ReportDateRange";
import {
  reportDateRangeSchema,
  reportKindLabel,
  reportPeriodDates,
  weeklyPeriodOf,
} from "@shared/report-period";
import { FileBarChart, Download, RefreshCw, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  PLATFORM_LABELS,
  SEVERITY_LABELS,
  SEVERITY_COLORS,
  type Platform,
} from "@shared/geo-types";

export default function WeeklyReports() {
  const { canEdit } = useRole();
  // ?week= lets the report center deep-link straight to one report.
  const [selectedWeek, setSelectedWeek] = useState<string>(
    () => new URLSearchParams(window.location.search).get("week") ?? ""
  );
  const [dateRange, setDateRange] = useState(() =>
    reportPeriodDates(weeklyPeriodOf(Date.now()))
  );
  const utils = trpc.useUtils();
  const { data: reportsList, isLoading } = trpc.weeklyReports.list.useQuery({
    limit: 36,
  });
  const activeWeek = selectedWeek || reportsList?.[0]?.reportWeek || "";
  const { data: reportDetail, isLoading: detailLoading } =
    trpc.weeklyReports.get.useQuery(
      { reportWeek: activeWeek },
      { enabled: !!activeWeek }
    );

  const generateMutation = trpc.weeklyReports.generate.useMutation({
    onSuccess: result => {
      toast.success(`已生成 ${result.reportPeriod}`);
      utils.weeklyReports.list.invalidate();
      utils.weeklyReports.get.invalidate({ reportWeek: result.reportWeek });
      setSelectedWeek(result.reportWeek);
    },
    onError: err => {
      console.error("GEO report generation failed", err);
      toast.error("报告生成失败，请稍后重试");
    },
  });
  const pendingType = generateMutation.isPending
    ? (generateMutation.variables?.reportType ?? "weekly")
    : null;
  const kind = reportDetail
    ? reportKindLabel(
        "weekly",
        reportDetail.reportPeriod || reportDetail.reportWeek
      )
    : "周报";

  const handleExportJSON = () => {
    if (!reportDetail) return;
    const blob = new Blob([JSON.stringify(reportDetail, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `geo-report-${activeWeek}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportCSV = () => {
    if (!reportDetail) return;
    const summary = reportDetail.summaryMetrics as any;
    const platforms = (reportDetail.platformBreakdown as any[]) || [];

    let csv = `报告周期,${reportDetail.reportPeriod}\n指标,数值${summary?.previous ? ",上月同期" : ""}\n`;
    if (summary) {
      const prev = summary.previous;
      const row = (label: string, key: string, unit = "") =>
        `${label},${summary[key] ?? ""}${unit}${prev ? `,${prev[key] ?? ""}${unit}` : ""}\n`;
      csv += row("情感均值", "overallSentimentAvg");
      csv += row("友好来源率", "friendlySourceRate", "%");
      csv += row("事实覆盖率", "targetFactsCoverage", "%");
      csv += row("引用命中率", "ourContentRate", "%");
      csv += row("预警数", "alertCount");
      csv += row("采集数", "totalCollections");
      csv += "\n平台,情感均值,采集数,引用均值\n";
      platforms.forEach((p: any) => {
        csv += `${PLATFORM_LABELS[p.platform as Platform] || p.platform},${p.sentimentAvg},${p.collectionCount},${p.citationCountAvg}\n`;
      });
    }

    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `geo-report-${activeWeek}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <FileBarChart className="h-6 w-6 text-primary" />
            <h1 className="text-2xl font-bold tracking-tight">GEO 报告</h1>
          </div>
          <p className="text-muted-foreground text-sm mt-1">
            GEO 监测周报/月报：模型表现、事实覆盖、引用与预警（月报附上月环比）
          </p>
        </div>
        {canEdit && (
          <div className="flex items-center gap-3 flex-wrap">
            <Button
              size="sm"
              variant="outline"
              disabled={
                generateMutation.isPending ||
                !reportDateRangeSchema.safeParse(dateRange).success
              }
              onClick={() => generateMutation.mutate({ dateRange })}
            >
              {pendingType === "weekly" ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5 mr-1" />
              )}
              生成所选周期周报
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={generateMutation.isPending}
              onClick={() => generateMutation.mutate({ reportType: "monthly" })}
            >
              {pendingType === "monthly" ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5 mr-1" />
              )}
              生成本月月报
            </Button>
          </div>
        )}
      </div>

      {canEdit && (
        <ReportDateRange
          value={dateRange}
          onChange={setDateRange}
          disabled={generateMutation.isPending}
        />
      )}

      <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
        <Card className="h-fit">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">报告列表</CardTitle>
          </CardHeader>
          <CardContent className="p-2 pt-0">
            {isLoading ? (
              <div className="space-y-2 p-2">
                {[0, 1, 2].map(i => (
                  <Skeleton key={i} className="h-9 w-full" />
                ))}
              </div>
            ) : !reportsList || reportsList.length === 0 ? (
              <p className="text-sm text-muted-foreground p-3">
                暂无报告{canEdit ? "，点右上角生成" : ""}
              </p>
            ) : (
              <div className="space-y-1">
                {reportsList.map(r => {
                  const label = reportKindLabel(
                    "weekly",
                    r.reportPeriod || r.reportWeek
                  );
                  return (
                    <button
                      key={r.reportWeek}
                      type="button"
                      onClick={() => setSelectedWeek(r.reportWeek)}
                      className={`w-full text-left rounded-md px-3 py-2 text-sm hover:bg-muted/60 ${r.reportWeek === activeWeek ? "bg-muted font-medium" : ""}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span>{r.reportPeriod || r.reportWeek}</span>
                        <Badge
                          variant={label === "月报" ? "outline" : "secondary"}
                          className="text-[10px]"
                        >
                          {label}
                        </Badge>
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        {r.generatedAt
                          ? `生成于 ${new Date(r.generatedAt).toLocaleString("zh-CN", { hour12: false })}`
                          : ""}
                      </p>
                    </button>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4 min-w-0">
          {(!activeWeek || detailLoading || !reportDetail) && (
            <Card>
              <CardContent className="py-12 text-center">
                {activeWeek && detailLoading ? (
                  <Loader2 className="h-5 w-5 animate-spin inline text-muted-foreground" />
                ) : (
                  <>
                    <FileBarChart className="h-12 w-12 mx-auto text-muted-foreground/30 mb-4" />
                    <h3 className="text-lg font-medium mb-2">暂无报告</h3>
                    <p className="text-sm text-muted-foreground">
                      选择起止日期后生成周报，或点击「生成本月月报」
                    </p>
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {activeWeek && reportDetail && (
            <div className="space-y-4">
              {/* Summary */}
              <Card>
                <CardHeader className="pb-3 flex-row flex-wrap items-start justify-between gap-3 space-y-0">
                  <div>
                    <CardTitle className="text-base font-semibold">
                      GEO {kind}总览
                    </CardTitle>
                    <p className="text-xs text-muted-foreground mt-1">
                      {reportDetail.reportPeriod}
                      {(reportDetail.summaryMetrics as any)?.previousPeriod
                        ? `　环比：${(reportDetail.summaryMetrics as any).previousPeriod}`
                        : ""}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleExportJSON}
                    >
                      <Download className="h-3.5 w-3.5 mr-1.5" />
                      JSON
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleExportCSV}
                    >
                      <Download className="h-3.5 w-3.5 mr-1.5" />
                      CSV
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  {(() => {
                    const summary = reportDetail.summaryMetrics as any;
                    if (!summary)
                      return (
                        <p className="text-sm text-muted-foreground">无数据</p>
                      );
                    const prev = summary.previous;
                    return (
                      <div className="grid grid-cols-3 xl:grid-cols-6 gap-3">
                        <MetricCard
                          label="情感均值"
                          value={summary.overallSentimentAvg?.toFixed(1) || "—"}
                          delta={delta(
                            summary,
                            prev,
                            "overallSentimentAvg",
                            "",
                            1
                          )}
                        />
                        <MetricCard
                          label="友好来源率"
                          value={`${summary.friendlySourceRate || 0}%`}
                          delta={delta(
                            summary,
                            prev,
                            "friendlySourceRate",
                            "%"
                          )}
                        />
                        <MetricCard
                          label="事实覆盖率"
                          value={`${summary.targetFactsCoverage || 0}%`}
                          delta={delta(
                            summary,
                            prev,
                            "targetFactsCoverage",
                            "%"
                          )}
                        />
                        <MetricCard
                          label="引用命中率"
                          value={`${summary.ourContentRate || 0}%`}
                          delta={delta(summary, prev, "ourContentRate", "%")}
                        />
                        <MetricCard
                          label="预警数"
                          value={summary.alertCount?.toString() || "0"}
                          delta={delta(summary, prev, "alertCount", "")}
                          lowerIsBetter
                        />
                        <MetricCard
                          label="采集数"
                          value={summary.totalCollections?.toString() || "0"}
                          delta={delta(summary, prev, "totalCollections", "")}
                        />
                      </div>
                    );
                  })()}
                </CardContent>
              </Card>

              {/* Platform breakdown */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base font-semibold">
                    各平台数据
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {(() => {
                    const platforms =
                      (reportDetail.platformBreakdown as any[]) || [];
                    if (platforms.length === 0)
                      return (
                        <p className="text-sm text-muted-foreground">无数据</p>
                      );
                    return (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b">
                              <th className="text-left p-2 font-medium">
                                平台
                              </th>
                              <th className="text-center p-2 font-medium">
                                情感均值
                              </th>
                              <th className="text-center p-2 font-medium">
                                采集数
                              </th>
                              <th className="text-center p-2 font-medium">
                                引用均值
                              </th>
                              <th className="text-left p-2 font-medium">
                                Top域名
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {platforms.map((p: any) => (
                              <tr
                                key={p.platform}
                                className="border-b border-border/50"
                              >
                                <td className="p-2 font-medium">
                                  {PLATFORM_LABELS[p.platform as Platform] ||
                                    p.platform}
                                </td>
                                <td className="p-2 text-center">
                                  {p.sentimentAvg?.toFixed(1) || "—"}
                                </td>
                                <td className="p-2 text-center">
                                  {p.collectionCount}
                                </td>
                                <td className="p-2 text-center">
                                  {p.citationCountAvg?.toFixed(1) || "—"}
                                </td>
                                <td className="p-2 text-xs text-muted-foreground">
                                  {p.topDomains
                                    ?.map((d: any) => d.domain)
                                    .join(", ") || "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    );
                  })()}
                </CardContent>
              </Card>

              {/* Alerts summary */}
              {(() => {
                const alertsSummary =
                  (reportDetail.alertsSummary as any[]) || [];
                if (alertsSummary.length === 0) return null;
                return (
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base font-semibold">
                        本期预警
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-2">
                        {alertsSummary.map((alert: any, i: number) => (
                          <div
                            key={i}
                            className="flex items-center gap-3 rounded-lg border p-3"
                          >
                            <div
                              className="h-2 w-2 rounded-full shrink-0"
                              style={{
                                backgroundColor:
                                  SEVERITY_COLORS[alert.severity] || "#6b7280",
                              }}
                            />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium">
                                {alert.title}
                              </p>
                              {alert.description && (
                                <p className="text-xs text-muted-foreground mt-0.5">
                                  {alert.description}
                                </p>
                              )}
                            </div>
                            <Badge
                              variant="outline"
                              style={{
                                color: SEVERITY_COLORS[alert.severity],
                                borderColor: SEVERITY_COLORS[alert.severity],
                              }}
                            >
                              {SEVERITY_LABELS[alert.severity]}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                );
              })()}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

type Delta = { text: string; sign: number } | null;
// Month-over-month change of one summary metric; rates are compared in percentage points.
function delta(
  cur: any,
  prev: any,
  key: string,
  unit: string,
  digits = 0
): Delta {
  if (
    !prev ||
    !prev.totalCollections ||
    cur?.[key] == null ||
    prev[key] == null
  )
    return null;
  const d = Number(cur[key]) - Number(prev[key]);
  if (!Number.isFinite(d)) return null;
  const v = Math.abs(d).toFixed(digits);
  return {
    text: d === 0 ? "持平" : `${d > 0 ? "+" : "-"}${v}${unit}`,
    sign: Math.sign(d),
  };
}

function MetricCard({
  label,
  value,
  delta,
  lowerIsBetter,
}: {
  label: string;
  value: string;
  delta?: Delta;
  lowerIsBetter?: boolean;
}) {
  const good = delta && delta.sign !== 0 && delta.sign > 0 !== !!lowerIsBetter;
  return (
    <div className="rounded-lg border p-3 text-center">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className="text-xl font-bold">{value}</p>
      {delta && (
        <p
          className={`text-[11px] mt-1 ${delta.sign === 0 ? "text-muted-foreground" : good ? "text-emerald-600" : "text-red-600"}`}
        >
          环比 {delta.text}
        </p>
      )}
    </div>
  );
}
