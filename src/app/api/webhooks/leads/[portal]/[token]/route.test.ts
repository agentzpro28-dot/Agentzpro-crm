// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

// The real intake service and field mapper; only the database and the rate limiter are replaced.
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), lookup: vi.fn(), insert: vi.fn(), rate: vi.fn() }));
vi.mock("@/lib/server/supabase-admin", () => ({
  getSupabaseAdminClient: () => ({
    // find_portal_integration is the URL lookup; every other function is the lead save.
    rpc: (fn: string, args: unknown) => fn === "find_portal_integration" ? mocks.lookup(args) : mocks.rpc(fn, args),
    from: () => ({
      insert: (row: unknown) => { mocks.insert(row); return { select: () => ({ single: async () => ({ data: { id: "log-1" }, error: null }) }) }; },
      update: () => { const chain = { eq: () => chain, then: (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve) }; return chain; },
    }),
  }),
}));
vi.mock("@/lib/server/custom-webhook/webhook-rate-limit", () => ({ checkCustomWebhookRate: mocks.rate }));

import { GET, HEAD, POST } from "./route";

const TOKEN = "C".repeat(43);
const url = (query = "", token = TOKEN, portal = "99acres") => `https://crm.example.com/api/webhooks/leads/${portal}/${token}${query}`;
const params = (token = TOKEN, portal = "99acres") => ({ params: Promise.resolve({ portal, token }) });
const fieldData = () => Object.fromEntries((mocks.rpc.mock.calls.at(-1)?.[1].p_field_data as Array<{ name: string; values: string[] }>).map((field) => [field.name, field.values[0]]));

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.lookup.mockResolvedValue({ data: [{ id: "integration-1", tenant_id: "tenant-a", portal_name: "99acres", field_mapping: {}, url_version: "current" }], error: null });
  mocks.rate.mockResolvedValue({ allowed: true });
  mocks.rpc.mockResolvedValue({ data: { outcome: "stored", lead_id: "lead-1" }, error: null });
});

