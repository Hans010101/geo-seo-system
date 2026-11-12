import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useMemo, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PLATFORM_LABELS } from "@shared/geo-types";

const OTHER_PLATFORMS: Record<string, string> = { hunyuan: "腾讯元宝", perplexity: "Perplexity", llama: "Llama" };
import { Plus, Pencil, Trash2, Target, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useRole } from "@/hooks/useRole";

export default function ConfigTargetFacts() {
  const { canEdit } = useRole();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);

  const { data: factsList, isLoading } = trpc.targetFacts.list.useQuery({});
  const [days, setDays] = useState(30);
  const { data: coverage } = trpc.targetFacts.coverage.useQuery({ days }, { staleTime: 300_000 });
  const coverageBy = useMemo(() => new Map((coverage || []).map(c => [c.factKey, c])), [coverage]);
  const rate = (key: string) => {
    const c = coverageBy.get(key);
    return c && c.total ? c.hit / c.total : null;
  };
  // Active facts weakest first, so the ones AI 没说到的 sit on top; inactive facts last.
  const sortedFacts = useMemo(() => [...(factsList || [])].sort((a, b) =>
    Number(!!b.isActive) - Number(!!a.isActive) || (rate(a.factKey) ?? 2) - (rate(b.factKey) ?? 2)), [factsList, coverageBy]);
  const activeRates = (factsList || []).filter(f => f.isActive).map(f => rate(f.factKey)).filter((r): r is number => r !== null);
  const avgRate = activeRates.length ? activeRates.reduce((a, b) => a + b, 0) / activeRates.length : null;
  const unseen = activeRates.filter(r => r === 0).length;
  const utils = trpc.useUtils();

  const createMutation = trpc.targetFacts.create.useMutation({
    onSuccess: () => {
      utils.targetFacts.list.invalidate();
      setDialogOpen(false);
      toast.success("目标事实创建成功");
    },
    onError: (err) => toast.error(err.message),
  });

  const updateMutation = trpc.targetFacts.update.useMutation({
    onSuccess: () => {
      utils.targetFacts.list.invalidate();
      setDialogOpen(false);
      setEditing(null);
      toast.success("已更新");
    },
    onError: (err) => toast.error(err.message),
  });

  const deleteMutation = trpc.targetFacts.delete.useMutation({
    onSuccess: () => {
      utils.targetFacts.list.invalidate();
      toast.success("已删除");
    },
    onError: (err) => toast.error(err.message),
  });

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const data = {
      factKey: formData.get("factKey") as string,
      factDescription: formData.get("factDescription") as string,
      isActive: true,
    };

    if (editing) {
      updateMutation.mutate({ id: editing.id, ...data });
    } else {
      createMutation.mutate(data);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">事实与口径</h1>
          <p className="text-muted-foreground text-sm mt-1">
            我们希望 AI 说到的关键事实，以及各平台实际说到的比例（自测采集；孙宇晨类事实只统计孙宇晨线问题，TRON 类只统计 TRON 线问题）
          </p>
          <p className="text-sm mt-2">
            {avgRate === null ? <span className="text-muted-foreground">所选时间内暂无自测分析</span> : <>
              平均提及率 <span className="font-semibold">{(avgRate * 100).toFixed(1)}%</span>
              <span className="text-muted-foreground"> · </span>
              没有任何平台提到 <span className={`font-semibold ${unseen ? "text-red-600" : ""}`}>{unseen}</span> 条
            </>}
          </p>
        </div>
        <div className="flex items-center gap-2">
        <Select value={String(days)} onValueChange={v => setDays(Number(v))}>
          <SelectTrigger className="w-[120px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="14">近 14 天</SelectItem>
            <SelectItem value="30">近 30 天</SelectItem>
            <SelectItem value="90">近 90 天</SelectItem>
          </SelectContent>
        </Select>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button onClick={() => { setEditing(null); setDialogOpen(true); }} disabled={!canEdit}>
              <Plus className="h-4 w-4 mr-2" />
              新增事实
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editing ? "编辑目标事实" : "新增目标事实"}</DialogTitle>
              <DialogDescription>
                定义AI回答中应该提及的关键事实
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="factKey">事实标识</Label>
                <Input
                  id="factKey"
                  name="factKey"
                  placeholder="如 tron_tps_2000"
                  defaultValue={editing?.factKey || ""}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="factDescription">事实描述</Label>
                <Textarea
                  id="factDescription"
                  name="factDescription"
                  placeholder="描述这个事实的内容，如：TRON网络TPS达到2000"
                  defaultValue={editing?.factDescription || ""}
                  rows={3}
                  required
                />
              </div>
              <DialogFooter>
                <Button
                  type="submit"
                  disabled={createMutation.isPending || updateMutation.isPending}
                >
                  {(createMutation.isPending || updateMutation.isPending) && (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  )}
                  {editing ? "保存" : "创建"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
        </div>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground">加载中...</div>
      ) : !factsList || factsList.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Target className="h-12 w-12 mx-auto text-muted-foreground/30 mb-4" />
            <h3 className="text-lg font-medium mb-2">暂无目标事实</h3>
            <p className="text-sm text-muted-foreground">添加需要AI回答中覆盖的关键事实</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {sortedFacts.map((fact) => {
            const c = coverageBy.get(fact.factKey);
            const r = rate(fact.factKey);
            return (
            <Card key={fact.id}>
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-mono font-medium text-primary">{fact.factKey}</span>
                      <Badge variant={fact.isActive ? "default" : "secondary"} className="text-[10px]">
                        {fact.isActive ? "启用" : "停用"}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">{fact.factDescription}</p>
                    {fact.isActive && c ? (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {c.platforms.map(p => {
                          const pr = p.total ? p.hit / p.total : 0;
                          const tone = pr >= 0.5 ? "bg-green-50 text-green-700 border-green-200" : pr > 0 ? "bg-amber-50 text-amber-700 border-amber-200" : "bg-red-50 text-red-600 border-red-200";
                          return (
                            <span key={p.platform} title={`${p.hit}/${p.total} 条回答提到`} className={`rounded border px-1.5 py-0.5 text-[11px] ${tone}`}>
                              {PLATFORM_LABELS[p.platform as keyof typeof PLATFORM_LABELS] || OTHER_PLATFORMS[p.platform] || p.platform} {Math.round(pr * 100)}%
                            </span>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                  {fact.isActive ? (
                    <div className="w-20 shrink-0 text-right">
                      <div className={`text-lg font-semibold ${r === null ? "text-muted-foreground" : r === 0 ? "text-red-600" : r < 0.2 ? "text-amber-600" : "text-green-600"}`}>
                        {r === null ? "—" : `${(r * 100).toFixed(0)}%`}
                      </div>
                      <div className="text-[10px] text-muted-foreground">{c ? `${c.hit}/${c.total} 提及` : "暂无数据"}</div>
                    </div>
                  ) : null}
                  <div className={`flex gap-1 shrink-0${!canEdit ? " invisible" : ""}`}>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => { setEditing(fact); setDialogOpen(true); }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => {
                        if (confirm("确定删除此目标事实？")) {
                          deleteMutation.mutate({ id: fact.id });
                        }
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
