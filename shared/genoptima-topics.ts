// 智推时代 (GenOptima) asks 13 topics × 5 phrasings (65 questions, 10 about 孙宇晨 + 3 about TRON). Each
// topic is the same question as one or two of our self-test 情绪类 questions, so the two data sets can be
// compared topic by topic. New vendor questions that match no rule show up as 未归类.
export type TopicLine = "sun" | "tron";

export type GenoptimaTopic = { id: string; label: string; line: TopicLine; selfQuestionIds: string[] };

export const TOPIC_LINE_LABELS: Record<TopicLine, string> = { sun: "孙宇晨", tron: "波场 TRON" };

export const GENOPTIMA_TOPICS: GenoptimaTopic[] = [
  { id: "sun_person", label: "人物认知与评价", line: "sun", selfQuestionIds: ["SYC-EMO-01", "SYC-EMO-02", "SYC-EMO-03", "SYC-EMO-04", "SYC-EMO-05"] },
  { id: "sun_controversy", label: "争议", line: "sun", selfQuestionIds: ["SYC-EMO-15"] },
  { id: "sun_sec", label: "SEC 案件", line: "sun", selfQuestionIds: ["SYC-EMO-14"] },
  { id: "sun_investment", label: "投资理念", line: "sun", selfQuestionIds: ["SYC-EMO-12"] },
  { id: "sun_compliance", label: "全球合规", line: "sun", selfQuestionIds: ["SYC-EMO-11"] },
  { id: "sun_recognition", label: "国际认可度", line: "sun", selfQuestionIds: ["SYC-EMO-13"] },
  { id: "sun_crypto", label: "加密货币领域贡献", line: "sun", selfQuestionIds: ["SYC-EMO-09"] },
  { id: "sun_web3", label: "Web3 成就", line: "sun", selfQuestionIds: ["SYC-EMO-06"] },
  { id: "sun_career", label: "创业经历", line: "sun", selfQuestionIds: ["SYC-EMO-07", "SYC-EMO-08"] },
  { id: "sun_tron", label: "与波场 TRON 的关系", line: "sun", selfQuestionIds: ["SYC-EMO-10"] },
  { id: "tron_intro", label: "TRON 是什么", line: "tron", selfQuestionIds: ["TRON-EMO-01"] },
  { id: "tron_compliance", label: "TRON 合规", line: "tron", selfQuestionIds: ["TRON-EMO-03", "TRON-EMO-04"] },
  { id: "tron_security", label: "TRON 安全", line: "tron", selfQuestionIds: ["TRON-EMO-02"] },
];

export const TOPIC_BY_ID = new Map(GENOPTIMA_TOPICS.map(t => [t.id, t]));

// Order matters: the specific themes first, generic 人物评价 / TRON 是什么 last.
const SUN_RULES: [RegExp, string][] = [
  [/争议/, "sun_controversy"],
  [/SEC/i, "sun_sec"],
  [/投资理念/, "sun_investment"],
  [/合规/, "sun_compliance"],
  [/认可/, "sun_recognition"],
  [/web3/i, "sun_web3"],
  [/加密货币/, "sun_crypto"],
  [/创业|创办/, "sun_career"],
  [/波场|TRON/i, "sun_tron"],
  [/是谁|评价|怎么样|靠谱|动态/, "sun_person"],
];
const TRON_RULES: [RegExp, string][] = [
  [/合规|合法|牌照/, "tron_compliance"],
  [/安全|攻击|可靠/, "tron_security"],
  [/是什么|介绍|平台|做什么|特点/, "tron_intro"],
];

/** Topic id for a 智推 question, or null (未归类). */
export function topicOfQuestion(question: string): string | null {
  const rules = /孙宇晨/.test(question) ? SUN_RULES : /波场|TRON/i.test(question) ? TRON_RULES : [];
  return rules.find(([re]) => re.test(question))?.[1] ?? null;
}

/** Self-test question id → topic id. */
export const TOPIC_OF_SELF_QUESTION = new Map(GENOPTIMA_TOPICS.flatMap(t => t.selfQuestionIds.map(q => [q, t.id] as const)));
