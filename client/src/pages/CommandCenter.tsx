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
  CheckCircle2,
  FileSearch,
  Link2,
  Radar,
  ShieldAlert,
  Target,
} from "lucide-react";
import { SOURCE_PLATFORM_META, THREAT_META } from "@/lib/monitorLabels";
import { useState } from "react";
import MonitorArticleDetailSheet from "@/components/MonitorArticleDetailSheet";
import CollectionDetailSheet from "@/components/CollectionDetailSheet";
import { buildBriefingText } from "@/lib/commandBriefing";
import { METRICS, metricTitle } from "@shared/metric-definitions";

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
  const [articleId, setArticleId] = useState<number | null>(null);
  const [collectionId, setCollectionId] = useState<number | null>(null);
  const [weekRange] = useState(week);
  const { data: geo, isLoading: geoLoading } = trpc.dashboard.summary.useQuery(weekRange, { staleTime: 30_000 });
  const { data: sentiment, isLoading: sentimentLoading, isError: sentimentError } = trpc.monitor.stats.useQuery(undefined, { staleTime: 30_000 });
  const { data: alerts, isError: alertsError } = trpc.alerts.list.useQuery({ status: "active", limit: 5, offset: 0 }, { staleTime: 15_000 });
  const { data: articles } = trpc.monitor.listArticles.useQuery({ page: 0, pageSize: 6, focus: true, startTime: weekRange.startTime, sort: "time" });

  const activeAlerts = alerts?.data ?? [];
  const recentArticles = articles?.data ?? [];
  const threatDistribution = sentiment?.threatDistribution ?? {};
  const threatRows = (["high", "medium", "low", "none"] as const).map(key => ({ key, label: THREAT_META[key].label, color: THREAT_META[key].color, value: threatDistribution[key] ?? 0 }));
  const threatMax = Math.max(1, ...threatRows.map(row => row.value));
  const sourceRows = (sentiment?.sourceQuality ?? [])
    .filter(row => row.focused > 0 && row.sourcePlatform !== "unknown")
    .sort((a, b) => b.focused - a.focused)
    .slice(0, 5)
    .map(row => ({ key: row.sourcePlatform, label: SOURCE_PLATFORM_META[row.sourcePlatform]?.label || row.sourcePlatform, value: row.focused }));
  const sourceMax = Math.max(1, ...sourceRows.map(row => row.value));
  const activeAlertTotal = alerts?.total ?? 0;
  const briefingInput = {
    sentimentLoaded: !!sentiment,
    alertsLoaded: !!alerts,
    failed: sentimentError || alertsError,
    highThreat: sentiment?.highThreat ?? 0,
    activeAlertTotal,
  };
  const briefing = buildBriefingText(briefingInput);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">GEO 与舆情工作台</h1>
          <p className="mt-1 text-sm text-muted-foreground">从情报发现到风险处置，在同一处掌握今天最重要的变化。</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild><Link href="/report-center">查看报告</Link></Button>
          <Button asChild><Link href="/alerts">处理预警 <ArrowRight className="ml-1.5 h-4 w-4" /></Link></Button>
        </div>
      </header>

      <section aria-labelledby="briefing-title" className="rounded-xl border bg-card p-5 lg:p-6">
        <div className="flex items-center gap-2 text-primary">
          <Radar className="h-4 w-4" />
          <h2 id="briefing-title" className="text-sm font-semibold">今日简报</h2>
        </div>
        <p className="mt-3 text-lg font-medium leading-7">{briefing}</p>
        <p className="mt-2 text-sm text-muted-foreground">
          近 24 小时新增舆情 {sentiment?.todayNew ?? "—"} 条；近 7 天 GEO 事实覆盖率 {geo?.targetFactsCoverage ?? "—"}%。
        </p>
      </section>

      <section aria-label="核心指标" className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Metric label={metricTitle("highThreat", "days30")} help={METRICS.highThreat.help} value={sentiment?.highThreat} suffix="条" icon={ShieldAlert} loading={sentimentLoading} danger={!!sentiment?.highThreat} href="/sentiment-monitor?range=30d&threat=high&relevance=all" linkTitle="查看近 30 天高威胁舆情" />
        <Metric label={metricTitle("geoSentiment", "week")} help={METRICS.geoSentiment.help} value={geo?.overallSentimentAvg?.toFixed(1)} suffix="/ 5" icon={Activity} loading={geoLoading} />
        <Metric label={metricTitle("factCoverage", "week")} help={METRICS.factCoverage.help} value={geo?.targetFactsCoverage} suffix="%" icon={Target} loading={geoLoading} />
        <Metric label={metricTitle("ownCitation", "week")} help={METRICS.ownCitation.help} value={geo?.ourContentRate} suffix="%" icon={Link2} loading={geoLoading} />
        <Metric label={metricTitle("openAlerts", "all")} help={METRICS.openAlerts.help} value={alerts?.total ?? 0} suffix="项" icon={AlertTriangle} loading={!alerts} danger={!!alerts?.total} href="/alerts" linkTitle="查看全部待处置预警" />
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
                  <button
                    key={alert.id}
                    type="button"
                    className="flex w-full items-start gap-3 py-3 text-left transition-colors first:pt-0 last:pb-0 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => alert.relatedArticleId
                      ? setArticleId(alert.relatedArticleId)
                      : alert.relatedCollectionId && setCollectionId(alert.relatedCollectionId)}
                    disabled={!alert.relatedArticleId && !alert.relatedCollectionId}
                    title="查看预警详情"
                  >
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${alert.severity === "critical" || alert.severity === "high" ? "bg-red-500" : "bg-amber-500"}`} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{alert.title}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{alert.severity === "critical" ? "严重" : alert.severity === "high" ? "高" : "中"} · {timeAgo(alert.createdAt)}</p>
                    </div>
                  </button>
                ))}
              </div>
            ) : alerts ? <Empty icon={CheckCircle2} text="暂无待处置预警" />
              : <Empty icon={AlertTriangle} text={alertsError ? "预警加载失败" : "正在加载预警…"} />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">近 30 天舆情分布</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">点任一项直达对应列表</p>
            </div>
            <Button variant="ghost" size="sm" asChild><Link href="/sentiment-monitor?range=30d&relevance=all">全部舆情 <ArrowRight className="ml-1 h-3.5 w-3.5" /></Link></Button>
          </CardHeader>
          <CardContent className="space-y-5">
            {sentimentLoading ? <Skeleton className="h-40 w-full" /> : sentiment ? <>
              <div>
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">威胁等级</p>
                {threatRows.map(row => (
                  <DistributionRow key={row.key} href={`/sentiment-monitor?range=30d&threat=${row.key}&relevance=all`} label={row.label} value={row.value} max={threatMax} color={row.color} title={`查看近 30 天${row.label}舆情`} />
                ))}
              </div>
              <div>
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">重点情报主要来源</p>
                {sourceRows.length ? sourceRows.map(row => (
                  <DistributionRow key={row.key} href={`/sentiment-monitor?range=30d&source=${row.key}`} label={row.label} value={row.value} max={sourceMax} title={`查看近 30 天来自${row.label}的重点情报`} />
                )) : <p className="py-2 text-sm text-muted-foreground">近 30 天暂无重点情报</p>}
              </div>
            </> : <Empty icon={AlertTriangle} text="舆情统计加载失败" />}
          </CardContent>
        </Card>
      </div>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div><CardTitle className="text-base">最新重点情报</CardTitle><p className="mt-1 text-xs text-muted-foreground">仅展示高、中相关且通过时效过滤的信息</p></div>
            <Button variant="ghost" size="sm" asChild><Link href="/sentiment-monitor">进入舆情情报 <ArrowRight className="ml-1 h-3.5 w-3.5" /></Link></Button>
          </CardHeader>
          <CardContent>
            {recentArticles.length ? <div className="divide-y">
              {recentArticles.map(article => (
                <button
                  key={article.id}
                  type="button"
                  className="grid w-full gap-1 py-3 text-left transition-colors first:pt-0 last:pb-0 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-4"
                  onClick={() => setArticleId(article.id)}
                  title="查看情报详情"
                >
                  <div className="min-w-0"><p className="truncate text-sm font-medium">{article.title}</p><p className="mt-1 text-xs text-muted-foreground">{article.domain} · {SOURCE_PLATFORM_META[article.sourcePlatform || ""]?.label || article.sourcePlatform || "Web/新闻"}</p></div>
                  <div className="flex items-center gap-2 text-xs"><Badge variant="secondary">{THREAT_META[article.threatLevel || "none"]?.label || "无威胁"}</Badge><span className="text-muted-foreground">{timeAgo(article.publishedAt)}</span></div>
                </button>
              ))}
            </div> : <Empty icon={FileSearch} text="近 7 天暂无重点情报" />}
          </CardContent>
        </Card>


      <MonitorArticleDetailSheet
        articleId={articleId}
        open={articleId !== null}
        onOpenChange={open => { if (!open) setArticleId(null); }}
      />
      <CollectionDetailSheet
        collectionId={collectionId}
        open={collectionId !== null}
        onOpenChange={open => { if (!open) setCollectionId(null); }}
      />
    </div>
  );
}

function Metric({ label, help, value, suffix, icon: Icon, loading, danger, href, linkTitle }: { label: string; help?: string; value: string | number | null | undefined; suffix: string; icon: typeof Activity; loading: boolean; danger?: boolean; href?: string; linkTitle?: string }) {
  const body = <><div className="flex items-center justify-between text-xs text-muted-foreground"><span>{label}</span><Icon className={`h-4 w-4 ${danger ? "text-red-500" : "text-primary"}`} /></div>{loading ? <Skeleton className="mt-4 h-7 w-20" /> : <p className={`mt-3 text-2xl font-semibold tabular-nums ${danger ? "text-red-600" : ""}`}>{value ?? "—"} <span className="text-xs font-normal text-muted-foreground">{suffix}</span>{href && <ArrowRight className="ml-1 inline h-3.5 w-3.5 align-middle text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />}</p>}</>;
  if (!href) return <div className="rounded-xl border bg-card p-4" title={help}>{body}</div>;
  return <Link href={href} title={linkTitle ?? help} className="group block rounded-xl border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{body}</Link>;
}

function DistributionRow({ href, label, value, max, color, title }: { href: string; label: string; value: number; max: number; color?: string; title: string }) {
  return <Link href={href} title={title} className="grid grid-cols-[minmax(0,1fr)_3.5rem_6rem] items-center gap-3 rounded-md px-2 py-1.5 text-sm transition-colors -mx-2 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><span className="truncate">{label}</span><span className="text-right font-semibold tabular-nums">{value}</span><span className="h-1.5 overflow-hidden rounded-full bg-muted"><span className={`block h-full rounded-full ${color ? "" : "bg-primary"}`} style={{ width: `${value ? Math.max(4, (value / max) * 100) : 0}%`, ...(color ? { backgroundColor: color } : {}) }} /></span></Link>;
}

function Empty({ icon: Icon, text }: { icon: typeof Activity; text: string }) {
  return <div className="flex min-h-24 flex-col items-center justify-center gap-2 text-sm text-muted-foreground"><Icon className="h-5 w-5" /><span>{text}</span></div>;
}
