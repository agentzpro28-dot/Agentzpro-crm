// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ access: vi.fn(), from: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/server/auth/access", () => ({ requireCrmAccess: mocks.access }));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => ({ from: mocks.from, rpc: mocks.rpc }) }));
vi.mock("@/lib/server/token-crypto", () => ({ encryptToken: (value: string) => `enc:${value}`, decryptToken: (value: string) => { if (value === "unreadable") throw new Error("bad key"); return value.replace(/^enc:/, ""); } }));

import { HOUSING_LOG_MESSAGES, hashHousingWebhookToken } from "@/lib/server/housing/housing-lead-intake-service";
import { HousingIntegrationService, housingFailureReason } from "@/lib/server/housing/housing-integration-service";
import { HOUSING_PAYLOAD_MESSAGES } from "@/lib/server/housing/housing-lead-mapper";

const ORIGIN = "https://crm.example.com";
const OWNER = { tenantId: "tenant-a", userId: "owner-a", membershipRole: "owner" };
const EMPLOYEE = { tenantId: "tenant-a", userId: "employee-a", membershipRole: "employee" };
const TOKEN = "T".repeat(43);

/** A query chain: every builder call returns the chain; maybeSingle() and await resolve to `result`. */
function chain(result: { data?: unknown; error: unknown }) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "eq", "lt", "order", "limit"]) query[method] = vi.fn(() => query);
  query.maybeSingle = vi.fn(() => Promise.resolve(result));
  return Object.assign(query, { then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve) });
}

const row = (extra: Record<string, unknown> = {}) => ({ id: "hs-1", encrypted_url_token: `enc:${TOKEN}`, is_active: true, last_received_at: null, previous_valid_until: null, previous_last_received_at: null, ...extra });

function overviewTables(integration: unknown, failedResult: { data?: unknown; error: unknown } = { data: [], error: null }, stuckResult: { data?: unknown; error: unknown } = { data: [], error: null }) {
  const integrationRead = chain({ data: integration, error: null });
  const logReads = [chain(failedResult), chain(stuckResult)];
  mocks.from.mockImplementation((table: string) => {
    if (table === "housing_integrations") return integrationRead;
    if (table === "housing_webhook_logs") return logReads.shift();
    throw new Error(`unexpected table ${table}`);
  });
  return { integrationRead };
}

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());

