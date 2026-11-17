// OpenRouter 主号 / 副号 (server/openrouter-accounts.ts): order, balance, pauses, last switch, 7-day GEO spend.
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertTriangle, Eye, EyeOff, Loader2, Plus, RefreshCw, Stethoscope, Wallet } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useRole } from "@/hooks/useRole";

const usd = (v: number | null | undefined, digits = 2) => (v == null ? "—" : `$${v.toFixed(digits)}`);
const time = (ms: number) => new Date(ms).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

export function useOpenRouterAccounts() {
  return trpc.globalApiKeys.openrouterAccounts.useQuery(undefined, { staleTime: 60_000, refetchInterval: 120_000 });
}

/** Banner for pages that start GEO batches: 主号 low on credit or paused → calls will go to the 副号. */
export function OpenRouterAccountsBanner() {
  const { data } = useOpenRouterAccounts();
  if (!data || (!data.primaryLow && !data.primaryPaused)) return null;
  const primary = data.accounts[0];
  const backup = data.accounts[1];
  const why = data.primaryPaused
    ? `主号「${primary?.name}」已暂停（${primary?.paused.find(p => p.model === "*")?.reason || "不可用"}）`
    : `主号「${primary?.name}」剩余 ${usd(primary?.balance.remaining)}，低于 ${usd(data.lowBalanceUsd, 0)}`;
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
      <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
      <span>
        {why}。{backup ? `采集会自动改走副号「${backup.name}」。` : "当前没有副号，余额用完后采集会失败。"}可在「平台配置 → OpenRouter 主号 / 副号」查看。
      </span>
    </div>
  );
}

