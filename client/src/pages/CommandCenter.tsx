import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bot,
  CheckCircle2,
  FileSearch,
  Link2,
  Radar,
  ShieldAlert,
  Target,
} from "lucide-react";
import { PLATFORM_LABELS, type Platform } from "@shared/geo-types";
import { SOURCE_PLATFORM_META, THREAT_META } from "@/lib/monitorLabels";

const week = () => ({ startTime: Date.now() - 7 * 86_400_000, endTime: Date.now() });

function timeAgo(value?: number | string | null) {
  const timestamp = typeof value === "string" ? Date.parse(value) : value;
  if (!timestamp) return "暂无记录";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / 1_440)} 天前`;
}

export default function CommandCenter() {
  const { data: geo, isLoading: geoLoading } = trpc.dashboard.summary.useQuery(week(), { staleTime: 30_000 });
  const { data: sentiment, isLoading: sentimentLoading } = trpc.monitor.stats.useQuery(undefined, { staleTime: 30_000 });
  const { data: alerts } = trpc.alerts.list.useQuery({ status: "active", limit: 5, offset: 0 }, { staleTime: 15_000 });
  const { data: articles } = trpc.monitor.listArticles.useQuery({ page: 0, pageSize: 6, focus: true, startTime: Date.now() - 7 * 86_400_000, sort: "time" });
  const { data: cloudflare } = trpc.system.cloudflareStatus.useQuery(undefined, { staleTime: 30_000, refetchInterval: 60_000 });

  const activeAlerts = alerts?.data ?? [];
  const recentArticles = articles?.data ?? [];
  const weakPlatforms = [...(geo?.platformBreakdown ?? [])]
    .filter(item => item.collectionCount > 0)
    .sort((a, b) => a.sentimentAvg - b.sentimentAvg)
    .slice(0, 4);
  const worker = cloudflare as any;
  const currentProfile = worker?.profiles?.monitor_primary_news;
  const workerHealthy = worker?.ok && ["success", "queued", "running"].includes(worker?.taskStatus);
  const briefing = sentiment?.highThreat
    ? `过去 30 天仍有 ${sentiment.highThreat} 条高威胁舆情，当前 ${activeAlerts.length} 项预警待处置。`
    : `当前未发现高威胁舆情，${activeAlerts.length ? `仍有 ${activeAlerts.length} 项 GEO 预警待处置。` : "暂无待处置预警。"}`;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Badge variant="outline" className="gap-1.5 font-normal">
              <span className={`h-1.5 w-1.5 rounded-full ${workerHealthy ? "bg-emerald-500" : "bg-amber-500"}`} />
              Cloudflare {workerHealthy ? "运行正常" : "需关注"}
            </Badge>
            <span className="text-xs text-muted-foreground">更新于 {timeAgo(worker?.finishedAt || worker?.fetchedAt)}</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">GEO 与舆情工作台</h1>
          <p className="mt-1 text-sm text-muted-foreground">从情报发现到风险处置，在同一处掌握今天最重要的变化。</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild><Link href="/report-center">查看报告</Link></Button>
          <Button asChild><Link href="/alerts">处理预警 <ArrowRight className="ml-1.5 h-4 w-4" /></Link></Button>
        </div>
      </header>

      <section aria-labelledby="briefing-title" className="overflow-hidden rounded-xl border bg-card">
        <div className="grid lg:grid-cols-[1.45fr_1fr]">
          <div className="p-5 lg:p-6">
            <div className="flex items-center gap-2 text-primary">
              <Radar className="h-4 w-4" />
              <h2 id="briefing-title" className="text-sm font-semibold">今日简报</h2>
            </div>
            <p className="mt-3 text-lg font-medium leading-7">{briefing}</p>
            <p className="mt-2 text-sm text-muted-foreground">
              近 24 小时新增舆情 {sentiment?.todayNew ?? "—"} 条；本周 GEO 共采集 {geo?.totalCollections ?? "—"} 次，事实覆盖率 {geo?.targetFactsCoverage ?? "—"}%。
            </p>
          </div>
          <div className="border-t bg-muted/35 p-5 lg:border-l lg:border-t-0 lg:p-6">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">系统判断</p>
            <div className="mt-3 space-y-2 text-sm">
              <StatusLine ok={!sentiment?.highThreat} label="舆情风险" value={sentiment?.highThreat ? "存在高威胁信号" : "风险平稳"} />
              <StatusLine ok={(geo?.targetFactsCoverage ?? 0) >= 80} label="事实一致性" value={`${geo?.targetFactsCoverage ?? "—"}%`} />
              <StatusLine ok={workerHealthy} label="采集主链" value={workerHealthy ? "定时任务持续运行" : "请进入运行中心检查"} />
            </div>
          </div>
        </div>
      </section>

      <section aria-label="核心指标" className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Metric label="高威胁舆情" value={sentiment?.highThreat} suffix="条" icon={ShieldAlert} loading={sentimentLoading} danger={!!sentiment?.highThreat} />
        <Metric label="GEO 情感均值" value={geo?.overallSentimentAvg?.toFixed(1)} suffix="/ 5" icon={Activity} loading={geoLoading} />
        <Metric label="事实覆盖率" value={geo?.targetFactsCoverage} suffix="%" icon={Target} loading={geoLoading} />
        <Metric label="己方引用率" value={geo?.ourContentRate} suffix="%" icon={Link2} loading={geoLoading} />
        <Metric label="待处置预警" value={alerts?.total ?? 0} suffix="项" icon={AlertTriangle} loading={!alerts} danger={!!alerts?.total} />
      </section>

      <div className="grid gap-4 xl:grid-cols-[1.15fr_.85fr]">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">今日待处置</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">按严重度聚合的有效预警</p>
            </div>
            <Button variant="ghost" size="sm" asChild><Link href="/alerts">全部预警 <ArrowRight className="ml-1 h-3.5 w-3.5" /></Link></Button>
          </CardHeader>
          <CardContent>
            {activeAlerts.length ? (
              <div className="divide-y">
                {activeAlerts.map(alert => (
                  <div key={alert.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${alert.severity === "critical" || alert.severity === "high" ? "bg-red-500" : "bg-amber-500"}`} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{alert.title}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{alert.severity === "critical" ? "严重" : alert.severity === "high" ? "高" : "中"} · {timeAgo(alert.createdAt)}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : <Empty icon={CheckCircle2} text="暂无待处置预警" />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">GEO 薄弱平台</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">近 7 天按情感均值升序</p>
            </div>
            <Button variant="ghost" size="sm" asChild><Link href="/geo">进入 GEO <ArrowRight className="ml-1 h-3.5 w-3.5" /></Link></Button>
          </CardHeader>
          <CardContent className="space-y-3">
            {weakPlatforms.length ? weakPlatforms.map(item => (
              <div key={item.platform} className="grid grid-cols-[minmax(0,1fr)_3rem_5rem] items-center gap-3 text-sm">
                <span className="truncate font-medium">{PLATFORM_LABELS[item.platform as Platform] || item.platform}</span>
                <span className="text-right font-semibold tabular-nums">{item.sentimentAvg.toFixed(1)}</span>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(4, item.sentimentAvg * 20)}%` }} /></div>
              </div>
            )) : <Empty icon={Bot} text="本周暂无 GEO 采集数据" />}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.35fr_.65fr]">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div><CardTitle className="text-base">最新重点情报</CardTitle><p className="mt-1 text-xs text-muted-foreground">仅展示高、中相关且通过时效过滤的信息</p></div>
            <Button variant="ghost" size="sm" asChild><Link href="/sentiment-monitor">进入舆情情报 <ArrowRight className="ml-1 h-3.5 w-3.5" /></Link></Button>
          </CardHeader>
          <CardContent>
            {recentArticles.length ? <div className="divide-y">
              {recentArticles.map(article => (
                <div key={article.id} className="grid gap-1 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-4">
                  <div className="min-w-0"><p className="truncate text-sm font-medium">{article.title}</p><p className="mt-1 text-xs text-muted-foreground">{article.domain} · {SOURCE_PLATFORM_META[article.sourcePlatform || ""]?.label || article.sourcePlatform || "Web/新闻"}</p></div>
                  <div className="flex items-center gap-2 text-xs"><Badge variant="secondary">{THREAT_META[article.threatLevel || "none"]?.label || "无威胁"}</Badge><span className="text-muted-foreground">{timeAgo(article.publishedAt)}</span></div>
                </div>
              ))}
            </div> : <Empty icon={FileSearch} text="近 7 天暂无重点情报" />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">运行摘要</CardTitle></CardHeader>
          <CardContent className="space-y-4 text-sm">
            <RuntimeRow label="新闻采集" value={currentProfile?.status || "等待状态"} detail={`${currentProfile?.inserted ?? 0} 入库 / ${currentProfile?.analyzed ?? 0} 分析`} />
            <RuntimeRow label="币安广场" value={worker?.binance?.status || "等待状态"} detail={worker?.binance?.provider || "未报告通道"} />
            <RuntimeRow label="日常 GEO" value={worker?.dailyGeo?.status || "等待状态"} detail={timeAgo(worker?.dailyGeo?.finishedAt)} />
            <RuntimeRow label="周度 GEO" value={worker?.weeklyGeo?.status || "等待状态"} detail={timeAgo(worker?.weeklyGeo?.finishedAt)} />
            <Button variant="outline" className="w-full" asChild><Link href="/operations">查看运行中心</Link></Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Metric({ label, value, suffix, icon: Icon, loading, danger }: { label: string; value: string | number | null | undefined; suffix: string; icon: typeof Activity; loading: boolean; danger?: boolean }) {
  return <div className="rounded-xl border bg-card p-4"><div className="flex items-center justify-between text-xs text-muted-foreground"><span>{label}</span><Icon className={`h-4 w-4 ${danger ? "text-red-500" : "text-primary"}`} /></div>{loading ? <Skeleton className="mt-4 h-7 w-20" /> : <p className={`mt-3 text-2xl font-semibold tabular-nums ${danger ? "text-red-600" : ""}`}>{value ?? "—"} <span className="text-xs font-normal text-muted-foreground">{suffix}</span></p>}</div>;
}

function StatusLine({ ok, label, value }: { ok: boolean; label: string; value: string }) {
  return <div className="flex items-center justify-between gap-3"><span className="text-muted-foreground">{label}</span><span className="flex items-center gap-1.5 font-medium"><span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-emerald-500" : "bg-amber-500"}`} />{value}</span></div>;
}

function RuntimeRow({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="flex items-start justify-between gap-3 border-b pb-3 last:border-0"><div><p className="font-medium">{label}</p><p className="mt-0.5 text-xs text-muted-foreground">{detail}</p></div><Badge variant={value === "success" ? "default" : "secondary"}>{value === "success" ? "正常" : value === "running" ? "运行中" : value === "queued" ? "已排队" : value === "partial" ? "部分完成" : value}</Badge></div>;
}

function Empty({ icon: Icon, text }: { icon: typeof Activity; text: string }) {
  return <div className="flex min-h-24 flex-col items-center justify-center gap-2 text-sm text-muted-foreground"><Icon className="h-5 w-5" /><span>{text}</span></div>;
}
