import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useEffect, useState } from "react";

// 智推时代 (GenOptima) answers: shared by 智推时代数据 and 回答监测 (数据来源 = 智推时代).
export const PLATFORM_LABELS: Record<string, string> = {
  doubao: "豆包", deepseek: "DeepSeek", yuanbao: "腾讯元宝", qianwen: "通义千问", kimi: "Kimi", wenxin: "文心一言",
};
export const SENTIMENT_META: Record<string, { label: string; className: string }> = {
  positive: { label: "正面", className: "bg-green-50 text-green-700 border-green-200" },
  negative: { label: "负面", className: "bg-red-50 text-red-700 border-red-200" },
  none: { label: "未判定", className: "bg-gray-50 text-gray-600 border-gray-200" },
};
export const PAGE_SIZE = 30;

export const pct = (part: number, total: number) => (total > 0 ? `${((part / total) * 100).toFixed(1)}%` : "—");
/** Beijing time "YYYY-MM-DD HH:mm" (locale-independent; zh-CN strings vary in padding). */
export const time = (ms: number | null | undefined) => {
  if (!ms) return "—";
  const iso = new Date(ms + 8 * 3_600_000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
};

function SentimentBadge({ value }: { value: string | null }) {
  const meta = SENTIMENT_META[value === "positive" || value === "negative" ? value : "none"];
  return <Badge variant="outline" className={meta.className}>{meta.label}</Badge>;
}

export function AnswerDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
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


export type AnswerFilter = { question?: string; sentiment?: "all" | "positive" | "negative" | "none"; nonce?: number };

/** Filterable answer list. `preset` lets a parent (e.g. 负面回答最多的问题) jump the filters. */
export function GenoptimaAnswerList({ days: fixedDays, defaultSentiment = "all", preset }: {
  days?: number; defaultSentiment?: AnswerFilter["sentiment"]; preset?: AnswerFilter;
}) {
  const [ownDays, setDays] = useState(7);
  const days = fixedDays ?? ownDays;
  const [platform, setPlatform] = useState("all");
  const [sentiment, setSentiment] = useState<NonNullable<AnswerFilter["sentiment"]>>(defaultSentiment);
  const [question, setQuestion] = useState("");
  const [page, setPage] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    if (!preset?.nonce) return;
    if (preset.question !== undefined) setQuestion(preset.question);
    if (preset.sentiment) setSentiment(preset.sentiment);
    setPage(0);
  }, [preset?.nonce]);

  const { data: answers } = trpc.external.geoAnswers.useQuery({
    days,
    platform: platform === "all" ? undefined : platform,
    sentiment: sentiment === "all" ? undefined : sentiment,
    question: question.trim() || undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  }, { staleTime: 60_000 });
  const resetPage = <T,>(set: (value: T) => void) => (value: T) => { set(value); setPage(0); };

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">回答明细（{answers?.total ?? 0} 条）</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              {fixedDays === undefined ? (
                <Select value={String(days)} onValueChange={resetPage((v: string) => setDays(Number(v)))}>
                  <SelectTrigger className="w-[110px] h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">近 1 天</SelectItem>
                    <SelectItem value="7">近 7 天</SelectItem>
                    <SelectItem value="14">近 14 天</SelectItem>
                    <SelectItem value="30">近 30 天</SelectItem>
                  </SelectContent>
                </Select>
              ) : null}
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
    </>
  );
}
