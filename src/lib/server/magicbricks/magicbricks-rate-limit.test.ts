// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ limit: vi.fn(), options: vi.fn() }));
vi.mock("@upstash/redis", () => ({ Redis: class {} }));
vi.mock("@upstash/ratelimit", () => ({
  Ratelimit: Object.assign(class { public constructor(options: unknown) { mocks.options(options); } public limit = mocks.limit; }, { slidingWindow: (count: number, window: string) => ({ count, window }) }),
}));

import { MAGICBRICKS_LEADS_PER_MINUTE, checkMagicbricksRate, resetMagicbricksRateLimiterForTests } from "@/lib/server/magicbricks/magicbricks-rate-limit";

beforeEach(() => {
  vi.resetAllMocks();
  resetMagicbricksRateLimiterForTests();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example.com");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token");
});
afterEach(() => vi.unstubAllEnvs());

describe("checkMagicbricksRate", () => {
  it("uses its own key prefix and 120 leads a minute per integration", async () => {
    mocks.limit.mockResolvedValue({ success: true });
    await expect(checkMagicbricksRate("mb-1")).resolves.toEqual({ allowed: true });
    expect(mocks.limit).toHaveBeenCalledWith("mb-1");
    expect(mocks.options).toHaveBeenCalledWith(expect.objectContaining({ prefix: "ratelimit:magicbricks-webhook", limiter: { count: MAGICBRICKS_LEADS_PER_MINUTE, window: "60 s" } }));
  });

  it("refuses with the seconds until the window resets", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    mocks.limit.mockResolvedValue({ success: false, reset: 1_000_000 + 4_200 });
    await expect(checkMagicbricksRate("mb-1")).resolves.toEqual({ allowed: false, retryAfterSeconds: 5 });
    vi.useRealTimers();
  });

  it("lets the lead in when Redis fails or is not set up", async () => {
    mocks.limit.mockRejectedValue(new Error("down"));
    await expect(checkMagicbricksRate("mb-1")).resolves.toEqual({ allowed: true });
    resetMagicbricksRateLimiterForTests();
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    await expect(checkMagicbricksRate("mb-1")).resolves.toEqual({ allowed: true });
  });
});
