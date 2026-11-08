import { afterEach, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import * as db from "./db";
import { withCloudflareEnv } from "./_core/cloudflare-env";
import type { TrpcContext } from "./_core/context";
import facts from "../docs/target-facts-20261022.json";

afterEach(() => vi.restoreAllMocks());

it("passes active descriptions to analysis and stores only strict boolean coverage for active keys", async () => {
  const ctx = { user: { id: 1, role: "developer", email: "hans.pan007@gmail.com" }, req: { headers: {} }, res: {} } as TrpcContext;
  vi.spyOn(db, "getCollectionById").mockResolvedValue({ id: 99, questionText: "介绍孙宇晨", responseText: "孙宇晨曾任格林纳达常驻WTO代表。", questionId: "q1", platform: "chatgpt" } as any);
  vi.spyOn(db, "deleteAnalysisByCollectionId").mockResolvedValue(undefined);
  const list = vi.spyOn(db, "listTargetFacts").mockResolvedValue(facts.facts as any);
  const save = vi.spyOn(db, "createAnalysis").mockResolvedValue(undefined);
  vi.spyOn(db, "listUrlMatchRules").mockResolvedValue([]);
  vi.spyOn(db, "getAnalysisByCollectionId").mockResolvedValue(undefined);
  const run = vi.fn().mockResolvedValue({ response: { sentiment_score: 3, target_facts_check: {
    sun_grenada_ambassador: true, sun_forbes_recognized: "false", tron_tps_2000: true,
  } } });

  await withCloudflareEnv({ AI: { run } }, () => appRouter.createCaller(ctx).collections.reanalyze({ id: 99 }));

  expect(list).toHaveBeenCalledWith(true);
  const input = run.mock.calls[0][1];
  const prompt = input.messages[1].content;
  for (const fact of facts.facts) expect(prompt).toContain(fact.factDescription);
  expect(prompt).toContain("不要把本标准中的内容当作回答已提及的证据");
  expect(prompt).toContain("情感评价应独立客观");
  expect(run).toHaveBeenCalledTimes(1);
  const coverage = save.mock.calls[0][0].targetFactsCheck;
  expect(coverage).toEqual(Object.fromEntries(facts.facts.map(f => [f.factKey, f.factKey === "sun_grenada_ambassador"])));
  expect(coverage).not.toHaveProperty("tron_tps_2000");
});

it("has unique, sourced criteria and disjoint retired keys", () => {
  const keys = facts.facts.map(f => f.factKey);
  expect(new Set(keys).size).toBe(keys.length);
  for (const fact of facts.facts) {
    expect(fact.factKey).toMatch(/^[a-z][a-z0-9_]+$/);
    expect(fact.factDescription).toContain("https://");
    expect(facts.retire).not.toContain(fact.factKey);
  }
});
