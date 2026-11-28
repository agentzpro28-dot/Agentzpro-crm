// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/server/app-error";

const mocks = vi.hoisted(() => ({ getOverview: vi.fn(), createOrReplace: vi.fn(), setPaused: vi.fn(), disconnect: vi.fn() }));
vi.mock("@/lib/server/portal-leads/portal-integration-service", () => ({
  PortalIntegrationService: class { getOverview = mocks.getOverview; createOrReplace = mocks.createOrReplace; setPaused = mocks.setPaused; disconnect = mocks.disconnect; },
}));

import { DELETE, PATCH } from "./route";

const URL_BASE = "http://localhost/api/integrations/portals/99acres";
const params = (portal = "99acres") => ({ params: Promise.resolve({ portal }) });
const patch = (body: string, origin = "http://localhost") => new Request(URL_BASE, { method: "PATCH", headers: { host: "localhost", origin, "content-type": "application/json" }, body });
const remove = (origin = "http://localhost") => new Request(URL_BASE, { method: "DELETE", headers: { host: "localhost", origin } });

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("PATCH /api/integrations/portals/[portal]", () => {
  it("pauses and resumes 99acres leads", async () => {
    mocks.setPaused.mockImplementation(async (_portal: string, paused: boolean) => ({ paused }));
    const paused = await PATCH(patch(JSON.stringify({ paused: true })), params());
    expect(paused.status).toBe(200);
    expect(await paused.json()).toEqual({ paused: true });
    expect(mocks.setPaused).toHaveBeenLastCalledWith("99acres", true);
    const resumed = await PATCH(patch(JSON.stringify({ paused: false })), params());
    expect(await resumed.json()).toEqual({ paused: false });
    expect(mocks.setPaused).toHaveBeenLastCalledWith("99acres", false);
  });

  it("refuses a body that is not exactly {\"paused\": true | false}", async () => {
    for (const body of ["{}", "not json", JSON.stringify({ paused: "yes" }), JSON.stringify({ paused: true, tenant_id: "tenant-b" })]) {
      expect((await PATCH(patch(body), params())).status).toBe(400);
    }
    expect(mocks.setPaused).not.toHaveBeenCalled();
  });

  it("refuses an unknown portal and a cross-site request, and passes the owner-only refusal through", async () => {
    expect((await PATCH(patch(JSON.stringify({ paused: true })), params("magicbricks"))).status).toBe(404);
    expect((await PATCH(patch(JSON.stringify({ paused: true }), "https://evil.example"), params())).status).toBe(403);
    expect(mocks.setPaused).not.toHaveBeenCalled();
    mocks.setPaused.mockRejectedValue(new AppError("Only the company owner can manage 99acres.", { status: 403, code: "PORTAL_OWNER_REQUIRED" }));
    expect((await PATCH(patch(JSON.stringify({ paused: true })), params())).status).toBe(403);
  });
});

describe("DELETE /api/integrations/portals/[portal]", () => {
  it("disconnects 99acres", async () => {
    mocks.disconnect.mockResolvedValue({ disconnected: true });
    const response = await DELETE(remove(), params());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ disconnected: true });
    expect(mocks.disconnect).toHaveBeenCalledWith("99acres");
  });

  it("refuses an unknown portal and a cross-site request, and passes the owner-only and no-URL refusals through", async () => {
    expect((await DELETE(remove(), params("magicbricks"))).status).toBe(404);
    expect((await DELETE(remove("https://evil.example"), params())).status).toBe(403);
    expect(mocks.disconnect).not.toHaveBeenCalled();
    mocks.disconnect.mockRejectedValueOnce(new AppError("Only the company owner can manage 99acres.", { status: 403, code: "PORTAL_OWNER_REQUIRED" }));
    expect((await DELETE(remove(), params())).status).toBe(403);
    mocks.disconnect.mockRejectedValueOnce(new AppError("Generate the webhook URL first.", { status: 404, code: "PORTAL_INTEGRATION_NOT_FOUND" }));
    expect((await DELETE(remove(), params())).status).toBe(404);
  });
});
