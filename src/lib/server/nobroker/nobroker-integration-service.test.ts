// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ access: vi.fn(), from: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/server/auth/access", () => ({ requireCrmAccess: mocks.access }));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => ({ from: mocks.from, rpc: mocks.rpc }) }));
vi.mock("@/lib/server/token-crypto", () => ({ encryptToken: (value: string) => `enc:${value}`, decryptToken: (value: string) => { if (value === "unreadable") throw new Error("bad key"); return value.replace(/^enc:/, ""); } }));

import { NOBROKER_LOG_MESSAGES, hashNoBrokerWebhookToken } from "@/lib/server/nobroker/nobroker-lead-intake-service";
import { NoBrokerIntegrationService, nobrokerFailureReason } from "@/lib/server/nobroker/nobroker-integration-service";
import { NOBROKER_PAYLOAD_MESSAGES } from "@/lib/server/nobroker/nobroker-lead-mapper";

const ORIGIN = "https://crm.example.com";
const OWNER = { tenantId: "tenant-a", userId: "owner-a", membershipRole: "owner" };
const EMPLOYEE = { tenantId: "tenant-a", userId: "employee-a", membershipRole: "employee" };
const TOKEN = "T".repeat(43);

/** A query chain: every builder call returns the chain; maybeSingle() and await resolve to `result`. */
function chain(result: { data?: unknown; error: unknown }) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "update", "eq", "lt", "order", "limit"]) query[method] = vi.fn(() => query);
  query.maybeSingle = vi.fn(() => Promise.resolve(result));
  return Object.assign(query, { then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve) });
}

const row = (extra: Record<string, unknown> = {}) => ({ id: "hs-1", encrypted_url_token: `enc:${TOKEN}`, is_active: true, last_received_at: null, previous_valid_until: null, previous_last_received_at: null, paused_at: null, ...extra });

function overviewTables(integration: unknown, failedResult: { data?: unknown; error: unknown } = { data: [], error: null }, stuckResult: { data?: unknown; error: unknown } = { data: [], error: null }) {
  const integrationRead = chain({ data: integration, error: null });
  const logReads = [chain(failedResult), chain(stuckResult)];
  mocks.from.mockImplementation((table: string) => {
    if (table === "nobroker_integrations") return integrationRead;
    if (table === "nobroker_webhook_logs") return logReads.shift();
    throw new Error(`unexpected table ${table}`);
  });
  return { integrationRead };
}

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());

