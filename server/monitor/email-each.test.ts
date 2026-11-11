import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({ getSysConfig: vi.fn(async () => null) }));
vi.mock("../_core/cloudflare-env", () => ({
  getCloudflareEnv: () => ({ RESEND_API_KEY: "re_test", RESEND_FROM: "TRON 舆情 <brief@trongeo.asia>", AUTH_ALLOWED_EMAIL: "owner@example.com" }),
}));
import { sendEmailToEach } from "./email-alert";

afterEach(() => vi.unstubAllGlobals());

describe("sendEmailToEach", () => {
  it("sends one private message per recipient and reports failures separately", async () => {
    const bodies: { to: string[]; from: string; text?: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      return body.to[0] === "bad@example.com"
        ? new Response(JSON.stringify({ message: "invalid" }), { status: 422 })
        : new Response(JSON.stringify({ id: "x" }), { status: 200 });
    }));
    const result = await sendEmailToEach(["a@example.com", "bad@example.com", "b@example.com"], "主题", "<p>x</p>", "x");
    expect(bodies.map(b => b.to)).toEqual([["a@example.com"], ["bad@example.com"], ["b@example.com"]]);
    expect(bodies[0]).toMatchObject({ from: "TRON 舆情 <brief@trongeo.asia>", text: "x" });
    expect(result.sent).toEqual(["a@example.com", "b@example.com"]);
    expect(result.failed).toEqual([{ to: "bad@example.com", error: "invalid" }]);
  });
});
