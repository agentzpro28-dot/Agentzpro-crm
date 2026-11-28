// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getOverview: vi.fn(), createOrReplace: vi.fn(), setPaused: vi.fn(), sameOrigin: vi.fn() }));
vi.mock("@/lib/server/olx-home/olx-home-integration-service", () => ({
  OlxHomeIntegrationService: class { public getOverview = mocks.getOverview; public createOrReplace = mocks.createOrReplace; public setPaused = mocks.setPaused; },
}));
vi.mock("@/lib/server/auth/same-origin", () => ({ assertSameOrigin: mocks.sameOrigin }));

import { AppError } from "@/lib/server/app-error";
import { GET, PATCH, POST } from "@/app/api/integrations/olx-home/route";

const patch = (body: string) => new Request("https://crm.example.com/api/integrations/olx-home", { method: "PATCH", headers: { "content-type": "application/json" }, body });

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("/api/integrations/olx-home", () => {
  it("GET returns the status only, without details", async () => {
    mocks.getOverview.mockResolvedValue({ canManage: true, hasIntegration: true, integration: null });
    const response = await GET(new Request("https://crm.example.com/api/integrations/olx-home"));
    await expect(response.json()).resolves.toEqual({ canManage: true, hasIntegration: true, integration: null });
    expect(mocks.getOverview).toHaveBeenCalledWith("https://crm.example.com", { details: false });
  });

  it("GET ?details=1 asks for the card's details", async () => {
    mocks.getOverview.mockResolvedValue({ canManage: true, hasIntegration: false, integration: null });
    await GET(new Request("https://crm.example.com/api/integrations/olx-home?details=1"));
    expect(mocks.getOverview).toHaveBeenCalledWith("https://crm.example.com", { details: true });
  });

  it("POST checks the origin, then creates or replaces the URL", async () => {
    mocks.createOrReplace.mockResolvedValue({ url: "https://crm.example.com/api/webhooks/olx-home/x" });
    const request = new Request("https://crm.example.com/api/integrations/olx-home", { method: "POST", body: "{}" });
    const response = await POST(request);
    await expect(response.json()).resolves.toEqual({ url: "https://crm.example.com/api/webhooks/olx-home/x" });
    expect(mocks.sameOrigin).toHaveBeenCalledWith(request);
    expect(mocks.createOrReplace).toHaveBeenCalledWith("https://crm.example.com");
  });

  it("POST answers the service's error (an employee is refused)", async () => {
    mocks.createOrReplace.mockRejectedValue(new AppError("Only the company owner can manage OLX Home.", { status: 403, code: "OLX_HOME_OWNER_REQUIRED" }));
    const response = await POST(new Request("https://crm.example.com/api/integrations/olx-home", { method: "POST", body: "{}" }));
    expect(response.status).toBe(403);
  });

  it("PATCH checks the origin, then pauses or resumes OLX Home leads", async () => {
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

  it("PATCH refuses a body that is not exactly {\"paused\": true | false}", async () => {
    for (const body of ["{}", "not json", JSON.stringify({ paused: "yes" }), JSON.stringify({ paused: true, tenant_id: "tenant-b" })]) {
      expect((await PATCH(patch(body))).status).toBe(400);
    }
    expect(mocks.setPaused).not.toHaveBeenCalled();
  });

  it("PATCH refuses a cross-site request before pausing anything", async () => {
    mocks.sameOrigin.mockImplementation(() => { throw new AppError("Cross-origin requests are not permitted on this endpoint.", { status: 403, code: "CROSS_ORIGIN_REQUEST" }); });
    const response = await PATCH(patch(JSON.stringify({ paused: true })));
    expect(response.status).toBe(403);
    expect(mocks.setPaused).not.toHaveBeenCalled();
  });
});
