import { trpc } from "@/lib/trpc";
import { useRole } from "@/hooks/useRole";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLocation, useRoute } from "wouter";
import { toast } from "sonner";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";

type Brief = NonNullable<inferRouterOutputs<AppRouter>["briefs"]["get"]>;
type Series = [number, number][];

const HOUR = 3_600_000;
const hhmm = (ms: number) => new Date(ms + 8 * HOUR).toISOString().slice(11, 16);
const mmddhhmm = (ms: number) => { const s = new Date(ms + 8 * HOUR).toISOString(); return `${s.slice(5, 10)} ${s.slice(11, 16)}`; };
const signed = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
const price = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v >= 0.01 ? `$${v.toFixed(4)}` : `$${v.toExponential(3)}`);
const tone = (v: number | null | undefined) => (v === null || v === undefined ? "" : v >= 0 ? "text-green-600" : "text-red-600");

const LIGHT: Record<string, { icon: string; bg: string }> = {
  平稳: { icon: "🟢", bg: "bg-green-600" }, 关注: { icon: "🟡", bg: "bg-amber-600" },
  警戒: { icon: "🟠", bg: "bg-orange-600" }, 危机: { icon: "🔴", bg: "bg-red-700" },
};
const TREND: Record<string, { text: string; cls: string }> = {
  up: { text: "▲ 升温", cls: "text-red-600" }, down: { text: "▼ 缓和", cls: "text-green-600" },
  flat: { text: "● 持平", cls: "text-muted-foreground" }, new: { text: "◆ 新增", cls: "text-blue-600" },
  closed: { text: "✓ 结案", cls: "text-muted-foreground" },
};
const LEVEL_BG: Record<string, string> = { P1: "bg-red-600", P2: "bg-amber-600", P3: "bg-blue-600" };
const SOURCE_TAG: Record<string, string> = {
  媒体: "border-blue-500 text-blue-600", 公众号: "border-green-600 text-green-700", 网帖: "border-gray-400 text-muted-foreground",
};

function Heading({ children }: { children: React.ReactNode }) {
  return <h2 className="flex items-center gap-2 text-base font-bold mt-2"><span className="w-1 h-[18px] bg-red-600" />{children}</h2>;
}

/** TRX 24h line with high / low / latest marks. */
function PriceChart({ series }: { series: Series }) {
  if (series.length < 2) return <p className="text-sm text-muted-foreground">暂无价格数据</p>;
  const w = 560, h = 220, l = 50, r = 12, t = 16, b = 24;
  const vals = series.map(p => p[1]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo || hi * 0.01) * 0.15;
  lo -= pad; hi += pad;
  const X = (i: number) => l + ((w - l - r) * i) / (series.length - 1);
  const Y = (v: number) => t + (h - t - b) * (1 - (v - lo) / (hi - lo));
  const pts = vals.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  const marks = new Map<number, string>([[vals.indexOf(Math.max(...vals)), "高"], [vals.indexOf(Math.min(...vals)), "低"], [vals.length - 1, "最新"]]);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-auto" role="img" aria-label="TRX 近 24 小时走势">
      {[0, 1, 2, 3, 4].map(k => {
        const v = lo + ((hi - lo) * k) / 4;
        return <g key={k}><line x1={l} x2={w - r} y1={Y(v)} y2={Y(v)} className="stroke-border" />
          <text x={l - 6} y={Y(v) + 4} textAnchor="end" className="fill-muted-foreground text-[10px]">{v.toFixed(4)}</text></g>;
      })}
      {series.map((p, i) => (i % 4 === 0 || i === series.length - 1) && (
        <text key={p[0]} x={X(i)} y={h - 6} textAnchor="middle" className="fill-muted-foreground text-[10px]">{hhmm(p[0])}</text>
      ))}
      <polygon points={`${X(0)},${h - b} ${pts} ${X(vals.length - 1)},${h - b}`} className="fill-red-500/10" />
      <polyline points={pts} fill="none" className="stroke-red-600" strokeWidth={2.2} strokeLinejoin="round" />
      {Array.from(marks.entries()).map(([i, name]) => (
        <g key={i}><circle cx={X(i)} cy={Y(vals[i])} r={4} className="fill-background stroke-red-600" strokeWidth={2} />
          <text x={Math.min(X(i), w - 50)} y={Y(vals[i]) - 9} textAnchor="middle" className="fill-foreground text-[11px] font-semibold">{name} {vals[i].toFixed(4)}</text></g>
      ))}
    </svg>
  );
}

