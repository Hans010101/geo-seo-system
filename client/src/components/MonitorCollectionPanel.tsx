// 舆情采集的运行信息（定时开关、币安采集、信源/抓取引擎分布、成本护栏），在「运行中心」展示，
// 让「舆情情报」页只留情报本身。
import { trpc } from "@/lib/trpc";
import { useRole } from "@/hooks/useRole";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Loader2, Play } from "lucide-react";
import { toast } from "sonner";
import { SOURCE_PLATFORM_META } from "@/lib/monitorLabels";

function freshnessLabel(value?: number) {
  if (!value) return "无数据";
  const hours = Math.max(0, Math.floor((Date.now() - value) / 3_600_000));
  return hours < 1 ? "1 小时内" : hours < 24 ? `${hours} 小时前` : `${Math.floor(hours / 24)} 天前`;
}

export default function MonitorCollectionPanel() {
  const { isAdmin } = useRole();
  const utils = trpc.useUtils();
  const { data: stats } = trpc.monitor.stats.useQuery();
  const { data: budget } = trpc.monitor.getBudgetStatus.useQuery();
  const { data: schedule } = trpc.monitor.getSchedule.useQuery(undefined, {
    refetchInterval: (q) => (q.state.data?.running ? 4000 : false),
  });
  const { data: binance } = trpc.monitor.binanceStatus.useQuery(undefined, { refetchInterval: 60_000 });
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
  const setSchedule = trpc.monitor.setSchedule.useMutation({
    onSuccess: (r) => {
      utils.monitor.getSchedule.invalidate();
      toast.success(r.enabled ? "定时监控已开启" : "定时监控已关闭");
    },
    onError: (e) => toast.error(e.message),
  });
  const running = trigger.isPending || schedule?.running;

  return (
    <section className="space-y-4" aria-label="舆情采集">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold">舆情采集</h2>
          <p className="text-xs text-muted-foreground mt-1">
            正文成功率 {stats ? `${stats.fullTextRate}%` : "—"} · 本月监控成本 {stats ? `$${stats.monthCostUsd.toFixed(4)}` : "—"}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 rounded-lg border px-3 py-1.5">
            <span className="text-xs text-muted-foreground">定时监控</span>
            <Switch
              checked={schedule?.enabled ?? false}
              disabled={!isAdmin || setSchedule.isPending}
              onCheckedChange={(v) => setSchedule.mutate({ enabled: v })}
            />
            <span className="text-[11px] text-muted-foreground">{schedule?.cronExpression || "0 9,21 * * *"}</span>
          </div>
          <div
            className="flex items-center gap-2 rounded-lg border px-3 py-1.5"
            title={[binance?.provider && `采集通道: ${binance.provider}`, binance?.updatedAt && `更新时间: ${new Date(binance.updatedAt).toLocaleString("zh-CN", { hour12: false })}`, binance?.error].filter(Boolean).join("\n") || "Cloudflare 币安广场采集状态"}
          >
            <span className="text-xs text-muted-foreground">币安采集</span>
            <Badge variant={binance?.status === "success" ? "default" : "secondary"} className={`text-[10px] ${binance?.status === "failed" ? "text-red-600" : binance?.status === "partial" ? "text-orange-600" : ""}`}>
              {binance?.status === "success" ? "正常" : binance?.status === "partial" ? "备用通道运行" : binance?.status === "empty" ? "本轮无新增" : binance?.status === "running" ? "运行中" : binance?.status === "failed" ? "采集异常" : "等待首轮"}
            </Badge>
          </div>
          {isAdmin && (
            <Button size="sm" onClick={() => trigger.mutate()} disabled={running} className="gap-1.5">
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {running ? "运行中…" : "立即运行一轮"}
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium text-muted-foreground mb-3">信源分布(近 30 天)</p>
            {(() => {
              const sd = stats?.sourceDistribution || {};
              const tot = Object.values(sd).reduce((a, b) => a + b, 0) || 1;
              const keys = Object.keys(sd).sort((a, b) => sd[b] - sd[a]);
              if (keys.length === 0) return <p className="text-xs text-muted-foreground">暂无数据</p>;
              return (
                <div className="space-y-2">
                  {keys.map((k) => {
                    const meta = SOURCE_PLATFORM_META[k] || { label: k, color: "#9ca3af" };
                    const n = sd[k];
                    const pct = Math.round((n / tot) * 100);
                    const quality = stats?.sourceQuality?.find((row) => row.sourcePlatform === k);
                    return (
                      <div key={k}>
                        <div className="flex justify-between text-xs mb-0.5"><span>{meta.label}</span><span className="text-muted-foreground">{n} · 占比 {pct}% · 有效 {quality?.focusRate ?? 0}% · 最近 {freshnessLabel(quality?.lastSeenAt)}</span></div>
                        <div className="h-1.5 rounded-full bg-muted overflow-hidden"><div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: meta.color }} /></div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium text-muted-foreground mb-3">抓取引擎分布(近 30 天)</p>
            {(() => {
              const ed = stats?.engineDistribution || {};
              const tot = Object.values(ed).reduce((a, b) => a + b, 0) || 1;
              const rows: [string, string, string][] = [
                ["self", "自建 L1(免费)", "#16a34a"],
                ["firecrawl", "Firecrawl L4(付费)", "#ea580c"],
                ...Object.keys(ed).filter(k => !["self", "firecrawl", "snippet"].includes(k)).map(k => [k,
                  ({ x_api: "X API 直取", telegram: "Telegram 直取", rss: "RSS 正文", source_api: "平台 API 直取", gate_firecrawl: "Gate · Firecrawl" } as Record<string, string>)[k] || k,
                  "#3b82f6",
                ] as [string, string, string]),
                ["snippet", "仅摘要/未取得正文", "#9ca3af"],
              ];
              return (
                <div className="space-y-2">
                  {rows.map(([k, label, color]) => {
                    const n = ed[k] || 0;
                    const pct = Math.round((n / tot) * 100);
                    return (
                      <div key={k}>
                        <div className="flex justify-between text-xs mb-0.5">
                          <span>{label}</span>
                          <span className="text-muted-foreground">{n} · {pct}%</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
                        </div>
                      </div>
                    );
                  })}
                  <p className="text-[11px] text-muted-foreground pt-1">已有平台正文直接复用；其余先免费 L1，再由 Firecrawl 限额补抓。仅摘要不等于采集失败。</p>
                </div>
              );
            })()}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium text-muted-foreground mb-1">成本护栏(本月)</p>
            <p className="text-[11px] text-muted-foreground mb-3">北京时间自然月 · 每月 1 日 00:00 重置</p>
            <div className="space-y-2.5">
              <BudgetBar label="Firecrawl credits" used={budget?.firecrawl.used} limit={budget?.firecrawl.limit} />
              {budget?.serper.limit === 0 ? (
                <div className="flex justify-between text-xs"><span>Serper 搜索</span><span className="text-muted-foreground">已停用（新闻走百分点 + 媒体站搜索）</span></div>
              ) : (
                <BudgetBar label="Serper API 请求（实际）" used={budget?.serper.used} limit={budget?.serper.limit} />
              )}
              <BudgetBar label={`X 推文(twitterapi.io · $${(budget?.x?.estUsd ?? 0).toFixed(2)})`} used={budget?.x?.used} limit={budget?.x?.limit} />
              <div className="flex justify-between text-xs pt-2 border-t">
                <span className="text-muted-foreground">本月成本细分</span>
                <span>抓取 ${(stats?.monthFetchCostUsd ?? 0).toFixed(4)} + 分析 ${(stats?.monthAnalysisCostUsd ?? 0).toFixed(4)}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

    </section>
  );
}

function BudgetBar({ label, used, limit }: { label: string; used?: number; limit?: number }) {
  const u = used ?? 0;
  const l = limit ?? 1;
  const pct = Math.min(100, Math.round((u / l) * 100));
  const danger = pct >= 80;
  return (
    <div>
      <div className="flex justify-between text-xs mb-0.5">
        <span>{label}</span>
        <span className={danger ? "text-red-600 font-medium" : "text-muted-foreground"}>{u} / {l}</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: danger ? "#dc2626" : "#3b82f6" }} />
      </div>
    </div>
  );
}
