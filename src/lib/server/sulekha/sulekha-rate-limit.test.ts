// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ limit: vi.fn(), options: vi.fn() }));
vi.mock("@upstash/redis", () => ({ Redis: class {} }));
vi.mock("@upstash/ratelimit", () => ({
  Ratelimit: Object.assign(class { public constructor(options: unknown) { mocks.options(options); } public limit = mocks.limit; }, { slidingWindow: (count: number, window: string) => ({ count, window }) }),
}));

import { SULEKHA_LEADS_PER_MINUTE, checkSulekhaRate, resetSulekhaRateLimiterForTests } from "@/lib/server/sulekha/sulekha-rate-limit";

beforeEach(() => {
  vi.resetAllMocks();
  resetSulekhaRateLimiterForTests();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example.com");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token");
});
afterEach(() => vi.unstubAllEnvs());

describe("checkSulekhaRate", () => {
  it("uses its own key prefix and 120 leads a minute per integration", async () => {
    mocks.limit.mockResolvedValue({ success: true });
    await expect(checkSulekhaRate("sul-1")).resolves.toEqual({ allowed: true });
    expect(mocks.limit).toHaveBeenCalledWith("sul-1");
    expect(SULEKHA_LEADS_PER_MINUTE).toBe(120);
    expect(mocks.options).toHaveBeenCalledWith(expect.objectContaining({ prefix: "ratelimit:sulekha-webhook", limiter: { count: 120, window: "60 s" } }));
  });

  it("refuses with the seconds until the window resets", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    mocks.limit.mockResolvedValue({ success: false, reset: 1_000_000 + 4_200 });
    await expect(checkSulekhaRate("sul-1")).resolves.toEqual({ allowed: false, retryAfterSeconds: 5 });
    vi.useRealTimers();
  });

  it("lets the lead in when Redis fails or is not set up", async () => {
    mocks.limit.mockRejectedValue(new Error("down"));
    await expect(checkSulekhaRate("sul-1")).resolves.toEqual({ allowed: true });
    resetSulekhaRateLimiterForTests();
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    await expect(checkSulekhaRate("sul-1")).resolves.toEqual({ allowed: true });
  });
});
