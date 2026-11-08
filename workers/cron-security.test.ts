import { describe, expect, it } from "vitest";
import { isOperatorAuthorized } from "./operator-auth";

describe("cron operator access", () => {
  const env = { CLOUDFLARE_OPERATOR_TOKEN: "secret" } as any;

  it("rejects missing/wrong credentials and accepts either supported header", () => {
    expect(isOperatorAuthorized(new Request("https://cron/status"), env)).toBe(false);
    expect(isOperatorAuthorized(new Request("https://cron/status", { headers: { "x-operator-token": "wrong" } }), env)).toBe(false);
    expect(isOperatorAuthorized(new Request("https://cron/status", { headers: { authorization: "Bearer secret" } }), env)).toBe(true);
  });
});
