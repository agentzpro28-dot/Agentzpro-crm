// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ ingest: vi.fn() }));
vi.mock("@/lib/server/sulekha/sulekha-lead-intake-service", () => ({
  SulekhaLeadIntakeService: class { public ingestFromWebhook = mocks.ingest; },
}));

import { GET, HEAD, POST } from "@/app/api/webhooks/sulekha/[token]/route";

const TOKEN = "S".repeat(43);
const params = (token = TOKEN) => ({ params: Promise.resolve({ token }) });
const post = (body: string, headers: Record<string, string> = { "content-type": "application/json" }) =>
  new Request(`https://crm.example.com/api/webhooks/sulekha/${TOKEN}`, { method: "POST", headers, body });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.ingest.mockResolvedValue({ status: 200, message: "Lead received", duplicate: false, outcome: "stored", leadId: "lead-1" });
});

describe("/api/webhooks/sulekha/[token]", () => {
  it("passes a POST JSON enquiry to the Sulekha intake and answers success", async () => {
    const response = await POST(post("{\"mobile\":\"9876543210\"}"), params());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, accepted: 1, message: "Lead received" });
    expect(mocks.ingest).toHaveBeenCalledWith(TOKEN, expect.objectContaining({ method: "POST", query: {}, rawBody: "{\"mobile\":\"9876543210\"}" }));
  });

  it("passes a POST form enquiry's raw body as sent", async () => {
    await POST(post("name=Ravi&mobile=9876543210", { "content-type": "application/x-www-form-urlencoded" }), params());
    expect(mocks.ingest).toHaveBeenCalledWith(TOKEN, expect.objectContaining({ method: "POST", rawBody: "name=Ravi&mobile=9876543210" }));
  });

  it("passes a GET enquiry's URL parameters (a repeated one as a list)", async () => {
    await GET(new Request(`https://crm.example.com/api/webhooks/sulekha/${TOKEN}?name=Ravi&mobile=9876543210&message=a&message=b`), params());
    expect(mocks.ingest).toHaveBeenCalledWith(TOKEN, expect.objectContaining({ method: "GET", rawBody: "", query: { name: "Ravi", mobile: "9876543210", message: ["a", "b"] } }));
  });

  it("says duplicate: true for a retry or a same-phone note", async () => {
    mocks.ingest.mockResolvedValueOnce({ status: 200, message: "Lead received", duplicate: true, outcome: "merged", leadId: "lead-1" });
    await expect((await POST(post("{}"), params())).json()).resolves.toEqual({ success: true, accepted: 1, message: "Lead received", duplicate: true });
  });

  it("answers 400 with the reason (never 200) when no lead could be read", async () => {
    mocks.ingest.mockResolvedValueOnce({ status: 400, message: "Mobile number or email not found." });
    const response = await POST(post("{\"foo\":\"bar\"}"), params());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ success: false, accepted: 0, reason: "Mobile number or email not found." });
  });

  it("answers 415 with the reason for a body that is not JSON, form data or URL parameters", async () => {
    mocks.ingest.mockResolvedValueOnce({ status: 415, message: "The body is not JSON, form data or URL parameters." });
    const response = await POST(post("<lead/>", { "content-type": "application/xml" }), params());
    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({ success: false, accepted: 0, reason: "The body is not JSON, form data or URL parameters." });
  });

  it("answers 404 with success: false for a wrong URL", async () => {
    mocks.ingest.mockResolvedValueOnce({ status: 404, message: "Unknown webhook." });
    const response = await POST(post("{}"), params());
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ success: false, accepted: 0, reason: "Unknown webhook." });
  });

  it("answers 429 with Retry-After", async () => {
    mocks.ingest.mockResolvedValueOnce({ status: 429, message: "Too many leads. Try again shortly.", retryAfterSeconds: 7 });
    const response = await POST(post("{}"), params());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
    await expect(response.json()).resolves.toEqual({ success: false, accepted: 0, reason: "Too many leads. Try again shortly." });
  });

  it("refuses a body declared over 64 KB before reading it", async () => {
    const response = await POST(post("{}", { "content-type": "application/json", "content-length": String(64 * 1024 + 1) }), params());
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ success: false, accepted: 0, reason: "Payload too large." });
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it("answers an empty URL check with accepted: 0", async () => {
    mocks.ingest.mockResolvedValueOnce({ status: 200, message: "Webhook ready" });
    await expect((await GET(new Request(`https://crm.example.com/api/webhooks/sulekha/${TOKEN}`), params())).json()).resolves.toEqual({ success: true, accepted: 0, message: "Webhook ready" });
  });

  it("answers 500 (safe to retry) when the intake throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.ingest.mockRejectedValueOnce(new Error("boom"));
    const response = await POST(post("{}"), params());
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ success: false, accepted: 0, reason: "Temporary failure, retry later." });
  });

  it("never saves anything on HEAD", async () => {
    expect((await HEAD()).status).toBe(200);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
});
