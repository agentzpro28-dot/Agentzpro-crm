// @vitest-environment node
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(), lookup: vi.fn(), insert: vi.fn(), insertResult: vi.fn(), update: vi.fn(), updateResult: vi.fn(), rate: vi.fn(),
}));
vi.mock("@/lib/server/supabase-admin", () => ({
  getSupabaseAdminClient: () => ({
    // find_portal_integration is the URL lookup; every other function is the lead save.
    rpc: (fn: string, args: unknown) => fn === "find_portal_integration" ? mocks.lookup(args) : mocks.rpc(fn, args),
    from: (table: string) => {
      if (table === "portal_webhook_logs") {
        return {
          insert: (row: unknown) => { mocks.insert(row); return { select: () => ({ single: mocks.insertResult }) }; },
          update: (row: unknown) => {
            mocks.update(row);
            const chain = { eq: () => chain, then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(mocks.updateResult()).then(resolve, reject) };
            return chain;
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));
vi.mock("@/lib/server/custom-webhook/webhook-rate-limit", () => ({ checkCustomWebhookRate: mocks.rate }));

import { PortalLeadIntakeService, hashPortalWebhookToken, loggableHeaders, type IncomingPortalRequest } from "@/lib/server/portal-leads/portal-lead-intake-service";

const TOKEN = "B".repeat(43);
const INTEGRATION = { id: "integration-1", tenant_id: "tenant-a", portal_name: "99acres", field_mapping: {}, url_version: "current" };
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");
const json = (body: Record<string, unknown>, headers: Record<string, string> = {}) => ({
  method: "POST" as const, headers: new Headers({ "content-type": "application/json", ...headers }), query: {}, rawBody: JSON.stringify(body),
});
const ACRES = { cust_name: "Ravi", contact_no: "9876543210", project_name: "Green Valley", query: "2 BHK", lead_id: "ENQ-1" };
const ingest = (request: IncomingPortalRequest = json(ACRES), token = TOKEN, portal = "99acres") => new PortalLeadIntakeService().ingestFromWebhook(portal, token, request);

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.lookup.mockResolvedValue({ data: [INTEGRATION], error: null });
  mocks.rate.mockResolvedValue({ allowed: true });
  mocks.insertResult.mockResolvedValue({ data: { id: "log-1" }, error: null });
  mocks.updateResult.mockReturnValue({ error: null });
  mocks.rpc.mockResolvedValue({ data: { outcome: "stored", lead_id: "lead-1" }, error: null });
});

describe("PortalLeadIntakeService.ingestFromWebhook", () => {
  it("finds the company by the SHA-256 of the URL token and the portal, logs the raw request, then saves the lead", async () => {
    await expect(ingest()).resolves.toEqual({ status: 200, message: "Lead received", duplicate: false, outcome: "stored", leadId: "lead-1" });
    expect(mocks.lookup).toHaveBeenCalledWith({ p_portal: "99acres", p_token_hash: TOKEN_HASH });
    expect(mocks.insert).toHaveBeenCalledWith({
      tenant_id: "tenant-a", integration_id: "integration-1", portal_name: "99acres", http_method: "POST",
      headers: { "content-type": "application/json" }, query_params: {}, raw_body: JSON.stringify(ACRES), url_version: "current", is_test: false,
    });
    expect(mocks.rpc).toHaveBeenCalledWith("ingest_portal_lead_on_url", {
      p_tenant_id: "tenant-a", p_integration_id: "integration-1", p_log_id: "log-1", p_portal: "99acres", p_token_hash: TOKEN_HASH, p_lead_ref: "ENQ-1",
      p_project_name: "Green Valley", p_enquiry_summary: "New 99acres enquiry · Name: Ravi · Project: Green Valley · Query: 2 BHK",
      p_field_data: [{ name: "full_name", values: ["Ravi"] }, { name: "phone_number", values: ["9876543210"] }, { name: "project_name", values: ["Green Valley"] }, { name: "query", values: ["2 BHK"] }],
      p_raw_payload: ACRES, p_is_test: false,
    });
    // The log is written before the lead is read and saved.
    expect(mocks.insert.mock.invocationCallOrder[0]).toBeLessThan(mocks.rpc.mock.invocationCallOrder[0]);
  });

  it("saves a lead sent to the old URL within its 7 days, logged as coming on the old URL", async () => {
    mocks.lookup.mockResolvedValue({ data: [{ ...INTEGRATION, url_version: "previous" }], error: null });
    await expect(ingest()).resolves.toMatchObject({ status: 200, outcome: "stored" });
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ url_version: "previous" }));
    expect(mocks.rpc).toHaveBeenCalledWith("ingest_portal_lead_on_url", expect.objectContaining({ p_token_hash: TOKEN_HASH }));
  });

  it("never lets the request pick the company", async () => {
    await ingest(json({ ...ACRES, tenant_id: "tenant-b", p_tenant_id: "tenant-b" }));
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({ p_tenant_id: "tenant-a", p_integration_id: "integration-1" });
  });

  it("answers 200 with duplicate when the enquiry was a retry or its phone was already in the CRM (a note was added)", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { outcome: "merged", lead_id: "lead-0" }, error: null });
    await expect(ingest()).resolves.toMatchObject({ status: 200, duplicate: true, outcome: "merged", leadId: "lead-0" });
    mocks.rpc.mockResolvedValueOnce({ data: { outcome: "duplicate", lead_id: "lead-0" }, error: null });
    await expect(ingest()).resolves.toMatchObject({ status: 200, duplicate: true, outcome: "duplicate" });
  });

  it("answers 404 for an unknown portal, a malformed token, or a token the database does not accept (unknown, stopped or an expired old URL), and logs nothing", async () => {
    await expect(ingest(json(ACRES), TOKEN, "magicbricks")).resolves.toMatchObject({ status: 404 });
    await expect(ingest(json(ACRES), "short")).resolves.toMatchObject({ status: 404 });
    expect(mocks.lookup).not.toHaveBeenCalled();
    mocks.lookup.mockResolvedValueOnce({ data: [], error: null });
    await expect(ingest()).resolves.toEqual({ status: 404, message: "Unknown webhook." });
    mocks.lookup.mockResolvedValueOnce({ data: null, error: null });
    await expect(ingest()).resolves.toMatchObject({ status: 404 });
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("answers 413 for an oversized body without a database lookup", async () => {
    await expect(ingest(json({ pad: "x".repeat(70_000) }))).resolves.toMatchObject({ status: 413 });
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it("answers 429 with the wait time when the company is over its per-minute limit, and logs nothing", async () => {
    mocks.rate.mockResolvedValue({ allowed: false, retryAfterSeconds: 9 });
    await expect(ingest()).resolves.toEqual({ status: 429, message: "Too many leads. Try again shortly.", retryAfterSeconds: 9 });
    expect(mocks.rate).toHaveBeenCalledWith("integration-1");
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("answers an empty URL check with Webhook ready, without logging or saving", async () => {
    await expect(ingest({ method: "GET", headers: new Headers(), query: {}, rawBody: "" })).resolves.toEqual({ status: 200, message: "Webhook ready" });
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("keeps the raw request when it cannot be read: the log is marked failed with the reason", async () => {
    await expect(ingest(json({ cust_name: "No Contact" }))).resolves.toEqual({ status: 400, message: "Send mobile or email." });
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", error_message: "Send mobile or email." }));
    expect(mocks.rpc).not.toHaveBeenCalled();
    await expect(ingest({ method: "POST", headers: new Headers({ "content-type": "application/xml" }), query: {}, rawBody: "<lead/>" })).resolves.toMatchObject({ status: 415 });
    expect(mocks.insert).toHaveBeenCalledTimes(2);
  });

  it("maps the database's refusals and marks the log failed: replaced meanwhile → 404, unusable → 400, other → 500", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "P0002", message: "gone" } });
    await expect(ingest()).resolves.toMatchObject({ status: 404 });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "22023", message: "Send mobile or email" } });
    await expect(ingest()).resolves.toMatchObject({ status: 400 });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "XX000", message: "boom" } });
    await expect(ingest()).resolves.toEqual({ status: 500, message: "Temporary failure, retry later." });
    expect(mocks.update).toHaveBeenCalledTimes(3);
    for (const [row] of mocks.update.mock.calls) expect(row).toMatchObject({ status: "failed" });
  });

  it("asks the portal to retry (500) and saves nothing when the raw log cannot be written", async () => {
    mocks.insertResult.mockResolvedValueOnce({ data: null, error: { message: "down" } });
    await expect(ingest()).resolves.toMatchObject({ status: 500 });
    expect(mocks.rpc).not.toHaveBeenCalled();
    mocks.lookup.mockResolvedValueOnce({ data: null, error: { message: "down" } });
    await expect(ingest()).resolves.toMatchObject({ status: 500 });
  });

  it("still answers when marking the log failed itself fails", async () => {
    mocks.updateResult.mockReturnValue({ error: { message: "down" } });
    await expect(ingest(json({ cust_name: "No Contact" }))).resolves.toMatchObject({ status: 400 });
  });

  it("never logs the token, a phone number, an email or a name", async () => {
    await ingest(json({ ...ACRES, email: "ravi@example.com" }));
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    await ingest(json({ ...ACRES, email: "ravi@example.com" }));
    const logged = [...vi.mocked(console.info).mock.calls, ...vi.mocked(console.error).mock.calls].flat().join(" ");
    expect(logged).toContain("LEAD_STORED");
    for (const secret of [TOKEN, "9876543210", "ravi@example.com", "Ravi"]) expect(logged).not.toContain(secret);
  });

  it("hashes the token as lowercase hex SHA-256, the stored format", () => {
    expect(hashPortalWebhookToken(TOKEN)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("loggableHeaders", () => {
  it("hides anything that may carry a credential and drops our hosting's own headers", () => {
    expect(loggableHeaders(new Headers({
      "content-type": "application/json", "user-agent": "99acres-push/1.0", authorization: "Bearer x", cookie: "a=b", "x-api-key": "k",
      "x-vercel-id": "bom1::abc", "x-invocation-id": "inv-1", "x-forwarded-for": "203.0.113.9",
    }))).toEqual({
      "content-type": "application/json", "user-agent": "99acres-push/1.0", authorization: "[hidden]", cookie: "[hidden]", "x-api-key": "[hidden]",
      "x-forwarded-for": "203.0.113.9",
    });
  });

  it("keeps at most 50 headers, each cut to 1,000 characters", () => {
    const many = new Headers(Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`x-h${index}`, "v".repeat(1200)])));
    const logged = loggableHeaders(many);
    expect(Object.keys(logged)).toHaveLength(50);
    expect(Object.values(logged).every((value) => value.length === 1000)).toBe(true);
  });
});
