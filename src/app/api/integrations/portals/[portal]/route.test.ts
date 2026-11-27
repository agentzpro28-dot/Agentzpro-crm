// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/server/app-error";

const mocks = vi.hoisted(() => ({ getOverview: vi.fn(), createOrReplace: vi.fn(), setPaused: vi.fn() }));
vi.mock("@/lib/server/portal-leads/portal-integration-service", () => ({
  PortalIntegrationService: class { getOverview = mocks.getOverview; createOrReplace = mocks.createOrReplace; setPaused = mocks.setPaused; },
}));

import { PATCH } from "./route";

const URL_BASE = "http://localhost/api/integrations/portals/99acres";
const params = (portal = "99acres") => ({ params: Promise.resolve({ portal }) });
const patch = (body: string, origin = "http://localhost") => new Request(URL_BASE, { method: "PATCH", headers: { host: "localhost", origin, "content-type": "application/json" }, body });

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
