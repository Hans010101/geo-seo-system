// Display helpers for spread signals (server/monitor/signals.ts): engagement, author reach, similar copies.
import { SEVERITY_LABELS } from "@shared/geo-types";
import { SOURCE_PLATFORM_META } from "@/lib/monitorLabels";

export function formatCount(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 100_000_000) return `${Math.round(n / 10_000_000) / 10}亿`;
  if (n >= 10_000) return `${Math.round(n / 1_000) / 10}万`;
  return String(n);
}

type SpreadFields = {
  similarCount?: number | null;
  commentCount?: number | null;
  shareCount?: number | null;
  likeCount?: number | null;
  viewCount?: number | null;
  authorFollowers?: number | null;
  authorVerified?: string | null;
};

/** Compact list-row pieces, e.g. ["相似 5", "评 300 转 50 赞 1.2万", "粉丝 52万"]. */
export function spreadBits(a: SpreadFields): string[] {
  const bits: string[] = [];
  if ((a.similarCount ?? 0) > 0) bits.push(`相似 ${a.similarCount}`);
  const eng = [
    a.commentCount ? `评 ${formatCount(a.commentCount)}` : "",
    a.shareCount ? `转 ${formatCount(a.shareCount)}` : "",
    a.likeCount ? `赞 ${formatCount(a.likeCount)}` : "",
    !a.commentCount && !a.shareCount && a.viewCount ? `播 ${formatCount(a.viewCount)}` : "",
  ].filter(Boolean);
  if (eng.length) bits.push(eng.join(" "));
  if ((a.authorFollowers ?? 0) >= 10_000) bits.push(`粉丝 ${formatCount(a.authorFollowers)}`);
  if (a.authorVerified === "org") bits.push("机构");
  return bits;
}

export function platformNames(raw: unknown): string {
  const list = Array.isArray(raw) ? (raw as string[]) : [];
  return list.map((p) => SOURCE_PLATFORM_META[p]?.label || p).join("、");
}

export type Escalation = { at: number; from?: string; to: string; reason: string };

/** Severity steps after creation ("中 → 高 · 相似转载 5 条"), oldest first. */
export function escalationSteps(raw: unknown): { at: number; text: string }[] {
  let list: Escalation[] = [];
  if (Array.isArray(raw)) list = raw as Escalation[];
  else if (typeof raw === "string" && raw) {
    try { const v = JSON.parse(raw); if (Array.isArray(v)) list = v; } catch { /* ignore */ }
  }
  return list
    .filter((e) => e && e.from && typeof e.at === "number")
    .map((e) => ({ at: e.at, text: `${SEVERITY_LABELS[e.from!] || e.from} → ${SEVERITY_LABELS[e.to] || e.to} · ${e.reason}` }));
}