function Spark({ series, up }: { series: Series; up: boolean }) {
  if (series.length < 2) return <div className="h-14" />;
  const w = 220, h = 56;
  const vals = series.map(p => p[1]);
  const lo = Math.min(...vals), span = Math.max(...vals) - lo || 1;
  const X = (i: number) => 2 + ((w - 4) * i) / (vals.length - 1);
  const Y = (v: number) => 5 + (h - 10) * (1 - (v - lo) / span);
  const pts = vals.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full h-14">
      <polygon points={`${X(0)},${h} ${pts} ${X(vals.length - 1)},${h}`} className={up ? "fill-green-500/10" : "fill-red-500/10"} />
      <polyline points={pts} fill="none" strokeWidth={1.8} vectorEffect="non-scaling-stroke" className={up ? "stroke-green-600" : "stroke-red-600"} />
    </svg>
  );
}

function Mini({ title, days, series, kind, unit = "", note }: {
  title: string; days: string[]; series: { name: string; values: number[]; cls: string; text: string }[];
  kind: "bar" | "line"; unit?: string; note?: string;
}) {
  const w = 260, h = 120, l = 32, r = 8, t = 12, b = 20;
  const max = Math.max(1, ...series.flatMap(s => s.values)) * 1.15;
  const X = (i: number) => l + ((w - l - r) * (i + 0.5)) / days.length;
  const Y = (v: number) => t + (h - t - b) * (1 - v / max);
  const bw = ((w - l - r) / days.length) * 0.6;
  return (
    <figure className="m-0 border bg-card p-3 grid gap-1 min-w-0">
      <figcaption className="text-sm font-semibold">{title}</figcaption>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-auto">
        {[0, 1, 2].map(k => <g key={k}><line x1={l} x2={w - r} y1={Y((max * k) / 2)} y2={Y((max * k) / 2)} className="stroke-border" />
          <text x={l - 4} y={Y((max * k) / 2) + 3} textAnchor="end" className="fill-muted-foreground text-[9px]">{((max * k) / 2).toFixed(0)}{unit}</text></g>)}
        {days.map((d, i) => <text key={d} x={X(i)} y={h - 5} textAnchor="middle" className="fill-muted-foreground text-[9px]">{d.slice(3)}</text>)}
        {kind === "bar" ? series[0].values.map((v, i) => (
          <g key={i}><rect x={X(i) - bw / 2} y={Y(v)} width={bw} height={h - b - Y(v)} className={`${series[0].cls} ${i === days.length - 1 ? "opacity-40" : "opacity-85"}`} />
            <text x={X(i)} y={Y(v) - 3} textAnchor="middle" className="fill-foreground text-[9px]">{v}</text></g>
        )) : series.map(s => (
          <g key={s.name}><polyline fill="none" strokeWidth={2} className={s.cls} points={s.values.map((v, i) => `${X(i)},${Y(v)}`).join(" ")} />
            <text x={X(days.length - 1) + 2} y={Y(s.values[s.values.length - 1]) - 5} textAnchor="end" className={`${s.text} text-[9px] font-semibold`}>
              {s.name} {s.values[s.values.length - 1].toFixed(1)}{unit}</text></g>
        ))}
      </svg>
      {note ? <p className="text-xs text-muted-foreground m-0">{note}</p> : null}
    </figure>
  );
}

