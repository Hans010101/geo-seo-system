import { describe, expect, it } from "vitest";
import { isPasswordRegistrationEnabled } from "./cf-auth";

describe("password registration gate", () => {
  it("is closed by default and only opens explicitly", () => {
    expect(isPasswordRegistrationEnabled({})).toBe(false);
    expect(isPasswordRegistrationEnabled({ ALLOW_PASSWORD_REGISTRATION: "false" })).toBe(false);
    expect(isPasswordRegistrationEnabled({ ALLOW_PASSWORD_REGISTRATION: "true" })).toBe(true);
  });
});
