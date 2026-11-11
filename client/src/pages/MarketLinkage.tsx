import { trpc } from "@/lib/trpc";
import { useRole } from "@/hooks/useRole";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import {
  Bar, CartesianGrid, ComposedChart, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { SOURCE_PLATFORM_META, THREAT_META } from "@/lib/monitorLabels";

/** Display rows: USDD sits with the TRON ecosystem (it is excluded from the index math only). */
const ROWS: { label: string; groups: string[] }[] = [
  { label: "TRON 生态", groups: ["tron", "stable"] },
  { label: "大盘参照", groups: ["benchmark"] },
];

/** 7-day price sparkline; USDD uses a fixed ±1% band so peg noise is not magnified. */
function Sparkline({ values, peg }: { values: (number | null)[]; peg?: boolean }) {
  const points = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null);
  if (points.length < 2) return <div className="h-9" />;
  const prices = points.map(p => p[1]);
  const lo = peg ? 0.99 : Math.min(...prices);
  const hi = peg ? 1.01 : Math.max(...prices);
  const span = hi - lo || 1;
  const w = 100;
  const h = 32;
  const x = (i: number) => (i / (values.length - 1)) * w;
  const y = (v: number) => h - 2 - ((Math.min(hi, Math.max(lo, v)) - lo) / span) * (h - 4);
  const up = prices[prices.length - 1] >= prices[0];
  const color = peg ? "#0ea5e9" : up ? "#16a34a" : "#dc2626";
  const line = points.map(([i, v]) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full h-9" aria-label="近 7 天走势">
      {peg ? <line x1="0" x2={w} y1={y(1)} y2={y(1)} stroke="#cbd5e1" strokeDasharray="2 2" vectorEffect="non-scaling-stroke" /> : null}
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

const signed = (value: number | null | undefined, digits = 2) =>
  value === null || value === undefined ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(digits)}%`;
const tone = (value: number | null | undefined) =>
  value === null || value === undefined ? "text-muted-foreground" : value > 0 ? "text-green-600" : value < 0 ? "text-red-600" : "";

function formatPrice(price: number | null) {
  if (price === null) return "—";
  if (price >= 100) return `$${price.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (price >= 1) return `$${price.toFixed(3)}`;
  if (price >= 0.001) return `$${price.toFixed(5)}`;
  return `$${price.toExponential(3)}`;
}

/** Beijing time as "MM-DD HH:mm" (or "HH:mm"), independent of the browser locale's padding. */
const bjTime = (ms: number, withDate = true) => {
  const text = new Date(ms + 8 * 3_600_000).toISOString(); // YYYY-MM-DDTHH:mm in UTC+8
  return withDate ? `${text.slice(5, 10)} ${text.slice(11, 16)}` : text.slice(11, 16);
};

function Overview() {
  const { data } = trpc.market.overview.useQuery(undefined, { staleTime: 60_000 });
  if (!data) return null;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-3">
        {(["24h", "7d", "30d"] as const).map(window => {
          const w = data.windows[window];
          return (
            <Card key={window}>
              <CardContent className="pt-5 space-y-1">
                <div className="text-sm text-muted-foreground">近 {window.replace("h", " 小时").replace("d", " 天")} TRX 超额收益</div>
                <div className={`text-2xl font-semibold ${tone(w?.excess)}`}>{signed(w?.excess)}</div>
                <div className="text-xs text-muted-foreground">
                  TRX {signed(w?.trx)} · 生态指数 {signed(w?.tronIndex)} · 大盘 {signed(w?.benchmark)}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
      {ROWS.map(row => (
        <div key={row.label}>
          <div className="text-sm font-medium text-muted-foreground mb-2">{row.label}</div>
          <div className="grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
            {data.tokens.filter(token => row.groups.includes(token.group)).map(token => (
              <Card key={token.symbol}>
                <CardContent className="pt-4 pb-4 space-y-1">
                  <div className="flex items-baseline justify-between">
                    <span className="font-semibold">{token.symbol}</span>
                    <span className="text-xs text-muted-foreground">{token.name}</span>
                  </div>
                  <div className="text-lg">{formatPrice(token.price)}</div>
                  <Sparkline values={token.spark} peg={token.group === "stable"} />
                  <div className="text-xs space-x-2">
                    <span className={tone(token.change24h)}>24h {signed(token.change24h)}</span>
                    <span className={tone(token.change7d)}>7d {signed(token.change7d)}</span>
                  </div>
                  {token.symbol === "USDD" && token.price !== null ? (
                    <div className={`text-xs ${Math.abs(token.price - 1) * 100 >= data.settings.usddDepegPct ? "text-red-600" : "text-muted-foreground"}`}>
                      偏离锚定 {signed((token.price - 1) * 100, 3)}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        数据来自 CoinGecko，云端每轮定时任务（北京时间 9–21 点每 2 小时及 3 点）同步小时级价格；
        最近更新 {data.updatedAt ? bjTime(data.updatedAt) : "—"}。生态指数 = {data.tronIndex.join("/")} 等权（USDD 为稳定币不计入），大盘 = {data.benchmark.join("/")} 等权，超额收益 = TRX − 大盘。小图为近 7 天走势。
      </p>
    </div>
  );
}

function Linkage() {
  const [days, setDays] = useState(30);
  const [showAll, setShowAll] = useState(false);
  const { data, isLoading } = trpc.market.linkage.useQuery({ days }, { staleTime: 60_000 });
  // Newest first by publication time (the API still includes every high-threat event).
  const events = [...(data?.events || [])].sort((a, b) => b.publishedAt - a.publishedAt);
  const step = data?.step ?? 3_600_000;
  const chart = (data?.chart || []).map(row => ({ ...row, label: bjTime(row.t, step < 86_400_000) }));
  // 行业大事 markers (行业动态 module): pinned to the chart bucket they fall in, numbered in time order.
  const { data: markerData } = trpc.industry.markers.useQuery({ days }, { staleTime: 300_000 });
  const markers = useMemo(() => {
    if (!chart.length) return [];
    const picked = [...(markerData || [])].sort((a, b) => b.importance - a.importance || b.t - a.t).slice(0, 12)
      .sort((a, b) => a.t - b.t);
    return picked.map((m, i) => {
      let row = chart[0];
      for (const r of chart) if (r.t <= m.t) row = r;
      return { ...m, n: i + 1, x: row.label, inRange: m.t >= chart[0].t };
    }).filter(m => m.inRange);
  }, [markerData, chart]);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">走势与舆情</h2>
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <SelectTrigger className="w-[120px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="7">近 7 天</SelectItem>
            <SelectItem value="30">近 30 天</SelectItem>
            <SelectItem value="90">近 90 天</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">TRX、生态指数与大盘（起点 = 100）· 负面舆情量</CardTitle>
        </CardHeader>
        <CardContent className="h-[340px]">
          {isLoading ? <p className="text-sm text-muted-foreground">加载中…</p> : (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chart}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" fontSize={11} minTickGap={24} />
                <YAxis yAxisId="level" domain={["auto", "auto"]} fontSize={11} />
                <YAxis yAxisId="count" orientation="right" allowDecimals={false} fontSize={11} />
                <Tooltip />
                <Legend />
                <Bar yAxisId="count" dataKey="negatives" name="负面舆情" fill="#fca5a5" />
                <Bar yAxisId="count" dataKey="highThreats" name="高威胁" fill="#dc2626" />
                <Line yAxisId="level" type="monotone" dataKey="trx" name="TRX" stroke="#e11d48" dot={false} strokeWidth={2} connectNulls />
                <Line yAxisId="level" type="monotone" dataKey="tronIndex" name="TRON 生态指数" stroke="#f59e0b" dot={false} connectNulls />
                <Line yAxisId="level" type="monotone" dataKey="benchmark" name="大盘" stroke="#64748b" dot={false} connectNulls />
                <Line yAxisId="level" type="monotone" dataKey="relative" name="TRX 相对大盘" stroke="#2563eb" dot={false} strokeDasharray="4 3" connectNulls />
                {markers.map(m => (
                  <ReferenceLine key={m.n} yAxisId="level" x={m.x} stroke={m.importance >= 5 ? "#7c3aed" : "#a78bfa"} strokeDasharray="2 3"
                    label={{ value: String(m.n), position: "insideTopLeft", fontSize: 10, fill: "#7c3aed" }} />
                ))}
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
      {markers.length ? (
        <Card>
          <CardContent className="py-3 text-xs space-y-1">
            <div className="font-medium text-sm mb-1">图中紫色竖线：行业大事 <Link href="/industry" className="text-muted-foreground font-normal underline">行业动态</Link></div>
            {markers.map(m => (
              <div key={m.n} className="flex gap-2">
                <span className="text-violet-700 w-4 shrink-0">{m.n}</span>
                <span className="text-muted-foreground w-[78px] shrink-0">{bjTime(m.t)}</span>
                <a href={m.url} target="_blank" rel="noreferrer" className="hover:underline">{m.label}</a>
                <span className="text-muted-foreground shrink-0 ml-auto">{m.category}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
      {days > 30 ? <p className="text-xs text-muted-foreground -mt-2">舆情文章保留 30 天，更早的时段只有币价。</p> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">USDD 锚定</CardTitle></CardHeader>
          <CardContent className="h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chart}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" fontSize={11} minTickGap={24} />
                <YAxis domain={[0.98, 1.02]} fontSize={11} tickFormatter={(v: number) => v.toFixed(3)} />
                <Tooltip />
                <ReferenceLine y={1} stroke="#16a34a" />
                <ReferenceLine y={1.005} stroke="#f97316" strokeDasharray="3 3" />
                <ReferenceLine y={0.995} stroke="#f97316" strokeDasharray="3 3" />
                <Line type="monotone" dataKey="usdd" name="USDD" stroke="#0ea5e9" dot={false} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">负面舆情与 TRX 超额收益（近 30 天，按日）</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            {data ? (
              <>
                <div className="grid grid-cols-2 gap-3">
                  {([["当天", data.correlation.sameDay], ["次日", data.correlation.nextDay]] as const).map(([label, c]) => (
                    <div key={label} className="rounded-md border p-3">
                      <div className="text-muted-foreground">负面量 vs {label}超额收益</div>
                      <div className="text-2xl font-semibold">{c.r === null ? "—" : c.r.toFixed(2)}</div>
                      <div className="text-xs text-muted-foreground">相关系数 r · {c.n} 天</div>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground leading-5">
                  r 接近 −1 表示负面越多、TRX 越跑输大盘；|r| &lt; 0.3 基本无关。样本少于 20 天或个别大事件都会让结果不稳，
                  相关也不等于因果，请结合下方事件表逐条判断。
                </p>
                <div className="grid grid-cols-3 gap-2 text-center">
                  {data.eventSummary.map(s => (
                    <div key={s.level} className="col-span-3 grid grid-cols-4 gap-2 items-center rounded border px-2 py-1.5">
                      <span className="text-left">{THREAT_META[s.level]?.label || s.level}（{s.count}）</span>
                      <span className={tone(s.after1h)}>1h {signed(s.after1h)}</span>
                      <span className={tone(s.after4h)}>4h {signed(s.after4h)}</span>
                      <span className={tone(s.after24h)}>24h {signed(s.after24h)}</span>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">上表为事件发生后 TRX 相对大盘的平均超额收益。</p>
              </>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">事件影响（中/高威胁负面舆情发布后 TRX 超额收益）</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-muted-foreground">
              <tr className="border-b">
                <th className="text-left py-2 w-[110px]">发布时间</th><th className="text-left">事件</th>
                <th className="text-right w-[70px]">1 小时</th><th className="text-right w-[70px]">4 小时</th><th className="text-right w-[70px]">24 小时</th>
              </tr>
            </thead>
            <tbody>
              {(showAll ? events : events.slice(0, 30)).map(event => (
                <tr key={event.id} className="border-b last:border-0 align-top">
                  <td className="py-2 text-muted-foreground">{bjTime(event.publishedAt)}</td>
                  <td className="py-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline" style={{ color: THREAT_META[event.threatLevel || ""]?.color }}>
                        {THREAT_META[event.threatLevel || ""]?.label || event.threatLevel}
                      </Badge>
                      <Badge variant="secondary">{SOURCE_PLATFORM_META[event.sourcePlatform || ""]?.label || event.sourcePlatform}</Badge>
                      <a href={event.url} target="_blank" rel="noreferrer" title={event.title || event.url}
                        className="hover:underline line-clamp-2 min-w-0 flex-1 basis-[240px]">{event.title || event.url}</a>
                    </div>
                  </td>
                  <td className={`text-right ${tone(event.after1h)}`}>{signed(event.after1h)}</td>
                  <td className={`text-right ${tone(event.after4h)}`}>{signed(event.after4h)}</td>
                  <td className={`text-right ${tone(event.after24h)}`}>{signed(event.after24h)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && data.events.length === 0 ? <p className="text-sm text-muted-foreground text-center py-6">该时段没有中高威胁的负面舆情</p> : null}
          {events.length > 30 ? (
            <div className="text-center pt-2">
              <Button variant="outline" size="sm" onClick={() => setShowAll(!showAll)}>
                {showAll ? "收起" : `展开全部 ${events.length} 条`}
              </Button>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground mt-2">“—” 表示窗口尚未结束或该时段缺价格。多个事件挨得很近时，它们的影响会互相叠加。</p>
        </CardContent>
      </Card>
    </div>
  );
}

function AlertSettings() {
  const { isAdmin } = useRole();
  const utils = trpc.useUtils();
  const { data } = trpc.market.overview.useQuery(undefined, { staleTime: 60_000 });
  const [form, setForm] = useState({ enabled: false, usddDepegPct: "0.5", trxExcessDropPct: "5" });
  useEffect(() => {
    if (data) setForm({
      enabled: data.settings.enabled,
      usddDepegPct: String(data.settings.usddDepegPct),
      trxExcessDropPct: String(data.settings.trxExcessDropPct),
    });
  }, [data]);
  const save = trpc.market.setAlertSettings.useMutation({
    onSuccess: () => { toast.success("已保存提醒设置"); utils.market.overview.invalidate(); },
    onError: (error) => toast.error(error.message),
  });
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">异动与脱锚提醒（Telegram）</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex items-center gap-3">
          <Switch checked={form.enabled} disabled={!isAdmin} onCheckedChange={(enabled) => setForm({ ...form, enabled })} />
          <span>{form.enabled ? "已开启" : "已关闭"}</span>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1">
            <span className="text-muted-foreground">USDD 偏离 1 美元超过（%）</span>
            <Input value={form.usddDepegPct} disabled={!isAdmin} onChange={(e) => setForm({ ...form, usddDepegPct: e.target.value })} />
          </label>
          <label className="space-y-1">
            <span className="text-muted-foreground">TRX 24 小时跑输大盘超过（%）</span>
            <Input value={form.trxExcessDropPct} disabled={!isAdmin} onChange={(e) => setForm({ ...form, trxExcessDropPct: e.target.value })} />
          </label>
        </div>
        <p className="text-xs text-muted-foreground leading-5">
          每轮定时任务检查一次。USDD 脱锚期间每 24 小时提醒一次，回到区间后报一次恢复；TRX 异动最多每 12 小时提醒一次，并附同时段的主要负面舆情。
        </p>
        {isAdmin ? (
          <Button
            size="sm"
            disabled={save.isPending}
            onClick={() => save.mutate({
              enabled: form.enabled,
              usddDepegPct: Number(form.usddDepegPct),
              trxExcessDropPct: Number(form.trxExcessDropPct),
            })}
          >保存</Button>
        ) : <p className="text-xs text-muted-foreground">仅管理员可修改。</p>}
      </CardContent>
    </Card>
  );
}

export default function MarketLinkage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">币价联动</h1>
        <p className="text-muted-foreground text-sm mt-1">TRON 生态币种走势、相对大盘的超额收益，以及与舆情事件的关系</p>
      </div>
      <Overview />
      <Linkage />
      <AlertSettings />
    </div>
  );
}
