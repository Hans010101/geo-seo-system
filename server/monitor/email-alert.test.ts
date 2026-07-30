import { afterEach, describe, expect, it, vi } from "vitest";
import * as db from "../db";
import { withCloudflareEnv } from "../_core/cloudflare-env";
import { getEmailAlertConfig, sendEmailAlert } from "./email-alert";

vi.mock("../db", () => ({
  getSysConfig: vi.fn(),
}));

describe("Cloudflare Resend alert transport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses Cloudflare secrets when no database override exists", async () => {
    vi.mocked(db.getSysConfig).mockResolvedValue(null);
    const config = await withCloudflareEnv({
      RESEND_API_KEY: "re_cloudflare",
      RESEND_FROM: "GEO <onboarding@resend.dev>",
      AUTH_ALLOWED_EMAIL: "hans.pan007@gmail.com",
    }, getEmailAlertConfig);
    expect(config).toEqual({
      apiKey: "re_cloudflare",
      from: "GEO <onboarding@resend.dev>",
      recipient: "hans.pan007@gmail.com",
    });
  });

  it("sends through the Resend HTTP API with an idempotency key", async () => {
    vi.mocked(db.getSysConfig).mockResolvedValue(null);
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "email_1" }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await withCloudflareEnv({
      RESEND_API_KEY: "re_cloudflare",
      AUTH_ALLOWED_EMAIL: "hans.pan007@gmail.com",
    }, () => sendEmailAlert("subject", "<p>body</p>"));
    expect(result).toEqual({ sent: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer re_cloudflare",
          "Idempotency-Key": expect.stringMatching(/^geo-alert-/),
        }),
      }),
    );
  });
});
