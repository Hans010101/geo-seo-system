import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../server/routers";
import CollectionDetailSheet from "@/components/CollectionDetailSheet";
import MonitorArticleDetailSheet from "@/components/MonitorArticleDetailSheet";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { getAlertSourceUrl } from "@/lib/alertSource";
import { SEVERITY_LABELS } from "@shared/geo-types";
import { ExternalLink } from "lucide-react";

export type AlertDetail = inferRouterOutputs<AppRouter>["alerts"]["list"]["data"][number];

export default function AlertDetailSheet({ alert, onClose }: { alert: AlertDetail | null; onClose: () => void }) {
  if (!alert) return null;
  const onOpenChange = (open: boolean) => { if (!open) onClose(); };
  if (alert.relatedArticleId) {
    return <MonitorArticleDetailSheet key={`article-${alert.relatedArticleId}`} articleId={alert.relatedArticleId} open onOpenChange={onOpenChange} />;
  }
  if (alert.relatedCollectionId) {
    return <CollectionDetailSheet key={`collection-${alert.relatedCollectionId}`} collectionId={alert.relatedCollectionId} open onOpenChange={onOpenChange} />;
  }
  const sourceUrl = getAlertSourceUrl(alert.description);
  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto" aria-describedby={undefined}>
        <SheetHeader className="px-6 pt-6">
          <SheetTitle>预警详情</SheetTitle>
        </SheetHeader>
        <div className="px-6 pb-6 space-y-4 break-words">
          <h2 className="text-base font-semibold">{alert.title}</h2>
          <p className="text-xs text-muted-foreground">{SEVERITY_LABELS[alert.severity]} · {new Date(alert.createdAt).toLocaleString("zh-CN")}</p>
          <p className="text-sm whitespace-pre-wrap leading-relaxed">{alert.description || "暂无详细说明"}</p>
          <p className="text-xs text-muted-foreground">此预警未关联文章或采集记录，以上为完整预警内容。</p>
          {sourceUrl && <Button variant="outline" asChild><a href={sourceUrl} target="_blank" rel="noopener noreferrer"><ExternalLink className="h-4 w-4 mr-2" />查看原文</a></Button>}
        </div>
      </SheetContent>
    </Sheet>
  );
}
