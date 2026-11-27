import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getActiveAlertByDedupKey: vi.fn(),
  updateAlertEscalation: vi.fn(),
  getSysConfig: vi.fn(),
  foldSimilarIntoMonitorArticle: vi.fn(),
}));
const notifyMocks = vi.hoisted(() => ({ dispatchNotification: vi.fn(), sendEmailAlert: vi.fn() }));
vi.mock("../db", () => dbMocks);
vi.mock("../_core/notification", () => ({ dispatchNotification: notifyMocks.dispatchNotification }));
vi.mock("./email-alert", () => ({ sendEmailAlert: notifyMocks.sendEmailAlert, buildAlertEmailHtml: () => "" }));

import { escalateArticleAlert, negativeAlertSeverity } from "./notify";
import { foldCopyIntoArticle } from "./spread";

const article = {
  url: "https://m.weibo.cn/detail/1", urlHash: "abc", title: "孙宇晨被骂到道歉", domain: "m.weibo.cn",
  threatLevel: "medium", spread: { similarCount: 5 },
};

describe("negative alert severity", () => {
  it("raises one step for spread like for AI amplification", () => {
    expect(negativeAlertSeverity("medium", 2, false)).toBe("medium");
    expect(negativeAlertSeverity("medium", 2, false, true)).toBe("high");
    expect(negativeAlertSeverity("medium", 1, true, true)).toBe("high"); // medium never reaches critical
    expect(negativeAlertSeverity("high", 3, false, true)).toBe("critical");
  });
});

describe("escalateArticleAlert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.getSysConfig.mockResolvedValue("true");
    notifyMocks.dispatchNotification.mockResolvedValue({ sent: 1, attempted: 1 });
    notifyMocks.sendEmailAlert.mockResolvedValue({ sent: true });
  });

  it("raises an open alert, appends the step and pushes the new level", async () => {
    dbMocks.getActiveAlertByDedupKey.mockResolvedValue({
      id: 7, severity: "medium", title: "负面舆情[威胁中]: x",
      escalations: [{ at: 1, to: "medium", reason: "创建" }],
    });
    const res = await escalateArticleAlert(article, { pushMinSeverity: "high" });
    expect(res).toEqual({ escalated: true, severity: "high" });
    expect(dbMocks.getActiveAlertByDedupKey).toHaveBeenCalledWith("negative_article:abc");
    const patch = dbMocks.updateAlertEscalation.mock.calls[0][1];
    expect(patch.severity).toBe("high");
    expect(patch.escalations).toHaveLength(2);
    expect(patch.escalations[1]).toMatchObject({ from: "medium", to: "high", reason: "相似转载 5 条" });
    expect(notifyMocks.dispatchNotification.mock.calls[0][0]).toMatchObject({
      severity: "high", dedupKey: "negative_article:abc:esc:high", title: "【升级·高】负面舆情 - m.weibo.cn",
    });
  });

  it("does nothing without spread, without an open alert, or when already at the level", async () => {
    dbMocks.getActiveAlertByDedupKey.mockResolvedValue({ id: 7, severity: "medium", title: "t", escalations: null });
    expect((await escalateArticleAlert({ ...article, spread: { similarCount: 2 } })).escalated).toBe(false);
    dbMocks.getActiveAlertByDedupKey.mockResolvedValue({ id: 7, severity: "high", title: "t", escalations: null });
    expect((await escalateArticleAlert(article)).escalated).toBe(false);
    dbMocks.getActiveAlertByDedupKey.mockResolvedValue(undefined);
    expect((await escalateArticleAlert(article)).escalated).toBe(false);
    expect(dbMocks.updateAlertEscalation).not.toHaveBeenCalled();
  });

  it("records but does not push below the channel floor or with delivery off", async () => {
    dbMocks.getActiveAlertByDedupKey.mockResolvedValue({ id: 7, severity: "medium", title: "t", escalations: [] });
    await escalateArticleAlert(article, { pushMinSeverity: "critical" });
    await escalateArticleAlert(article, { deliveryEnabledOverride: false });
    expect(dbMocks.updateAlertEscalation).toHaveBeenCalledTimes(2);
    expect(notifyMocks.dispatchNotification).not.toHaveBeenCalled();
  });
});

describe("foldCopyIntoArticle", () => {
  beforeEach(() => vi.clearAllMocks());

  it("counts the copy and escalates when an influential account reposts", async () => {
    dbMocks.foldSimilarIntoMonitorArticle.mockResolvedValue({
      id: 3, url: article.url, urlHash: "abc", title: "t", domain: "m.weibo.cn", sourcePlatform: "weibo",
      threatLevel: "high", similarCount: 1,
    });
    dbMocks.getActiveAlertByDedupKey.mockResolvedValue({ id: 9, severity: "high", title: "t", escalations: [] });
    const res = await foldCopyIntoArticle(3, { sourcePlatform: "weibo", metrics: { authorName: "@大V", authorFollowers: 800_000 } },
      { deliveryEnabledOverride: false });
    expect(res).toEqual({ folded: true, escalated: true });
    expect(dbMocks.foldSimilarIntoMonitorArticle).toHaveBeenCalledWith(3, "weibo");
    expect(dbMocks.updateAlertEscalation.mock.calls[0][1].escalations[0]).toMatchObject({
      from: "high", to: "critical", reason: "被 @大V（粉丝 80万）转载",
    });
  });

  it("skips the alert lookup for non-threatening articles", async () => {
    dbMocks.foldSimilarIntoMonitorArticle.mockResolvedValue({ id: 3, threatLevel: "none", similarCount: 9 });
    expect(await foldCopyIntoArticle(3, { sourcePlatform: "web" })).toEqual({ folded: true, escalated: false });
    expect(dbMocks.getActiveAlertByDedupKey).not.toHaveBeenCalled();
  });
});