export default function OpenRouterAccountsCard() {
  const { canEdit } = useRole();
  const utils = trpc.useUtils();
  const { data, isLoading, isFetching, refetch } = useOpenRouterAccounts();
  const clearPauses = trpc.globalApiKeys.clearOpenRouterPauses.useMutation({
    onSuccess: () => { toast.success("已解除暂停，下一次调用会先试主号"); utils.globalApiKeys.openrouterAccounts.invalidate(); },
    onError: (err) => toast.error(err.message),
  });

  const accounts = data?.accounts ?? [];
  const anyPaused = accounts.some(a => a.paused.length > 0);
  const refresh = () => {
    utils.globalApiKeys.openrouterAccounts.invalidate();
    utils.globalApiKeys.list.invalidate();
    utils.globalApiKeys.routePreview.invalidate();
  };
  const setPrimary = trpc.globalApiKeys.setOpenRouterPrimary.useMutation({
    onSuccess: () => { toast.success("主号已切换"); refresh(); },
    onError: (err) => toast.error(err.message),
  });
  const [form, setForm] = useState<{ name: string; apiKey: string; asPrimary: boolean } | null>(null);
  const [showKey, setShowKey] = useState(false);
  const addKey = trpc.globalApiKeys.addOpenRouterKey.useMutation({
    onSuccess: (res) => {
      toast.success(`已添加${form?.asPrimary ? "为主号" : "为副号"}`, {
        description: res.remaining != null ? `Key 校验通过，剩余 ${usd(res.remaining)}` : "Key 校验通过（未设额度上限）",
      });
      setForm(null);
      refresh();
    },
    onError: (err) => toast.error(err.message),
  });
  const openForm = () => {
    setShowKey(false);
    setForm({ name: accounts.length ? "OpenRouter · 公用" : "OpenRouter", apiKey: "", asPrimary: true });
  };

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <Wallet className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold">OpenRouter 主号 / 副号</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                GEO 采集、行业动态、早晚报、行业周报都先用主号；主号余额不足、额度用完、Key 失效、模型不允许或被限流时，本次调用自动改用副号。
                空回答、超时等模型问题不切换。在「全局 API 配置」里点「设为主号」调整顺序。
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {canEdit && !form && (
              <Button size="sm" className="h-7 text-xs gap-1" onClick={openForm}>
                <Plus className="h-3.5 w-3.5" />添加 OpenRouter Key
              </Button>
            )}
            {anyPaused && canEdit && (
              <Button variant="outline" size="sm" className="h-7 text-xs" disabled={clearPauses.isPending} onClick={() => clearPauses.mutate()}>
                {clearPauses.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "解除暂停"}
              </Button>
            )}
            <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => refetch()} disabled={isFetching} title="刷新余额">
              <RefreshCw className={`h-3.5 w-3.5${isFetching ? " animate-spin" : ""}`} />
            </Button>
          </div>
        </div>

        {isLoading ? (
          <div className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="h-3 w-3 animate-spin" />读取账号与余额…</div>
        ) : accounts.length === 0 ? (
          <p className="text-xs text-destructive">尚未配置 OpenRouter Key。</p>
        ) : (
          <div className="space-y-2">
            {accounts.map((a, i) => {
              const b = a.balance;
              const low = i === 0 && b.remaining != null && b.remaining < (data?.lowBalanceUsd ?? 5);
              return (
                <div key={`${a.keyId}-${i}`} className="rounded-md border px-3 py-2 text-xs space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant={i === 0 ? "default" : "secondary"} className="text-[10px]">{i === 0 ? "主号" : `副号${accounts.length > 2 ? i : ""}`}</Badge>
                    <span className="font-medium">{a.name}</span>
                    <span className="font-mono text-muted-foreground">{a.apiKeyMasked}</span>
                    {!b.ok && <Badge variant="destructive" className="text-[10px]">Key 校验失败</Badge>}
                    {i > 0 && a.keyId > 0 && canEdit && (
                      <Button variant="outline" size="sm" className="h-6 px-2 text-[11px] ml-auto" disabled={setPrimary.isPending}
                        onClick={() => setPrimary.mutate({ id: a.keyId })}>
                        设为主号
                      </Button>
                    )}
                    {low && <Badge variant="destructive" className="text-[10px]">余额偏低</Badge>}
                    {a.paused.map(p => (
                      <Badge key={p.model} variant="outline" className="text-[10px] border-amber-400 text-amber-700 dark:text-amber-300">
                        {p.model === "*" ? "整号暂停" : `${p.model} 暂停`}至 {time(p.until)} · {p.reason}
                      </Badge>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-muted-foreground">
                    {b.ok ? (
                      <>
                        <span>剩余 <b className="text-foreground">{b.remaining != null ? usd(b.remaining) : "未设上限"}</b></span>
                        <span>Key 已用 {usd(b.usage)}{b.limit != null ? ` / 上限 ${usd(b.limit)}` : ""}</span>
                        {b.accountRemaining != null && <span>账户余额 {usd(b.accountRemaining)}</span>}
                      </>
                    ) : (
                      <span className="text-destructive">{b.error}</span>
                    )}
                    <span>近 7 天 GEO 采集 {a.week.rows} 条 · {usd(a.week.usd)}{a.week.fallbackRows ? `（其中 ${a.week.fallbackRows} 条由主号切来）` : ""}</span>
                  </div>
                </div>
              );
            })}
            {accounts.length === 1 && !form && (
              <p className="text-xs text-muted-foreground">
                只有一个 OpenRouter Key，暂无副号兜底。点右上角「添加 OpenRouter Key」填入公用号的 Key 并选「作为主号」，现在这个会自动变成副号。
              </p>
            )}
            {data?.unrecordedWeek && data.unrecordedWeek.rows > 0 && (
              <p className="text-[11px] text-muted-foreground">另有 {data.unrecordedWeek.rows} 条（{usd(data.unrecordedWeek.usd)}）为启用主副号记账前的采集，未区分账号。</p>
            )}
            {data?.lastFailover && (
              <p className="text-[11px] text-muted-foreground">
                最近一次切换：{time(data.lastFailover.at)} · {data.lastFailover.purpose} · {data.lastFailover.model} · {data.lastFailover.reason}
                {data.lastFailover.to ? ` → 改用「${data.lastFailover.to}」` : " → 已无可用副号"}
              </p>
            )}
          </div>
        )}
        {canEdit && accounts.length > 0 && <OpenRouterProbePanel accounts={accounts.map(a => ({ keyId: a.keyId, name: a.name }))} />}

        {form && (
          <form
            className="rounded-md border border-primary/30 p-3 space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!form.apiKey.trim()) { toast.error("请填入 API Key"); return; }
              addKey.mutate({ name: form.name.trim() || "OpenRouter", apiKey: form.apiKey.trim(), asPrimary: form.asPrimary });
            }}
          >
            <p className="text-xs font-medium">添加 OpenRouter Key</p>
            <div className="grid gap-2 sm:grid-cols-[180px_1fr]">
              <Input className="h-8 text-sm" placeholder="名称" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <div className="relative">
                <Input
                  type={showKey ? "text" : "password"}
                  autoComplete="off"
                  className="h-8 text-sm font-mono pr-9"
                  placeholder="sk-or-v1-..."
                  value={form.apiKey}
                  onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                />
                <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setShowKey(!showKey)}>
                  {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="radio" name="or-role" checked={form.asPrimary} onChange={() => setForm({ ...form, asPrimary: true })} />
                作为主号{accounts.length ? `（「${accounts[0].name}」改为副号）` : ""}
              </label>
              {accounts.length > 0 && (
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" name="or-role" checked={!form.asPrimary} onChange={() => setForm({ ...form, asPrimary: false })} />
                  作为副号
                </label>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">保存前会先向 OpenRouter 校验 Key 并读取余额；校验不通过不会保存。</p>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => setForm(null)}>取消</Button>
              <Button type="submit" size="sm" className="h-7 text-xs" disabled={addKey.isPending}>
                {addKey.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "校验并保存"}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

type ProbeRow = { model: string; ok: boolean; status: number; ms: number; error?: string };
type ProbeRun = Record<string, ProbeRow[] | "running" | { error: string }>;

const statusText = (r: ProbeRow | undefined) => {
  if (!r) return "—";
  if (r.ok) return "✓";
  if (r.status === 402) return "余额不足";
  if (r.status === 401) return "Key 无效";
  if (r.status === 403 && /terms of service|prohibited/i.test(r.error || "")) return "被拒（条款）";
  if (r.status === 403) return "403";
  if (r.status === 404) return "不可用";
  if (r.status === 429) return "限流";
  if (r.status === 0) return "超时";
  return String(r.status);
};

/** 检测模型可用性: each account × (neutral prompt, TRON prompt) for every model the system uses. */
function OpenRouterProbePanel({ accounts }: { accounts: { keyId: number; name: string }[] }) {
  const { data: models } = trpc.globalApiKeys.openrouterModels.useQuery(undefined, { staleTime: 300_000 });
  const probe = trpc.globalApiKeys.probeOpenRouter.useMutation();
  const [run, setRun] = useState<ProbeRun | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const kinds = ["neutral", "topic"] as const;
  const key = (keyId: number, kind: string) => `${keyId}:${kind}`;
  const running = !!run && Object.values(run).some(v => v === "running");

  const start = async () => {
    const jobs = accounts.flatMap(a => kinds.map(kind => ({ keyId: a.keyId, kind })));
    setRun(Object.fromEntries(jobs.map(j => [key(j.keyId, j.kind), "running"])));
    setAt(Date.now());
    await Promise.all(jobs.map(async j => {
      try {
        const res = await probe.mutateAsync(j);
        setRun(prev => ({ ...(prev ?? {}), [key(j.keyId, j.kind)]: res.results }));
      } catch (err) {
        setRun(prev => ({ ...(prev ?? {}), [key(j.keyId, j.kind)]: { error: (err as Error).message } }));
      }
    }));
  };

  const cell = (keyId: number, kind: string, model: string) => {
    const v = run?.[key(keyId, kind)];
    if (!v) return <span className="text-muted-foreground">—</span>;
    if (v === "running") return <Loader2 className="h-3 w-3 animate-spin inline" />;
    if (!Array.isArray(v)) return <span className="text-destructive" title={v.error}>出错</span>;
    const r = v.find(x => x.model === model);
    return (
      <span className={r?.ok ? "text-green-600 dark:text-green-400" : "text-destructive"} title={r?.error || (r ? `${r.ms}ms` : "")}>
        {statusText(r)}
      </span>
    );
  };

  return (
    <div className="rounded-md border px-3 py-2 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs">
          <span className="font-medium">检测模型可用性</span>
          <span className="text-muted-foreground"> · 每个账号对系统用到的每个模型各发两次极短请求：「通用」是一句 OK，「本业务」是一句介绍 TRON / 孙宇晨；合计花费不到 $0.05。</span>
        </div>
        <Button variant="outline" size="sm" className="h-7 text-xs gap-1 shrink-0" disabled={running || !models} onClick={start}>
          {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Stethoscope className="h-3.5 w-3.5" />}
          {run ? "重新检测" : "开始检测"}
        </Button>
      </div>
      {run && models && (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-muted-foreground">
                <th className="text-left font-normal py-1 pr-2">模型 / 用途</th>
                {accounts.map(a => (
                  <th key={a.keyId} colSpan={2} className="text-center font-normal px-2">{a.name}</th>
                ))}
              </tr>
              <tr className="text-muted-foreground">
                <th />
                {accounts.flatMap(a => [
                  <th key={`${a.keyId}n`} className="font-normal px-2">通用</th>,
                  <th key={`${a.keyId}t`} className="font-normal px-2">本业务</th>,
                ])}
              </tr>
            </thead>
            <tbody>
              {models.map(m => (
                <tr key={m.model} className="border-t">
                  <td className="py-1 pr-2">
                    <div className="font-mono">{m.model}</div>
                    <div className="text-muted-foreground">{m.uses.join("、")}</div>
                  </td>
                  {accounts.flatMap(a => kinds.map(kind => (
                    <td key={`${a.keyId}-${kind}`} className="text-center px-2">{cell(a.keyId, kind, m.model)}</td>
                  )))}
                </tr>
              ))}
            </tbody>
          </table>
          {at && <p className="text-[10px] text-muted-foreground mt-1">检测于 {time(at)}。鼠标悬停可看错误原文。</p>}
        </div>
      )}
    </div>
  );
}