describe("NoBrokerIntegrationService.getOverview", () => {
  it("without details: one read of this company's row, never a URL (the /leads and dashboard check)", async () => {
    mocks.access.mockResolvedValue(OWNER);
    const { integrationRead } = overviewTables(row());
    await expect(new NoBrokerIntegrationService().getOverview(ORIGIN)).resolves.toEqual({ canManage: true, hasIntegration: true, integration: null });
    expect(integrationRead.select).toHaveBeenCalledWith("id,encrypted_url_token,is_active,last_received_at,previous_valid_until,previous_last_received_at,paused_at");
    expect(integrationRead.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });

  it("says Not set up when the company has no NoBroker URL", async () => {
    mocks.access.mockResolvedValue(OWNER);
    overviewTables(null);
    await expect(new NoBrokerIntegrationService().getOverview(ORIGIN, { details: true })).resolves.toEqual({ canManage: true, hasIntegration: false, integration: null });
  });

  it("never gives an employee the URL", async () => {
    mocks.access.mockResolvedValue(EMPLOYEE);
    overviewTables(row());
    await expect(new NoBrokerIntegrationService().getOverview(ORIGIN, { details: true })).resolves.toEqual({ canManage: false, hasIntegration: true, integration: null });
  });

  it("gives the owner the URL, the last lead time and the failed requests (stuck ones too) with short labels", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-20T12:00:00Z") });
    mocks.access.mockResolvedValue(OWNER);
    overviewTables(
      row({ last_received_at: "2026-11-20T11:00:00Z" }),
      { data: [{ id: "log-2", created_at: "2026-11-20T10:00:00Z", error_message: NOBROKER_PAYLOAD_MESSAGES.noContact }], error: null },
      { data: [{ id: "log-1", created_at: "2026-11-20T09:00:00Z", error_message: null }], error: null },
    );
    const overview = await new NoBrokerIntegrationService().getOverview(ORIGIN, { details: true });
    expect(overview.integration).toEqual({
      url: `${ORIGIN}/api/webhooks/nobroker/${TOKEN}`,
      lastLeadAt: "2026-11-20T11:00:00Z",
      previousUrl: null,
      paused: false,
      failedRequests: [
        { id: "log-2", createdAt: "2026-11-20T10:00:00Z", reason: "Mobile number or email not found" },
        { id: "log-1", createdAt: "2026-11-20T09:00:00Z", reason: "Not saved" },
      ],
    });
  });

  it("shows the old URL's handover while it still works, with its own last lead time", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-20T12:00:00Z") });
    mocks.access.mockResolvedValue(OWNER);
    overviewTables(row({ previous_valid_until: "2026-11-27T12:00:00Z", previous_last_received_at: "2026-11-20T11:30:00Z" }));
    const overview = await new NoBrokerIntegrationService().getOverview(ORIGIN, { details: true });
    expect(overview.integration?.previousUrl).toEqual({ validUntil: "2026-11-27T12:00:00Z", lastLeadAt: "2026-11-20T11:30:00Z" });
    // A lead on the old URL never makes the new URL look Connected.
    expect(overview.integration?.lastLeadAt).toBeNull();
  });

  it("hides the old URL once its 7 days are over", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-28T12:00:00Z") });
    mocks.access.mockResolvedValue(OWNER);
    overviewTables(row({ previous_valid_until: "2026-11-27T12:00:00Z" }));
    expect((await new NoBrokerIntegrationService().getOverview(ORIGIN, { details: true })).integration?.previousUrl).toBeNull();
  });

  it("still loads with url null when the stored copy cannot be decrypted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.access.mockResolvedValue(OWNER);
    overviewTables(row({ encrypted_url_token: "unreadable" }));
    expect((await new NoBrokerIntegrationService().getOverview(ORIGIN, { details: true })).integration?.url).toBeNull();
  });

  it("fails cleanly when a log read fails", async () => {
    mocks.access.mockResolvedValue(OWNER);
    overviewTables(row(), { data: null, error: { message: "down" } });
    await expect(new NoBrokerIntegrationService().getOverview(ORIGIN, { details: true })).rejects.toMatchObject({ status: 500, code: "NOBROKER_OVERVIEW_FAILED" });
  });
});

describe("NoBrokerIntegrationService.createOrReplace", () => {
  it("saves only the hash and the encrypted copy through save_nobroker_url, and returns the new URL", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.rpc.mockResolvedValue({ data: { replaced: false, previous_valid_until: null }, error: null });
    const { url } = await new NoBrokerIntegrationService().createOrReplace(ORIGIN);
    const token = url.split("/").at(-1) ?? "";
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mocks.rpc).toHaveBeenCalledWith("save_nobroker_url", { p_tenant_id: "tenant-a", p_token_hash: hashNoBrokerWebhookToken(token), p_encrypted_token: `enc:${token}` });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("refuses an employee", async () => {
    mocks.access.mockResolvedValue(EMPLOYEE);
    await expect(new NoBrokerIntegrationService().createOrReplace(ORIGIN)).rejects.toMatchObject({ status: 403, code: "NOBROKER_OWNER_REQUIRED" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("fails cleanly when the save fails", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "down" } });
    await expect(new NoBrokerIntegrationService().createOrReplace(ORIGIN)).rejects.toMatchObject({ status: 500, code: "NOBROKER_SAVE_FAILED" });
  });
});