describe("HousingIntegrationService.getOverview", () => {
  it("without details: one read of this company's row, never a URL (the /leads and dashboard check)", async () => {
    mocks.access.mockResolvedValue(OWNER);
    const { integrationRead } = overviewTables(row());
    await expect(new HousingIntegrationService().getOverview(ORIGIN)).resolves.toEqual({ canManage: true, hasIntegration: true, integration: null });
    expect(integrationRead.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });

  it("says Not set up when the company has no Housing.com URL", async () => {
    mocks.access.mockResolvedValue(OWNER);
    overviewTables(null);
    await expect(new HousingIntegrationService().getOverview(ORIGIN, { details: true })).resolves.toEqual({ canManage: true, hasIntegration: false, integration: null });
  });

  it("never gives an employee the URL", async () => {
    mocks.access.mockResolvedValue(EMPLOYEE);
    overviewTables(row());
    await expect(new HousingIntegrationService().getOverview(ORIGIN, { details: true })).resolves.toEqual({ canManage: false, hasIntegration: true, integration: null });
  });

  it("gives the owner the URL, the last lead time and the failed requests (stuck ones too) with short labels", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-20T12:00:00Z") });
    mocks.access.mockResolvedValue(OWNER);
    overviewTables(
      row({ last_received_at: "2026-11-20T11:00:00Z" }),
      { data: [{ id: "log-2", created_at: "2026-11-20T10:00:00Z", error_message: HOUSING_PAYLOAD_MESSAGES.noContact }], error: null },
      { data: [{ id: "log-1", created_at: "2026-11-20T09:00:00Z", error_message: null }], error: null },
    );
    const overview = await new HousingIntegrationService().getOverview(ORIGIN, { details: true });
    expect(overview.integration).toEqual({
      url: `${ORIGIN}/api/webhooks/housing/${TOKEN}`,
      lastLeadAt: "2026-11-20T11:00:00Z",
      previousUrl: null,
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
    const overview = await new HousingIntegrationService().getOverview(ORIGIN, { details: true });
    expect(overview.integration?.previousUrl).toEqual({ validUntil: "2026-11-27T12:00:00Z", lastLeadAt: "2026-11-20T11:30:00Z" });
    // A lead on the old URL never makes the new URL look Connected.
    expect(overview.integration?.lastLeadAt).toBeNull();
  });

  it("hides the old URL once its 7 days are over", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-28T12:00:00Z") });
    mocks.access.mockResolvedValue(OWNER);
    overviewTables(row({ previous_valid_until: "2026-11-27T12:00:00Z" }));
    expect((await new HousingIntegrationService().getOverview(ORIGIN, { details: true })).integration?.previousUrl).toBeNull();
  });

  it("still loads with url null when the stored copy cannot be decrypted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.access.mockResolvedValue(OWNER);
    overviewTables(row({ encrypted_url_token: "unreadable" }));
    expect((await new HousingIntegrationService().getOverview(ORIGIN, { details: true })).integration?.url).toBeNull();
  });

  it("fails cleanly when a log read fails", async () => {
    mocks.access.mockResolvedValue(OWNER);
    overviewTables(row(), { data: null, error: { message: "down" } });
    await expect(new HousingIntegrationService().getOverview(ORIGIN, { details: true })).rejects.toMatchObject({ status: 500, code: "HOUSING_OVERVIEW_FAILED" });
  });
});

describe("HousingIntegrationService.createOrReplace", () => {
  it("saves only the hash and the encrypted copy through save_housing_url, and returns the new URL", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.rpc.mockResolvedValue({ data: { replaced: false, previous_valid_until: null }, error: null });
    const { url } = await new HousingIntegrationService().createOrReplace(ORIGIN);
    const token = url.split("/").at(-1) ?? "";
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mocks.rpc).toHaveBeenCalledWith("save_housing_url", { p_tenant_id: "tenant-a", p_token_hash: hashHousingWebhookToken(token), p_encrypted_token: `enc:${token}` });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("refuses an employee", async () => {
    mocks.access.mockResolvedValue(EMPLOYEE);
    await expect(new HousingIntegrationService().createOrReplace(ORIGIN)).rejects.toMatchObject({ status: 403, code: "HOUSING_OWNER_REQUIRED" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("fails cleanly when the save fails", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "down" } });
    await expect(new HousingIntegrationService().createOrReplace(ORIGIN)).rejects.toMatchObject({ status: 500, code: "HOUSING_SAVE_FAILED" });
  });
});

describe("housingFailureReason", () => {
  it("maps every stored message to a short label, anything else to Not saved", () => {
    expect(housingFailureReason(HOUSING_PAYLOAD_MESSAGES.noContact)).toBe("Mobile number or email not found");
    for (const message of [HOUSING_PAYLOAD_MESSAGES.unsupportedType, HOUSING_PAYLOAD_MESSAGES.notJsonObject, HOUSING_PAYLOAD_MESSAGES.oneLeadPerRequest, HOUSING_PAYLOAD_MESSAGES.tooManyFields, HOUSING_PAYLOAD_MESSAGES.fieldNameTooLong]) {
      expect(housingFailureReason(message)).toBe("Unsupported format");
    }
    expect(housingFailureReason(HOUSING_LOG_MESSAGES.serverError)).toBe("Server error");
    expect(housingFailureReason(HOUSING_LOG_MESSAGES.urlReplaced)).toBe("Old webhook URL");
    expect(housingFailureReason(null)).toBe("Not saved");
    expect(housingFailureReason("something new")).toBe("Not saved");
  });
});
