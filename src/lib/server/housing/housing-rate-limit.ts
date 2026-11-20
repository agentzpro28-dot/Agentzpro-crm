import "server-only";

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

/**
 * At most this many leads a minute reach one company through its Housing.com URL, so a leaked URL cannot flood the CRM.
 * Housing.com sends far fewer.
 */
export const HOUSING_LEADS_PER_MINUTE = 120;
// How long one Redis check may take before the lead is let in anyway.
const RATE_LIMIT_TIMEOUT_MS = 1000;

export type HousingRateDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

let cachedLimiter: Ratelimit | null | undefined;

/**
 * Reads only the two Upstash variables, straight from process.env: an unrelated missing variable must never stop
 * Housing.com leads arriving. Null when Upstash is not set. Its own key prefix, so its counts never mix with any other
 * limit.
 */
function getLimiter(): Ratelimit | null {
  if (cachedLimiter !== undefined) return cachedLimiter;
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  cachedLimiter = url && token
    ? new Ratelimit({
      redis: new Redis({ url, token }),
      limiter: Ratelimit.slidingWindow(HOUSING_LEADS_PER_MINUTE, "60 s"),
      prefix: "ratelimit:housing-webhook",
      timeout: RATE_LIMIT_TIMEOUT_MS,
    })
    : null;
  if (!cachedLimiter) log("RATE_LIMIT_NOT_CONFIGURED");
  return cachedLimiter;
}

/**
 * Whether this Housing.com integration may take one more lead now. Failure-safe: if Upstash is not set up, unreachable
 * or slow, the lead is let in and the problem is logged. A lead is never lost because of the rate limiter.
 */
export async function checkHousingRate(integrationId: string): Promise<HousingRateDecision> {
  try {
    const limiter = getLimiter();
    if (!limiter) return { allowed: true };
    const result = await limiter.limit(integrationId);
    if (result.success) return { allowed: true };
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((result.reset - Date.now()) / 1000)) };
  } catch {
    log("RATE_LIMIT_UNAVAILABLE");
    return { allowed: true };
  }
}

/** Test hook: forget the cached limiter so a test can change the environment. */
export function resetHousingRateLimiterForTests(): void {
  cachedLimiter = undefined;
}

function log(code: string): void {
  console.error(JSON.stringify({ operation: "housing_lead_webhook", code }));
}
