// @vitest-environment node
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(), lookup: vi.fn(), insert: vi.fn(), insertResult: vi.fn(), update: vi.fn(), updateResult: vi.fn(), rate: vi.fn(), tables: [] as string[], functions: [] as string[],
}));
vi.mock("@/lib/server/supabase-admin", () => ({
  getSupabaseAdminClient: () => ({
    // find_magicbricks_integration is the URL lookup; every other function is the lead save.
    rpc: (fn: string, args: unknown) => { mocks.functions.push(fn); return fn === "find_magicbricks_integration" ? mocks.lookup(args) : mocks.rpc(fn, args); },
    from: (table: string) => {
      mocks.tables.push(table);
      if (table === "magicbricks_webhook_logs") {
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
vi.mock("@/lib/server/magicbricks/magicbricks-rate-limit", () => ({ checkMagicbricksRate: mocks.rate }));

import { MAGICBRICKS_LOG_MESSAGES, MagicbricksLeadIntakeService, hashMagicbricksWebhookToken, loggableMagicbricksHeaders, type IncomingMagicbricksRequest } from "@/lib/server/magicbricks/magicbricks-lead-intake-service";
import { MAGICBRICKS_PAYLOAD_MESSAGES } from "@/lib/server/magicbricks/magicbricks-lead-mapper";

const TOKEN = "M".repeat(43);
const INTEGRATION = { id: "mb-integration-1", tenant_id: "tenant-a", field_mapping: {}, url_version: "current" };
const TOKEN_HASH = createHash("sha256").update("M".repeat(43)).digest("hex");
const SAMPLE = { name: "Test Buyer", mobile: "9876543210", email: "buyer@example.com", project: "Sample Towers", pid: "MB-45892", city: "Chennai", remark: "Interested in 3BHK" };
const json = (body: unknown, headers: Record<string, string> = {}): IncomingMagicbricksRequest => ({
  method: "POST", headers: new Headers({ "content-type": "application/json", ...headers }), query: {}, rawBody: JSON.stringify(body),
});
const ingest = (request: IncomingMagicbricksRequest = json(SAMPLE), token = TOKEN) => new MagicbricksLeadIntakeService().ingestFromWebhook(token, request);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.tables.length = 0;
  mocks.functions.length = 0;
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.lookup.mockResolvedValue({ data: [INTEGRATION], error: null });
  mocks.rate.mockResolvedValue({ allowed: true });
  mocks.insertResult.mockResolvedValue({ data: { id: "log-1" }, error: null });
  mocks.updateResult.mockReturnValue({ error: null });
  mocks.rpc.mockResolvedValue({ data: { outcome: "stored", lead_id: "lead-1" }, error: null });
});

describe("MagicbricksLeadIntakeService.ingestFromWebhook", () => {
  it("finds the company by the SHA-256 of the URL token, logs the raw request, then saves the lead with MagicBricks's own function", async () => {
    await expect(ingest()).resolves.toEqual({ status: 200, message: "Lead received", duplicate: false, outcome: "stored", leadId: "lead-1" });
    expect(mocks.lookup).toHaveBeenCalledWith({ p_token_hash: TOKEN_HASH });
    expect(mocks.insert).toHaveBeenCalledWith({
      tenant_id: "tenant-a", integration_id: "mb-integration-1", http_method: "POST",
      headers: { "content-type": "application/json" }, query_params: {}, raw_body: JSON.stringify(SAMPLE), url_version: "current",
    });
    expect(mocks.rpc).toHaveBeenCalledWith("ingest_magicbricks_lead_on_url", {
      p_tenant_id: "tenant-a", p_integration_id: "mb-integration-1", p_log_id: "log-1", p_token_hash: TOKEN_HASH, p_lead_ref: null, p_project_name: "Sample Towers",
      p_enquiry_summary: "New MagicBricks enquiry · Name: Test Buyer · Project: Sample Towers · City: Chennai · Query: Interested in 3BHK",
      p_field_data: expect.arrayContaining([{ name: "phone_number", values: ["9876543210"] }, { name: "pid", values: ["MB-45892"] }]),
      p_raw_payload: SAMPLE,
    });
    expect(new Set(mocks.tables)).toEqual(new Set(["magicbricks_webhook_logs"]));
    expect(mocks.functions).toEqual(["find_magicbricks_integration", "ingest_magicbricks_lead_on_url"]);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("saves a GET enquiry sent as URL parameters", async () => {
    const request: IncomingMagicbricksRequest = { method: "GET", headers: new Headers(), query: { name: "Ravi", mobile: "9876543210", project: "Green Valley", pid: "MB-1", remark: "2 BHK" }, rawBody: "" };
    await expect(ingest(request)).resolves.toMatchObject({ status: 200, outcome: "stored" });
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ http_method: "GET", query_params: request.query, raw_body: "" }));
    expect(mocks.rpc).toHaveBeenCalledWith("ingest_magicbricks_lead_on_url", expect.objectContaining({ p_project_name: "Green Valley", p_lead_ref: null }));
  });

  it("saves a lead sent to the old URL within its 7 days, logged as coming on the old URL", async () => {
    mocks.lookup.mockResolvedValue({ data: [{ ...INTEGRATION, url_version: "previous" }], error: null });
    await expect(ingest()).resolves.toMatchObject({ status: 200, outcome: "stored" });
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ url_version: "previous" }));
    expect(mocks.rpc).toHaveBeenCalledWith("ingest_magicbricks_lead_on_url", expect.objectContaining({ p_token_hash: TOKEN_HASH }));
  });

  it("answers duplicate for a retry or a same-phone note", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { outcome: "merged", lead_id: "lead-9" }, error: null });
    await expect(ingest()).resolves.toEqual({ status: 200, message: "Lead received", duplicate: true, outcome: "merged", leadId: "lead-9" });
    mocks.rpc.mockResolvedValueOnce({ data: { outcome: "duplicate", lead_id: "lead-9" }, error: null });
    await expect(ingest()).resolves.toMatchObject({ duplicate: true, outcome: "duplicate" });
  });

  it.each([["a malformed token", "short"], ["a token with other characters", `${"M".repeat(42)}!`]])("answers 404 for %s without reading the database", async (_case, token) => {
    await expect(ingest(json(SAMPLE), token)).resolves.toEqual({ status: 404, message: "Unknown webhook." });
    expect(mocks.tables).toEqual([]);
    expect(mocks.functions).toEqual([]);
  });

  it("answers 404 and logs nothing for a URL the database does not accept (unknown, stopped or an expired old URL)", async () => {
    mocks.lookup.mockResolvedValueOnce({ data: [], error: null });
    await expect(ingest()).resolves.toEqual({ status: 404, message: "Unknown webhook." });
    mocks.lookup.mockResolvedValueOnce({ data: null, error: null });
    await expect(ingest()).resolves.toEqual({ status: 404, message: "Unknown webhook." });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("answers 500 when the URL lookup fails", async () => {
    mocks.lookup.mockResolvedValueOnce({ data: null, error: { message: "down" } });
    await expect(ingest()).resolves.toEqual({ status: 500, message: "Temporary failure, retry later." });
  });

  it("answers 413 for a body over 64 KB", async () => {
    await expect(ingest({ ...json(SAMPLE), rawBody: "x".repeat(64 * 1024 + 1) })).resolves.toEqual({ status: 413, message: "Payload too large." });
  });

  it("answers 429 with Retry-After seconds when the company is over its limit, and logs nothing", async () => {
    mocks.rate.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 12 });
    await expect(ingest()).resolves.toEqual({ status: 429, message: "Too many leads. Try again shortly.", retryAfterSeconds: 12 });
    expect(mocks.rate).toHaveBeenCalledWith("mb-integration-1");
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("answers an empty URL check with Webhook ready, saving and logging nothing", async () => {
    await expect(ingest({ method: "GET", headers: new Headers(), query: {}, rawBody: "" })).resolves.toEqual({ status: 200, message: "Webhook ready" });
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("takes no lead without its raw copy: a failed log write answers 500", async () => {
    mocks.insertResult.mockResolvedValueOnce({ data: null, error: { message: "down" } });
    await expect(ingest()).resolves.toEqual({ status: 500, message: "Temporary failure, retry later." });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("marks the log failed with the reason when the request cannot become a lead", async () => {
    await expect(ingest(json({ name: "No contact" }))).resolves.toEqual({ status: 400, message: MAGICBRICKS_PAYLOAD_MESSAGES.noContact });
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", error_message: MAGICBRICKS_PAYLOAD_MESSAGES.noContact }));
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["22023", 400, MAGICBRICKS_PAYLOAD_MESSAGES.noContact, MAGICBRICKS_PAYLOAD_MESSAGES.noContact],
    ["P0002", 404, "Unknown webhook.", MAGICBRICKS_LOG_MESSAGES.urlReplaced],
    ["XX000", 500, "Temporary failure, retry later.", MAGICBRICKS_LOG_MESSAGES.serverError],
  ])("maps the save function's error %s by its code", async (code, status, message, logged) => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code, message: "anything" } });
    await expect(ingest()).resolves.toEqual({ status, message });
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", error_message: logged }));
  });
});

describe("loggableMagicbricksHeaders", () => {
  it("drops our hosting's headers and hides anything that may carry a credential", () => {
    const headers = new Headers({ "content-type": "application/json", "x-vercel-id": "1", "x-forwarded-for": "1.2.3.4", authorization: "Bearer x", "x-api-key": "k", cookie: "a=b" });
    expect(loggableMagicbricksHeaders(headers)).toEqual({ "content-type": "application/json", "x-forwarded-for": "1.2.3.4", authorization: "[hidden]", "x-api-key": "[hidden]", cookie: "[hidden]" });
  });
});

describe("hashMagicbricksWebhookToken", () => {
  it("is the hex SHA-256 of the token", () => {
    expect(hashMagicbricksWebhookToken("abc")).toBe(createHash("sha256").update("abc").digest("hex"));
  });
});
