// 舆情周报/月报 — Friday–Thursday weeks and calendar months, in Beijing time.
// INDEPENDENT from the GEO weeklyReports (那是 AI 平台情感周报); stored in monitor_reports.
// Dimensions: 总览 / 信源 / 威胁(含环比) / GEO穿透 / 成本. Pure DB aggregation — no LLM cost.
import { sql } from "drizzle-orm";
import * as db from "../db";
import { dispatchNotification } from "../_core/notification";
import { citationReachSql, normSql, rawRows } from "./penetration";
import { log, SHARED_PLATFORM_DOMAINS } from "./util";
import { getMarketPeriodSummary, type MarketPeriodSummary } from "../market";
import {
  comparisonWindow,
  dateRangePeriod,
  formatReportDate as fmtDate,
  reportKindLabel,
  monthlyPeriodOf,
  parsePeriod,
  weeklyPeriodOf,
  type ReportDateRange,
  type ReportPeriod,
  type ReportType,
} from "../../shared/report-period";
export { monthlyPeriodOf, parsePeriod, weeklyPeriodOf } from "../../shared/report-period";
export type { ReportPeriod, ReportType } from "../../shared/report-period";

// Reports follow the source publication time. Discovery time must never make recirculated
// historical content appear in the current week/month.
const SEEN = "publishedAt";

export interface MonitorReportData {
  periodLabel: string; // 'YYYY-MM-DD ~ YYYY-MM-DD'
  overview: {
    total: number;
    effective: number; // relevance high+medium
    bySource: Record<string, number>;
    sentiment: { positive: number; neutral: number; negative: number; unanalyzed: number }; // on effective
    threat: Record<string, number>;
    relevance: Record<string, number>;
  };
  sources: {
    topDomains: { domain: string; articles: number; negatives: number; stance: string | null }[];
    hostileActivity: { domain: string; articles: number; negatives: number }[];
    newDomains: string[]; // first-ever seen during this period
  };
  threats: {
    highThreatList: { title: string | null; domain: string | null; url: string; sentimentScore: number | null }[];
    topNegatives: { title: string | null; domain: string | null; url: string; sentimentScore: number | null; threatLevel: string | null }[];
    compare: {
      prevPeriodLabel: string;
      // true when generated before the period ended; both sides then cover the same elapsed days
      partial?: boolean;
      curPeriodLabel?: string;
      total: number; prevTotal: number;
      negatives: number; prevNegatives: number;
      highThreat: number; prevHighThreat: number;
    };
  };
  penetration: {
    citedDomainsCount: number; // period-active domains already cited by AI
    amplified: { domain: string; aiPlatforms: number; aiCitations: number; negatives: number; stance: string | null }[];
    newlyAmplifiedHostile: { domain: string; aiPlatforms: number; firstCitedAt: number }[];
  };
  costs: {
    analysisUsd: number;
    fetchUsd: number;
    totalUsd: number;
    byEngine: Record<string, { articles: number; fetchUsd: number }>;
  };
  /** 市场表现 (币价联动); absent in reports generated before the module existed or without prices. */
  market?: MarketPeriodSummary | null;
}

async function periodStats(startMs: number, endMs: number) {
  const rows = await rawRows<any>(sql.raw(`
    SELECT COUNT(*) AS total,
      SUM(relevance IN ('high','medium')) AS effective,
      SUM(relevance IN ('high','medium') AND sentimentScore >= 4) AS pos,
      SUM(relevance IN ('high','medium') AND sentimentScore = 3) AS neu,
      SUM(relevance IN ('high','medium') AND sentimentScore <= 2) AS neg,
      SUM(relevance IN ('high','medium') AND sentimentScore IS NULL) AS unanalyzed,
      SUM(threatLevel = 'high') AS high
    FROM monitor_articles WHERE ${SEEN} >= ${startMs} AND ${SEEN} < ${endMs}`));
  const r = rows[0] ?? {};
  return {
    total: Number(r.total) || 0,
    effective: Number(r.effective) || 0,
    pos: Number(r.pos) || 0,
    neu: Number(r.neu) || 0,
    neg: Number(r.neg) || 0,
    unanalyzed: Number(r.unanalyzed) || 0,
    high: Number(r.high) || 0,
  };
}

