// @vitest-environment node
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(), insert: vi.fn(), insertResult: vi.fn(), update: vi.fn(), updateResult: vi.fn(), rate: vi.fn(), tables: [] as string[],
}));
vi.mock("@/lib/server/supabase-admin", () => ({
  getSupabaseAdminClient: () => ({
    rpc: mocks.rpc,
    from: (table: string) => {
      mocks.tables.push(table);
      if (table === "sulekha_webhook_logs") {
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
vi.mock("@/lib/server/sulekha/sulekha-rate-limit", () => ({ checkSulekhaRate: mocks.rate }));

import { SULEKHA_LOG_MESSAGES, SulekhaLeadIntakeService, hashSulekhaWebhookToken, loggableSulekhaHeaders, sulekhaSourceIp, type IncomingSulekhaRequest } from "@/lib/server/sulekha/sulekha-lead-intake-service";
import { SULEKHA_PAYLOAD_MESSAGES } from "@/lib/server/sulekha/sulekha-lead-mapper";

const TOKEN = "S".repeat(43);
const HASH = createHash("sha256").update(TOKEN).digest("hex");
const MATCH = { id: "sul-integration-1", tenant_id: "tenant-a", field_mapping: {}, url_version: "current" };
const SAMPLE = { name: "Test Customer", mobile: "9876543210", email: "customer@example.com", service: "Interior Designers", lead_id: "SUL-ENQ-1" };
const json = (body: unknown, headers: Record<string, string> = {}): IncomingSulekhaRequest => ({
  method: "POST", headers: new Headers({ "content-type": "application/json", ...headers }), query: {}, rawBody: JSON.stringify(body),
});
const ingest = (request: IncomingSulekhaRequest = json(SAMPLE), token = TOKEN) => new SulekhaLeadIntakeService().ingestFromWebhook(token, request);
const lookupCalls = () => mocks.rpc.mock.calls.filter(([name]) => name === "find_sulekha_integration");
const saveCalls = () => mocks.rpc.mock.calls.filter(([name]) => name === "ingest_sulekha_lead");

function rpcAnswers({ match = [MATCH] as unknown, lookupError = null as unknown, save = { data: { outcome: "stored", lead_id: "lead-1" }, error: null } as unknown } = {}) {
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === "find_sulekha_integration") return { data: match, error: lookupError };
    if (name === "ingest_sulekha_lead") return save;
    throw new Error(`unexpected rpc ${name}`);
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.tables.length = 0;
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  rpcAnswers();
  mocks.rate.mockResolvedValue({ allowed: true });
  mocks.insertResult.mockResolvedValue({ data: { id: "log-1" }, error: null });
  mocks.updateResult.mockReturnValue({ error: null });
});

describe("SulekhaLeadIntakeService.ingestFromWebhook", () => {
  it("finds the company by the SHA-256 of the URL token, logs the raw request, then saves the lead with Sulekha's own function", async () => {
    await expect(ingest()).resolves.toEqual({ status: 200, message: "Lead received", duplicate: false, outcome: "stored", leadId: "lead-1" });
    expect(hashSulekhaWebhookToken(TOKEN)).toBe(HASH);
    expect(lookupCalls()).toEqual([["find_sulekha_integration", { p_token_hash: HASH }]]);
    expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain(TOKEN);
    expect(saveCalls()[0][1]).toMatchObject({ p_tenant_id: "tenant-a", p_integration_id: "sul-integration-1", p_log_id: "log-1", p_token_hash: HASH, p_lead_ref: "SUL-ENQ-1", p_service_name: "Interior Designers" });
    expect(mocks.tables).toEqual(["sulekha_webhook_logs"]);
    // Only Sulekha's own database objects are used.
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual(["find_sulekha_integration", "ingest_sulekha_lead"]);
  });

  it("logs the method, URL version, content type, user agent and source IP with the raw copy, before reading it", async () => {
    await ingest(json(SAMPLE, { "user-agent": "SulekhaBot/1.0", "x-forwarded-for": "203.0.113.7, 10.0.0.1", authorization: "Bearer secret", "x-vercel-id": "v1" }));
    const row = mocks.insert.mock.calls[0][0];
    expect(row).toMatchObject({ tenant_id: "tenant-a", integration_id: "sul-integration-1", http_method: "POST", url_version: "current", content_type: "application/json", user_agent: "SulekhaBot/1.0", source_ip: "203.0.113.7", raw_body: JSON.stringify(SAMPLE) });
    expect(row.headers).toMatchObject({ authorization: "[hidden]", "user-agent": "SulekhaBot/1.0" });
    expect(row.headers).not.toHaveProperty("x-vercel-id");
  });

  it("logs a request on the old URL as url_version previous", async () => {
    rpcAnswers({ match: [{ ...MATCH, url_version: "previous" }] });
    await ingest();
    expect(mocks.insert.mock.calls[0][0]).toMatchObject({ url_version: "previous" });
  });

  it("answers 404 without logging for a malformed, unknown, stopped or expired token", async () => {
    await expect(ingest(json(SAMPLE), "short")).resolves.toEqual({ status: 404, message: "Unknown webhook." });
    rpcAnswers({ match: [] });
    await expect(ingest()).resolves.toEqual({ status: 404, message: "Unknown webhook." });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("answers 413 for a body over 64 KB even without a content-length", async () => {
    await expect(ingest(json({ mobile: "9876543210", pad: "x".repeat(64 * 1024) }))).resolves.toEqual({ status: 413, message: "Payload too large." });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("answers 429 with Retry-After seconds and logs nothing", async () => {
    mocks.rate.mockResolvedValue({ allowed: false, retryAfterSeconds: 9 });
    await expect(ingest()).resolves.toEqual({ status: 429, message: "Too many leads. Try again shortly.", retryAfterSeconds: 9 });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("answers Webhook ready for an empty URL check and logs nothing", async () => {
    await expect(ingest({ method: "GET", headers: new Headers(), query: {}, rawBody: "" })).resolves.toEqual({ status: 200, message: "Webhook ready" });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("answers 500 (retry) when the raw copy cannot be written, and saves nothing", async () => {
    mocks.insertResult.mockResolvedValue({ data: null, error: { message: "down" } });
    await expect(ingest()).resolves.toEqual({ status: 500, message: "Temporary failure, retry later." });
    expect(saveCalls()).toHaveLength(0);
  });

  it("answers 200 Received (not 4XX) and marks the copy failed when there is no mobile or email", async () => {
    await expect(ingest(json({ name: "Only A Name" }))).resolves.toEqual({ status: 200, message: "Received", accepted: false, reason: SULEKHA_PAYLOAD_MESSAGES.noContact });
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", error_message: SULEKHA_PAYLOAD_MESSAGES.noContact }));
    expect(saveCalls()).toHaveLength(0);
  });

  it("answers 200 Received for a body in an unknown format", async () => {
    await expect(ingest({ method: "POST", headers: new Headers({ "content-type": "application/xml" }), query: {}, rawBody: "<lead/>" })).resolves.toEqual({ status: 200, message: "Received", accepted: false, reason: SULEKHA_PAYLOAD_MESSAGES.unsupportedType });
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", error_message: SULEKHA_PAYLOAD_MESSAGES.unsupportedType }));
  });

  it("answers 200 Received when the database finds no usable contact (22023)", async () => {
    rpcAnswers({ save: { data: null, error: { code: "22023", message: "Mobile number or email not found" } } });
    await expect(ingest()).resolves.toEqual({ status: 200, message: "Received", accepted: false, reason: SULEKHA_PAYLOAD_MESSAGES.noContact });
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", error_message: SULEKHA_PAYLOAD_MESSAGES.noContact }));
  });

  it("answers 404 and marks the copy when the URL was replaced or expired before the save (P0002)", async () => {
    rpcAnswers({ save: { data: null, error: { code: "P0002", message: "not found" } } });
    await expect(ingest()).resolves.toEqual({ status: 404, message: "Unknown webhook." });
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", error_message: SULEKHA_LOG_MESSAGES.urlReplaced }));
  });

  it("answers 500 (retry) and marks the copy for any other save failure", async () => {
    rpcAnswers({ save: { data: null, error: { code: "55000", message: "log" } } });
    await expect(ingest()).resolves.toEqual({ status: 500, message: "Temporary failure, retry later." });
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", error_message: SULEKHA_LOG_MESSAGES.serverError }));
  });

  it("answers 500 when the lookup itself fails", async () => {
    rpcAnswers({ lookupError: { message: "down" } });
    await expect(ingest()).resolves.toEqual({ status: 500, message: "Temporary failure, retry later." });
  });

  it.each([["merged"], ["duplicate"]])("says duplicate for a %s enquiry", async (outcome) => {
    rpcAnswers({ save: { data: { outcome, lead_id: "lead-9" }, error: null } });
    await expect(ingest()).resolves.toEqual({ status: 200, message: "Lead received", duplicate: true, outcome, leadId: "lead-9" });
  });

  it("never logs the token, a phone or an email", async () => {
    await ingest();
    const logged = JSON.stringify([...vi.mocked(console.info).mock.calls, ...vi.mocked(console.error).mock.calls]);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain("9876543210");
    expect(logged).not.toContain("customer@example.com");
  });
});

describe("loggableSulekhaHeaders / sulekhaSourceIp", () => {
  it("hides anything that may carry a credential and drops our hosting's own headers", () => {
    const headers = loggableSulekhaHeaders(new Headers({ cookie: "a", "x-api-key": "k", "x-session-id": "s", "x-invocation-id": "i", "x-real-ip": "1.1.1.1", accept: "*/*" }));
    expect(headers).toEqual({ cookie: "[hidden]", "x-api-key": "[hidden]", "x-session-id": "[hidden]", accept: "*/*" });
  });

  it("takes the first x-forwarded-for value, else x-real-ip", () => {
    expect(sulekhaSourceIp(new Headers({ "x-forwarded-for": " 203.0.113.7 , 10.0.0.1" }))).toBe("203.0.113.7");
    expect(sulekhaSourceIp(new Headers({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(sulekhaSourceIp(new Headers())).toBeNull();
  });
});
