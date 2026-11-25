// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/server/app-error";

const mocks = vi.hoisted(() => ({ context: vi.fn(), arrivals: vi.fn() }));
vi.mock("@/lib/server/tenant-context", () => ({ resolveTenantRequestContext: mocks.context }));
vi.mock("@/lib/server/lead-query-service", () => ({ countLeadsSavedSince: mocks.arrivals }));

import { POST } from "./route";

function post(body: unknown): Request {
  return new Request("http://localhost/api/leads/arrivals", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

const NOW = Date.parse("2026-11-25T10:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  mocks.context.mockReset().mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
  mocks.arrivals.mockReset().mockResolvedValue({ count: 1, newest: { id: "lead-1", name: "Ravi", source: "Facebook" } });
});
afterEach(() => { vi.useRealTimers(); });

describe("new lead arrivals route (background pop-up)", () => {
  it("asks for the session's company since the tab went into the background, on the server's clock, minus a 5 s margin", async () => {
    const response = await POST(post({ hiddenForMs: 60_000 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ count: 1, newest: { id: "lead-1", name: "Ravi", source: "Facebook" } });
    expect(mocks.arrivals).toHaveBeenCalledWith({ tenantId: "tenant-a", userId: "user-a" }, new Date(NOW - 60_000 - 5_000).toISOString());
  });

  it("accepts a tab hidden this very moment and one hidden for a whole day", async () => {
    expect((await POST(post({ hiddenForMs: 0 }))).status).toBe(200);
    expect((await POST(post({ hiddenForMs: 86_400_000 }))).status).toBe(200);
    expect(mocks.arrivals).toHaveBeenLastCalledWith(expect.anything(), new Date(NOW - 86_400_000 - 5_000).toISOString());
  });

  it.each([
    ["no hidden time", {}],
    ["a negative hidden time", { hiddenForMs: -1 }],
    ["more than a day", { hiddenForMs: 86_400_001 }],
    ["a fraction", { hiddenForMs: 1.5 }],
    ["a string", { hiddenForMs: "60000" }],
    ["a tenant id in the body", { hiddenForMs: 1_000, tenantId: "tenant-b" }],
    ["a time chosen by the browser", { hiddenForMs: 1_000, since: "2026-01-01T00:00:00Z" }],
  ])("rejects %s with a 400 before reading any lead", async (_name, body) => {
    const response = await POST(post(body));
    expect(response.status).toBe(400);
    expect(mocks.arrivals).not.toHaveBeenCalled();
  });

  it("refuses a signed-out request before reading any lead", async () => {
    mocks.context.mockRejectedValue(new AppError("Sign in again.", { status: 401, code: "UNAUTHENTICATED" }));
    const response = await POST(post({ hiddenForMs: 1_000 }));
    expect(response.status).toBe(401);
    expect(mocks.arrivals).not.toHaveBeenCalled();
  });

  it("answers a failed read with an error, never a made-up count", async () => {
    mocks.arrivals.mockRejectedValue(new AppError("New leads could not be checked.", { status: 500, code: "LEAD_QUERY_FAILED" }));
    const response = await POST(post({ hiddenForMs: 1_000 }));
    expect(response.status).toBe(500);
    expect(await response.json()).not.toHaveProperty("count");
  });
});
