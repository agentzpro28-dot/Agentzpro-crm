// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getOverview: vi.fn(), createOrReplace: vi.fn(), setPaused: vi.fn(), disconnect: vi.fn(), sameOrigin: vi.fn() }));
vi.mock("@/lib/server/housing/housing-integration-service", () => ({
  HousingIntegrationService: class { public getOverview = mocks.getOverview; public createOrReplace = mocks.createOrReplace; public setPaused = mocks.setPaused; public disconnect = mocks.disconnect; },
}));
vi.mock("@/lib/server/auth/same-origin", () => ({ assertSameOrigin: mocks.sameOrigin }));

import { AppError } from "@/lib/server/app-error";
import { DELETE, GET, PATCH, POST } from "@/app/api/integrations/housing/route";

const patch = (body: string) => new Request("https://crm.example.com/api/integrations/housing", { method: "PATCH", headers: { "content-type": "application/json" }, body });
const remove = () => new Request("https://crm.example.com/api/integrations/housing", { method: "DELETE" });

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("/api/integrations/housing", () => {
  it("GET returns the status only, without details", async () => {
    mocks.getOverview.mockResolvedValue({ canManage: true, hasIntegration: true, disconnected: false, integration: null });
    const response = await GET(new Request("https://crm.example.com/api/integrations/housing"));
    await expect(response.json()).resolves.toEqual({ canManage: true, hasIntegration: true, disconnected: false, integration: null });
    expect(mocks.getOverview).toHaveBeenCalledWith("https://crm.example.com", { details: false });
  });

  it("GET ?details=1 asks for the card's details", async () => {
    mocks.getOverview.mockResolvedValue({ canManage: true, hasIntegration: false, disconnected: false, integration: null });
    await GET(new Request("https://crm.example.com/api/integrations/housing?details=1"));
    expect(mocks.getOverview).toHaveBeenCalledWith("https://crm.example.com", { details: true });
  });

  it("POST checks the origin, then creates or replaces the URL", async () => {
    mocks.createOrReplace.mockResolvedValue({ url: "https://crm.example.com/api/webhooks/housing/x" });
    const request = new Request("https://crm.example.com/api/integrations/housing", { method: "POST", body: "{}" });
    const response = await POST(request);
    await expect(response.json()).resolves.toEqual({ url: "https://crm.example.com/api/webhooks/housing/x" });
    expect(mocks.sameOrigin).toHaveBeenCalledWith(request);
    expect(mocks.createOrReplace).toHaveBeenCalledWith("https://crm.example.com");
  });

  it("POST answers the service's error (an employee is refused)", async () => {
    mocks.createOrReplace.mockRejectedValue(new AppError("Only the company owner can manage Housing.com.", { status: 403, code: "HOUSING_OWNER_REQUIRED" }));
    const response = await POST(new Request("https://crm.example.com/api/integrations/housing", { method: "POST", body: "{}" }));
    expect(response.status).toBe(403);
  });

  it("PATCH checks the origin, then pauses or resumes", async () => {
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

  it("PATCH blocks a cross-site request before touching the service", async () => {
    mocks.sameOrigin.mockImplementation(() => { throw new AppError("Cross-origin requests are not permitted on this endpoint.", { status: 403, code: "CROSS_ORIGIN_REQUEST" }); });
    expect((await PATCH(patch(JSON.stringify({ paused: true })))).status).toBe(403);
    expect(mocks.setPaused).not.toHaveBeenCalled();
  });

  it("DELETE checks the origin, then disconnects", async () => {
    mocks.disconnect.mockResolvedValue({ disconnected: true });
    const request = remove();
    const response = await DELETE(request);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ disconnected: true });
    expect(mocks.sameOrigin).toHaveBeenCalledWith(request);
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    expect(mocks.disconnect).toHaveBeenCalledWith();
  });

  it("DELETE blocks a cross-site request before touching the service", async () => {
    mocks.sameOrigin.mockImplementation(() => { throw new AppError("Cross-origin requests are not permitted on this endpoint.", { status: 403, code: "CROSS_ORIGIN_REQUEST" }); });
    expect((await DELETE(remove())).status).toBe(403);
    expect(mocks.disconnect).not.toHaveBeenCalled();
  });

  it("DELETE passes the owner-only and no-URL refusals through", async () => {
    mocks.disconnect.mockRejectedValueOnce(new AppError("Only the company owner can manage Housing.com.", { status: 403, code: "HOUSING_OWNER_REQUIRED" }));
    expect((await DELETE(remove())).status).toBe(403);
    mocks.disconnect.mockRejectedValueOnce(new AppError("Generate the webhook URL first.", { status: 404, code: "HOUSING_INTEGRATION_NOT_FOUND" }));
    const response = await DELETE(remove());
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "HOUSING_INTEGRATION_NOT_FOUND", message: "Generate the webhook URL first." } });
  });
});
