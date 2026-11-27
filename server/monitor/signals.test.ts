import { describe, expect, it } from "vitest";
import {
  copyInfluenceReason,
  hammingHex,
  metricsColumns,
  parseCountText,
  ruleNoiseReason,
  sanitizeMetrics,
  simHashBands,
  simHashHex,
  similarityText,
  spreadReasons,
} from "./signals";

const STORY =
  "11月18日，孙宇晨在社交平台抛出了一个扎心的观点：字节跳动这一家公司，基本等于做空了整个恒生科技和中概股。" +
  "这就像1644年清军入关，最强的玩家根本不在指数里、不在二级市场，普通人买不到，却在蚕食所有存量市场。";

describe("simhash near-duplicates", () => {
  it("ignores the author label, links and punctuation", () => {
    expect(similarityText("【微博】@某人：孙宇晨，说了 https://t.cn/x 一句话！")).toBe("孙宇晨说了一句话");
    expect(similarityText("UP主 福睿达：孙宇晨的视频")).toBe("孙宇晨的视频");
  });

  it("matches reposts with a different author label and small edits", () => {
    const a = simHashHex(`【微博】@甲：${STORY}`)!;
    const b = simHashHex(`@乙：$腾讯控股 hk00700$ ${STORY.replace("扎心的", "扎心")}`)!;
    const other = simHashHex("孙宇晨要买字节5%老股，字节跳动目前市场估值6000亿美金，5%就是300亿美金，也就是人民币2000亿，怎么说？")!;
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(hammingHex(a, simHashHex(STORY)!)).toBe(0);
    expect(hammingHex(a, b)).toBeLessThanOrEqual(10);
    expect(hammingHex(a, other)).toBeGreaterThan(3);
  });

  it("skips texts too short to fingerprint", () => {
    expect(simHashHex("孙宇晨又上热搜了")).toBeNull();
  });

  it("splits into four bands for the candidate query", () => {
    expect(simHashBands("0123456789abcdef")).toEqual(["0123", "4567", "89ab", "cdef"]);
    expect(hammingHex("0000000000000000", "000000000000000f")).toBe(4);
    expect(hammingHex("ffffffff00000000", "7fffffff00000001")).toBe(2);
  });
});

describe("rule noise", () => {
  it("drops posts that are only hashtags with a bare entity tag", () => {
    expect(ruleNoiseReason("", "【抖音】@波牛：#孙宇晨 #股民交流")).toBe("仅话题标签，无正文");
    expect(ruleNoiseReason("", "#坚持 #薄肌 #孙宇晨 #游戏 #拒绝精神内耗")).toBe("仅话题标签，无正文");
    expect(ruleNoiseReason("", "#孙宇晨#伙伴计划#创作者计划#")).toBe("仅话题标签，无正文");
  });

  it("keeps posts with text or a specific topic tag", () => {
    // Real 2026-11 negatives that a broader 'ignore keywords in tags/@' rule would have dropped.
    expect(ruleNoiseReason("", "一个不敢回国的人，嘲笑90万人的饭碗？#名人名事 #孙宇晨嘲讽京东翻车")).toBeNull();
    expect(ruleNoiseReason("", "…被网友骂到滑跪道歉，“东哥永远是我大哥”#孙宇晨#刘强东#京东#道歉#滑跪")).toBeNull();
    expect(ruleNoiseReason("", "实锤了好像 号都没了 @孙宇晨")).toBeNull();
    expect(ruleNoiseReason("", "#孙宇晨嘲讽京东翻车#")).toBeNull();
    expect(ruleNoiseReason("", "孙宇晨回应争议 #孙宇晨")).toBeNull();
  });
});

describe("metrics", () => {
  it("parses Chinese count text", () => {
    expect(parseCountText("2.4万")).toBe(24_000);
    expect(parseCountText("1.2w")).toBe(12_000);
    expect(parseCountText("3亿")).toBe(300_000_000);
    expect(parseCountText("10+")).toBe(10);
    expect(parseCountText("1,234")).toBe(1_234);
    expect(parseCountText("赞")).toBeNull();
  });

  it("sanitizes untrusted metrics", () => {
    expect(sanitizeMetrics({ authorName: " 某大V ", authorFollowers: "52万", authorVerified: "org", likeCount: -1, viewCount: "x", shareCount: 3.6 }))
      .toEqual({ authorName: "某大V", authorFollowers: 520_000, authorVerified: "org", shareCount: 4 });
    expect(sanitizeMetrics({ authorVerified: "admin" })).toBeUndefined();
    expect(sanitizeMetrics("nope")).toBeUndefined();
  });

  it("maps to columns, seeding similarCount from the vendor's own fold", () => {
    expect(metricsColumns({ vendorSimilar: 4, likeCount: 2 }, "@x")).toMatchObject({ authorName: "@x", likeCount: 2, similarCount: 4, commentCount: null });
    expect(metricsColumns(undefined)).toMatchObject({ authorName: null, similarCount: 0 });
  });
});

describe("spread reasons", () => {
  it("names each signal over its threshold", () => {
    expect(spreadReasons({ similarCount: 4, commentCount: 100, likeCount: 10 })).toEqual([]);
    expect(spreadReasons({ similarCount: 5 })).toEqual(["相似转载 5 条"]);
    expect(spreadReasons({ commentCount: 300, shareCount: 250, authorFollowers: 520_000 })).toEqual(["评论+转发 550", "作者粉丝 52万"]);
    expect(spreadReasons({ viewCount: 718_971, authorVerified: "org" })).toEqual(["播放/阅读 71.9万", "机构认证作者"]);
  });

  it("describes an influential reposting copy", () => {
    expect(copyInfluenceReason({ authorName: "@某大V", authorFollowers: 1_200_000 }, "微博")).toBe("被 @某大V（粉丝 120万）转载");
    expect(copyInfluenceReason({ authorVerified: "org" }, "微博")).toBe("被机构认证账号 微博账号 转载");
    expect(copyInfluenceReason({ authorFollowers: 900 }, "微博")).toBeNull();
  });
});
