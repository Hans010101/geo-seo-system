import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowRight, BarChart3, ClipboardList, FileSpreadsheet, FileText } from "lucide-react";

function dateTime(value?: number | Date | string | null) {
  if (!value) return "暂无生成时间";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export default function ReportsCenter() {
  const { data: sentimentReports } = trpc.monitor.listReports.useQuery({ limit: 5 });
  const { data: geoReports } = trpc.weeklyReports.list.useQuery({ limit: 5 });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">报告中心</h1>
        <p className="mt-1 text-sm text-muted-foreground">统一查看舆情周报/月报与 GEO 周报；导出功能保留在各报告详情页。</p>
      </header>

      <section className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div className="flex items-center gap-3"><div className="rounded-lg bg-primary/10 p-2 text-primary"><ClipboardList className="h-5 w-5" /></div><div><CardTitle className="text-base">舆情报告</CardTitle><p className="mt-1 text-xs text-muted-foreground">趋势、信源、威胁、成本与 GEO 穿透</p></div></div>
            <Button variant="outline" size="sm" asChild><Link href="/sentiment-monitor/reports">打开 <ArrowRight className="ml-1 h-3.5 w-3.5" /></Link></Button>
          </CardHeader>
          <CardContent>
            <div className="mb-4 flex gap-2"><Badge variant="secondary" className="gap-1 font-normal"><FileSpreadsheet className="h-3 w-3" />Excel</Badge><Badge variant="secondary" className="gap-1 font-normal"><FileText className="h-3 w-3" />PDF</Badge></div>
            <div className="divide-y">{sentimentReports?.length ? sentimentReports.map(report => <div key={report.id} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"><div><p className="text-sm font-medium">{report.reportPeriod}</p><p className="mt-1 text-xs text-muted-foreground">{dateTime(report.generatedAt)}</p></div><Badge variant="outline">{report.reportType === "weekly" ? "周报" : "月报"}</Badge></div>) : <Empty />}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div className="flex items-center gap-3"><div className="rounded-lg bg-primary/10 p-2 text-primary"><BarChart3 className="h-5 w-5" /></div><div><CardTitle className="text-base">GEO 报告</CardTitle><p className="mt-1 text-xs text-muted-foreground">模型表现、事实覆盖、引用与预警</p></div></div>
            <Button variant="outline" size="sm" asChild><Link href="/reports">打开 <ArrowRight className="ml-1 h-3.5 w-3.5" /></Link></Button>
          </CardHeader>
          <CardContent>
            <div className="mb-4 flex gap-2"><Badge variant="secondary" className="font-normal">CSV</Badge><Badge variant="secondary" className="font-normal">JSON</Badge></div>
            <div className="divide-y">{geoReports?.length ? geoReports.map(report => <div key={report.reportWeek} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"><div><p className="text-sm font-medium">{report.reportWeek}</p><p className="mt-1 text-xs text-muted-foreground">{report.reportPeriod || dateTime(report.generatedAt)}</p></div><Badge variant="outline">周报</Badge></div>) : <Empty />}</div>
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardContent className="grid gap-5 p-5 md:grid-cols-3">
          <ReportRule title="面向决策" text="首页先呈现异常、变化和待办，报告保留完整证据。" />
          <ReportRule title="双域分离" text="舆情报告与 GEO 报告独立生成，避免指标混淆。" />
          <ReportRule title="可继续追溯" text="从报告返回原始文章、信源或模型回答完成复核。" />
        </CardContent>
      </Card>
    </div>
  );
}

function Empty() { return <p className="py-8 text-center text-sm text-muted-foreground">暂无报告</p>; }
function ReportRule({ title, text }: { title: string; text: string }) { return <div><p className="text-sm font-medium">{title}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{text}</p></div>; }
