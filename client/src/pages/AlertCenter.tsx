import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useState } from "react";
import { Bell, CheckCheck, Eye, Check, X, ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { SEVERITY_LABELS, SEVERITY_COLORS, PLATFORM_LABELS, type Platform } from "@shared/geo-types";
import { getAlertSourceUrl } from "@/lib/alertSource";
export { getAlertSourceUrl } from "@/lib/alertSource";

export default function AlertCenter() {
  const pageSize = 50;
  const [page, setPage] = useState(0);
  const [severityFilter, setSeverityFilter] = useState<string>("all");
  // ?domain=geo|sentiment deep-links from the GEO 总览 / 舆情 pages.
  const [domainFilter, setDomainFilter] = useState<string>(() => {
    const d = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("domain");
    return d === "geo" || d === "sentiment" ? d : "all";
  });
  const [statusFilter, setStatusFilter] = useState<"active" | "resolved" | "dismissed">("active");

  const { data: alertsResult, isLoading } = trpc.alerts.list.useQuery({
    severity: severityFilter === "all" ? undefined : severityFilter,
    domain: domainFilter === "all" ? undefined : (domainFilter as "geo" | "sentiment"),
    status: statusFilter,
    limit: pageSize,
    offset: page * pageSize,
  });
  const alertsList = alertsResult?.data;

  const utils = trpc.useUtils();

  const markReadMutation = trpc.alerts.markRead.useMutation({
    onMutate: async ({ id }) => {
      await utils.alerts.list.cancel();
      const prev = utils.alerts.list.getData();
      utils.alerts.list.setData(undefined, (old: any) =>
        old ? { ...old, data: old.data?.map((a: any) => (a.id === id ? { ...a, isRead: true } : a)) } : old
      );
      return { prev };
    },
    onError: (_err, _vars, ctx: any) => {
      if (ctx?.prev) utils.alerts.list.setData(undefined, ctx.prev);
    },
    onSettled: () => {
      utils.alerts.list.invalidate();
    },
  });

  // H2: resolve = "已处理"; dismiss = "已忽略"; both remove from active list.
  const resolveMutation = trpc.alerts.resolve.useMutation({
    onSuccess: () => { utils.alerts.list.invalidate(); toast.success("已标记为已解决"); },
    onError: (e) => toast.error(e.message),
  });
  const dismissMutation = trpc.alerts.dismiss.useMutation({
    onSuccess: () => { utils.alerts.list.invalidate(); toast.success("已忽略"); },
    onError: (e) => toast.error(e.message),
  });

  const markAllReadMutation = trpc.alerts.markAllRead.useMutation({
    onSuccess: () => {
      utils.alerts.list.invalidate();
      toast.success("已全部标记为已读");
    },
  });

  const unreadCount = alertsList?.filter((a) => !a.isRead).length || 0;
  const total = alertsResult?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">预警中心</h1>
          <p className="text-muted-foreground text-sm mt-1">
            当前筛选共 {total} 个预警事件{unreadCount > 0 ? `，本页 ${unreadCount} 个未读` : ""}
          </p>
        </div>
        {unreadCount > 0 && (
          <Button
            variant="outline"
            onClick={() => markAllReadMutation.mutate()}
            disabled={markAllReadMutation.isPending}
          >
            <CheckCheck className="h-4 w-4 mr-2" />
            全部已读
          </Button>
        )}
      </div>

      <div className="flex gap-3">
        <Select value={domainFilter} onValueChange={(value) => { setDomainFilter(value); setPage(0); }}>
          <SelectTrigger className="w-[130px]">
            <SelectValue placeholder="预警类别" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部类别</SelectItem>
            <SelectItem value="sentiment">舆情预警</SelectItem>
            <SelectItem value="geo">GEO 预警</SelectItem>
          </SelectContent>
        </Select>
        <Select value={severityFilter} onValueChange={(value) => { setSeverityFilter(value); setPage(0); }}>
          <SelectTrigger className="w-[130px]">
            <SelectValue placeholder="严重程度" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部级别</SelectItem>
            <SelectItem value="critical">紧急</SelectItem>
            <SelectItem value="high">高</SelectItem>
            <SelectItem value="medium">中</SelectItem>
            <SelectItem value="low">低</SelectItem>
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v as any); setPage(0); }}>
          <SelectTrigger className="w-[130px]">
            <SelectValue placeholder="状态" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">活跃</SelectItem>
            <SelectItem value="resolved">已解决</SelectItem>
            <SelectItem value="dismissed">已忽略</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {!alertsList || alertsList.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Bell className="h-12 w-12 mx-auto text-muted-foreground/30 mb-4" />
            <h3 className="text-lg font-medium mb-2">暂无预警</h3>
            <p className="text-sm text-muted-foreground">当检测到异常情况时，预警将显示在这里</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {alertsList.map((alert) => {
            const sourceUrl = getAlertSourceUrl(alert.description);
            return (
            <Card
              key={alert.id}
              className={`transition-colors ${!alert.isRead ? "border-l-2" : "opacity-70"}`}
              style={{
                borderLeftColor: !alert.isRead ? SEVERITY_COLORS[alert.severity] : undefined,
              }}
            >
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <div
                    className="h-2.5 w-2.5 rounded-full mt-1.5 shrink-0"
                    style={{ backgroundColor: SEVERITY_COLORS[alert.severity] || "#6b7280" }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-sm font-semibold">{alert.title}</h3>
                      <Badge
                        variant="outline"
                        className="text-[10px] px-1.5"
                        style={{
                          color: SEVERITY_COLORS[alert.severity],
                          borderColor: SEVERITY_COLORS[alert.severity],
                        }}
                      >
                        {SEVERITY_LABELS[alert.severity]}
                      </Badge>
                      {alert.relatedPlatform && (
                        <Badge variant="secondary" className="text-[10px] px-1.5">
                          {PLATFORM_LABELS[alert.relatedPlatform as Platform] || alert.relatedPlatform}
                        </Badge>
                      )}
                      {alert.relatedQuestionId && (
                        <Badge variant="secondary" className="text-[10px] px-1.5">
                          {alert.relatedQuestionId}
                        </Badge>
                      )}
                      {(alert.occurrenceCount ?? 1) > 1 && (
                        <Badge variant="outline" className="text-[10px] px-1.5">
                          累计 {alert.occurrenceCount} 次
                        </Badge>
                      )}
                    </div>
                    {alert.description && (
                      <p className="text-sm text-muted-foreground mt-1.5">{alert.description}</p>
                    )}
                    <p className="text-xs text-muted-foreground/60 mt-2">
                      {new Date(alert.createdAt).toLocaleString("zh-CN")}
                    </p>
                    {statusFilter !== "active" && (alert.resolvedAt || alert.resolutionNote) && (
                      <p className="text-xs text-muted-foreground mt-1">
                        {alert.resolvedBy || "系统"} · {alert.resolvedAt ? new Date(alert.resolvedAt).toLocaleString("zh-CN") : ""}
                        {alert.resolutionNote ? ` · ${alert.resolutionNote}` : ""}
                      </p>
                    )}
                    {sourceUrl && (
                      <Button variant="outline" size="sm" className="mt-3" asChild>
                        <a href={sourceUrl} target="_blank" rel="noopener noreferrer" aria-label={`查看原文：${alert.title}（新标签页）`}>
                          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                          查看原文
                        </a>
                      </Button>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {!alert.isRead && statusFilter === "active" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        title="标记已读"
                        onClick={() => markReadMutation.mutate({ id: alert.id })}
                        disabled={markReadMutation.isPending}
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {statusFilter === "active" && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          title="解决"
                          className="text-emerald-600 hover:text-emerald-700"
                          onClick={() => {
                            const note = window.prompt("请输入处置说明（可选）", "已核查并完成处置");
                            if (note !== null) resolveMutation.mutate({ id: alert.id, note: note.trim() || undefined });
                          }}
                          disabled={resolveMutation.isPending}
                        >
                          <Check className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          title="忽略"
                          className="text-muted-foreground hover:text-foreground"
                          onClick={() => dismissMutation.mutate({ id: alert.id })}
                          disabled={dismissMutation.isPending}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
            );
          })}
        </div>
      )}
      {total > 0 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">第 {page + 1}/{totalPages} 页</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>
              <ChevronLeft className="h-3.5 w-3.5 mr-1" />上一页
            </Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages - 1} onClick={() => setPage((value) => value + 1)}>
              下一页<ChevronRight className="h-3.5 w-3.5 ml-1" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