describe("NoBrokerIntegrationService pause", () => {
  it("pauses only this company's active NoBroker URL, and the owner's card then reads paused", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-27T10:00:00Z") });
    mocks.access.mockResolvedValue(OWNER);
    const query = chain({ data: [{ id: "hs-1" }], error: null });
    mocks.from.mockReturnValue(query);
    await expect(new NoBrokerIntegrationService().setPaused(true)).resolves.toEqual({ paused: true });
    expect(mocks.from).toHaveBeenCalledWith("nobroker_integrations");
    expect(query.update).toHaveBeenCalledWith({ paused_at: "2026-11-27T10:00:00.000Z" });
    expect(query.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
    expect(query.eq).toHaveBeenCalledWith("is_active", true);
    expect(query.select).toHaveBeenCalledWith("id");
    expect(mocks.rpc).not.toHaveBeenCalled();
    overviewTables(row({ paused_at: "2026-11-27T10:00:00Z" }));
    expect((await new NoBrokerIntegrationService().getOverview(ORIGIN, { details: true })).integration?.paused).toBe(true);
  });

  it("resumes by clearing paused_at", async () => {
    mocks.access.mockResolvedValue(OWNER);
    const query = chain({ data: [{ id: "hs-1" }], error: null });
    mocks.from.mockReturnValue(query);
    await expect(new NoBrokerIntegrationService().setPaused(false)).resolves.toEqual({ paused: false });
    expect(query.update).toHaveBeenCalledWith({ paused_at: null });
    expect(query.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
  });

  it("refuses an employee before touching the database", async () => {
    mocks.access.mockResolvedValue(EMPLOYEE);
    await expect(new NoBrokerIntegrationService().setPaused(true)).rejects.toMatchObject({ status: 403, code: "NOBROKER_OWNER_REQUIRED" });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("says to generate the URL first when there is none", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.from.mockReturnValue(chain({ data: [], error: null }));
    await expect(new NoBrokerIntegrationService().setPaused(true)).rejects.toMatchObject({ status: 404, code: "NOBROKER_INTEGRATION_NOT_FOUND", message: "Generate the webhook URL first." });
  });

  it("fails cleanly with 500 when the database fails", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.from.mockReturnValue(chain({ data: null, error: { message: "down" } }));
    await expect(new NoBrokerIntegrationService().setPaused(true)).rejects.toMatchObject({ status: 500, code: "NOBROKER_PAUSE_FAILED", message: "NoBroker leads could not be paused. Try again." });
    await expect(new NoBrokerIntegrationService().setPaused(false)).rejects.toMatchObject({ status: 500, code: "NOBROKER_PAUSE_FAILED", message: "NoBroker leads could not be resumed. Try again." });
  });
});

describe("nobrokerFailureReason", () => {
  it("maps every stored message to a short label, anything else to Not saved", () => {
    expect(nobrokerFailureReason(NOBROKER_PAYLOAD_MESSAGES.noContact)).toBe("Mobile number or email not found");
    for (const message of [NOBROKER_PAYLOAD_MESSAGES.unsupportedType, NOBROKER_PAYLOAD_MESSAGES.notJsonObject, NOBROKER_PAYLOAD_MESSAGES.oneLeadPerRequest, NOBROKER_PAYLOAD_MESSAGES.tooManyFields, NOBROKER_PAYLOAD_MESSAGES.fieldNameTooLong]) {
      expect(nobrokerFailureReason(message)).toBe("Unsupported format");
    }
    expect(nobrokerFailureReason(NOBROKER_LOG_MESSAGES.serverError)).toBe("Server error");
    expect(nobrokerFailureReason(NOBROKER_LOG_MESSAGES.urlReplaced)).toBe("Old webhook URL");
    expect(nobrokerFailureReason(null)).toBe("Not saved");
    expect(nobrokerFailureReason("something new")).toBe("Not saved");
  });
});