export async function buildMonitorReport(p: ReportPeriod, nowMs = Date.now()): Promise<MonitorReportData> {
  const { startMs, endMs } = p;
  const win = `${SEEN} >= ${startMs} AND ${SEEN} < ${endMs}`;
  const cmp = comparisonWindow(p, nowMs);
  const cur = await periodStats(startMs, cmp.curEndMs);
  const prev = await periodStats(cmp.prevStartMs, cmp.prevEndMs);

  const [bySrcRows, threatRows, relRows] = await Promise.all([
    rawRows<any>(sql.raw(`SELECT COALESCE(sourcePlatform,'unknown') k, COUNT(*) c FROM monitor_articles WHERE ${win} GROUP BY k`)),
    rawRows<any>(sql.raw(`SELECT COALESCE(threatLevel,'unanalyzed') k, COUNT(*) c FROM monitor_articles WHERE ${win} GROUP BY k`)),
    rawRows<any>(sql.raw(`SELECT COALESCE(relevance,'unanalyzed') k, COUNT(*) c FROM monitor_articles WHERE ${win} GROUP BY k`)),
  ]);
  const toMap = (rows: any[]) => Object.fromEntries(rows.map((r) => [String(r.k), Number(r.c) || 0]));

  // —— 信源维度 ——
  const topDomains = (await rawRows<any>(sql.raw(`
    SELECT ma.domain, COUNT(*) articles,
      SUM(ma.relevance IN ('high','medium') AND ma.sentimentScore <= 2) negatives, sr.stance
    FROM monitor_articles ma LEFT JOIN monitor_source_rules sr ON sr.domain = ma.domain
    WHERE ${win.replace(/firstSeenAt/g, "ma.firstSeenAt").replace(/createdAt/g, "ma.createdAt")} AND ma.domain IS NOT NULL AND ma.domain <> ''
    GROUP BY ma.domain, sr.stance ORDER BY articles DESC LIMIT 10`))).map((r) => ({
    domain: String(r.domain), articles: Number(r.articles) || 0, negatives: Number(r.negatives) || 0, stance: r.stance ?? null,
  }));
  const hostileActivity = (await rawRows<any>(sql.raw(`
    SELECT ma.domain, COUNT(*) articles,
      SUM(ma.relevance IN ('high','medium') AND ma.sentimentScore <= 2) negatives
    FROM monitor_articles ma JOIN monitor_source_rules sr ON sr.domain = ma.domain AND sr.stance = 'hostile'
    WHERE ${win.replace(/firstSeenAt/g, "ma.firstSeenAt").replace(/createdAt/g, "ma.createdAt")}
    GROUP BY ma.domain ORDER BY negatives DESC, articles DESC LIMIT 10`))).map((r) => ({
    domain: String(r.domain), articles: Number(r.articles) || 0, negatives: Number(r.negatives) || 0,
  }));
  const newDomains = (await rawRows<any>(sql.raw(`
    SELECT domain FROM monitor_articles WHERE domain IS NOT NULL AND domain <> ''
    GROUP BY domain HAVING MIN(${SEEN}) >= ${startMs} AND MIN(${SEEN}) < ${endMs}
    ORDER BY COUNT(*) DESC LIMIT 20`))).map((r) => String(r.domain));

  // —— 威胁/负面维度 ——
  const highThreatList = (await rawRows<any>(sql.raw(`
    SELECT title, domain, url, sentimentScore FROM monitor_articles
    WHERE ${win} AND threatLevel = 'high' ORDER BY ${SEEN} DESC LIMIT 20`))).map((r) => ({
    title: r.title ?? null, domain: r.domain ?? null, url: String(r.url), sentimentScore: r.sentimentScore == null ? null : Number(r.sentimentScore),
  }));
  const topNegatives = (await rawRows<any>(sql.raw(`
    SELECT title, domain, url, sentimentScore, threatLevel FROM monitor_articles
    WHERE ${win} AND relevance IN ('high','medium') AND sentimentScore <= 2
    ORDER BY threatLevel IS NULL, CASE threatLevel WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, sentimentScore ASC LIMIT 10`))).map((r) => ({
    title: r.title ?? null, domain: r.domain ?? null, url: String(r.url),
    sentimentScore: r.sentimentScore == null ? null : Number(r.sentimentScore), threatLevel: r.threatLevel ?? null,
  }));

  // —— GEO 穿透维度 —— (period-active monitor domains × recent AI citations; shared platforms
  // such as x.com only count citations of our monitored post URLs — see citationReachSql)
  const penRows = await rawRows<any>(sql.raw(`
    SELECT m.d domain, m.negatives, c.aiPlatforms, c.aiCitations, sr.stance
    FROM (
      SELECT ${normSql("domain")} d,
        SUM(relevance IN ('high','medium') AND sentimentScore <= 2) negatives
      FROM monitor_articles WHERE ${win} AND domain IS NOT NULL AND domain <> '' GROUP BY d
    ) m
    JOIN ${citationReachSql()} c ON m.d = c.domain
    LEFT JOIN monitor_source_rules sr ON sr.domain = m.d
    ORDER BY (sr.stance = 'hostile') DESC, m.negatives DESC, c.aiPlatforms DESC`));
  const citedDomainsCount = penRows.length;
  const amplified = penRows
    .filter((r) => Number(r.negatives) > 0 || r.stance === "hostile")
    .slice(0, 10)
    .map((r) => ({
      domain: String(r.domain), aiPlatforms: Number(r.aiPlatforms) || 0, aiCitations: Number(r.aiCitations) || 0,
      negatives: Number(r.negatives) || 0, stance: r.stance ?? null,
    }));
  // 新进入 AI 引用的敌对/负面信源: first-ever citation of that domain landed inside this period.
  const newlyAmplifiedHostile = (await rawRows<any>(sql.raw(`
    SELECT c.d domain, c.aiPlatforms, c.firstCited
    FROM (
      SELECT ${normSql("ci.domain")} d, COUNT(DISTINCT co.platform) aiPlatforms,
        MIN(ci.createdAt * 1000) firstCited
      FROM citations ci JOIN collections co ON ci.collectionId = co.id
      WHERE ${normSql("ci.domain")} NOT IN (${SHARED_PLATFORM_DOMAINS.map((d) => `'${d}'`).join(", ")})
      GROUP BY d
      HAVING firstCited >= ${startMs} AND firstCited < ${endMs}
    ) c
    JOIN (
      SELECT ${normSql("ma.domain")} d
      FROM monitor_articles ma LEFT JOIN monitor_source_rules sr ON sr.domain = ma.domain
      WHERE (sr.stance = 'hostile' OR (ma.relevance IN ('high','medium') AND ma.sentimentScore <= 2))
      GROUP BY d
    ) m ON m.d = c.d
    ORDER BY c.aiPlatforms DESC LIMIT 10`))).map((r) => ({
    domain: String(r.domain), aiPlatforms: Number(r.aiPlatforms) || 0, firstCitedAt: Number(r.firstCited) || 0,
  }));

  // —— 成本 ——
  const costRows = await rawRows<any>(sql.raw(`
    SELECT COALESCE(fetchEngine,'unknown') engine, COUNT(*) articles,
      COALESCE(SUM(fetchCostUsd), 0) fetchUsd, COALESCE(SUM(costUsd), 0) analysisUsd
    FROM monitor_articles WHERE ${win} GROUP BY engine`));
  const byEngine: MonitorReportData["costs"]["byEngine"] = {};
  let analysisUsd = 0, fetchUsd = 0;
  for (const r of costRows) {
    const f = Number(r.fetchUsd) || 0;
    byEngine[String(r.engine)] = { articles: Number(r.articles) || 0, fetchUsd: Math.round(f * 1e6) / 1e6 };
    fetchUsd += f;
    analysisUsd += Number(r.analysisUsd) || 0;
  }

  // —— 市场表现 ——（币价缺失不影响舆情报告）
  let market: MarketPeriodSummary | null = null;
  try {
    market = await getMarketPeriodSummary(startMs, endMs);
  } catch (error: any) {
    log.warn(`Market summary skipped: ${error?.message || error}`);
  }

  return {
    periodLabel: `${fmtDate(startMs)} ~ ${fmtDate(endMs - 1)}`,
    overview: {
      total: cur.total,
      effective: cur.effective,
      bySource: toMap(bySrcRows),
      sentiment: { positive: cur.pos, neutral: cur.neu, negative: cur.neg, unanalyzed: cur.unanalyzed },
      threat: toMap(threatRows),
      relevance: toMap(relRows),
    },
    sources: { topDomains, hostileActivity, newDomains },
    threats: {
      highThreatList,
      topNegatives,
      compare: {
        prevPeriodLabel: `${fmtDate(cmp.prevStartMs)} ~ ${fmtDate(cmp.prevEndMs - 1)}`,
        curPeriodLabel: `${fmtDate(startMs)} ~ ${fmtDate(cmp.curEndMs - 1)}`,
        partial: cmp.partial,
        total: cur.total, prevTotal: prev.total,
        negatives: cur.neg, prevNegatives: prev.neg,
        highThreat: cur.high, prevHighThreat: prev.high,
      },
    },
    penetration: { citedDomainsCount, amplified, newlyAmplifiedHostile },
    costs: {
      analysisUsd: Math.round(analysisUsd * 1e6) / 1e6,
      fetchUsd: Math.round(fetchUsd * 1e6) / 1e6,
      totalUsd: Math.round((analysisUsd + fetchUsd) * 1e6) / 1e6,
      byEngine,
    },
    market,
  };
}

