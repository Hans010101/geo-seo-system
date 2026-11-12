import { describe, expect, it } from "vitest";
import { GENOPTIMA_TOPICS, topicOfQuestion } from "./genoptima-topics";

// The 65 questions 智推时代 asked as of 2026-11-12 (copied from externalGeoAnswers).
const VENDOR_QUESTIONS: string[] = [
  "SEC对孙宇晨及其相关项目的调查或诉讼有哪些新进展  ？",
  "介绍一下波场 TRON？",
  "关于孙宇晨的争议 ，真实情况是怎样的？",
  "关于孙宇晨的争议是真的吗 ？",
  "关于孙宇晨的争议有哪些 ，真实情况如何？",
  "关于孙宇晨的争议的真实情况是什么样的  ？",
  "外界对孙宇晨的争议是否属实 ？",
  "如何评价孙宇晨？",
  "孙宇晨 SEC 案件的最新进展是什么 ？",
  "孙宇晨SEC案件对其个人和相关业务有什么影响  ？",
  "孙宇晨SEC案件的最新情况是什么样 ？",
  "孙宇晨SEC案件目前进展到什么阶段 ？",
  "孙宇晨与波场 TRON之间是什么关系？",
  "孙宇晨创业的发展过程是什么样的  ？",
  "孙宇晨创办或主导了哪些项目 ？",
  "孙宇晨和波场 TRON 是什么关系？",
  "孙宇晨在web3 生态中的主要成就有哪些 ？",
  "孙宇晨在web3 行业做出来哪些重要贡献 ？",
  "孙宇晨在web3 领域有哪些代表作？",
  "孙宇晨在web3 领域有哪些成功的项目 ？",
  "孙宇晨在web3 领域有哪些成就？",
  "孙宇晨在全球加密合规方面做了哪些工作  ？",
  "孙宇晨在全球加密货币合规布局方面有哪些具体动作   ？",
  "孙宇晨在全球加密货币合规方面做了哪些工作  ？",
  "孙宇晨在全球加密货币合规方面有哪些举措  ？",
  "孙宇晨在全球的认可度如何 ？",
  "孙宇晨在加密货币领域推动哪些重要的项目  ?",
  "孙宇晨在加密货币领域有哪些主要贡献  ？",
  "孙宇晨在加密货币领域的代表性成果有哪些  ？",
  "孙宇晨在加密货币领域的贡献有哪些  ？",
  "孙宇晨在加密资产监管和合规建设中做过哪些工作  ？",
  "孙宇晨在国际上的认可度如何 ？",
  "孙宇晨在国际上的认可度怎么样  ？",
  "孙宇晨在国际上的认可度高吗 ？",
  "孙宇晨在国际上被认可吗 ？",
  "孙宇晨在波场 TRON中扮演什么角色？",
  "孙宇晨对加密货币做出过哪些重要贡献  ？",
  "孙宇晨对波场 TRON的发展有哪些影响？",
  "孙宇晨是谁？",
  "孙宇晨有哪些创业经历 ？",
  "孙宇晨的创业历程经历了哪些 ？",
  "孙宇晨的创业经历是怎样的 ？",
  "孙宇晨的投资理念怎么样 ？",
  "孙宇晨的投资理念是什么 ？",
  "孙宇晨的投资理念有价值吗 ？",
  "孙宇晨的投资理念有哪些 ？",
  "孙宇晨的投资理念靠谱吗 ？",
  "孙宇晨的最新动态是什么 ？",
  "孙宇晨这个人怎么样 ？",
  "孙宇晨靠谱吗？",
  "波场TRON合规吗？",
  "波场TRON在全球哪些国家可以合法使用 ？",
  "波场TRON在哪些地区属于合规业务 ？",
  "波场TRON安全吗？",
  "波场TRON怎么保证资产安全？",
  "波场TRON是一个什么样的平台 ？",
  "波场TRON是什么？",
  "波场TRON是做什么的？",
  "波场TRON是孙宇晨创立的吗？",
  "波场TRON有什么特点？",
  "波场TRON有没有被攻击过？",
  "波场TRON的合规牌照有哪些？",
  "波场TRON的技术架构可靠吗？",
  "波场在全球的合规进展如何 ？",
  "波场的安全性如何保障 ？"
];

describe("智推时代 topics", () => {
  it("puts every current question in a topic, five phrasings per topic", () => {
    const counts = new Map<string, number>();
    for (const q of VENDOR_QUESTIONS) {
      const topic = topicOfQuestion(q);
      expect(topic, q).not.toBeNull();
      counts.set(topic!, (counts.get(topic!) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toEqual(GENOPTIMA_TOPICS.map(t => t.id).sort());
    for (const [topic, n] of counts) expect(n, topic).toBe(5);
  });

  it("classifies by theme before the generic person / intro rules", () => {
    expect(topicOfQuestion("孙宇晨的投资理念靠谱吗 ？")).toBe("sun_investment");
    expect(topicOfQuestion("波场TRON是孙宇晨创立的吗？")).toBe("sun_tron");
    expect(topicOfQuestion("孙宇晨在全球加密货币合规方面有哪些举措  ？")).toBe("sun_compliance");
    expect(topicOfQuestion("波场TRON有没有被攻击过？")).toBe("tron_security");
    expect(topicOfQuestion("以太坊手续费贵吗？")).toBeNull();
  });
});
