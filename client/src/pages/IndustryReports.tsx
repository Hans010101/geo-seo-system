import { useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useRole } from "@/hooks/useRole";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ReportDateRange } from "@/components/ReportDateRange";
import { reportDateRangeSchema, reportPeriodDates, weeklyPeriodOf } from "@shared/report-period";
import { CATEGORY_TONE, bjDay, bjTime } from "@/lib/industryFormat";
import { Download, Globe2, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

type Report = import("../../../server/industry-weekly").IndustryWeekly;

const periodText = (r: Report) => r.reportPeriod || `${bjDay(r.from)} ~ ${bjDay(r.to - 1)}`;

// Plain-text copy for pasting into the combined weekly write-up.
function toMarkdown(r: Report) {
  const kind = r.kind || "周报";
  const lines = [
    `# 行业${kind} · ${periodText(r)}${r.partial ? `（截至 ${bjTime(r.to)}）` : ""}`,
    "", `**${r.headline}**`, "", r.overview, "",
    "## 关键数据", ...r.numbers.map(n => `- ${n.label}：${n.value}（${n.change}）`), "",
    ...r.sections.flatMap(s => [`## ${s.label}`, ...s.points.map(p => `- ${p}`), ""]),
    ...(r.competitors.length ? ["## 竞品动向", ...r.competitors.map(c => `- ${c.label}：${c.text}`), ""] : []),
    "## 对 TRON 的影响", ...r.tron.map(p => `- ${p}`), "",
    `## ${kind === "月报" ? "下月" : kind === "周报" ? "下周" : "后续"}关注`, ...r.watch.map(p => `- ${p}`), "",
    "## 重要事件", ...r.events.map(e => `- ${bjTime(e.publishedAt)} [${e.category}] [${e.summary}](${e.url})`),
  ];
  return lines.join("\n");
}

export default function IndustryReports() {
  const { isAdmin } = useRole();
  const utils = trpc.useUtils();
  const [selected, setSelected] = useState<string>(() => new URLSearchParams(window.location.search).get("id") ?? "");
  const [dateRange, setDateRange] = useState(() => reportPeriodDates(weeklyPeriodOf(Date.now())));
  const { data: list, isLoading } = trpc.industry.reportList.useQuery(undefined, { staleTime: 60_000 });
  const activeId = selected || list?.[0]?.id || "";
  const { data, isLoading: detailLoading } = trpc.industry.report.useQuery({ id: activeId }, { enabled: !!activeId });

  const gen = trpc.industry.generateReport.useMutation({
    onSuccess: r => {
      toast.success(`已生成 ${r.reportPeriod}`);
      utils.industry.reportList.invalidate();
      utils.industry.report.invalidate({ id: r.id });
      setSelected(r.id);
    },
    onError: e => toast.error(e.message),
  });
  const pendingType = gen.isPending ? (gen.variables?.reportType ?? "weekly") : null;

  const exportMd = () => {
    if (!data) return;
    const blob = new Blob([toMarkdown(data)], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `行业${data.kind || "周报"}-${periodText(data).replace(/\s/g, "")}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <Globe2 className="h-6 w-6 text-primary" />
            <h1 className="text-2xl font-bold tracking-tight">行业报告</h1>
          </div>
          <p className="text-muted-foreground text-sm mt-1">
            行业周报/月报：重大事件、宏观与竞品数据、对 TRON 的影响。周期与舆情、GEO 报告一致；每周五、每月 1 日自动生成上一期。
          </p>
          <Link href="/industry" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mt-1.5">查看实时行业动态 →</Link>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-3 flex-wrap">
            <Button size="sm" variant="outline" disabled={gen.isPending || !reportDateRangeSchema.safeParse(dateRange).success}
              onClick={() => gen.mutate({ dateRange })}>
              {pendingType === "weekly" ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />}
              生成所选周期周报
            </Button>
            <Button size="sm" variant="outline" disabled={gen.isPending} onClick={() => gen.mutate({ reportType: "monthly" })}>
              {pendingType === "monthly" ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />}
              生成本月月报
            </Button>
          </div>
        )}
      </div>

      {isAdmin && <ReportDateRange value={dateRange} onChange={setDateRange} disabled={gen.isPending} />}
      {gen.isPending && <p className="text-xs text-muted-foreground -mt-3">AI 正在撰写，约需 1 分钟…</p>}

      <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
        <Card className="h-fit">
          <CardHeader className="pb-2"><CardTitle className="text-sm">报告列表</CardTitle></CardHeader>
          <CardContent className="p-2 pt-0">
            {isLoading ? (
              <div className="space-y-2 p-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-9 w-full" />)}</div>
            ) : !list?.length ? (
              <p className="text-sm text-muted-foreground p-3">暂无报告{isAdmin ? "，点右上角生成" : ""}</p>
            ) : (
              <div className="space-y-1">
                {list.map(r => (
                  <button key={r.id} type="button" onClick={() => setSelected(r.id)}
                    className={`w-full text-left rounded-md px-3 py-2 text-sm hover:bg-muted/60 ${r.id === activeId ? "bg-muted font-medium" : ""}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span>{r.reportPeriod}</span>
                      <Badge variant={r.kind === "月报" ? "outline" : "secondary"} className="text-[10px]">{r.kind}</Badge>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-1">{r.headline}</p>
                    <p className="text-[10px] text-muted-foreground">生成于 {new Date(r.generatedAt).toLocaleString("zh-CN", { hour12: false })}</p>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="min-w-0">
          {!activeId || detailLoading || !data ? (
            <Card>
              <CardContent className="py-16 text-center text-sm text-muted-foreground">
                {activeId && detailLoading ? <Loader2 className="h-5 w-5 animate-spin inline" /> : "暂无报告。选择起止日期后生成周报，或点击「生成本月月报」"}
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-6 space-y-5">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="text-xs text-muted-foreground">
                      行业{data.kind || "周报"} · {periodText(data)}{data.partial ? `（截至 ${bjTime(data.to)}，周期未结束）` : ""}
                    </div>
                    <h2 className="text-xl font-bold mt-1">{data.headline}</h2>
                  </div>
                  <Button variant="outline" size="sm" onClick={exportMd}><Download className="h-3.5 w-3.5 mr-1.5" />Markdown</Button>
                </div>
                <p className="text-sm leading-relaxed">{data.overview}</p>
                <div className="grid gap-2 grid-cols-2 md:grid-cols-4">
                  {data.numbers.map(n => (
                    <div key={n.label} className="rounded border p-2">
                      <div className="text-[11px] text-muted-foreground">{n.label}</div>
                      <div className="text-sm font-semibold">{n.value} <span className={`text-xs font-normal ${n.change.startsWith("+") ? "text-green-600" : n.change.startsWith("-") ? "text-red-600" : "text-muted-foreground"}`}>{n.change}</span></div>
                    </div>
                  ))}
                </div>
                {data.sections.map(s => (
                  <div key={s.category}>
                    <div className="text-sm font-semibold mb-1"><Badge variant="outline" className={CATEGORY_TONE[s.category] || ""}>{s.label}</Badge></div>
                    <ul className="list-disc pl-5 text-sm space-y-0.5">{s.points.map((p, i) => <li key={i}>{p}</li>)}</ul>
                  </div>
                ))}
                {data.competitors.length ? (
                  <div>
                    <div className="text-sm font-semibold mb-1">竞品动向</div>
                    <div className="space-y-1 text-sm">{data.competitors.map(c => <div key={c.key}><span className="font-medium">{c.label}：</span>{c.text}</div>)}</div>
                  </div>
                ) : null}
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="rounded bg-yellow-50 p-3 dark:bg-yellow-950/30">
                    <div className="text-sm font-semibold mb-1">对 TRON 的影响</div>
                    <ul className="list-disc pl-5 text-sm space-y-0.5">{data.tron.map((p, i) => <li key={i}>{p}</li>)}</ul>
                  </div>
                  <div className="rounded bg-muted/60 p-3">
                    <div className="text-sm font-semibold mb-1">{data.kind === "月报" ? "下月" : data.kind === "自定义" ? "后续" : "下周"}关注</div>
                    <ul className="list-disc pl-5 text-sm space-y-0.5">{data.watch.map((p, i) => <li key={i}>{p}</li>)}</ul>
                  </div>
                </div>
                <div>
                  <div className="text-sm font-semibold mb-1">重要事件</div>
                  {data.events.map(e => (
                    <div key={e.id} className="text-sm py-1 border-b last:border-0 flex gap-2">
                      <span className="text-xs text-muted-foreground w-[78px] shrink-0 pt-0.5">{bjTime(e.publishedAt)}</span>
                      <a href={e.url} target="_blank" rel="noreferrer" className="hover:underline">{e.summary}</a>
                      <span className="text-xs text-muted-foreground shrink-0 ml-auto">{e.category}</span>
                    </div>
                  ))}
                </div>
                <div className="text-[11px] text-muted-foreground">生成于 {bjTime(data.generatedAt)} · {data.model}</div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
