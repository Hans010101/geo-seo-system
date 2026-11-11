import { describe, expect, it } from "vitest";
import { COOKIE_NAME } from "@shared/const";
import { app } from "./index";

describe("退出登录", () => {
  it("expires the session cookie in the tRPC response", async () => {
    const res = await app.request("/api/trpc/auth.logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, {});
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") || "";
    expect(cookie).toContain(`${COOKIE_NAME}=;`);
    expect(cookie).toContain("Max-Age=0");
  });

  it("leaves other calls without a cookie header", async () => {
    const res = await app.request("/api/trpc/auth.me", {}, {});
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
