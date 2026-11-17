// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/server/app-error";

const mocks = vi.hoisted(() => ({ listStatuses: vi.fn(), getOverview: vi.fn(), createOrReplace: vi.fn() }));
vi.mock("@/lib/server/portal-leads/portal-integration-service", () => ({
  PortalIntegrationService: class { listStatuses = mocks.listStatuses; getOverview = mocks.getOverview; createOrReplace = mocks.createOrReplace; },
}));

import { GET as listGET } from "./route";
import { GET, POST } from "./[portal]/route";

const BASE = "http://localhost/api/integrations/portals";
const params = (portal = "99acres") => ({ params: Promise.resolve({ portal }) });
const post = (path: string, origin = "http://localhost") => new Request(`${BASE}${path}`, { method: "POST", headers: { host: "localhost", origin }, body: "{}" });

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/integrations/portals", () => {
  it("lists which portals the company set up", async () => {
    mocks.listStatuses.mockResolvedValue({ portals: [{ portal: "99acres", hasIntegration: true }] });
    const response = await listGET(new Request(BASE));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ portals: [{ portal: "99acres", hasIntegration: true }] });
  });

  it("passes a sign-in refusal through", async () => {
    mocks.listStatuses.mockRejectedValue(new AppError("Authentication is required.", { status: 401, code: "UNAUTHENTICATED" }));
    expect((await listGET(new Request(BASE))).status).toBe(401);
  });
});

describe("/api/integrations/portals/[portal]", () => {
  it("asks for the owner's details only with ?details=1", async () => {
    mocks.getOverview.mockResolvedValue({ portal: "99acres", canManage: true, hasIntegration: false, integration: null });
    await GET(new Request(`${BASE}/99acres`), params());
    expect(mocks.getOverview).toHaveBeenLastCalledWith("99acres", "http://localhost", { details: false });
    await GET(new Request(`${BASE}/99acres?details=1`), params());
    expect(mocks.getOverview).toHaveBeenLastCalledWith("99acres", "http://localhost", { details: true });
  });

  it("answers 404 for a portal that is not offered", async () => {
    expect((await GET(new Request(`${BASE}/magicbricks`), params("magicbricks"))).status).toBe(404);
    expect((await POST(post("/magicbricks"), params("magicbricks"))).status).toBe(404);
    expect(mocks.getOverview).not.toHaveBeenCalled();
    expect(mocks.createOrReplace).not.toHaveBeenCalled();
  });

  it("creates or regenerates the URL for this site's origin", async () => {
    mocks.createOrReplace.mockResolvedValue({ url: "http://localhost/api/webhooks/leads/99acres/x" });
    const response = await POST(post("/99acres"), params());
    expect(response.status).toBe(200);
    expect(mocks.createOrReplace).toHaveBeenCalledWith("99acres", "http://localhost");
  });

  it("refuses a cross-site POST before doing anything", async () => {
    expect((await POST(post("/99acres", "https://evil.example"), params())).status).toBe(403);
    expect(mocks.createOrReplace).not.toHaveBeenCalled();
  });

  it("passes the owner-only refusal through", async () => {
    mocks.createOrReplace.mockRejectedValue(new AppError("Only the company owner can manage 99acres.", { status: 403, code: "PORTAL_OWNER_REQUIRED" }));
    expect((await POST(post("/99acres"), params())).status).toBe(403);
  });
});
