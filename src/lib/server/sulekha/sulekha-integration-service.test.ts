// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ access: vi.fn(), from: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/server/auth/access", () => ({ requireCrmAccess: mocks.access }));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => ({ from: mocks.from, rpc: mocks.rpc }) }));
vi.mock("@/lib/server/token-crypto", () => ({ encryptToken: (value: string) => `enc:${value}`, decryptToken: (value: string) => { if (value === "unreadable") throw new Error("bad key"); return value.replace(/^enc:/, ""); } }));

import { SULEKHA_LOG_MESSAGES, hashSulekhaWebhookToken } from "@/lib/server/sulekha/sulekha-lead-intake-service";
import { SulekhaIntegrationService, sulekhaFailureReason } from "@/lib/server/sulekha/sulekha-integration-service";
import { SULEKHA_PAYLOAD_MESSAGES } from "@/lib/server/sulekha/sulekha-lead-mapper";

const ORIGIN = "https://crm.example.com";
const OWNER = { tenantId: "tenant-a", userId: "owner-a", membershipRole: "owner" };
const EMPLOYEE = { tenantId: "tenant-a", userId: "employee-a", membershipRole: "employee" };
const TOKEN = "T".repeat(43);

/** A query chain: every builder call returns the chain; maybeSingle() and await resolve to `result`. */
function chain(result: { data?: unknown; error: unknown }) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "eq", "lt", "order", "limit", "update"]) query[method] = vi.fn(() => query);
  query.maybeSingle = vi.fn(() => Promise.resolve(result));
  return Object.assign(query, { then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve) });
}

const row = (extra: Record<string, unknown> = {}) => ({ id: "sul-1", encrypted_url_token: `enc:${TOKEN}`, is_active: true, last_received_at: null, previous_valid_until: null, previous_last_received_at: null, paused_at: null, ...extra });

function overviewTables(integration: unknown, failedResult: { data?: unknown; error: unknown } = { data: [], error: null }, stuckResult: { data?: unknown; error: unknown } = { data: [], error: null }) {
  const integrationRead = chain({ data: integration, error: null });
  const logReads = [chain(failedResult), chain(stuckResult)];
  mocks.from.mockImplementation((table: string) => {
    if (table === "sulekha_integrations") return integrationRead;
    if (table === "sulekha_webhook_logs") return logReads.shift();
    throw new Error(`unexpected table ${table}`);
  });
  return { integrationRead };
}

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());

