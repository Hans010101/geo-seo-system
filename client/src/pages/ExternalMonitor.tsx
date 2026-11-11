import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useRoute } from "wouter";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const PLATFORM_LABELS: Record<string, string> = {
  doubao: "豆包", deepseek: "DeepSeek", yuanbao: "腾讯元宝", qianwen: "通义千问", kimi: "Kimi", wenxin: "文心一言",
};
const SENTIMENT_META: Record<string, { label: string; className: string }> = {
  positive: { label: "正面", className: "bg-green-50 text-green-700 border-green-200" },
  negative: { label: "负面", className: "bg-red-50 text-red-700 border-red-200" },
  none: { label: "未判定", className: "bg-gray-50 text-gray-600 border-gray-200" },
};
const PAGE_SIZE = 30;

const pct = (part: number, total: number) => (total > 0 ? `${((part / total) * 100).toFixed(1)}%` : "—");
/** Beijing time "YYYY-MM-DD HH:mm" (locale-independent; zh-CN strings vary in padding). */
const time = (ms: number | null | undefined) => {
  if (!ms) return "—";
  const iso = new Date(ms + 8 * 3_600_000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
};

function SentimentBadge({ value }: { value: string | null }) {
  const meta = SENTIMENT_META[value === "positive" || value === "negative" ? value : "none"];
  return <Badge variant="outline" className={meta.className}>{meta.label}</Badge>;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className="text-2xl font-semibold mt-1">{value}</div>
        {hint ? <div className="text-xs text-muted-foreground mt-1">{hint}</div> : null}
      </CardContent>
    </Card>
  );
}

function AnswerDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data } = trpc.external.geoAnswer.useQuery({ id: id || "" }, { enabled: !!id });
  return (
    <Dialog open={!!id} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base leading-6">{data ? data.question : "加载中…"}</DialogTitle>
        </DialogHeader>
        {data ? (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
              <Badge variant="secondary">{PLATFORM_LABELS[data.platform] || data.platform}</Badge>
              <SentimentBadge value={data.sentiment} />
              <span>{time(data.queryTime)}</span>
              <span>引用 {data.referenceCount} 个信源</span>
            </div>
            <div className="whitespace-pre-wrap leading-6 rounded-md bg-muted/40 p-3">{data.answer}</div>
            {data.refs.length > 0 ? (
              <div>
                <div className="font-medium mb-1">引用信源</div>
                <div className="flex flex-wrap gap-1.5">
                  {data.refs.map((name, i) => <Badge key={i} variant="outline">{name}</Badge>)}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function GeoTab() {
  const [days, setDays] = useState(7);
  const [platform, setPlatform] = useState("all");
  const [sentiment, setSentiment] = useState<"all" | "positive" | "negative" | "none">("negative");
  const [question, setQuestion] = useState("");
  const [page, setPage] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);

  const { data: overview, isLoading } = trpc.external.geoOverview.useQuery({ days }, { staleTime: 60_000 });
  const { data: answers } = trpc.external.geoAnswers.useQuery({
    days,
    platform: platform === "all" ? undefined : platform,
    sentiment: sentiment === "all" ? undefined : sentiment,
    question: question.trim() || undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  }, { staleTime: 60_000 });

  const totals = (overview?.byPlatform || []).reduce(
    (acc, row) => ({ positive: acc.positive + row.positive, negative: acc.negative + row.negative }),
    { positive: 0, negative: 0 },
  );
  const resetPage = <T,>(set: (value: T) => void) => (value: T) => { set(value); setPage(0); };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          数据来自智推时代 GenOptima「星枢监测」（项目：波场TRON），由 Mac 本机采集器每轮同步；情感为服务商判定。
        </p>
        <Select value={String(days)} onValueChange={resetPage((v: string) => setDays(Number(v)))}>
          <SelectTrigger className="w-[120px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="1">近 1 天</SelectItem>
            <SelectItem value="7">近 7 天</SelectItem>
            <SelectItem value="14">近 14 天</SelectItem>
            <SelectItem value="30">近 30 天</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="AI 回答数" value={isLoading ? "…" : String(overview?.total ?? 0)} hint={`${overview?.byPlatform.length ?? 0} 个 AI 平台`} />
        <Stat label="正面占比" value={pct(totals.positive, overview?.total ?? 0)} hint={`${totals.positive} 条`} />
        <Stat label="负面占比" value={pct(totals.negative, overview?.total ?? 0)} hint={`${totals.negative} 条`} />
        <Stat label="最近一次采集" value={time(overview?.latestQueryTime)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">各 AI 平台情感</CardTitle></CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead className="text-muted-foreground">
                <tr className="border-b"><th className="text-left py-2">平台</th><th className="text-right">回答</th><th className="text-right">正面</th><th className="text-right">负面</th><th className="text-right">负面率</th></tr>
              </thead>
              <tbody>
                {(overview?.byPlatform || []).map(row => (
                  <tr key={row.platform} className="border-b last:border-0">
                    <td className="py-2">{row.label}</td>
                    <td className="text-right">{row.total}</td>
                    <td className="text-right">{row.positive}</td>
                    <td className="text-right">{row.negative}</td>
                    <td className="text-right font-medium">{pct(row.negative, row.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {overview && overview.total === 0 ? <p className="text-sm text-muted-foreground text-center py-6">暂无数据</p> : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">每日回答情感</CardTitle></CardHeader>
          <CardContent className="h-[260px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={overview?.byDay || []}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="day" tickFormatter={(d: string) => d.slice(5)} fontSize={12} />
                <YAxis fontSize={12} />
                <Tooltip />
                <Legend />
                <Bar dataKey="positive" name="正面" stackId="s" fill="#16a34a" />
                <Bar dataKey="negative" name="负面" stackId="s" fill="#dc2626" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">负面回答最多的问题</CardTitle></CardHeader>
          <CardContent className="space-y-1.5">
            {(overview?.negativeQuestions || []).slice(0, 15).map(row => (
              <button
                key={row.question}
                className="w-full flex items-center justify-between gap-3 text-left text-sm rounded px-2 py-1.5 hover:bg-muted"
                onClick={() => { setQuestion(row.question); setSentiment("negative"); setPage(0); }}
              >
                <span className="truncate">{row.question}</span>
                <span className="shrink-0 text-red-600">{row.negative}/{row.total}</span>
              </button>
            ))}
            {overview && overview.negativeQuestions.length === 0 ? <p className="text-sm text-muted-foreground text-center py-6">没有负面回答</p> : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">AI 最常引用的信源</CardTitle></CardHeader>
          <CardContent className="space-y-1.5">
            {(overview?.topReferences || []).slice(0, 15).map((row, i) => (
              <div key={row.name} className="flex items-center justify-between text-sm px-2 py-1">
                <span className="truncate"><span className="text-muted-foreground mr-2">{i + 1}</span>{row.name}</span>
                <span className="shrink-0 text-muted-foreground">{row.count} 次</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">回答明细（{answers?.total ?? 0} 条）</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="w-[220px] h-9"
                placeholder="按问题搜索"
                value={question}
                onChange={(e) => { setQuestion(e.target.value); setPage(0); }}
              />
              <Select value={platform} onValueChange={resetPage(setPlatform)}>
                <SelectTrigger className="w-[120px] h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部平台</SelectItem>
                  {Object.entries(PLATFORM_LABELS).map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={sentiment} onValueChange={resetPage((v: string) => setSentiment(v as typeof sentiment))}>
                <SelectTrigger className="w-[110px] h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部情感</SelectItem>
                  <SelectItem value="negative">负面</SelectItem>
                  <SelectItem value="positive">正面</SelectItem>
                  <SelectItem value="none">未判定</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-1">
          {(answers?.items || []).map(item => (
            <button
              key={item.id}
              className="w-full text-left rounded-md border px-3 py-2 hover:bg-muted/50"
              onClick={() => setOpenId(item.id)}
            >
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant="secondary">{PLATFORM_LABELS[item.platform] || item.platform}</Badge>
                <SentimentBadge value={item.sentiment} />
                <span className="font-medium">{item.question}</span>
                <span className="ml-auto text-xs text-muted-foreground">{time(item.queryTime)}</span>
              </div>
              <div className="text-xs text-muted-foreground mt-1 line-clamp-2">{item.preview}</div>
            </button>
          ))}
          {answers && answers.items.length === 0 ? <p className="text-sm text-muted-foreground text-center py-6">没有符合条件的回答</p> : null}
          {answers && answers.total > PAGE_SIZE ? (
            <div className="flex items-center justify-end gap-2 pt-2 text-sm">
              <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</Button>
              <span className="text-muted-foreground">{page + 1} / {Math.ceil(answers.total / PAGE_SIZE)}</span>
              <Button variant="outline" size="sm" disabled={(page + 1) * PAGE_SIZE >= answers.total} onClick={() => setPage(page + 1)}>下一页</Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
      <AnswerDialog id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

function PercentTab() {
  const { data, isLoading } = trpc.external.percentDaily.useQuery({ days: 30 }, { staleTime: 60_000 });
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        数据来自百分点 Mediaforce（方案：波场TRON）。敏感信息逐条导入「舆情情报」统一分析（来源显示为“百分点舆情导入”），这里是每日总量快照；“合并后”为百分点合并相似内容后的条数。
      </p>
      <Card>
        <CardContent className="pt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-muted-foreground">
              <tr className="border-b">
                <th className="text-left py-2">日期</th><th className="text-right">信息总量</th><th className="text-right">合并后</th>
                <th className="text-right">敏感</th><th className="text-right">敏感合并后</th><th className="text-right">敏感占比</th>
                <th className="text-left pl-4">敏感信息主要平台</th>
              </tr>
            </thead>
            <tbody>
              {(data || []).map(row => (
                <tr key={row.day} className="border-b last:border-0">
                  <td className="py-2">{row.day}</td>
                  <td className="text-right">{row.total ?? "—"}</td>
                  <td className="text-right">{row.totalFolded ?? "—"}</td>
                  <td className="text-right">{row.sensitive ?? "—"}</td>
                  <td className="text-right">{row.sensitiveFolded ?? "—"}</td>
                  <td className="text-right">{pct(row.sensitive ?? 0, row.total ?? 0)}</td>
                  <td className="pl-4 text-muted-foreground">
                    {Object.entries(row.sensitiveByPlatform || {}).sort((a, b) => b[1] - a[1]).slice(0, 5)
                      .map(([name, count]) => `${name} ${count}`).join(" · ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!isLoading && (!data || data.length === 0) ? <p className="text-sm text-muted-foreground text-center py-6">暂无数据</p> : null}
        </CardContent>
      </Card>
    </div>
  );
}

export default function ExternalMonitor() {
  const [isPercent] = useRoute("/external/percent");
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{isPercent ? "百分点数据" : "智推时代数据"}</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {isPercent ? "百分点 Mediaforce 舆情服务的每日总量快照" : "服务商智推时代的 AI 平台回答监测，与本系统 GEO 采集互为对照"}
        </p>
      </div>
      {isPercent ? <PercentTab /> : <GeoTab />}
    </div>
  );
}
