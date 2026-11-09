import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  db: { listMonitorKeywords: vi.fn(), getMonitorArticleByUrlHash: vi.fn(), getRecentMonitorArticleDuplicate: vi.fn(), createMonitorArticle: vi.fn() },
  fetch: vi.fn(), sources: vi.fn(), analyze: vi.fn(), alert: vi.fn(), briefing: vi.fn(),
}));
vi.mock("../db", () => m.db);
vi.mock("./budget", () => ({ beginCycle: vi.fn(), maxArticlesPerCycle: () => 80 }));
vi.mock("./sources/registry", () => ({ enabledSources: m.sources }));
vi.mock("./fetch/router", () => ({ fetchArticle: m.fetch }));
vi.mock("./analyzer", () => ({ analyzeArticle: m.analyze, shouldStoreMonitorAnalysis: (a: any) => a?.relevance !== "irrelevant" }));
vi.mock("./notify", () => ({ alertThresholdMet: async () => true, dispatchHighThreatAlert: m.alert, sendBriefing: m.briefing }));
import { runMonitorCycle } from "./pipeline";
const post = () => ({ url: "https://news.org/justin-sun-tron", title: "孙宇晨与波场 TRON", contentSnippet: "孙宇晨宣布波场 TRON 区块链新进展。", publishedAt: Date.now() - 3600_000, sourceName: "agent_reach", sourcePlatform: "web" });
beforeEach(() => {
  vi.clearAllMocks();
  m.db.listMonitorKeywords.mockResolvedValue([{ keyword: "孙宇晨", priority: 10 }]);
  m.db.getMonitorArticleByUrlHash.mockResolvedValue(null);
  m.db.getRecentMonitorArticleDuplicate.mockResolvedValue(null);
  m.db.createMonitorArticle.mockResolvedValue(12);
  m.analyze.mockResolvedValue({ relevance: "high", sentimentScore: 2, threatLevel: "medium", summary: "test", provider: "cloudflare_workers_ai", model: "8b" });
  m.alert.mockResolvedValue({ created: true });
});
it("imports partial content through existing filters, analysis and alerting without any paid fetch/discovery", async () => {
  const result = await runMonitorCycle({ importPosts: [post()], maxArticles: 1 });
  expect(result).toMatchObject({ inserted: 1, serperCalls: 0, fetchCostUsd: 0 });
  expect(m.fetch).not.toHaveBeenCalled();
  expect(m.sources).not.toHaveBeenCalled();
  expect(m.briefing).not.toHaveBeenCalled();
  expect(m.db.createMonitorArticle).toHaveBeenCalledWith(expect.objectContaining({ fetchStatus: "partial", fetchEngine: "agent_reach_public" }));
  expect(m.alert).toHaveBeenCalledOnce();
});
it("labels Mac-browser posts as local_browser", async () => {
  await runMonitorCycle({ importPosts: [{ ...post(), sourceName: "local_browser", fetchEngineHint: "local_browser", sourcePlatform: "weibo" }], maxArticles: 1 });
  expect(m.db.createMonitorArticle).toHaveBeenCalledWith(expect.objectContaining({ fetchEngine: "local_browser" }));
});
it("labels 百分点 imports with their own engine and original platform", async () => {
  await runMonitorCycle({ importPosts: [{ ...post(), sourceName: "percent", fetchEngineHint: "percent", sourcePlatform: "douyin" }], maxArticles: 1 });
  expect(m.db.createMonitorArticle).toHaveBeenCalledWith(expect.objectContaining({ fetchEngine: "percent", sourcePlatform: "douyin" }));
});
it("does not discover anything on an empty import or admit irrelevant/old posts", async () => {
  await runMonitorCycle({ importPosts: [] });
  await runMonitorCycle({ importPosts: [{ ...post(), title: "电影 TRON 配乐", contentSnippet: "a film soundtrack" }, { ...post(), publishedAt: 1 }] });
  expect(m.sources).not.toHaveBeenCalled();
  expect(m.analyze).not.toHaveBeenCalled();
  expect(m.db.createMonitorArticle).not.toHaveBeenCalled();
});
it("skips already-stored URLs before AI", async () => {
  m.db.getMonitorArticleByUrlHash.mockResolvedValue({ id: 1 });
  await runMonitorCycle({ importPosts: [post()] });
  expect(m.analyze).not.toHaveBeenCalled();
});