const PUSH_CFG = "monitor_report_push_enabled"; // default OFF — 确认格式后再开

export async function getReportPushEnabled(): Promise<boolean> {
  return (await db.getSysConfig(PUSH_CFG)) === "true";
}
export async function setReportPushEnabled(v: boolean): Promise<void> {
  await db.setSysConfig(PUSH_CFG, String(v));
}

// Compact text digest for 飞书/TG push (reuses Phase 2 notification channels).
export function buildReportDigest(p: ReportPeriod, d: MonitorReportData): { title: string; content: string } {
  const typeLabel = reportKindLabel(p.reportType, p.reportPeriod);
  const c = d.threats.compare;
  const delta = (a: number, b: number) => (a === b ? "持平" : a > b ? `↑${a - b}` : `↓${b - a}`);
  const L: string[] = [];
  L.push(`📈 舆情${typeLabel} ${d.periodLabel}`);
  L.push("━━━━━━━━━━━━━━");
  L.push(`新增 ${d.overview.total} 篇(有效 ${d.overview.effective}) | 环比 ${delta(c.total, c.prevTotal)}`);
  L.push(`🟢正 ${d.overview.sentiment.positive} 🟡中 ${d.overview.sentiment.neutral} 🔴负 ${d.overview.sentiment.negative}(环比 ${delta(c.negatives, c.prevNegatives)})`);
  L.push(`高威胁 ${c.highThreat} 篇(环比 ${delta(c.highThreat, c.prevHighThreat)})`);
  if (d.sources.hostileActivity.length > 0)
    L.push(`敌对信源动态: ${d.sources.hostileActivity.slice(0, 3).map((h) => `${h.domain}(${h.articles}篇/负${h.negatives})`).join("、")}`);
  if (d.penetration.newlyAmplifiedHostile.length > 0)
    L.push(`⚠️ 新进入AI引用的风险信源: ${d.penetration.newlyAmplifiedHostile.slice(0, 3).map((x) => `${x.domain}(${x.aiPlatforms}平台)`).join("、")}`);
  if (d.market && d.market.trx !== null) {
    const f = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
    L.push(`💹 TRX ${f(d.market.trx)} | 大盘 ${f(d.market.benchmark)} | 超额 ${f(d.market.excess)} | 生态指数 ${f(d.market.tronIndex)}`);
  }
  L.push(`本期成本 $${d.costs.totalUsd.toFixed(4)}`);
  return { title: `舆情${typeLabel} ${p.reportPeriod} · 新增${d.overview.total}/负面${d.overview.sentiment.negative}`, content: L.join("\n") };
}

