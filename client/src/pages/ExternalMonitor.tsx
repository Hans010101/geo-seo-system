import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useRoute } from "wouter";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { GenoptimaAnswerList, pct, time, type AnswerFilter } from "@/components/GenoptimaAnswers";

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "good" | "warn" | "bad" }) {
  const color = tone === "bad" ? "text-red-600" : tone === "warn" ? "text-amber-600" : tone === "good" ? "text-green-600" : "";
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className={`text-2xl font-semibold mt-1 ${color}`}>{value}</div>
        {hint ? <div className="text-xs text-muted-foreground mt-1">{hint}</div> : null}
      </CardContent>
    </Card>
  );
}

const share = (part: number, total: number) => (total > 0 ? part / total : 0);
const hoursAgo = (ms: number | null) => (ms ? (Date.now() - ms) / 3_600_000 : Infinity);

// ---------------------------------------------------------------- 服务效果（供应商评估）
function SupplierSection({ days }: { days: number }) {
  const { data: s, isLoading } = trpc.external.geoSupplier.useQuery({ days }, { staleTime: 60_000 });
  if (isLoading || !s) return <p className="text-sm text-muted-foreground">加载中…</p>;

  const today = time(Date.now()).slice(0, 10);
  const full = s.daily.filter(d => d.day < today);
  const avg = full.length ? Math.round(full.reduce((n, d) => n + d.total, 0) / full.length) : 0;
  const expectedPairs = s.scope.platforms * s.scope.questions;
  const pairRate = full.length && expectedPairs ? full.reduce((n, d) => n + d.pairs, 0) / (full.length * expectedPairs) : 0;
  const judged = 1 - share(s.totals.unjudged, s.totals.total);
  const lowDays = full.filter(d => s.baseline && d.total < s.baseline * 0.8);
  const syncLag = hoursAgo(s.latestSyncTime);
  const rows = [...s.daily, ...s.missingDays.map(day => ({ day, missing: true as const }))]
    .sort((a, b) => b.day.localeCompare(a.day));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="交付量（日均）" value={avg.toLocaleString()}
          hint={`常态约 ${s.baseline.toLocaleString()} 条/天 · 断档 ${s.missingDays.length} 天 · 偏少 ${lowDays.length} 天`}
          tone={s.missingDays.length || lowDays.length ? "warn" : "good"} />
        <Stat label="覆盖（平台 × 问题）" value={`${(pairRate * 100).toFixed(1)}%`}
          hint={`${s.scope.platforms} 个平台 × ${s.scope.questions} 个问题，按天计`}
          tone={pairRate >= 0.98 ? "good" : "warn"} />
        <Stat label="情感已判定" value={`${(judged * 100).toFixed(1)}%`}
          hint={`${s.totals.unjudged.toLocaleString()} 条未判定 · ${s.totals.noRefs.toLocaleString()} 条无引用信源`}
          tone={judged >= 0.95 ? "good" : judged >= 0.85 ? "warn" : "bad"} />
        <Stat label="数据新鲜度" value={time(s.latestQueryTime).slice(5)}
          hint={`最近同步 ${time(s.latestSyncTime).slice(5)}`}
          tone={syncLag > 24 ? "bad" : syncLag > 12 ? "warn" : "good"} />
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">每日交付</CardTitle>
            <p className="text-xs text-muted-foreground">轮次 = 当天有回答的整点数；覆盖 = 当天采到的「平台 × 问题」组合占比。低于常态 80% 标黄。</p>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  <th className="text-left py-2">日期</th><th className="text-right">回答</th><th className="text-right">轮次</th>
                  <th className="text-right">平台</th><th className="text-right">问题</th><th className="text-right">覆盖</th><th className="text-right">未判定</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(d => {
                  if (!d) return null;
                  if ("missing" in d) return (
                    <tr key={d.day} className="border-b bg-red-50 dark:bg-red-950/30">
                      <td className="py-1.5">{d.day}</td><td className="text-right text-red-600" colSpan={6}>无交付</td>
                    </tr>
                  );
                  const partial = d.day >= today;
                  const low = !partial && s.baseline > 0 && d.total < s.baseline * 0.8;
                  return (
                    <tr key={d.day} className={`border-b last:border-0 ${low ? "bg-amber-50 dark:bg-amber-950/30" : ""}`}>
                      <td className="py-1.5">{d.day}{partial ? <span className="text-xs text-muted-foreground">（今天）</span> : null}</td>
                      <td className="text-right font-medium">{d.total.toLocaleString()}</td>
                      <td className="text-right">{d.rounds}</td>
                      <td className="text-right">{d.platforms}</td>
                      <td className="text-right">{d.questions}</td>
                      <td className="text-right">{expectedPairs ? pct(d.pairs, expectedPairs) : "—"}</td>
                      <td className="text-right">{pct(d.unjudged, d.total)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {s.daily.length === 0 ? <p className="text-sm text-muted-foreground text-center py-6">所选时间内没有交付</p> : null}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">与自测结果对照</CardTitle>
            <p className="text-xs text-muted-foreground">
              同一模型的负面率：智推为服务商判定；自测为本系统对孙宇晨线和 TRON 线问题的打分（≤2 分算负面）。两边差距大，说明智推的情感判定需要复核。
            </p>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead className="text-muted-foreground">
                <tr className="border-b"><th className="text-left py-2">平台</th><th className="text-right">智推负面率</th><th className="text-right">自测负面率</th><th className="text-right">差距</th></tr>
              </thead>
              <tbody>
                {s.consistency.map(row => {
                  const v = share(row.vendor.negative, row.vendor.total);
                  const m = share(row.self.negative, row.self.total);
                  const gap = row.vendor.total && row.self.total ? (v - m) * 100 : null;
                  return (
                    <tr key={row.platform} className="border-b last:border-0">
                      <td className="py-1.5">{row.label}</td>
                      <td className="text-right">{pct(row.vendor.negative, row.vendor.total)}<span className="text-xs text-muted-foreground"> /{row.vendor.total}</span></td>
                      <td className="text-right">{row.self.total ? pct(row.self.negative, row.self.total) : "无自测"}{row.self.total ? <span className="text-xs text-muted-foreground"> /{row.self.total}</span> : null}</td>
                      <td className={`text-right font-medium ${gap !== null && Math.abs(gap) >= 10 ? "text-amber-600" : ""}`}>
                        {gap === null ? "—" : `${gap > 0 ? "+" : ""}${gap.toFixed(1)} 点`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 监测内容
function ContentSection({ days }: { days: number }) {
  const [preset, setPreset] = useState<AnswerFilter>({});
  const { data: overview } = trpc.external.geoOverview.useQuery({ days: Math.min(days, 30) }, { staleTime: 60_000 });
  const totals = (overview?.byPlatform || []).reduce(
    (acc, row) => ({ positive: acc.positive + row.positive, negative: acc.negative + row.negative }),
    { positive: 0, negative: 0 },
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">各 AI 平台情感</CardTitle>
            <p className="text-xs text-muted-foreground">
              共 {overview?.total ?? 0} 条 · 正面 {pct(totals.positive, overview?.total ?? 0)} · 负面 {pct(totals.negative, overview?.total ?? 0)}
            </p>
          </CardHeader>
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
                onClick={() => setPreset({ question: row.question, sentiment: "negative", nonce: Date.now() })}
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

      <GenoptimaAnswerList days={days} defaultSentiment="negative" preset={preset} />
    </div>
  );
}

function GeoTab() {
  const [days, setDays] = useState(14);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          数据来自智推时代 GenOptima「星枢监测」（项目：波场TRON），由 Mac 本机采集器每轮同步；情感为服务商判定。
        </p>
        <Select value={String(days)} onValueChange={v => setDays(Number(v))}>
          <SelectTrigger className="w-[120px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="7">近 7 天</SelectItem>
            <SelectItem value="14">近 14 天</SelectItem>
            <SelectItem value="30">近 30 天</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold flex items-center gap-2">服务效果 <Badge variant="outline" className="font-normal">供应商评估</Badge></h2>
        <SupplierSection days={days} />
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">监测内容</h2>
        <ContentSection days={days} />
      </section>
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
          {isPercent ? "百分点 Mediaforce 舆情服务的每日总量快照" : "服务商智推时代的交付情况与监测内容：国内 6 个 AI 平台、TRON 与孙宇晨相关的 65 个问题，每天约 3 轮"}
        </p>
      </div>
      {isPercent ? <PercentTab /> : <GeoTab />}
    </div>
  );
}
