// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/server/app-error";

const mocks = vi.hoisted(() => ({ getOverview: vi.fn(), createOrReplace: vi.fn(), stop: vi.fn(), setPaused: vi.fn() }));
vi.mock("@/lib/server/custom-webhook/custom-webhook-connection-service", () => ({
  CustomWebhookConnectionService: class { getOverview = mocks.getOverview; createOrReplace = mocks.createOrReplace; stop = mocks.stop; setPaused = mocks.setPaused; },
}));

import { DELETE, GET, PATCH, POST } from "./route";

const URL_BASE = "http://localhost/api/integrations/custom-webhook";
const send = (method: "POST" | "DELETE", origin = "http://localhost") => new Request(URL_BASE, { method, headers: { host: "localhost", origin }, body: method === "POST" ? "{}" : undefined });

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/integrations/custom-webhook", () => {
  it("asks for the URL only with ?details=1 (the Connection card)", async () => {
    mocks.getOverview.mockResolvedValue({ canManage: true, hasWebhook: true, webhookStopped: false, webhook: null });
    expect((await GET(new Request(URL_BASE))).status).toBe(200);
    expect(mocks.getOverview).toHaveBeenLastCalledWith("http://localhost", { includeUrl: false });
    await GET(new Request(`${URL_BASE}?details=1`));
    expect(mocks.getOverview).toHaveBeenLastCalledWith("http://localhost", { includeUrl: true });
  });

  it("passes a sign-in refusal through", async () => {
    mocks.getOverview.mockRejectedValue(new AppError("Authentication is required.", { status: 401, code: "UNAUTHENTICATED" }));
    expect((await GET(new Request(URL_BASE))).status).toBe(401);
  });
});

describe("POST /api/integrations/custom-webhook", () => {
  it("creates or replaces the URL", async () => {
    mocks.createOrReplace.mockResolvedValue({ url: "http://localhost/api/webhooks/custom/x" });
    const response = await POST(send("POST"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: "http://localhost/api/webhooks/custom/x" });
    expect(mocks.createOrReplace).toHaveBeenCalledWith("http://localhost");
  });

  it("refuses a cross-site request without creating anything", async () => {
    expect((await POST(send("POST", "https://evil.example"))).status).toBe(403);
    expect(mocks.createOrReplace).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/integrations/custom-webhook", () => {
  it("stops webhook leads", async () => {
    mocks.stop.mockResolvedValue(undefined);
    const response = await DELETE(send("DELETE"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stopped: true });
  });

  it("refuses a cross-site request, and passes the owner-only refusal through", async () => {
    expect((await DELETE(send("DELETE", "https://evil.example"))).status).toBe(403);
    expect(mocks.stop).not.toHaveBeenCalled();
    mocks.stop.mockRejectedValue(new AppError("Only the company owner can manage the webhook.", { status: 403, code: "CUSTOM_WEBHOOK_OWNER_REQUIRED" }));
    const response = await DELETE(send("DELETE"));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("CUSTOM_WEBHOOK_OWNER_REQUIRED");
  });
});

describe("PATCH /api/integrations/custom-webhook", () => {
  const patch = (body: string, origin = "http://localhost") => new Request(URL_BASE, { method: "PATCH", headers: { host: "localhost", origin, "content-type": "application/json" }, body });

  it("pauses and resumes webhook leads", async () => {
    mocks.setPaused.mockImplementation(async (paused: boolean) => ({ paused }));
    const paused = await PATCH(patch(JSON.stringify({ paused: true })));
    expect(paused.status).toBe(200);
    expect(await paused.json()).toEqual({ paused: true });
    expect(mocks.setPaused).toHaveBeenLastCalledWith(true);
    const resumed = await PATCH(patch(JSON.stringify({ paused: false })));
    expect(await resumed.json()).toEqual({ paused: false });
    expect(mocks.setPaused).toHaveBeenLastCalledWith(false);
  });

  it("refuses a body that is not exactly {\"paused\": true | false}", async () => {
    for (const body of ["{}", "not json", JSON.stringify({ paused: "yes" }), JSON.stringify({ paused: true, tenant_id: "tenant-b" })]) {
      expect((await PATCH(patch(body))).status).toBe(400);
    }
    expect(mocks.setPaused).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request, and passes the owner-only refusal through", async () => {
    expect((await PATCH(patch(JSON.stringify({ paused: true }), "https://evil.example"))).status).toBe(403);
    expect(mocks.setPaused).not.toHaveBeenCalled();
    mocks.setPaused.mockRejectedValue(new AppError("Only the company owner can manage the webhook.", { status: 403, code: "CUSTOM_WEBHOOK_OWNER_REQUIRED" }));
    expect((await PATCH(patch(JSON.stringify({ paused: true })))).status).toBe(403);
  });
});
