// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ ingest: vi.fn() }));
vi.mock("@/lib/server/magicbricks/magicbricks-lead-intake-service", () => ({
  MagicbricksLeadIntakeService: class { public ingestFromWebhook = mocks.ingest; },
}));

import { GET, HEAD, POST } from "@/app/api/webhooks/magicbricks/[token]/route";

const TOKEN = "M".repeat(43);
const params = (token = TOKEN) => ({ params: Promise.resolve({ token }) });
const post = (body: string, headers: Record<string, string> = { "content-type": "application/json" }) =>
  new Request(`https://crm.example.com/api/webhooks/magicbricks/${TOKEN}`, { method: "POST", headers, body });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.ingest.mockResolvedValue({ status: 200, message: "Lead received", duplicate: false, outcome: "stored", leadId: "lead-1" });
});

describe("/api/webhooks/magicbricks/[token]", () => {
  it("passes a POST JSON enquiry to the MagicBricks intake and answers success", async () => {
    const response = await POST(post("{\"mobile\":\"9876543210\"}"), params());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, accepted: 1, message: "Lead received" });
    expect(mocks.ingest).toHaveBeenCalledWith(TOKEN, expect.objectContaining({ method: "POST", query: {}, rawBody: "{\"mobile\":\"9876543210\"}" }));
  });

  it("passes a GET enquiry's URL parameters (a repeated one as a list)", async () => {
    await GET(new Request(`https://crm.example.com/api/webhooks/magicbricks/${TOKEN}?name=Ravi&mobile=9876543210&pid=MB-1&remark=a&remark=b`), params());
    expect(mocks.ingest).toHaveBeenCalledWith(TOKEN, expect.objectContaining({ method: "GET", rawBody: "", query: { name: "Ravi", mobile: "9876543210", pid: "MB-1", remark: ["a", "b"] } }));
  });

  it("says duplicate: true for a retry or a same-phone note", async () => {
    mocks.ingest.mockResolvedValueOnce({ status: 200, message: "Lead received", duplicate: true, outcome: "merged", leadId: "lead-1" });
    await expect((await POST(post("{}"), params())).json()).resolves.toEqual({ success: true, accepted: 1, message: "Lead received", duplicate: true });
  });

  it("answers 4XX with success: false and the reason", async () => {
    mocks.ingest.mockResolvedValueOnce({ status: 400, message: "Send mobile or email." });
    const response = await POST(post("{}"), params());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ success: false, accepted: 0, message: "Send mobile or email." });
  });

  it("answers 429 with Retry-After", async () => {
    mocks.ingest.mockResolvedValueOnce({ status: 429, message: "Too many leads. Try again shortly.", retryAfterSeconds: 7 });
    const response = await POST(post("{}"), params());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
    await expect(response.json()).resolves.toEqual({ success: false, accepted: 0, message: "Too many leads. Try again shortly." });
  });

  it("refuses a body declared over 64 KB before reading it", async () => {
    const response = await POST(post("{}", { "content-type": "application/json", "content-length": String(64 * 1024 + 1) }), params());
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ success: false, accepted: 0, message: "Payload too large." });
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it("answers an empty URL check with accepted: 0", async () => {
    mocks.ingest.mockResolvedValueOnce({ status: 200, message: "Webhook ready" });
    await expect((await GET(new Request(`https://crm.example.com/api/webhooks/magicbricks/${TOKEN}`), params())).json()).resolves.toEqual({ success: true, accepted: 0, message: "Webhook ready" });
  });

  it("answers 500 (safe to retry) when the intake throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.ingest.mockRejectedValueOnce(new Error("boom"));
    const response = await POST(post("{}"), params());
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ success: false, accepted: 0, message: "Temporary failure, retry later." });
  });

  it("never saves anything on HEAD", async () => {
    expect((await HEAD()).status).toBe(200);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
});