describe("/api/webhooks/leads/[portal]/[token]", () => {
  it("1. POST JSON from 99acres (cust_name, contact_no, project_name, query) is saved: 200 Lead received", async () => {
    const response = await POST(new Request(url(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cust_name: "Ravi Kumar", contact_no: "9876543210", project_name: "Green Valley", query: "Need 2 BHK" }) }), params());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, accepted: 1, message: "Lead received" });
    expect(fieldData()).toEqual({ full_name: "Ravi Kumar", phone_number: "9876543210", project_name: "Green Valley", query: "Need 2 BHK" });
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({ p_tenant_id: "tenant-a", p_portal: "99acres", p_project_name: "Green Valley" });
  });

  it("2. POST form data is saved", async () => {
    const response = await POST(new Request(url(), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "name=Asha&mobile=9123456789&city=Chennai&lead_id=99-77" }), params());
    expect(response.status).toBe(200);
    expect(fieldData()).toEqual({ full_name: "Asha", phone_number: "9123456789", city: "Chennai" });
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({ p_lead_ref: "99-77" });
  });

  it("3. GET with URL parameters is saved", async () => {
    const response = await GET(new Request(url("?customer_name=Vijay&mobile_no=9000000002&property_name=Sea%20View")), params());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, accepted: 1, message: "Lead received" });
    expect(fieldData()).toEqual({ full_name: "Vijay", phone_number: "9000000002", project_name: "Sea View" });
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ http_method: "GET", query_params: { customer_name: "Vijay", mobile_no: "9000000002", property_name: "Sea View" }, raw_body: "" }));
  });

  it("4. a phone already in the CRM answers 200 with duplicate (the database adds a note to that lead instead)", async () => {
    mocks.rpc.mockResolvedValue({ data: { outcome: "merged", lead_id: "lead-0" }, error: null });
    const response = await POST(new Request(url(), { method: "POST", body: JSON.stringify({ name: "Ravi", mobile: "9876543210" }) }), params());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, accepted: 1, message: "Lead received", duplicate: true });
  });

  it("4b. a lead on the old URL (within its 7 days) is saved and logged as coming on the old URL", async () => {
    mocks.lookup.mockResolvedValue({ data: [{ id: "integration-1", tenant_id: "tenant-a", portal_name: "99acres", field_mapping: {}, url_version: "previous" }], error: null });
    const response = await POST(new Request(url(), { method: "POST", body: JSON.stringify({ name: "Old Url", mobile: "9876543210" }) }), params());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, accepted: 1, message: "Lead received" });
    expect(mocks.lookup).toHaveBeenCalledWith({ p_portal: "99acres", p_token_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ url_version: "previous" }));
    expect(mocks.rpc).toHaveBeenCalledWith("ingest_portal_lead_on_url", expect.objectContaining({ p_token_hash: mocks.lookup.mock.calls[0][0].p_token_hash }));
  });

  it("5. an invalid token is refused with 404 before any database work", async () => {
    const response = await POST(new Request(url("", "not-a-token"), { method: "POST", body: JSON.stringify({ name: "x", mobile: "9876543210" }) }), params("not-a-token"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ success: false, accepted: 0, message: "Unknown webhook." });
    expect(mocks.lookup).not.toHaveBeenCalled();
    mocks.lookup.mockResolvedValueOnce({ data: [], error: null });
    expect((await GET(new Request(url("?mobile=9876543210")), params())).status).toBe(404);
    expect((await GET(new Request(url("?mobile=9876543210", TOKEN, "magicbricks")), params(TOKEN, "magicbricks"))).status).toBe(404);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("answers a lead with no mobile or email 400, after keeping its raw copy", async () => {
    const response = await POST(new Request(url(), { method: "POST", body: JSON.stringify({ name: "No Contact" }) }), params());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, accepted: 0, message: "Send mobile or email." });
    expect(mocks.insert).toHaveBeenCalledTimes(1);
  });

  it("answers an empty URL check (GET with nothing) 200 Webhook ready, saving nothing", async () => {
    const response = await GET(new Request(url()), params());
    expect(await response.json()).toEqual({ success: true, accepted: 0, message: "Webhook ready" });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("answers HEAD 200 empty without reading anything", async () => {
    const response = await HEAD();
    expect(response.status).toBe(200);
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it("refuses a declared body over 64 KB with 413 before reading it", async () => {
    const response = await POST(new Request(url(), { method: "POST", headers: { "content-length": String(70_000) }, body: "{}" }), params());
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ success: false, accepted: 0, message: "Payload too large." });
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it("passes the per-minute limit on with Retry-After", async () => {
    mocks.rate.mockResolvedValue({ allowed: false, retryAfterSeconds: 12 });
    const response = await POST(new Request(url(), { method: "POST", body: JSON.stringify({ mobile: "9876543210" }) }), params());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("12");
    expect(await response.json()).toEqual({ success: false, accepted: 0, message: "Too many leads. Try again shortly." });
  });

  it("reads field names with capitals, spaces and underscores ignored (MobileNo, customerName, EMAIL_ID)", async () => {
    const response = await POST(new Request(url(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ customerName: "Kavya", MobileNo: "9876543210", EMAIL_ID: "k@example.com" }) }), params());
    expect(await response.json()).toEqual({ success: true, accepted: 1, message: "Lead received" });
    expect(fieldData()).toEqual({ full_name: "Kavya", phone_number: "9876543210", email: "k@example.com" });
  });

  it("answers 500 (safe to retry) when something unexpected fails", async () => {
    mocks.lookup.mockRejectedValue(new Error("network"));
    const response = await POST(new Request(url(), { method: "POST", body: JSON.stringify({ mobile: "9876543210" }) }), params());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ success: false, accepted: 0, message: "Temporary failure, retry later." });
  });
});