describe("SulekhaIntegrationService.getOverview", () => {
  it("without details: one read of this company's row, never a URL (the /leads and dashboard check)", async () => {
    mocks.access.mockResolvedValue(OWNER);
    const { integrationRead } = overviewTables(row());
    await expect(new SulekhaIntegrationService().getOverview(ORIGIN)).resolves.toEqual({ canManage: true, hasIntegration: true, integration: null });
    expect(integrationRead.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });

  it("says Not set up when the company has no Sulekha URL", async () => {
    mocks.access.mockResolvedValue(OWNER);
    overviewTables(null);
    await expect(new SulekhaIntegrationService().getOverview(ORIGIN, { details: true })).resolves.toEqual({ canManage: true, hasIntegration: false, integration: null });
  });

  it("never gives an employee the URL", async () => {
    mocks.access.mockResolvedValue(EMPLOYEE);
    overviewTables(row());
    await expect(new SulekhaIntegrationService().getOverview(ORIGIN, { details: true })).resolves.toEqual({ canManage: false, hasIntegration: true, integration: null });
  });

  it("gives the owner the URL, the last lead time and the failed requests (stuck ones too) with short labels", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-24T12:00:00Z") });
    mocks.access.mockResolvedValue(OWNER);
    const { integrationRead } = overviewTables(
      row({ last_received_at: "2026-11-24T11:00:00Z" }),
      { data: [{ id: "log-2", created_at: "2026-11-24T10:00:00Z", error_message: SULEKHA_PAYLOAD_MESSAGES.noContact }], error: null },
      { data: [{ id: "log-1", created_at: "2026-11-24T09:00:00Z", error_message: null }], error: null },
    );
    const overview = await new SulekhaIntegrationService().getOverview(ORIGIN, { details: true });
    expect(overview.integration).toEqual({
      url: `${ORIGIN}/api/webhooks/sulekha/${TOKEN}`,
      lastLeadAt: "2026-11-24T11:00:00Z",
      previousUrl: null,
      paused: false,
      failedRequests: [
        { id: "log-2", createdAt: "2026-11-24T10:00:00Z", reason: "Mobile number or email not found" },
        { id: "log-1", createdAt: "2026-11-24T09:00:00Z", reason: "Not saved" },
      ],
    });
    expect(integrationRead.select).toHaveBeenCalledWith("id,encrypted_url_token,is_active,last_received_at,previous_valid_until,previous_last_received_at,paused_at");
  });

  it("tells only the owner's card that Sulekha is paused", async () => {
    mocks.access.mockResolvedValue(OWNER);
    overviewTables(row({ paused_at: "2026-11-27T10:00:00Z" }));
    expect((await new SulekhaIntegrationService().getOverview(ORIGIN, { details: true })).integration?.paused).toBe(true);
    mocks.access.mockResolvedValue(EMPLOYEE);
    overviewTables(row({ paused_at: "2026-11-27T10:00:00Z" }));
    await expect(new SulekhaIntegrationService().getOverview(ORIGIN, { details: true })).resolves.toEqual({ canManage: false, hasIntegration: true, integration: null });
  });

  it("shows the old URL's handover while it still works, with its own last lead time", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-24T12:00:00Z") });
    mocks.access.mockResolvedValue(OWNER);
    overviewTables(row({ previous_valid_until: "2026-12-01T12:00:00Z", previous_last_received_at: "2026-11-24T11:30:00Z" }));
    const overview = await new SulekhaIntegrationService().getOverview(ORIGIN, { details: true });
    expect(overview.integration?.previousUrl).toEqual({ validUntil: "2026-12-01T12:00:00Z", lastLeadAt: "2026-11-24T11:30:00Z" });
    expect(overview.integration?.lastLeadAt).toBeNull();
  });

  it("hides the old URL once its 7 days are over", async () => {
    vi.useFakeTimers({ now: new Date("2026-12-02T12:00:00Z") });
    mocks.access.mockResolvedValue(OWNER);
    overviewTables(row({ previous_valid_until: "2026-12-01T12:00:00Z" }));
    expect((await new SulekhaIntegrationService().getOverview(ORIGIN, { details: true })).integration?.previousUrl).toBeNull();
  });

  it("still loads with url null when the stored copy cannot be decrypted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.access.mockResolvedValue(OWNER);
    overviewTables(row({ encrypted_url_token: "unreadable" }));
    expect((await new SulekhaIntegrationService().getOverview(ORIGIN, { details: true })).integration?.url).toBeNull();
  });

  it("fails cleanly when a log read fails", async () => {
    mocks.access.mockResolvedValue(OWNER);
    overviewTables(row(), { data: null, error: { message: "down" } });
    await expect(new SulekhaIntegrationService().getOverview(ORIGIN, { details: true })).rejects.toMatchObject({ status: 500, code: "SULEKHA_OVERVIEW_FAILED" });
  });
});

describe("SulekhaIntegrationService.createOrReplace", () => {
  it("saves only the hash and the encrypted copy through save_sulekha_url, and returns the new URL", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.rpc.mockResolvedValue({ data: { replaced: false, previous_valid_until: null }, error: null });
    const { url } = await new SulekhaIntegrationService().createOrReplace(ORIGIN);
    const token = url.split("/").at(-1) ?? "";
    expect(url).toBe(`${ORIGIN}/api/webhooks/sulekha/${token}`);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mocks.rpc).toHaveBeenCalledWith("save_sulekha_url", { p_tenant_id: "tenant-a", p_token_hash: hashSulekhaWebhookToken(token), p_encrypted_token: `enc:${token}` });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("refuses an employee", async () => {
    mocks.access.mockResolvedValue(EMPLOYEE);
    await expect(new SulekhaIntegrationService().createOrReplace(ORIGIN)).rejects.toMatchObject({ status: 403, code: "SULEKHA_OWNER_REQUIRED" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("fails cleanly when the save fails", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "down" } });
    await expect(new SulekhaIntegrationService().createOrReplace(ORIGIN)).rejects.toMatchObject({ status: 500, code: "SULEKHA_SAVE_FAILED" });
  });
});

