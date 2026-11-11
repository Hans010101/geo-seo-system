import { trpc } from "@/lib/trpc";
import { useRole } from "@/hooks/useRole";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useMemo, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { toast } from "sonner";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const CATEGORY_TONE: Record<string, string> = {
  regulation: "bg-violet-50 text-violet-700 border-violet-200",
  macro: "bg-amber-50 text-amber-700 border-amber-200",
  stablecoin: "bg-emerald-50 text-emerald-700 border-emerald-200",
  exchange: "bg-sky-50 text-sky-700 border-sky-200",
  chain: "bg-indigo-50 text-indigo-700 border-indigo-200",
  institution: "bg-teal-50 text-teal-700 border-teal-200",
  tokenization: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200",
  security: "bg-red-50 text-red-700 border-red-200",
  market: "bg-slate-50 text-slate-700 border-slate-200",
  other: "bg-zinc-50 text-zinc-600 border-zinc-200",
};
const ENTITY_LABEL: Record<string, string> = { tron: "TRON", binance: "Binance", solana: "Solana", tether: "Tether", circle: "Circle", ethereum: "以太坊" };
const CHAIN_COLORS: Record<string, string> = { tron: "#dc2626", ethereum: "#6366f1", solana: "#14b8a6", bsc: "#eab308", plasma: "#0ea5e9", stable: "#64748b", arc: "#a855f7" };

