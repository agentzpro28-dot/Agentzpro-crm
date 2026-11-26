// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getOverview: vi.fn(), createOrReplace: vi.fn(), sameOrigin: vi.fn() }));
vi.mock("@/lib/server/nobroker/nobroker-integration-service", () => ({
  NoBrokerIntegrationService: class { public getOverview = mocks.getOverview; public createOrReplace = mocks.createOrReplace; },
}));
vi.mock("@/lib/server/auth/same-origin", () => ({ assertSameOrigin: mocks.sameOrigin }));

import { AppError } from "@/lib/server/app-error";
import { GET, POST } from "@/app/api/integrations/nobroker/route";

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("/api/integrations/nobroker", () => {
  it("GET returns the status only, without details", async () => {
    mocks.getOverview.mockResolvedValue({ canManage: true, hasIntegration: true, integration: null });
    const response = await GET(new Request("https://crm.example.com/api/integrations/nobroker"));
    await expect(response.json()).resolves.toEqual({ canManage: true, hasIntegration: true, integration: null });
    expect(mocks.getOverview).toHaveBeenCalledWith("https://crm.example.com", { details: false });
  });

  it("GET ?details=1 asks for the card's details", async () => {
    mocks.getOverview.mockResolvedValue({ canManage: true, hasIntegration: false, integration: null });
    await GET(new Request("https://crm.example.com/api/integrations/nobroker?details=1"));
    expect(mocks.getOverview).toHaveBeenCalledWith("https://crm.example.com", { details: true });
  });

  it("POST checks the origin, then creates or replaces the URL", async () => {
    mocks.createOrReplace.mockResolvedValue({ url: "https://crm.example.com/api/webhooks/nobroker/x" });
    const request = new Request("https://crm.example.com/api/integrations/nobroker", { method: "POST", body: "{}" });
    const response = await POST(request);
    await expect(response.json()).resolves.toEqual({ url: "https://crm.example.com/api/webhooks/nobroker/x" });
    expect(mocks.sameOrigin).toHaveBeenCalledWith(request);
    expect(mocks.createOrReplace).toHaveBeenCalledWith("https://crm.example.com");
  });

  it("POST answers the service's error (an employee is refused)", async () => {
    mocks.createOrReplace.mockRejectedValue(new AppError("Only the company owner can manage NoBroker.", { status: 403, code: "NOBROKER_OWNER_REQUIRED" }));
    const response = await POST(new Request("https://crm.example.com/api/integrations/nobroker", { method: "POST", body: "{}" }));
    expect(response.status).toBe(403);
  });
});
