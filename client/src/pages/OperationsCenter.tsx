import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Activity, Bot, CircleGauge, Clock3, Database, ExternalLink, Radio, SearchCheck } from "lucide-react";

const PROFILE_LABELS: Record<string, string> = {
  monitor_primary_news: "新闻批次",
  monitor_primary_social: "社交批次",
};
const REJECTION_LABELS: Record<string, string> = {
  duplicate_url: "重复链接",
  duplicate_content: "重复内容",
  source_date_unverifiable: "日期不可验证",
  source_date_failed: "日期识别失败",
  freshness_stale: "内容过期",
  language: "语言不匹配",
};

export function readSummary(value?: string | null) {
  try { return value ? JSON.parse(value) : {}; } catch { return {}; }
}

function dateTime(value?: number | string | null) {
  const timestamp = typeof value === "string" ? Number(value) : value;
  return timestamp ? new Date(timestamp).toLocaleString("zh-CN", { hour12: false }) : "暂无";
}

function statusLabel(status?: string) {
  return status === "success" ? "正常" : status === "running" ? "运行中" : status === "queued" ? "已排队" : status === "partial" ? "部分完成" : status === "empty" ? "无新增" : status || "等待状态";
}

export default function OperationsCenter() {
  const query = trpc.system.cloudflareStatus.useQuery(undefined, { refetchInterval: 60_000, staleTime: 30_000 });
  const data = query.data as any;
  const profiles = Object.entries(data?.profiles ?? {}) as [string, any][];
  const sourceRows = profiles.flatMap(([profile, cycle]) => Object.entries(cycle?.sourceDiagnostics ?? {}).map(([source, diagnostic]) => ({ profile, source, ...(diagnostic as any) })));
  const binanceSummary = readSummary(data?.binance?.summary);
  const daily = readSummary(data?.dailyGeo?.summary);
  const weekly = readSummary(data?.weeklyGeo?.summary);
  const browser = data?.browserFulltext;
  const social = data?.chineseSocial;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Badge variant={data?.ok ? "default" : "destructive"}>{data?.ok ? "Cloudflare 主链在线" : "状态读取异常"}</Badge>
            <span className="text-xs text-muted-foreground">每分钟自动刷新</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">运行中心</h1>
          <p className="mt-1 text-sm text-muted-foreground">查看采集漏斗、信源健康、GEO 进度与资源使用；本页只读，不会改变生产任务。</p>
        </div>
        <Button variant="outline" onClick={() => query.refetch()} disabled={query.isFetching}>
          <Activity className={`mr-2 h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} />刷新状态
        </Button>
      </header>

      {data?.error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">状态源读取失败：{data.error}</div>}

      <section aria-label="运行概况" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard icon={Radio} label="运行模式" value={data?.mode || "—"} detail={data?.execution || "未报告执行方式"} />
        <SummaryCard icon={SearchCheck} label="新闻任务" value={statusLabel(data?.profiles?.monitor_primary_news?.status)} detail={dateTime(data?.profiles?.monitor_primary_news?.finishedAt)} />
        <SummaryCard icon={Activity} label="社交任务" value={statusLabel(data?.profiles?.monitor_primary_social?.status)} detail={dateTime(data?.profiles?.monitor_primary_social?.finishedAt)} />
        <SummaryCard icon={Clock3} label="最新任务" value={data?.task || "—"} detail={dateTime(data?.finishedAt)} />
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        {profiles.map(([key, cycle]) => {
          const discovered = cycle.discovered ?? 0;
          return <Card key={key}>
            <CardHeader className="flex-row items-start justify-between space-y-0">
              <div><CardTitle className="text-base">{PROFILE_LABELS[key] || key}</CardTitle><p className="mt-1 text-xs text-muted-foreground">完成于 {dateTime(cycle.finishedAt)}</p></div>
              <StatusBadge status={cycle.status} />
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid grid-cols-5 gap-2 text-center">
                <FunnelStep label="发现" value={discovered} />
                <FunnelStep label="接受" value={cycle.accepted} />
                <FunnelStep label="入库" value={cycle.inserted} />
                <FunnelStep label="分析" value={cycle.analyzed} />
                <FunnelStep label="失败" value={cycle.failed} danger />
              </div>
              <div>
                <div className="mb-2 flex justify-between text-xs text-muted-foreground"><span>发现 → 入库转化</span><span>{discovered ? Math.round((cycle.inserted || 0) / discovered * 100) : 0}%</span></div>
                <Progress value={discovered ? (cycle.inserted || 0) / discovered * 100 : 0} />
              </div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(cycle.rejectionReasons ?? {}).map(([reason, count]) => <Badge key={reason} variant="secondary" className="font-normal">{REJECTION_LABELS[reason] || reason} {String(count)}</Badge>)}
                {(cycle.dedupExisting ?? 0) > 0 && <Badge variant="outline" className="font-normal">历史去重 {cycle.dedupExisting}</Badge>}
              </div>
              <div className="flex justify-between border-t pt-3 text-xs text-muted-foreground"><span>Workers AI {Number(cycle.analysisNeurons || 0).toFixed(1)} neurons</span><span>备用路由 {cycle.analysisFallbacks || 0} 次 · ${Number(cycle.analysisCostUsd || 0).toFixed(4)}</span></div>
            </CardContent>
          </Card>;
        })}
      </section>

      <Card>
        <CardHeader><CardTitle className="text-base">信源健康与覆盖</CardTitle><p className="text-xs text-muted-foreground">最近一轮各采集通道的真实产出；“无新增”与“失败”分开显示。</p></CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead><tr className="border-b text-left text-xs text-muted-foreground"><th className="pb-3 font-medium">信源</th><th className="pb-3 font-medium">所属任务</th><th className="pb-3 font-medium">状态</th><th className="pb-3 text-right font-medium">发现</th><th className="pb-3 text-right font-medium">入队</th><th className="pb-3 text-right font-medium">查询成功</th><th className="pb-3 text-right font-medium">耗时</th><th className="pb-3 font-medium">异常摘要</th></tr></thead>
            <tbody>{sourceRows.map(row => <tr key={`${row.profile}-${row.source}`} className="border-b last:border-0"><td className="py-3 font-medium">{row.source}</td><td className="py-3 text-muted-foreground">{PROFILE_LABELS[row.profile] || row.profile}</td><td className="py-3"><StatusBadge status={row.status} /></td><td className="py-3 text-right tabular-nums">{row.discovered ?? 0}</td><td className="py-3 text-right tabular-nums">{row.enqueued ?? 0}</td><td className="py-3 text-right tabular-nums">{row.queriesSucceeded ?? 0}/{row.queriesAttempted ?? 0}</td><td className="py-3 text-right tabular-nums">{((row.durationMs ?? 0) / 1000).toFixed(1)}s</td><td className="max-w-72 truncate py-3 text-xs text-muted-foreground" title={(row.errors ?? []).join("；")}>{row.errors?.[0] || "—"}</td></tr>)}</tbody>
          </table>
        </CardContent>
      </Card>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <ProgressCard icon={Database} title="币安广场" status={data?.binance?.status} detail={`${data?.binance?.provider || "—"} · ${binanceSummary.enqueued ?? 0} 条入队`} value={binanceSummary.matchedPosts ?? 0} max={Math.max(binanceSummary.rawPosts ?? 0, 1)} footer={`每 ${data?.binance?.intervalHours ?? "—"} 小时`} />
        <ProgressCard icon={Bot} title="日常 GEO" status={data?.dailyGeo?.status} detail={`${daily.completed ?? 0} 完成 · ${daily.failed ?? 0} 失败`} value={daily.cursorAfter ?? 0} max={daily.totalCells ?? 24} footer={`剩余 ${daily.remaining ?? "—"} 单元`} />
        <ProgressCard icon={CircleGauge} title="周度 GEO" status={data?.weeklyGeo?.status} detail={`${weekly.completed ?? 0} 完成 · ${weekly.failed ?? 0} 失败`} value={weekly.cursorAfter ?? 0} max={weekly.totalCells ?? 372} footer={`剩余 ${weekly.remaining ?? "—"} 单元`} />
        <ProgressCard icon={Activity} title="Browser" status={browser?.failed ? "partial" : "success"} detail={`${browser?.successes ?? 0} 成功 · ${browser?.failed ?? 0} 失败`} value={browser?.reserved ?? 0} max={browser?.configuredMaxPagesPerDay ?? 4} footer={`${Math.round((browser?.browserMs ?? 0) / 1000)} 秒浏览器时间`} />
      </section>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0"><div><CardTitle className="text-base">中文社交平台</CardTitle><p className="mt-1 text-xs text-muted-foreground">Cloudflare Browser 优先，Serper 自动兜底</p></div><StatusBadge status={social?.enabled ? "success" : "disabled"} /></CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <RuntimeDetail label="运行频率" value={`每 ${social?.intervalHours ?? "—"} 小时`} />
          <RuntimeDetail label="监控关键词" value={(social?.keywords ?? []).join("、") || "—"} />
          <RuntimeDetail label="覆盖平台" value={`${social?.platforms?.length ?? 0} 个平台`} />
        </CardContent>
      </Card>

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><ExternalLink className="h-3.5 w-3.5" />数据来自 geo-seo-system Cloudflare Cron Worker 只读状态接口。</p>
    </div>
  );
}

function SummaryCard({ icon: Icon, label, value, detail }: { icon: typeof Activity; label: string; value: string; detail: string }) {
  return <div className="rounded-xl border bg-card p-4"><div className="flex items-center gap-2 text-xs text-muted-foreground"><Icon className="h-4 w-4 text-primary" />{label}</div><p className="mt-3 truncate text-lg font-semibold">{value}</p><p className="mt-1 truncate text-xs text-muted-foreground">{detail}</p></div>;
}
function FunnelStep({ label, value = 0, danger }: { label: string; value?: number; danger?: boolean }) { return <div><p className={`text-xl font-semibold tabular-nums ${danger && value ? "text-red-600" : ""}`}>{value}</p><p className="mt-1 text-xs text-muted-foreground">{label}</p></div>; }
function StatusBadge({ status }: { status?: string }) { return <Badge variant={status === "success" ? "default" : status === "failed" ? "destructive" : "secondary"}>{statusLabel(status)}</Badge>; }
function ProgressCard({ icon: Icon, title, status, detail, value, max, footer }: { icon: typeof Activity; title: string; status?: string; detail: string; value: number; max: number; footer: string }) { const percent = max ? Math.min(100, value / max * 100) : 0; return <Card><CardContent className="p-4"><div className="flex items-start justify-between"><div className="flex items-center gap-2 font-medium"><Icon className="h-4 w-4 text-primary" />{title}</div><StatusBadge status={status} /></div><p className="mt-4 text-sm">{detail}</p><Progress value={percent} className="mt-3" /><p className="mt-2 text-xs text-muted-foreground">{footer}</p></CardContent></Card>; }
function RuntimeDetail({ label, value }: { label: string; value: string }) { return <div><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-sm font-medium leading-6">{value}</p></div>; }
