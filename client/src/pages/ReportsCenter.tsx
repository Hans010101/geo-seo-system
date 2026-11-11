import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowRight, BarChart3, ClipboardList, FileSpreadsheet, FileText } from "lucide-react";
import { reportKindLabel } from "@shared/report-period";

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
        <p className="mt-1 text-sm text-muted-foreground">统一查看舆情与 GEO 的周报/月报；导出功能保留在各报告详情页。</p>
      </header>

      <section className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div className="flex items-center gap-3"><div className="rounded-lg bg-primary/10 p-2 text-primary"><ClipboardList className="h-5 w-5" /></div><div><CardTitle className="text-base">舆情报告</CardTitle><p className="mt-1 text-xs text-muted-foreground">趋势、信源、威胁、成本与 GEO 穿透</p></div></div>
            <Button variant="outline" size="sm" asChild><Link href="/sentiment-monitor/reports">打开 <ArrowRight className="ml-1 h-3.5 w-3.5" /></Link></Button>
          </CardHeader>
          <CardContent>
            <div className="mb-4 flex gap-2"><Badge variant="secondary" className="gap-1 font-normal"><FileSpreadsheet className="h-3 w-3" />Excel</Badge><Badge variant="secondary" className="gap-1 font-normal"><FileText className="h-3 w-3" />PDF</Badge></div>
            <div className="divide-y">{sentimentReports?.length ? sentimentReports.map(report => <ReportRow key={report.id} href={`/sentiment-monitor/reports?id=${report.id}`} period={report.reportPeriod} generatedAt={report.generatedAt} kind={reportKindLabel(report.reportType, report.reportPeriod)} />) : <Empty />}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div className="flex items-center gap-3"><div className="rounded-lg bg-primary/10 p-2 text-primary"><BarChart3 className="h-5 w-5" /></div><div><CardTitle className="text-base">GEO 报告</CardTitle><p className="mt-1 text-xs text-muted-foreground">模型表现、事实覆盖、引用与预警</p></div></div>
            <Button variant="outline" size="sm" asChild><Link href="/reports">打开 <ArrowRight className="ml-1 h-3.5 w-3.5" /></Link></Button>
          </CardHeader>
          <CardContent>
            <div className="mb-4 flex gap-2"><Badge variant="secondary" className="font-normal">CSV</Badge><Badge variant="secondary" className="font-normal">JSON</Badge></div>
            <div className="divide-y">{geoReports?.length ? geoReports.map(report => <ReportRow key={report.reportWeek} href={`/reports?week=${encodeURIComponent(report.reportWeek)}`} period={report.reportPeriod || report.reportWeek} generatedAt={report.generatedAt} kind={reportKindLabel("weekly", report.reportPeriod || report.reportWeek)} />) : <Empty />}</div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function ReportRow({ href, period, generatedAt, kind }: { href: string; period: string; generatedAt?: number | Date | string | null; kind: string }) {
  return (
    <Link href={href} className="group -mx-2 flex items-center justify-between gap-4 rounded-md px-2 py-3 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <div><p className="text-sm font-medium group-hover:underline">{period}</p><p className="mt-1 text-xs text-muted-foreground">{dateTime(generatedAt)}</p></div>
      <span className="flex items-center gap-2"><Badge variant="outline">{kind}</Badge><ArrowRight className="h-3.5 w-3.5 text-muted-foreground" /></span>
    </Link>
  );
}

function Empty() { return <p className="py-8 text-center text-sm text-muted-foreground">暂无报告</p>; }