describe("SulekhaIntegrationService pause", () => {
  it("pauses only this company's active Sulekha URL", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-27T10:00:00Z") });
    mocks.access.mockResolvedValue(OWNER);
    const query = chain({ data: [{ id: "sul-1" }], error: null });
    mocks.from.mockReturnValue(query);
    await expect(new SulekhaIntegrationService().setPaused(true)).resolves.toEqual({ paused: true });
    expect(mocks.from).toHaveBeenCalledWith("sulekha_integrations");
    expect(query.update).toHaveBeenCalledWith({ paused_at: "2026-11-27T10:00:00.000Z" });
    expect(query.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
    expect(query.eq).toHaveBeenCalledWith("is_active", true);
    expect(query.select).toHaveBeenCalledWith("id");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("resumes by clearing paused_at", async () => {
    mocks.access.mockResolvedValue(OWNER);
    const query = chain({ data: [{ id: "sul-1" }], error: null });
    mocks.from.mockReturnValue(query);
    await expect(new SulekhaIntegrationService().setPaused(false)).resolves.toEqual({ paused: false });
    expect(query.update).toHaveBeenCalledWith({ paused_at: null });
    expect(query.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
    expect(query.eq).toHaveBeenCalledWith("is_active", true);
  });

  it("refuses an employee before touching the database", async () => {
    mocks.access.mockResolvedValue(EMPLOYEE);
    await expect(new SulekhaIntegrationService().setPaused(true)).rejects.toMatchObject({ status: 403, code: "SULEKHA_OWNER_REQUIRED" });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("says to generate the URL first when the company has none", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.from.mockReturnValue(chain({ data: [], error: null }));
    await expect(new SulekhaIntegrationService().setPaused(true)).rejects.toMatchObject({ status: 404, code: "SULEKHA_INTEGRATION_NOT_FOUND", message: "Generate the webhook URL first." });
  });

  it("fails cleanly when the database fails", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.from.mockReturnValue(chain({ data: null, error: { message: "down" } }));
    await expect(new SulekhaIntegrationService().setPaused(true)).rejects.toMatchObject({ status: 500, code: "SULEKHA_PAUSE_FAILED", message: "Sulekha leads could not be paused. Try again." });
    await expect(new SulekhaIntegrationService().setPaused(false)).rejects.toMatchObject({ status: 500, code: "SULEKHA_PAUSE_FAILED", message: "Sulekha leads could not be resumed. Try again." });
  });
});

describe("sulekhaFailureReason", () => {
  it("maps every stored message to a short label, anything else to Not saved", () => {
    expect(sulekhaFailureReason(SULEKHA_PAYLOAD_MESSAGES.noContact)).toBe("Mobile number or email not found");
    for (const message of [SULEKHA_PAYLOAD_MESSAGES.unsupportedType, SULEKHA_PAYLOAD_MESSAGES.notJsonObject, SULEKHA_PAYLOAD_MESSAGES.oneLeadPerRequest, SULEKHA_PAYLOAD_MESSAGES.tooManyFields, SULEKHA_PAYLOAD_MESSAGES.fieldNameTooLong]) {
      expect(sulekhaFailureReason(message)).toBe("Unsupported format");
    }
    expect(sulekhaFailureReason(SULEKHA_LOG_MESSAGES.serverError)).toBe("Server error");
    expect(sulekhaFailureReason(SULEKHA_LOG_MESSAGES.urlReplaced)).toBe("Old webhook URL");
    expect(sulekhaFailureReason(null)).toBe("Not saved");
    expect(sulekhaFailureReason("something new")).toBe("Not saved");
  });
});
