// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ limit: vi.fn(), options: vi.fn() }));
vi.mock("@upstash/redis", () => ({ Redis: class {} }));
vi.mock("@upstash/ratelimit", () => ({
  Ratelimit: Object.assign(class { public constructor(options: unknown) { mocks.options(options); } public limit = mocks.limit; }, { slidingWindow: (count: number, window: string) => ({ count, window }) }),
}));

import { NOBROKER_LEADS_PER_MINUTE, checkNoBrokerRate, resetNoBrokerRateLimiterForTests } from "@/lib/server/nobroker/nobroker-rate-limit";

beforeEach(() => {
  vi.resetAllMocks();
  resetNoBrokerRateLimiterForTests();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example.com");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token");
});
afterEach(() => vi.unstubAllEnvs());

describe("checkNoBrokerRate", () => {
  it("uses its own key prefix and 120 leads a minute per integration", async () => {
    mocks.limit.mockResolvedValue({ success: true });
    await expect(checkNoBrokerRate("hs-1")).resolves.toEqual({ allowed: true });
    expect(mocks.limit).toHaveBeenCalledWith("hs-1");
    expect(NOBROKER_LEADS_PER_MINUTE).toBe(120);
    expect(mocks.options).toHaveBeenCalledWith(expect.objectContaining({ prefix: "ratelimit:nobroker-webhook", limiter: { count: 120, window: "60 s" } }));
  });

  it("refuses with the seconds until the window resets", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    mocks.limit.mockResolvedValue({ success: false, reset: 1_000_000 + 4_200 });
    await expect(checkNoBrokerRate("hs-1")).resolves.toEqual({ allowed: false, retryAfterSeconds: 5 });
    vi.useRealTimers();
  });

  it("lets the lead in when Redis fails or is not set up", async () => {
    mocks.limit.mockRejectedValue(new Error("down"));
    await expect(checkNoBrokerRate("hs-1")).resolves.toEqual({ allowed: true });
    resetNoBrokerRateLimiterForTests();
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    await expect(checkNoBrokerRate("hs-1")).resolves.toEqual({ allowed: true });
  });
});