function BriefView({ brief }: { brief: Brief }) {
  const light = LIGHT[brief.verdict.level] || LIGHT["关注"];
  const k = brief.kpis;
  const m = brief.market;
  return (
    <div className="grid gap-5 max-w-[880px]">
      <header className="border-b-[3px] border-red-600 pb-2 grid gap-1">
        <h1 className="text-2xl font-extrabold tracking-tight">{brief.title}
          <span className="ml-2 text-sm font-medium text-muted-foreground">{brief.dateLabel} · 内部限阅</span></h1>
        <div className="flex flex-wrap gap-x-4 text-xs text-muted-foreground tabular-nums">
          <span>监测时段 {mmddhhmm(brief.windowStart)} → {mmddhhmm(brief.windowEnd)}</span>
          <span>生成 {mmddhhmm(brief.generatedAt)}</span><span>下一期 {brief.nextLabel}</span>
        </div>
      </header>

      <section className="grid sm:grid-cols-[auto_1fr] border bg-card">
        <div className={`${light.bg} text-white px-5 py-3 grid place-content-center text-center`}>
          <b className="text-xl">{light.icon} {brief.verdict.level}</b><span className="text-xs opacity-90">较上期 {brief.verdict.change}</span>
        </div>
        <div className="px-5 py-3 grid gap-2 min-w-0">
          <p className="m-0 font-bold text-[16px]">{brief.verdict.lead}</p>
          <ol className="m-0 pl-5 grid gap-1 text-sm list-decimal">
            {brief.verdict.points.map((p, i) => {
              const [head, ...rest] = p.split("：");
              return <li key={i}>{rest.length ? <><b>{head}：</b>{rest.join("：")}</> : p}</li>;
            })}
          </ol>
        </div>
      </section>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
        {[
          ["高威胁舆情", String(k.high), `中威胁 ${k.medium}（上一日同时段 ${k.mediumPrev}）`, ""],
          ["负面舆情", String(k.negative), `上一日同时段 ${k.negativePrev} · 相关 ${k.relevant} 条`, ""],
          ["TRX 价格", price(m?.trx.price), `24h ${signed(m?.trx.change24h)}`, ""],
          ["TRX 相对大盘", signed(m?.excess24h), `24h 超额；同期大盘 ${signed(m?.benchmark24h)}`, tone(m?.excess24h)],
        ].map(([label, value, sub, cls]) => (
          <div key={label} className="border bg-card px-3.5 py-3 grid gap-0.5 min-w-0">
            <span className="text-xs text-muted-foreground">{label}</span>
            <span className={`text-2xl font-semibold tabular-nums ${cls}`}>{value}</span>
            <span className="text-xs text-muted-foreground">{sub}</span>
          </div>
        ))}
      </section>

      {m ? <>
        <Heading>市场走势</Heading>
        <section className="grid md:grid-cols-[3fr_2fr] gap-2.5">
          <div className="border bg-card p-3.5 grid gap-1.5 min-w-0">
            <h4 className="m-0 text-sm font-semibold">TRX 近 24 小时（小时价，USD）</h4>
            <PriceChart series={m.trx.series as Series} />
            <p className="m-0 text-sm text-muted-foreground">{m.note}</p>
          </div>
          <div className="border bg-card p-3.5 grid grid-cols-2 gap-x-3 gap-y-2 content-start min-w-0">
            {m.coins.map(c => (
              <div key={c.symbol} className="grid min-w-0">
                <div className="flex items-baseline gap-1.5"><b className="text-sm">{c.symbol}</b>
                  <span className="text-[11px] text-muted-foreground flex-1 truncate">{c.name}</span>
                  <span className={`text-xs font-semibold tabular-nums ${tone(c.change24h)}`}>{signed(c.change24h)}</span></div>
                <div className="text-[15px] font-semibold tabular-nums">{price(c.price)}</div>
                <Spark series={c.series as Series} up={(c.change24h ?? 0) >= 0} />
              </div>
            ))}
            <p className="col-span-2 m-0 text-sm text-muted-foreground">{m.coinsNote}</p>
          </div>
        </section>
      </> : null}

      <Heading>事件追踪</Heading>
      {brief.events.map(e => (
        <article key={e.key} className="border bg-card grid">
          <header className="flex flex-wrap items-center gap-2.5 px-3.5 py-2.5 border-b">
            <span className={`${LEVEL_BG[e.level] || "bg-blue-600"} text-white text-xs font-semibold px-1.5`}>{e.level}</span>
            <h3 className="m-0 text-base font-semibold flex-1 min-w-[12em]">{e.title}</h3>
            <span className="text-xs text-muted-foreground tabular-nums">{e.count} 条{e.prevCount !== null ? `（上期 ${e.prevCount}）` : ""}</span>
            <span className={`text-sm font-semibold ${TREND[e.trend]?.cls || ""}`}>{TREND[e.trend]?.text || e.trend}</span>
          </header>
          <div className="grid sm:grid-cols-2 text-sm">
            <p className="m-0 px-3.5 py-2"><b className="block text-xs text-muted-foreground font-semibold">当前状态</b>{e.state}</p>
            <p className="m-0 px-3.5 py-2 bg-amber-50 dark:bg-amber-950/30"><b className="block text-xs text-muted-foreground font-semibold">升级条件</b>{e.escalate}</p>
          </div>
          <dl className="m-0 px-3.5 pt-1.5 pb-1 grid gap-1 text-sm">
            {([["发生了什么", e.happened], ["怎么看", e.view], ["还没确认", e.unconfirmed], [brief.kind === "pm" ? "明天看什么" : "今天看什么", e.next]] as const)
              .filter(([, v]) => v).map(([label, v]) => (
                <div key={label} className="grid sm:grid-cols-[6.5em_1fr] gap-x-2"><dt className="text-muted-foreground">{label}</dt><dd className="m-0 min-w-0">{v}</dd></div>
              ))}
          </dl>
          <ul className="list-none m-0 px-3.5 pt-1.5 pb-3 grid gap-1 text-[13px]">
            {e.sources.map(s => (
              <li key={s.url}><span className={`text-[11px] px-1 mr-1.5 border ${SOURCE_TAG[s.kind] || ""}`}>{s.kind}</span>
                <a href={s.url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline break-all">{s.label}</a></li>
            ))}
          </ul>
        </article>
      ))}
      {brief.events.length === 0 ? <p className="text-sm text-muted-foreground">本时段没有需要追踪的事件。</p> : null}

      {brief.others.length ? <>
        <Heading>其他动态</Heading>
        <section className="border bg-card">
          {brief.others.map((o, i) => (
            <div key={o.label} className={`grid sm:grid-cols-[6em_1fr] gap-x-2.5 px-3.5 py-2 text-sm ${i ? "border-t" : ""}`}>
              <b className="text-muted-foreground font-semibold">{o.label}</b><span className="min-w-0">{o.text}</span>
            </div>
          ))}
        </section>
      </> : null}

      <Heading>舆情趋势（近 7 日）</Heading>
      <section className="grid sm:grid-cols-2 gap-2.5">
        <Mini title="每日新发表条数" days={brief.trends.days} kind="bar"
          series={[{ name: "新发表", values: brief.trends.published, cls: "fill-red-600", text: "" }]} note="最后一天截至本期统计时间（浅色）" />
        <Mini title="负面内容占比" days={brief.trends.days} kind="line" unit="%"
          series={[{ name: "负面占比", values: brief.trends.negativeShare, cls: "stroke-red-600", text: "fill-red-600" }]} />
        <Mini title="中威胁条数" days={brief.trends.days} kind="bar"
          series={[{ name: "中威胁", values: brief.trends.medium, cls: "fill-red-600", text: "" }]} />
        <Mini title="AI 回答负面率" days={brief.trends.days} kind="line" unit="%" note="智推时代 · 每日约 195 条回答 / 平台"
          series={[
            { name: "豆包", values: brief.trends.geoDoubao, cls: "stroke-red-600", text: "fill-red-600" },
            { name: "DeepSeek", values: brief.trends.geoDeepseek, cls: "stroke-blue-600", text: "fill-blue-600" },
          ]} />
      </section>

      {brief.outlook ? (
        <section className="bg-red-50 dark:bg-red-950/30 border-l-4 border-red-600 px-4 py-3 grid gap-1 text-sm">
          <b>{brief.kind === "pm" ? "明日预判" : "今日预判"}</b><p className="m-0">{brief.outlook}</p>
        </section>
      ) : null}
    </div>
  );
}

function AdminBar() {
  const { isAdmin } = useRole();
  const utils = trpc.useUtils();
  const [, navigate] = useLocation();
  const { data: settings } = trpc.briefs.settings.useQuery(undefined, { enabled: isAdmin });
  const save = trpc.briefs.setSettings.useMutation({ onSuccess: () => { toast.success("已保存"); utils.briefs.settings.invalidate(); } });
  const generate = trpc.briefs.generate.useMutation({
    onSuccess: (r) => { toast.success("已生成"); utils.briefs.list.invalidate(); utils.briefs.get.invalidate(); navigate(`/briefs/${r.id}`); },
    onError: (e) => toast.error(e.message),
  });
  if (!isAdmin || !settings) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
      <label className="flex items-center gap-2"><Switch checked={settings.enabled} onCheckedChange={(v) => save.mutate({ enabled: v, push: settings.push })} />自动生成（09:20 / 17:45）</label>
      <label className="flex items-center gap-2"><Switch checked={settings.push} onCheckedChange={(v) => save.mutate({ enabled: settings.enabled, push: v })} />推送 Telegram</label>
      <Button size="sm" variant="outline" disabled={generate.isPending} onClick={() => generate.mutate({ kind: "am" })}>生成早报</Button>
      <Button size="sm" variant="outline" disabled={generate.isPending} onClick={() => generate.mutate({ kind: "pm" })}>生成晚报</Button>
      {generate.isPending ? <span className="text-muted-foreground">生成中，约需 1 分钟…</span> : null}
    </div>
  );
}

