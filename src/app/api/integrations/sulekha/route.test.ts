// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getOverview: vi.fn(), createOrReplace: vi.fn(), setPaused: vi.fn(), sameOrigin: vi.fn() }));
vi.mock("@/lib/server/sulekha/sulekha-integration-service", () => ({
  SulekhaIntegrationService: class { public getOverview = mocks.getOverview; public createOrReplace = mocks.createOrReplace; public setPaused = mocks.setPaused; },
}));
vi.mock("@/lib/server/auth/same-origin", () => ({ assertSameOrigin: mocks.sameOrigin }));

import { AppError } from "@/lib/server/app-error";
import { GET, PATCH, POST } from "@/app/api/integrations/sulekha/route";

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("/api/integrations/sulekha", () => {
  it("GET returns the status only, without details", async () => {
    mocks.getOverview.mockResolvedValue({ canManage: true, hasIntegration: true, integration: null });
    const response = await GET(new Request("https://crm.example.com/api/integrations/sulekha"));
    await expect(response.json()).resolves.toEqual({ canManage: true, hasIntegration: true, integration: null });
    expect(mocks.getOverview).toHaveBeenCalledWith("https://crm.example.com", { details: false });
  });

  it("GET ?details=1 asks for the card's details", async () => {
    mocks.getOverview.mockResolvedValue({ canManage: true, hasIntegration: false, integration: null });
    await GET(new Request("https://crm.example.com/api/integrations/sulekha?details=1"));
    expect(mocks.getOverview).toHaveBeenCalledWith("https://crm.example.com", { details: true });
  });

  it("POST checks the origin, then creates or replaces the URL", async () => {
    mocks.createOrReplace.mockResolvedValue({ url: "https://crm.example.com/api/webhooks/sulekha/x" });
    const request = new Request("https://crm.example.com/api/integrations/sulekha", { method: "POST", body: "{}" });
    const response = await POST(request);
    await expect(response.json()).resolves.toEqual({ url: "https://crm.example.com/api/webhooks/sulekha/x" });
    expect(mocks.sameOrigin).toHaveBeenCalledWith(request);
    expect(mocks.createOrReplace).toHaveBeenCalledWith("https://crm.example.com");
  });

  it("POST answers the service's error (an employee is refused)", async () => {
    mocks.createOrReplace.mockRejectedValue(new AppError("Only the company owner can manage Sulekha.", { status: 403, code: "SULEKHA_OWNER_REQUIRED" }));
    const response = await POST(new Request("https://crm.example.com/api/integrations/sulekha", { method: "POST", body: "{}" }));
    expect(response.status).toBe(403);
  });
});

describe("PATCH /api/integrations/sulekha", () => {
  const patch = (body: string, origin = "https://crm.example.com") => new Request("https://crm.example.com/api/integrations/sulekha", { method: "PATCH", headers: { host: "crm.example.com", origin, "content-type": "application/json" }, body });

  it("checks the origin, then pauses and resumes Sulekha leads", async () => {
    mocks.setPaused.mockImplementation(async (paused: boolean) => ({ paused }));
    const request = patch(JSON.stringify({ paused: true }));
    const paused = await PATCH(request);
    expect(paused.status).toBe(200);
    await expect(paused.json()).resolves.toEqual({ paused: true });
    expect(mocks.sameOrigin).toHaveBeenCalledWith(request);
    expect(mocks.setPaused).toHaveBeenLastCalledWith(true);
    const resumed = await PATCH(patch(JSON.stringify({ paused: false })));
    await expect(resumed.json()).resolves.toEqual({ paused: false });
    expect(mocks.setPaused).toHaveBeenLastCalledWith(false);
  });

  it("refuses a body that is not exactly {\"paused\": true | false}", async () => {
    for (const body of ["{}", "not json", JSON.stringify({ paused: "yes" }), JSON.stringify({ paused: true, tenant_id: "tenant-b" })]) {
      expect((await PATCH(patch(body))).status).toBe(400);
    }
    expect(mocks.setPaused).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request (the real origin check) before pausing anything", async () => {
    const real = await vi.importActual<typeof import("@/lib/server/auth/same-origin")>("@/lib/server/auth/same-origin");
    mocks.sameOrigin.mockImplementation(real.assertSameOrigin);
    const response = await PATCH(patch(JSON.stringify({ paused: true }), "https://evil.example"));
    expect(response.status).toBe(403);
    expect(mocks.setPaused).not.toHaveBeenCalled();
  });
});
