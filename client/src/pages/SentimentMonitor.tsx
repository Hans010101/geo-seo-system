import { useMemo, useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useRole } from "@/hooks/useRole";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Radar,
  AlertTriangle,
  FileText,
  Play,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Eye,
  Network,
  Settings2,
} from "lucide-react";
import { toast } from "sonner";
import MonitorArticleDetailSheet from "@/components/MonitorArticleDetailSheet";
import { THREAT_META, STANCE_META, RELEVANCE_LABELS, FETCH_ENGINE_LABELS, SOURCE_PLATFORM_META } from "@/lib/monitorLabels";

const PAGE_SIZE = 50;

export default function SentimentMonitor() {
  const { isAdmin, isDeveloper } = useRole();
  const utils = trpc.useUtils();
  const [page, setPage] = useState(0);
  const [threat, setThreat] = useState<string>("all");
  const [stance, setStance] = useState<string>("all");
  const [relevance, setRelevance] = useState<string>("focus");
  const [range, setRange] = useState<string>("100d");
  const [sort, setSort] = useState<string>("time"); // default: 最新发布
  const [source, setSource] = useState<string>("all");
  const [detailId, setDetailId] = useState<number | null>(null);

  const listInput = useMemo(() => {
    const now = Date.now();
    const startTime =
      range === "24h"
        ? now - 86_400_000
        : range === "3d"
          ? now - 3 * 86_400_000
          : range === "7d"
            ? now - 7 * 86_400_000
            : range === "30d"
              ? now - 30 * 86_400_000
              : range === "100d"
                ? now - 100 * 86_400_000
                : undefined;
    return {
      page,
      pageSize: PAGE_SIZE,
      threatLevel: threat === "all" ? undefined : (threat as any),
      stance: stance === "all" ? undefined : (stance as any),
      ...(relevance === "focus" ? { focus: true } : relevance === "all" ? {} : { relevance: relevance as any }),
      ...(source === "all" ? {} : { sourcePlatform: source }),
      startTime,
      sort: sort as any,
    };
  }, [page, threat, stance, relevance, range, sort, source]);

  const { data: stats, isLoading: statsLoading } = trpc.monitor.stats.useQuery();
  const { data: resp, isLoading } = trpc.monitor.listArticles.useQuery(listInput);
  const { data: schedule } = trpc.monitor.getSchedule.useQuery(undefined, {
    refetchInterval: (q) => (q.state.data?.running ? 4000 : false),
  });

  const trigger = trpc.monitor.triggerCycle.useMutation({
    onSuccess: (r) => {
      toast.info(r.message);
      utils.monitor.stats.invalidate();
      utils.monitor.listArticles.invalidate();
      utils.monitor.getBudgetStatus.invalidate();
      utils.monitor.binanceStatus.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const articles = resp?.data ?? [];
  const total = resp?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const resetPage = () => setPage(0);
  // Clicking an active KPI again goes back to the default view.
  const applyQuick = (r: string, t: string) => {
    const on = range === r && threat === t;
    setRange(on ? "100d" : r);
    setThreat(on ? "all" : t);
    resetPage();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">舆情情报</h1>
          <p className="text-muted-foreground text-sm mt-1">涉及孙宇晨 / 波场的最新内容，点任一条查看全文、AI 分析与处置。</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {isDeveloper && (
            <Link href="/operations" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <Settings2 className="h-3.5 w-3.5" /> 采集运行与成本
            </Link>
          )}
          {isAdmin && (
            <Button size="sm" variant="outline" onClick={() => trigger.mutate()} disabled={trigger.isPending || schedule?.running} className="gap-1.5">
              {trigger.isPending || schedule?.running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              {trigger.isPending || schedule?.running ? "采集中…" : "立即采集"}
            </Button>
          )}
        </div>
      </div>

      {/* KPI cards double as quick filters */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPICard title="24 小时新增" value={stats?.todayNew} icon={<FileText className="h-4 w-4" />} color="text-primary" loading={statsLoading}
          active={range === "24h" && threat === "all"} onClick={() => applyQuick("24h", "all")} />
        <KPICard title="近 7 天文章" value={stats?.weekTotal} icon={<Radar className="h-4 w-4" />} color="text-blue-600" loading={statsLoading}
          active={range === "7d" && threat === "all"} onClick={() => applyQuick("7d", "all")} />
        <KPICard title="高威胁（30 天）" value={stats?.highThreat} icon={<AlertTriangle className="h-4 w-4" />} color="text-red-600" loading={statsLoading}
          active={range === "30d" && threat === "high"} onClick={() => applyQuick("30d", "high")} />
        <KPICard title="有效情报率（30 天）" value={stats ? `${stats.focusRate}%` : undefined} icon={<Network className="h-4 w-4" />} color="text-violet-600" loading={statsLoading} />
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <FilterSelect value={threat} onChange={(v) => { setThreat(v); resetPage(); }} placeholder="威胁等级"
          options={[["all", "全部威胁"], ["high", "高威胁"], ["medium", "中威胁"], ["low", "低威胁"], ["none", "无威胁"]]} />
        <FilterSelect value={stance} onChange={(v) => { setStance(v); resetPage(); }} placeholder="信源立场"
          options={[["all", "全部立场"], ["hostile", "敌对"], ["neutral", "中立"], ["friendly", "友好"]]} />
        <FilterSelect value={relevance} onChange={(v) => { setRelevance(v); resetPage(); }} placeholder="相关性"
          options={[["focus", "重点(高+中)"], ["all", "全部相关性"], ["high", "高相关"], ["medium", "中相关"], ["low", "低相关"], ["irrelevant", "无关"]]} />
        <FilterSelect value={range} onChange={(v) => { setRange(v); resetPage(); }} placeholder="时间范围"
          options={[["24h", "近 24 小时"], ["3d", "近 3 天"], ["7d", "近 7 天"], ["30d", "近 30 天"], ["100d", "近 100 天"]]} />
        <FilterSelect value={source} onChange={(v) => { setSource(v); resetPage(); }} placeholder="来源平台"
          options={[["all", "全部来源"], ["web", "Web/新闻"], ["binance_square", "币安广场"], ["gate_square", "Gate广场"], ["wechat", "微信公众号（历史）"], ["rss", "RSS媒体"], ["telegram", "Telegram"], ["x", "X"], ["xiaohongshu", "小红书"], ["douyin", "抖音"], ["kuaishou", "快手"], ["bilibili", "B站"], ["weibo", "微博"], ["tieba", "百度贴吧"], ["zhihu", "知乎"]]} />
        <FilterSelect value={sort} onChange={(v) => { setSort(v); resetPage(); }} placeholder="排序"
          options={[["time", "最新发布"], ["collected", "最新入库"], ["threat", "威胁优先"], ["sentiment", "最负面优先"]]} />
      </div>

      {/* Table */}
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="p-2.5 text-left font-medium">标题</th>
                <th className="p-2.5 text-left font-medium">信源</th>
                <th className="p-2.5 text-center font-medium">来源</th>
                <th className="p-2.5 text-center font-medium">发布</th>
                <th className="p-2.5 text-center font-medium">情感</th>
                <th className="p-2.5 text-center font-medium">威胁</th>
                <th className="p-2.5 text-center font-medium">抓取</th>
                <th className="p-2.5 text-center font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={8} className="p-8 text-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin inline" /></td></tr>
              ) : articles.length === 0 ? (
                <tr><td colSpan={8} className="p-8 text-center text-muted-foreground">暂无文章。点击「立即运行一轮」开始监控。</td></tr>
              ) : (
                articles.map((a: any) => {
                  const threatMeta = THREAT_META[a.threatLevel || "none"];
                  const stanceMeta = a.stance ? STANCE_META[a.stance] : null;
                  return (
                    <tr key={a.id} className="border-t hover:bg-muted/30 cursor-pointer" onClick={() => setDetailId(a.id)}>
                      <td className={`p-2.5 max-w-[340px] ${a.archived ? "opacity-60" : ""}`}>
                        <p className="truncate">{a.title || "(无标题)"}</p>
                        <span className="text-[10px] text-muted-foreground">
                          {a.relevance ? RELEVANCE_LABELS[a.relevance] : ""}
                          {a.archived ? (a.relevance ? " · " : "") + "已归档" : ""}
                        </span>
                      </td>
                      <td className="p-2.5">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-muted-foreground truncate max-w-[120px]">{a.domain || "—"}</span>
                          {stanceMeta && (
                            <Badge className="text-[9px] text-white border-0 px-1" style={{ backgroundColor: stanceMeta.color }}>
                              {stanceMeta.label}
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="p-2.5 text-center">
                        {(() => {
                          const m = SOURCE_PLATFORM_META[a.sourcePlatform] || { label: a.sourcePlatform || "—", color: "#9ca3af" };
                          return <Badge className="text-[9px] text-white border-0" style={{ backgroundColor: m.color }}>{m.label}</Badge>;
                        })()}
                      </td>
                      <td className="p-2.5 text-center text-xs text-muted-foreground whitespace-nowrap">
                        {a.publishedAt
                          ? new Date(a.publishedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
                          : "—"}
                      </td>
                      <td className="p-2.5 text-center">{a.sentimentScore ?? "—"}</td>
                      <td className="p-2.5 text-center">
                        <Badge className="text-[10px] text-white border-0" style={{ backgroundColor: threatMeta.color }}>
                          {threatMeta.label}
                        </Badge>
                      </td>
                      <td className="p-2.5 text-center text-[11px] text-muted-foreground whitespace-nowrap">
                        {FETCH_ENGINE_LABELS[a.fetchEngine || ""] || "—"}
                      </td>
                      <td className="p-2.5 text-center">
                        <Eye className="h-3.5 w-3.5 text-muted-foreground inline" />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {total > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t text-sm">
            <span className="text-muted-foreground">共 {total} 篇，第 {page + 1}/{totalPages || 1} 页</span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                <ChevronLeft className="h-3.5 w-3.5 mr-1" />上一页
              </Button>
              <Button variant="outline" size="sm" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>
                下一页<ChevronRight className="h-3.5 w-3.5 ml-1" />
              </Button>
            </div>
          </div>
        )}
      </Card>

      <MonitorArticleDetailSheet
        articleId={detailId}
        open={detailId !== null}
        onOpenChange={(o) => { if (!o) setDetailId(null); }}
      />
    </div>
  );
}

function KPICard({ title, value, icon, color, loading, active, onClick }: { title: string; value: number | string | undefined; icon: React.ReactNode; color: string; loading: boolean; active?: boolean; onClick?: () => void }) {
  const body = loading ? (
    <div className="space-y-2"><Skeleton className="h-4 w-20" /><Skeleton className="h-7 w-16" /></div>
  ) : (
    <>
      <div className="flex items-center gap-2 mb-1.5">
        <span className={color}>{icon}</span>
        <p className="text-xs font-medium text-muted-foreground">{title}</p>
      </div>
      <p className="text-2xl font-bold">{value ?? "—"}</p>
    </>
  );
  return (
    <Card className={`${onClick ? "cursor-pointer hover:border-primary/50 transition-colors" : ""} ${active ? "border-primary ring-1 ring-primary/30" : ""}`}>
      {onClick ? (
        <button type="button" onClick={onClick} className="w-full text-left p-4" title="点击筛选下方列表">{body}</button>
      ) : (
        <CardContent className="p-4">{body}</CardContent>
      )}
    </Card>
  );
}

function FilterSelect({ value, onChange, placeholder, options }: { value: string; onChange: (v: string) => void; placeholder: string; options: [string, string][] }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-[140px] h-9 text-xs"><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>
        {options.map(([v, label]) => <SelectItem key={v} value={v} className="text-xs">{label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
