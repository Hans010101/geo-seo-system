import { useMemo, useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PLATFORM_LABELS } from "@shared/geo-types";
import { TOPIC_LINE_LABELS, type TopicLine } from "@shared/genoptima-topics";
import { GenoptimaAnswerList } from "@/components/GenoptimaAnswers";

type Stat = { total: number; negative: number };
const SELF_LABELS: Record<string, string> = { ...PLATFORM_LABELS, hunyuan: "腾讯元宝", perplexity: "Perplexity", llama: "Llama" };
const rate = (s: Stat) => (s.total ? s.negative / s.total : null);
const fmt = (s: Stat) => {
  const r = rate(s);
  return r === null ? "—" : `${(r * 100).toFixed(1)}%`;
};
const tone = (s: Stat) => {
  const r = rate(s);
  return r === null ? "text-muted-foreground" : r >= 0.3 ? "text-red-600" : r >= 0.1 ? "text-amber-600" : "text-green-600";
};

function Rate({ stat, hint = true }: { stat: Stat; hint?: boolean }) {
  return (
    <span className={tone(stat)}>
      {fmt(stat)}{hint && stat.total ? <span className="text-[10px] text-muted-foreground"> /{stat.total}</span> : null}
    </span>
  );
}

// 回答监测 · 主题对照: 智推 13 topics (5 phrasings each, 6 domestic platforms, daily) next to the matching
// self-test 情绪类 questions (11 platforms, weekly). 负面: 智推 = vendor judgement; 自测 = score ≤ 2.
export function TopicComparison() {
  const [days, setDays] = useState(14);
  const [selected, setSelected] = useState("sun_controversy");
  const { data, isLoading } = trpc.external.geoTopics.useQuery({ days }, { staleTime: 120_000 });
  const topic = useMemo(() => data?.topics.find(t => t.id === selected), [data, selected]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          智推时代的 13 个主题（每个主题 5 种问法）对应自测的情绪类问题。负面率：智推为服务商判定，自测为 1–5 分打分中 ≤2 分的比例。推荐类问题只有自测，在「自测明细」里看。
        </p>
        <Select value={String(days)} onValueChange={v => setDays(Number(v))}>
          <SelectTrigger className="w-[120px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="14">近 14 天</SelectItem>
            <SelectItem value="30">近 30 天</SelectItem>
            <SelectItem value="60">近 60 天</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <Card className="h-fit">
          <CardContent className="p-2">
            {isLoading || !data ? <p className="p-3 text-sm text-muted-foreground">加载中…</p> : (
              <>
                <div className="grid grid-cols-[1fr_64px_64px] gap-1 px-2 py-1.5 text-[11px] text-muted-foreground">
                  <span>主题</span><span className="text-right">智推负面</span><span className="text-right">自测负面</span>
                </div>
                {(["sun", "tron"] as TopicLine[]).map(line => (
                  <div key={line} className="mb-1">
                    <div className="px-2 pt-2 pb-1 text-xs font-semibold">{TOPIC_LINE_LABELS[line]}</div>
                    {data.topics.filter(t => t.line === line).map(t => (
                      <button key={t.id} type="button" onClick={() => setSelected(t.id)}
                        className={`grid w-full grid-cols-[1fr_64px_64px] gap-1 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60 ${t.id === selected ? "bg-muted font-medium" : ""}`}>
                        <span className="truncate">{t.label}</span>
                        <span className="text-right"><Rate stat={t.vendor} hint={false} /></span>
                        <span className="text-right"><Rate stat={t.selfAll} hint={false} /></span>
                      </button>
                    ))}
                  </div>
                ))}
                {data.unmapped.length ? (
                  <div className="m-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/30">
                    智推有 {data.unmapped.length} 个新问题未归类：{data.unmapped.slice(0, 3).map(u => u.question).join("；")}
                  </div>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>

        <div className="min-w-0 space-y-4">
          {topic ? (
            <>
              <Card>
                <CardHeader className="pb-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      {topic.label}<Badge variant="outline" className="font-normal">{TOPIC_LINE_LABELS[topic.line]}</Badge>
                    </CardTitle>
                    <div className="flex flex-wrap gap-1.5">
                      {topic.selfQuestionIds.map(id => (
                        <Button key={id} variant="outline" size="sm" asChild><Link href={`/questions/${id}`}>自测 {id}</Link></Button>
                      ))}
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    智推 {topic.vendor.total.toLocaleString()} 条，负面 {fmt(topic.vendor)} · 自测同平台 {topic.selfMatched.total} 条，负面 {fmt(topic.selfMatched)} · 自测全部平台 {topic.selfAll.total} 条，负面 {fmt(topic.selfAll)}
                  </p>
                </CardHeader>
                <CardContent className="grid gap-4 xl:grid-cols-2">
                  <table className="w-full text-sm">
                    <thead className="text-muted-foreground">
                      <tr className="border-b"><th className="text-left py-2">平台</th><th className="text-right">智推负面率</th><th className="text-right">自测负面率</th></tr>
                    </thead>
                    <tbody>
                      {topic.platforms.map(p => (
                        <tr key={p.platform} className="border-b">
                          <td className="py-1.5">{p.label}</td>
                          <td className="text-right"><Rate stat={p.vendor} /></td>
                          <td className="text-right">{p.self.total ? <Rate stat={p.self} /> : <span className="text-muted-foreground">无自测</span>}</td>
                        </tr>
                      ))}
                      {topic.selfOtherPlatforms.map(p => (
                        <tr key={p.platform} className="border-b last:border-0">
                          <td className="py-1.5">{SELF_LABELS[p.platform] || p.platform}<span className="text-[10px] text-muted-foreground"> 仅自测</span></td>
                          <td className="text-right text-muted-foreground">—</td>
                          <td className="text-right"><Rate stat={p} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div>
                    <div className="text-sm font-medium mb-1">智推的 5 种问法</div>
                    {topic.questions.map(q => (
                      <div key={q.question} className="flex items-center justify-between gap-3 border-b py-1.5 text-sm last:border-0">
                        <span className="min-w-0 truncate">{q.question}</span>
                        <span className="shrink-0"><Rate stat={q} /></span>
                      </div>
                    ))}
                    {!topic.questions.length ? <p className="text-sm text-muted-foreground py-4">所选时间内没有智推回答</p> : null}
                  </div>
                </CardContent>
              </Card>
              <GenoptimaAnswerList days={days} topic={topic.id} defaultSentiment="negative" title="智推回答" />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
