import { describe, expect, it, vi } from "vitest";
import {
  isFreshHealthyOpenRouter,
  probeOpenRouter,
} from "./openrouter-preflight";

describe("OpenRouter preflight", () => {
  it("detects an exhausted account before weekly GEO work starts", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({
        data: { limit_remaining: null, usage_daily: 0 },
      }))
      .mockResolvedValueOnce(Response.json({
        error: { code: 402, message: "Insufficient credits" },
      }, { status: 402 }));

    const result = await probeOpenRouter({
      apiKey: "test-key",
      fetchImpl,
      checkedAt: 1234,
    });

    expect(result).toMatchObject({
      configured: true,
      available: false,
      status: "insufficient_credits",
      httpStatus: 402,
      checkedAt: 1234,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("marks a valid key and one-token completion as healthy", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({
        data: { limit_remaining: 5, usage_daily: 0.1 },
      }))
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: "OK" } }],
      }));

    const result = await probeOpenRouter({
      apiKey: "test-key",
      fetchImpl,
      checkedAt: 10_000,
    });

    expect(result).toMatchObject({
      available: true,
      status: "healthy",
      keyLimitRemaining: 5,
      keyUsageDaily: 0.1,
    });
    expect(isFreshHealthyOpenRouter(result, 20_000, 26)).toBe(true);
    expect(isFreshHealthyOpenRouter(result, 27 * 3_600_000, 26)).toBe(false);
  });

  it("does not call the network without a configured key", async () => {
    const fetchImpl = vi.fn();
    const result = await probeOpenRouter({ fetchImpl });
    expect(result.status).toBe("unconfigured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
