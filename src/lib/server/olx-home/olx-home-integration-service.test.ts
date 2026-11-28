// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ access: vi.fn(), from: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/server/auth/access", () => ({ requireCrmAccess: mocks.access }));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => ({ from: mocks.from, rpc: mocks.rpc }) }));
vi.mock("@/lib/server/token-crypto", () => ({ encryptToken: (value: string) => `enc:${value}`, decryptToken: (value: string) => { if (value === "unreadable") throw new Error("bad key"); return value.replace(/^enc:/, ""); } }));

import { OLX_HOME_LOG_MESSAGES, hashOlxHomeWebhookToken } from "@/lib/server/olx-home/olx-home-lead-intake-service";
import { OlxHomeIntegrationService, olxHomeFailureReason } from "@/lib/server/olx-home/olx-home-integration-service";
import { OLX_HOME_PAYLOAD_MESSAGES } from "@/lib/server/olx-home/olx-home-lead-mapper";

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
    if (table === "olx_home_integrations") return integrationRead;
    if (table === "olx_home_webhook_logs") return logReads.shift();
    throw new Error(`unexpected table ${table}`);
  });
  return { integrationRead };
}

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());

describe("OlxHomeIntegrationService.getOverview", () => {
  it("without details: one read of this company's row, never a URL (the /leads and dashboard check)", async () => {
    mocks.access.mockResolvedValue(OWNER);
    const { integrationRead } = overviewTables(row());
    await expect(new OlxHomeIntegrationService().getOverview(ORIGIN)).resolves.toEqual({ canManage: true, hasIntegration: true, disconnected: false, integration: null });
    expect(integrationRead.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });

  it("says Not set up when the company has no OLX Home URL", async () => {
    mocks.access.mockResolvedValue(OWNER);
    overviewTables(null);
    await expect(new OlxHomeIntegrationService().getOverview(ORIGIN, { details: true })).resolves.toEqual({ canManage: true, hasIntegration: false, disconnected: false, integration: null });
  });

  it("never gives an employee the URL", async () => {
    mocks.access.mockResolvedValue(EMPLOYEE);
    overviewTables(row());
    await expect(new OlxHomeIntegrationService().getOverview(ORIGIN, { details: true })).resolves.toEqual({ canManage: false, hasIntegration: true, disconnected: false, integration: null });
  });

  it("gives the owner the URL, the last lead time and the failed requests (stuck ones too) with short labels", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-20T12:00:00Z") });
    mocks.access.mockResolvedValue(OWNER);
    overviewTables(
      row({ last_received_at: "2026-11-20T11:00:00Z" }),
      { data: [{ id: "log-2", created_at: "2026-11-20T10:00:00Z", error_message: OLX_HOME_PAYLOAD_MESSAGES.noContact }], error: null },
      { data: [{ id: "log-1", created_at: "2026-11-20T09:00:00Z", error_message: null }], error: null },
    );
    const overview = await new OlxHomeIntegrationService().getOverview(ORIGIN, { details: true });
    expect(overview.integration).toEqual({
      url: `${ORIGIN}/api/webhooks/olx-home/${TOKEN}`,
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
    const overview = await new OlxHomeIntegrationService().getOverview(ORIGIN, { details: true });
    expect(overview.integration?.previousUrl).toEqual({ validUntil: "2026-11-27T12:00:00Z", lastLeadAt: "2026-11-20T11:30:00Z" });
    // A lead on the old URL never makes the new URL look Connected.
    expect(overview.integration?.lastLeadAt).toBeNull();
  });

  it("hides the old URL once its 7 days are over", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-28T12:00:00Z") });
    mocks.access.mockResolvedValue(OWNER);
    overviewTables(row({ previous_valid_until: "2026-11-27T12:00:00Z" }));
    expect((await new OlxHomeIntegrationService().getOverview(ORIGIN, { details: true })).integration?.previousUrl).toBeNull();
  });

  it("still loads with url null when the stored copy cannot be decrypted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.access.mockResolvedValue(OWNER);
    overviewTables(row({ encrypted_url_token: "unreadable" }));
    expect((await new OlxHomeIntegrationService().getOverview(ORIGIN, { details: true })).integration?.url).toBeNull();
  });

  it("fails cleanly when a log read fails", async () => {
    mocks.access.mockResolvedValue(OWNER);
    overviewTables(row(), { data: null, error: { message: "down" } });
    await expect(new OlxHomeIntegrationService().getOverview(ORIGIN, { details: true })).rejects.toMatchObject({ status: 500, code: "OLX_HOME_OVERVIEW_FAILED" });
  });
});