// Generate + persist (+ optional push). period omitted => the period containing `now`.
export async function generateMonitorReport(
  reportType: ReportType,
  period?: string,
  dateRange?: ReportDateRange
): Promise<{ reportPeriod: string; periodLabel: string; data: MonitorReportData }> {
  const now = Date.now();
  if (dateRange && reportType !== "weekly") throw new Error("自定义日期仅用于周报");
  const p = dateRange ? dateRangePeriod(dateRange) : period
    ? parsePeriod(reportType, period)
    : reportType === "weekly"
      ? weeklyPeriodOf(now)
      : monthlyPeriodOf(now);
  const data = await buildMonitorReport(p);
  await db.upsertMonitorReport({
    reportType: p.reportType,
    reportPeriod: p.reportPeriod,
    periodStart: p.startMs,
    periodEnd: p.endMs,
    reportData: data,
    generatedAt: now,
  });
  log.info(`Monitor report generated`, { type: reportType, period: p.reportPeriod, total: data.overview.total });

  if (await getReportPushEnabled()) {
    const msg = buildReportDigest(p, data);
    try {
      await dispatchNotification({
        messageType: "batch_summary",
        title: msg.title,
        content: msg.content,
      });
    } catch (error: any) {
      log.warn(`Report push failed: ${error?.message || error}`);
    }
  }
  return { reportPeriod: p.reportPeriod, periodLabel: data.periodLabel, data };
}
