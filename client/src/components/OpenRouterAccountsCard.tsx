// OpenRouter 主号 / 副号 (server/openrouter-accounts.ts): order, balance, pauses, last switch, 7-day GEO spend.
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Loader2, RefreshCw, Wallet } from "lucide-react";
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
            {accounts.length === 1 && (
              <p className="text-xs text-muted-foreground">只有一个 OpenRouter Key，暂无副号兜底。</p>
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
      </CardContent>
    </Card>
  );
}