describe("OlxHomeIntegrationService.createOrReplace", () => {
  it("saves only the hash and the encrypted copy through save_olx_home_url, and returns the new URL", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.rpc.mockResolvedValue({ data: { replaced: false, previous_valid_until: null }, error: null });
    const { url } = await new OlxHomeIntegrationService().createOrReplace(ORIGIN);
    const token = url.split("/").at(-1) ?? "";
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mocks.rpc).toHaveBeenCalledWith("save_olx_home_url", { p_tenant_id: "tenant-a", p_token_hash: hashOlxHomeWebhookToken(token), p_encrypted_token: `enc:${token}` });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("refuses an employee", async () => {
    mocks.access.mockResolvedValue(EMPLOYEE);
    await expect(new OlxHomeIntegrationService().createOrReplace(ORIGIN)).rejects.toMatchObject({ status: 403, code: "OLX_HOME_OWNER_REQUIRED" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("fails cleanly when the save fails", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "down" } });
    await expect(new OlxHomeIntegrationService().createOrReplace(ORIGIN)).rejects.toMatchObject({ status: 500, code: "OLX_HOME_SAVE_FAILED" });
  });
});

describe("OlxHomeIntegrationService pause", () => {
  it("reads paused_at and tells the owner's card whether OLX Home is paused", async () => {
    mocks.access.mockResolvedValue(OWNER);
    const { integrationRead } = overviewTables(row({ paused_at: "2026-11-27T10:00:00Z" }));
    const overview = await new OlxHomeIntegrationService().getOverview(ORIGIN, { details: true });
    expect(overview.integration?.paused).toBe(true);
    expect(integrationRead.select).toHaveBeenCalledWith("id,encrypted_url_token,is_active,last_received_at,previous_valid_until,previous_last_received_at,paused_at");
  });

  it("pauses and resumes only this company's active OLX Home URL", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-27T10:00:00Z") });
    mocks.access.mockResolvedValue(OWNER);
    const query = chain({ data: [{ id: "hs-1" }], error: null });
    mocks.from.mockReturnValue(query);
    const service = new OlxHomeIntegrationService();
    await expect(service.setPaused(true)).resolves.toEqual({ paused: true });
    expect(mocks.from).toHaveBeenCalledWith("olx_home_integrations");
    expect(query.update).toHaveBeenLastCalledWith({ paused_at: "2026-11-27T10:00:00.000Z" });
    expect(query.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
    expect(query.eq).toHaveBeenCalledWith("is_active", true);
    expect(query.select).toHaveBeenCalledWith("id");
    await expect(service.setPaused(false)).resolves.toEqual({ paused: false });
    expect(query.update).toHaveBeenLastCalledWith({ paused_at: null });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("refuses an employee before touching the database", async () => {
    mocks.access.mockResolvedValue(EMPLOYEE);
    await expect(new OlxHomeIntegrationService().setPaused(true)).rejects.toMatchObject({ status: 403, code: "OLX_HOME_OWNER_REQUIRED" });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("says to generate the URL first when there is none", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.from.mockReturnValue(chain({ data: [], error: null }));
    await expect(new OlxHomeIntegrationService().setPaused(true)).rejects.toMatchObject({ status: 404, code: "OLX_HOME_INTEGRATION_NOT_FOUND", message: "Generate the webhook URL first." });
  });

  it("fails with 500 when the database fails", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.from.mockReturnValue(chain({ data: null, error: { message: "down" } }));
    await expect(new OlxHomeIntegrationService().setPaused(true)).rejects.toMatchObject({ status: 500, code: "OLX_HOME_PAUSE_FAILED", message: "OLX Home leads could not be paused. Try again." });
    await expect(new OlxHomeIntegrationService().setPaused(false)).rejects.toMatchObject({ status: 500, code: "OLX_HOME_PAUSE_FAILED", message: "OLX Home leads could not be resumed. Try again." });
  });
});

describe("OlxHomeIntegrationService disconnect", () => {
  it("stops this company's OLX Home URL and its old URL in one update, and clears the pause", async () => {
    mocks.access.mockResolvedValue(OWNER);
    const query = chain({ data: [{ id: "hs-1" }], error: null });
    mocks.from.mockReturnValue(query);
    await expect(new OlxHomeIntegrationService().disconnect()).resolves.toEqual({ disconnected: true });
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.from).toHaveBeenCalledWith("olx_home_integrations");
    expect(query.update).toHaveBeenCalledTimes(1);
    expect(query.update).toHaveBeenCalledWith({ is_active: false, paused_at: null, previous_url_token_hash: null, previous_valid_until: null, previous_last_received_at: null });
    // Only this company's row; disconnecting twice (two tabs, a double click) is the same update again, never an error.
    expect(query.eq).toHaveBeenCalledTimes(1);
    expect(query.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
    expect(query.select).toHaveBeenCalledWith("id");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("refuses an employee before touching the database", async () => {
    mocks.access.mockResolvedValue(EMPLOYEE);
    await expect(new OlxHomeIntegrationService().disconnect()).rejects.toMatchObject({ status: 403, code: "OLX_HOME_OWNER_REQUIRED" });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("says to generate the URL first when there is none, and 500 when the database fails", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.from.mockReturnValue(chain({ data: [], error: null }));
    await expect(new OlxHomeIntegrationService().disconnect()).rejects.toMatchObject({ status: 404, code: "OLX_HOME_INTEGRATION_NOT_FOUND", message: "Generate the webhook URL first." });
    mocks.from.mockReturnValue(chain({ data: null, error: { message: "down" } }));
    await expect(new OlxHomeIntegrationService().disconnect()).rejects.toMatchObject({ status: 500, code: "OLX_HOME_DISCONNECT_FAILED", message: "OLX Home could not be disconnected. Try again." });
  });

  it("tells the owner and an employee that OLX Home is disconnected, without the URL or the failed requests", async () => {
    mocks.access.mockResolvedValue(OWNER);
    overviewTables(row({ is_active: false }));
    await expect(new OlxHomeIntegrationService().getOverview(ORIGIN, { details: true })).resolves.toEqual({ canManage: true, hasIntegration: true, disconnected: true, integration: null });
    expect(mocks.from).toHaveBeenCalledTimes(1);
    mocks.access.mockResolvedValue(EMPLOYEE);
    overviewTables(row({ is_active: false }));
    await expect(new OlxHomeIntegrationService().getOverview(ORIGIN, { details: true })).resolves.toEqual({ canManage: false, hasIntegration: true, disconnected: true, integration: null });
  });

  it("keeps a disconnected OLX Home in the Source filter (the /leads and dashboard check)", async () => {
    mocks.access.mockResolvedValue(EMPLOYEE);
    const { integrationRead } = overviewTables(row({ is_active: false }));
    await expect(new OlxHomeIntegrationService().getOverview(ORIGIN)).resolves.toEqual({ canManage: false, hasIntegration: true, disconnected: true, integration: null });
    expect(integrationRead.eq).not.toHaveBeenCalledWith("is_active", expect.anything());
  });
});

describe("olxHomeFailureReason", () => {
  it("maps every stored message to a short label, anything else to Not saved", () => {
    expect(olxHomeFailureReason(OLX_HOME_PAYLOAD_MESSAGES.noContact)).toBe("Mobile number or email not found");
    for (const message of [OLX_HOME_PAYLOAD_MESSAGES.unsupportedType, OLX_HOME_PAYLOAD_MESSAGES.notJsonObject, OLX_HOME_PAYLOAD_MESSAGES.oneLeadPerRequest, OLX_HOME_PAYLOAD_MESSAGES.tooManyFields, OLX_HOME_PAYLOAD_MESSAGES.fieldNameTooLong]) {
      expect(olxHomeFailureReason(message)).toBe("Unsupported format");
    }
    expect(olxHomeFailureReason(OLX_HOME_LOG_MESSAGES.serverError)).toBe("Server error");
    expect(olxHomeFailureReason(OLX_HOME_LOG_MESSAGES.urlReplaced)).toBe("Old webhook URL");
    expect(olxHomeFailureReason(null)).toBe("Not saved");
    expect(olxHomeFailureReason("something new")).toBe("Not saved");
  });
});