const bjTime = (ms: number, withDate = true) => {
  const text = new Date(ms + 8 * 3_600_000).toISOString();
  return withDate ? `${text.slice(5, 10)} ${text.slice(11, 16)}` : text.slice(11, 16);
};
const bjDay = (ms: number) => new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10);
const signed = (v: number | null | undefined, unit = "%", digits = 2) =>
  v === null || v === undefined ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(digits)}${unit}`;
const tone = (v: number | null | undefined) => (v === null || v === undefined ? "text-muted-foreground" : v > 0 ? "text-green-600" : v < 0 ? "text-red-600" : "");
const usd = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : v >= 1e8 ? `${(v / 1e8).toFixed(v >= 1e10 ? 0 : 1)} 亿` : v >= 1e4 ? `${Math.round(v / 1e4)} 万` : v.toFixed(0);

function Stars({ n }: { n: number }) {
  return <span className={n >= 5 ? "text-red-600" : n >= 4 ? "text-orange-500" : "text-muted-foreground"} title={`重要性 ${n}`}>{"●".repeat(n)}<span className="opacity-20">{"●".repeat(5 - n)}</span></span>;
}

type NewsItem = {
  id: string; url: string; summary: string; title: string; publishedAt: number; category: string; categoryLabel: string;
  importance: number; entities: string[]; tron: number; tronNote: string; sourceCount: number; sourceList: string[]; sourceLabel: string;
};

function NewsRow({ item, compact = false }: { item: NewsItem; compact?: boolean }) {
  return (
    <div className={`py-2.5 border-b last:border-0 ${item.tron >= 1 ? "bg-yellow-50/70 -mx-2 px-2 rounded" : ""}`}>
      <div className="flex items-start gap-2">
        <span className="text-xs text-muted-foreground w-[78px] shrink-0 pt-0.5 tabular-nums">{compact ? bjTime(item.publishedAt) : bjTime(item.publishedAt)}</span>
        <div className="min-w-0 flex-1">
          <a href={item.url} target="_blank" rel="noreferrer" className="text-sm leading-snug hover:underline">{item.summary}</a>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <Stars n={item.importance} />
            <Badge variant="outline" className={`text-[11px] px-1.5 py-0 ${CATEGORY_TONE[item.category] || ""}`}>{item.categoryLabel}</Badge>
            {item.entities.filter(e => e !== "tron").map(e => <Badge key={e} variant="secondary" className="text-[11px] px-1.5 py-0">{ENTITY_LABEL[e] || e}</Badge>)}
            <span>{item.sourceList.slice(0, 3).join(" · ")}{item.sourceCount > 1 ? `（${item.sourceCount} 家报道）` : ""}</span>
          </div>
          {item.tronNote ? <div className="mt-1 text-xs text-amber-800">与 TRON：{item.tronNote}</div> : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 快讯
function NewsTab() {
  const { isAdmin } = useRole();
  const utils = trpc.useUtils();
  const [days, setDays] = useState(1);
  const [category, setCategory] = useState("all");
  const [entity, setEntity] = useState("all");
  const [minImportance, setMinImportance] = useState(3);
  const [tronOnly, setTronOnly] = useState(false);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const input = {
    days, minImportance, tronOnly, q: q || undefined, limit: 50, offset: page * 50,
    category: category === "all" ? undefined : category, entity: entity === "all" ? undefined : entity,
  };
  const { data, isLoading } = trpc.industry.list.useQuery(input, { staleTime: 60_000 });
  const { data: status } = trpc.industry.status.useQuery(undefined, { staleTime: 60_000 });
  const triage = trpc.industry.triageNow.useMutation({
    onSuccess: r => {
      if (r.busy) toast.info("后台正在分拣，稍后刷新即可");
      else toast.success(`已分拣：保留 ${r.kept}，合并重复 ${r.dups}，忽略 ${r.skipped}`);
      utils.industry.invalidate();
    },
    onError: e => toast.error(e.message),
  });
  const setAlerts = trpc.industry.setAlerts.useMutation({ onSuccess: () => utils.industry.status.invalidate() });
  const reset = () => setPage(0);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 grid-cols-2 md:grid-cols-5">
        {(data?.categories || []).filter(c => c.n > 0).sort((a, b) => b.n - a.n).slice(0, 5).map(c => (
          <button key={c.key} onClick={() => { setCategory(category === c.key ? "all" : c.key); reset(); }}
            className={`text-left rounded-lg border p-3 transition ${category === c.key ? "ring-2 ring-primary" : "hover:bg-muted/50"}`}>
            <div className="text-xs text-muted-foreground">{c.label}</div>
            <div className="text-xl font-semibold">{c.n}<span className="text-xs font-normal text-muted-foreground ml-1">条 · 重要 {c.major}</span></div>
          </button>
        ))}
      </div>
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base mr-auto">行业快讯 <span className="text-sm font-normal text-muted-foreground">共 {data?.total ?? "—"} 条（重复报道已合并，黄色为 TRON 相关）</span></CardTitle>
            <Select value={String(days)} onValueChange={v => { setDays(Number(v)); reset(); }}>
              <SelectTrigger className="w-[110px] h-8"><SelectValue /></SelectTrigger>
              <SelectContent>{[1, 3, 7, 30].map(d => <SelectItem key={d} value={String(d)}>{d === 1 ? "近 24 小时" : `近 ${d} 天`}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={category} onValueChange={v => { setCategory(v); reset(); }}>
              <SelectTrigger className="w-[130px] h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部方向</SelectItem>
                {(data?.categories || []).map(c => <SelectItem key={c.key} value={c.key}>{c.label}（{c.n}）</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={entity} onValueChange={v => { setEntity(v); reset(); }}>
              <SelectTrigger className="w-[130px] h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部主体</SelectItem>
                {(data?.entities || []).map(e => <SelectItem key={e.key} value={e.key}>{e.label}（{e.n}）</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={String(minImportance)} onValueChange={v => { setMinImportance(Number(v)); reset(); }}>
              <SelectTrigger className="w-[120px] h-8"><SelectValue /></SelectTrigger>
              <SelectContent>{[1, 3, 4, 5].map(n => <SelectItem key={n} value={String(n)}>{n === 1 ? "全部重要性" : `${n} 级及以上`}</SelectItem>)}</SelectContent>
            </Select>
            <label className="flex items-center gap-1.5 text-sm"><Switch checked={tronOnly} onCheckedChange={v => { setTronOnly(v); reset(); }} />仅 TRON 相关</label>
            <Input value={q} onChange={e => { setQ(e.target.value); reset(); }} placeholder="搜索" className="w-[140px] h-8" />
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? <div className="py-10 text-center text-sm text-muted-foreground">加载中…</div> :
            !data?.items.length ? <div className="py-10 text-center text-sm text-muted-foreground">暂无符合条件的快讯</div> :
            <div className="px-2">{data.items.map(item => <NewsRow key={item.id} item={item} />)}</div>}
          {data && data.total > 50 ? (
            <div className="flex items-center justify-end gap-2 pt-3 text-sm">
              <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</Button>
              <span className="text-muted-foreground">{page + 1} / {Math.ceil(data.total / 50)}</span>
              <Button size="sm" variant="outline" disabled={(page + 1) * 50 >= data.total} onClick={() => setPage(page + 1)}>下一页</Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="py-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
          <span>采集：{status?.fetch?.at ? `${bjTime(status.fetch.at)}（本次新增 ${status.fetch.inserted}）` : "尚未收到"}</span>
          <span>分拣：{status?.triage?.at ? `${bjTime(status.triage.at)}（保留 ${status.triage.kept}，合并 ${status.triage.dups}）` : "—"}</span>
          <span>最新一条 {status?.latest ? bjTime(status.latest) : "—"}</span>
          <span>待分拣 {status?.pending ?? "—"} 条</span>
          <span>近 24 小时原始 {status?.last24h?.raw ?? "—"} 条 → 保留 {status?.last24h?.kept ?? "—"} 条</span>
          {isAdmin ? (
            <span className="flex items-center gap-3 ml-auto">
              <label className="flex items-center gap-1.5">
                <Switch checked={!!status?.settings.alertsEnabled} onCheckedChange={v => setAlerts.mutate({ enabled: v })} />
                重大事件告警（5 级事件、BTC±8%、纳指跌 3%、美债收益率单日 ±0.15%）
              </label>
              <Button size="sm" variant="outline" disabled={triage.isPending} onClick={() => triage.mutate()}>{triage.isPending ? "分拣中…" : "立即分拣"}</Button>
            </span>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- 宏观
function MiniSpark({ values }: { values: (number | null)[] }) {
  const pts = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null);
  if (pts.length < 2) return <div className="h-8" />;
  const ys = pts.map(p => p[1]);
  const lo = Math.min(...ys), hi = Math.max(...ys), span = hi - lo || 1;
  const line = pts.map(([i, v]) => `${((i / (values.length - 1)) * 100).toFixed(2)},${(30 - ((v - lo) / span) * 28).toFixed(2)}`).join(" ");
  const up = ys[ys.length - 1] >= ys[0];
  return <svg viewBox="0 0 100 32" preserveAspectRatio="none" className="w-full h-8"><polyline points={line} fill="none" stroke={up ? "#16a34a" : "#dc2626"} strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg>;
}

function MacroTab() {
  const { data } = trpc.industry.macro.useQuery(undefined, { staleTime: 120_000 });
  const fng = data?.fng[data.fng.length - 1];
  return (
    <div className="space-y-4">
      <div className="grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        {(data?.macro || []).map(m => {
          const bp = m.unit === "%";
          return (
            <Card key={m.symbol}><CardContent className="p-3">
              <div className="text-xs text-muted-foreground">{m.name}</div>
              <div className="text-lg font-semibold tabular-nums">{m.price === null ? "—" : bp ? `${m.price.toFixed(2)}%` : m.price >= 1000 ? Math.round(m.price).toLocaleString("en-US") : m.price.toFixed(2)}</div>
              <div className="text-xs flex gap-2 tabular-nums">
                <span className={tone(m.change1d)}>日 {signed(m.change1d)}</span>
                <span className={tone(m.change7d)}>周 {signed(m.change7d)}</span>
              </div>
              <MiniSpark values={m.spark} />
              <div className="text-[11px] text-muted-foreground">{m.at ? `截至 ${bjTime(m.at)} · 30 日` : "暂无数据"}</div>
            </CardContent></Card>
          );
        })}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">美联储利率预期 <span className="text-sm font-normal text-muted-foreground">Polymarket</span></CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {!data?.fed?.events.length ? <div className="text-sm text-muted-foreground">暂无数据</div> : data.fed.events.slice(0, 3).map(e => (
              <div key={e.url}>
                <a href={e.url} target="_blank" rel="noreferrer" className="text-sm font-medium hover:underline">{e.title}</a>
                <span className="text-xs text-muted-foreground ml-2">结算 {e.endDate.slice(0, 10)}</span>
                <div className="mt-1.5 space-y-1">
                  {e.outcomes.map(o => (
                    <div key={o.label} className="flex items-center gap-2 text-xs">
                      <span className="w-40 truncate">{o.label}</span>
                      <div className="flex-1 h-2 bg-muted rounded"><div className="h-2 rounded bg-amber-500" style={{ width: `${Math.min(100, o.prob)}%` }} /></div>
                      <span className="w-10 text-right tabular-nums">{Math.round(o.prob)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {data?.fed?.at ? <div className="text-[11px] text-muted-foreground">更新于 {bjTime(data.fed.at)}</div> : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">恐慌贪婪指数 <span className="text-sm font-normal text-muted-foreground">{fng ? `${fng.value}（${fng.value >= 75 ? "极度贪婪" : fng.value >= 55 ? "贪婪" : fng.value > 45 ? "中性" : fng.value > 25 ? "恐慌" : "极度恐慌"}）` : ""}</span></CardTitle></CardHeader>
          <CardContent>
            <div className="h-[180px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data?.fng || []} margin={{ left: -20, right: 8, top: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="day" tickFormatter={d => String(d).slice(5)} fontSize={11} />
                  <YAxis domain={[0, 100]} fontSize={11} />
                  <Tooltip />
                  <Line dataKey="value" name="指数" stroke="#f59e0b" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">近 7 天宏观要闻</CardTitle></CardHeader>
        <CardContent className="px-6">{!data?.news.length ? <div className="text-sm text-muted-foreground">暂无</div> : data.news.map(item => <NewsRow key={item.id} item={item} />)}</CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- 竞品
function CompetitorsTab() {
  const { data } = trpc.industry.competitors.useQuery(undefined, { staleTime: 300_000 });
  const [metric, setMetric] = useState<"stable" | "usdt">("stable");
  const chainKeys = (data?.chains || []).map(c => c.key);
  const trend = metric === "stable" ? data?.stableTrend : data?.usdtTrend;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        {(data?.issuers || []).map(i => (
          <Card key={i.key}><CardContent className="p-3">
            <div className="text-xs text-muted-foreground">{i.label}</div>
            <div className="text-lg font-semibold">{usd(i.value)}<span className="text-xs font-normal text-muted-foreground ml-1">美元</span></div>
            <div className="text-xs flex gap-2"><span className={tone(i.change7d)}>7 日 {signed(i.change7d)}</span><span className={tone(i.change30d)}>30 日 {signed(i.change30d)}</span></div>
          </CardContent></Card>
        ))}
      </div>
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">稳定币通道对比 <span className="text-sm font-normal text-muted-foreground">DefiLlama · 截至 {data?.latestDay || "—"}</span></CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground border-b">
              <tr>
                <th className="text-left py-2 font-normal">链</th>
                <th className="text-right font-normal">稳定币</th><th className="text-right font-normal">份额</th>
                <th className="text-right font-normal">7 日</th><th className="text-right font-normal">30 日</th>
                <th className="text-right font-normal">USDT</th><th className="text-right font-normal">USDT 份额</th>
                <th className="text-right font-normal">USDC</th><th className="text-right font-normal">TVL</th>
                <th className="text-right font-normal">日手续费</th><th className="text-right font-normal">代币 7 日 / 30 日</th>
              </tr>
            </thead>
            <tbody>
              {(data?.chains || []).map(c => (
                <tr key={c.key} className={`border-b last:border-0 ${c.key === "tron" ? "bg-red-50/50 font-medium" : ""}`}>
                  <td className="py-2">{c.label}</td>
                  <td className="text-right tabular-nums">{usd(c.stablecoins)}</td>
                  <td className="text-right tabular-nums">{c.stableShare === null ? "—" : `${c.stableShare}%`}</td>
                  <td className={`text-right tabular-nums ${tone(c.stable7d)}`}>{signed(c.stable7d)}</td>
                  <td className={`text-right tabular-nums ${tone(c.stable30d)}`}>{signed(c.stable30d)}</td>
                  <td className="text-right tabular-nums">{usd(c.usdt)}</td>
                  <td className="text-right tabular-nums">{c.usdtShare === null ? "—" : `${c.usdtShare}%`}</td>
                  <td className="text-right tabular-nums">{usd(c.usdc)}</td>
                  <td className="text-right tabular-nums">{usd(c.tvl)}</td>
                  <td className="text-right tabular-nums">{c.fees24h === null ? "—" : `$${usd(c.fees24h)}`}</td>
                  <td className="text-right tabular-nums">{c.token ? <><span className={tone(c.token7d)}>{signed(c.token7d, "%", 1)}</span> / <span className={tone(c.token30d)}>{signed(c.token30d, "%", 1)}</span></> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="text-[11px] text-muted-foreground mt-2">金额单位：美元。Plasma、Stable 为 Tether 体系扶持的稳定币链，Arc 为 Circle 自有链，与 TRON 的 USDT 转账场景直接竞争。</div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base mr-auto">近 90 天走势</CardTitle>
            <Button size="sm" variant={metric === "stable" ? "default" : "outline"} onClick={() => setMetric("stable")}>稳定币总量</Button>
            <Button size="sm" variant={metric === "usdt" ? "default" : "outline"} onClick={() => setMetric("usdt")}>USDT</Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="h-[280px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trend || []} margin={{ left: 0, right: 8, top: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="day" tickFormatter={d => String(d).slice(5)} fontSize={11} minTickGap={24} />
                <YAxis scale="log" domain={["auto", "auto"]} tickFormatter={v => usd(Number(v))} fontSize={11} width={56} allowDataOverflow />
                <Tooltip formatter={(v: number) => `${usd(v)} 美元`} />
                <Legend />
                {chainKeys.map(k => <Line key={k} dataKey={k} name={data?.chains.find(c => c.key === k)?.label} stroke={CHAIN_COLORS[k] || "#888"} dot={false} strokeWidth={k === "tron" ? 2.5 : 1.5} connectNulls />)}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="text-[11px] text-muted-foreground">对数坐标，便于同图比较体量差距很大的链。</div>
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        {(data?.timelines || []).map(t => (
          <Card key={t.key}>
            <CardHeader className="pb-1"><CardTitle className="text-base">{t.label} <span className="text-sm font-normal text-muted-foreground">近 30 天 {t.total} 条动向</span></CardTitle></CardHeader>
            <CardContent className="px-6">{!t.items.length ? <div className="text-sm text-muted-foreground py-2">暂无</div> : t.items.map(item => <NewsRow key={item.id} item={item} compact />)}</CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 周报
function WeeklyTab({ id }: { id?: string }) {
  const { isAdmin } = useRole();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const { data: list } = trpc.industry.weeklyList.useQuery(undefined, { staleTime: 120_000 });
  const current = id || list?.[0]?.id;
  const { data } = trpc.industry.weekly.useQuery({ id: current || "0000-00-00" }, { enabled: !!current });
  const gen = trpc.industry.generateWeekly.useMutation({
    onSuccess: r => { toast.success("行业周报已生成"); utils.industry.weeklyList.invalidate(); navigate(`/industry/weekly/${r.id}`); },
    onError: e => toast.error(e.message),
  });
  return (
    <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
      <Card className="h-fit">
        <CardContent className="p-2 space-y-1">
          {isAdmin ? <Button size="sm" className="w-full mb-2" disabled={gen.isPending} onClick={() => gen.mutate()}>{gen.isPending ? "生成中（约 1 分钟）…" : "生成本周周报"}</Button> : null}
          {!list?.length ? <div className="text-sm text-muted-foreground p-2">每周五 19:15 自动生成</div> : list.map(w => (
            <button key={w.id} onClick={() => navigate(`/industry/weekly/${w.id}`)}
              className={`w-full text-left rounded p-2 text-sm ${w.id === current ? "bg-muted font-medium" : "hover:bg-muted/50"}`}>
              <div>{bjDay(w.from).slice(5)} — {bjDay(w.to).slice(5)}</div>
              <div className="text-xs text-muted-foreground line-clamp-2">{w.headline}</div>
            </button>
          ))}
        </CardContent>
      </Card>
      {!data ? <Card><CardContent className="py-16 text-center text-sm text-muted-foreground">暂无周报</CardContent></Card> : (
        <Card>
          <CardContent className="p-6 space-y-5">
            <div>
              <div className="text-xs text-muted-foreground">行业周报 · {bjDay(data.from)} 至 {bjDay(data.to)}</div>
              <h2 className="text-xl font-bold mt-1">{data.headline}</h2>
              <p className="text-sm leading-relaxed mt-2">{data.overview}</p>
            </div>
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
              <div className="rounded bg-yellow-50 p-3">
                <div className="text-sm font-semibold mb-1">对 TRON 的影响</div>
                <ul className="list-disc pl-5 text-sm space-y-0.5">{data.tron.map((p, i) => <li key={i}>{p}</li>)}</ul>
              </div>
              <div className="rounded bg-muted/60 p-3">
                <div className="text-sm font-semibold mb-1">下周关注</div>
                <ul className="list-disc pl-5 text-sm space-y-0.5">{data.watch.map((p, i) => <li key={i}>{p}</li>)}</ul>
              </div>
            </div>
            <div>
              <div className="text-sm font-semibold mb-1">本周重要事件</div>
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
  );
}

const TABS = ["news", "macro", "competitors", "weekly"] as const;

export default function IndustryTrends() {
  const [, navigate] = useLocation();
  const [, tabParams] = useRoute("/industry/:tab");
  const [, weeklyParams] = useRoute("/industry/weekly/:id");
  const tab = weeklyParams ? "weekly" : (TABS as readonly string[]).includes(tabParams?.tab || "") ? tabParams!.tab : "news";
  const weeklyId = useMemo(() => weeklyParams?.id, [weeklyParams?.id]);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">行业动态</h1>
        <p className="text-sm text-muted-foreground mt-1">加密 / web3 行业快讯、影响加密市场的宏观金融大事，以及 Binance、Solana、Tether、Circle、以太坊等竞品动向。每小时采集，AI 分类、去重并评估与 TRON 的关联。</p>
      </div>
      <Tabs value={tab} onValueChange={v => navigate(v === "news" ? "/industry" : `/industry/${v}`)}>
        <TabsList>
          <TabsTrigger value="news">行业快讯</TabsTrigger>
          <TabsTrigger value="macro">宏观仪表</TabsTrigger>
          <TabsTrigger value="competitors">竞品看板</TabsTrigger>
          <TabsTrigger value="weekly">行业周报</TabsTrigger>
        </TabsList>
        <TabsContent value="news" className="mt-4"><NewsTab /></TabsContent>
        <TabsContent value="macro" className="mt-4"><MacroTab /></TabsContent>
        <TabsContent value="competitors" className="mt-4"><CompetitorsTab /></TabsContent>
        <TabsContent value="weekly" className="mt-4"><WeeklyTab id={weeklyId} /></TabsContent>
      </Tabs>
    </div>
  );
}