export default function DailyBriefs() {
  const [, params] = useRoute("/briefs/:id");
  const [, navigate] = useLocation();
  const { data: list } = trpc.briefs.list.useQuery(undefined, { staleTime: 60_000 });
  const id = params?.id || list?.[0]?.id;
  const { data: brief, isLoading } = trpc.briefs.get.useQuery({ id: id || "" }, { enabled: !!id });
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">早晚报</h1>
          <p className="text-muted-foreground text-sm mt-1">每日 09:20 早报、17:45 晚报，由系统汇总舆情、AI 回答与币价后自动生成</p>
        </div>
        {list && list.length ? (
          <Select value={id} onValueChange={(v) => navigate(`/briefs/${v}`)}>
            <SelectTrigger className="w-[240px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {list.map(b => (
                <SelectItem key={b.id} value={b.id}>{b.day} {b.kind === "am" ? "早报" : "晚报"} · {b.level}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>
      <AdminBar />
      {brief ? <BriefView brief={brief} /> : isLoading && id ? <p className="text-sm text-muted-foreground">加载中…</p>
        : <div className="border bg-card p-6 text-sm text-muted-foreground">还没有早晚报。系统会在每天 09:20、17:45 自动生成；管理员也可以点上方按钮立即生成。</div>}
      {brief ? <Badge variant="outline" className="text-muted-foreground font-normal">{brief.model} · {brief.events.length} 个事件</Badge> : null}
    </div>
  );
}
