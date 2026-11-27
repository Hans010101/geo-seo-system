// Spread handling shared by the queue worker (cloud sources) and the ingest pipeline (Mac collector,
// 百分点): a post whose text is already stored under another URL is counted as a copy of it, and an
// open negative alert on that article may escalate.
import * as db from "../db";
import { escalateArticleAlert } from "./notify";
import { copyInfluenceReason, type PostMetrics } from "./signals";
import { SOURCE_PLATFORM_LABELS } from "./sources/registry";
import { log } from "./util";

export async function foldCopyIntoArticle(
  canonicalId: number,
  copy: { sourcePlatform: string; metrics?: PostMetrics },
  options?: { deliveryEnabledOverride?: boolean; pushMinSeverity?: "high" | "critical" },
): Promise<{ folded: boolean; escalated: boolean }> {
  try {
    const row = await db.foldSimilarIntoMonitorArticle(canonicalId, copy.sourcePlatform);
    if (!row) return { folded: false, escalated: false };
    if (row.threatLevel !== "high" && row.threatLevel !== "medium") return { folded: true, escalated: false };
    const extra = copyInfluenceReason(copy.metrics, SOURCE_PLATFORM_LABELS[copy.sourcePlatform] || copy.sourcePlatform);
    const res = await escalateArticleAlert({
      url: row.url,
      urlHash: row.urlHash,
      title: row.title,
      domain: row.domain,
      threatLevel: row.threatLevel,
      spread: {
        similarCount: row.similarCount,
        authorFollowers: row.authorFollowers,
        authorVerified: row.authorVerified as any,
        likeCount: row.likeCount,
        commentCount: row.commentCount,
        shareCount: row.shareCount,
        viewCount: row.viewCount,
      },
      extraReasons: extra ? [extra] : [],
    }, options);
    return { folded: true, escalated: res.escalated };
  } catch (e: any) {
    log.warn(`Fold copy into ${canonicalId} failed: ${String(e?.message || e).slice(0, 160)}`);
    return { folded: false, escalated: false };
  }
}
