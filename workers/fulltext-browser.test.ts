import { describe, expect, it } from "vitest";
import { validatePublicHttpUrl } from "./fulltext-browser-guard";

describe("fulltext browser URL validation", () => {
  it("accepts public HTTP(S) URLs and strips credentials", () => {
    expect(validatePublicHttpUrl("https://user:pass@example.com/a").toString())
      .toBe("https://example.com/a");
  });

  it.each([
    "file:///etc/passwd",
    "http://localhost/a",
    "http://127.0.0.1/a",
    "http://10.0.0.1/a",
    "http://172.16.0.1/a",
    "http://192.168.1.1/a",
    "http://service.local/a",
    "http://[::1]/a",
  ])("rejects non-public destination %s", (url) => {
    expect(() => validatePublicHttpUrl(url)).toThrow();
  });
});
