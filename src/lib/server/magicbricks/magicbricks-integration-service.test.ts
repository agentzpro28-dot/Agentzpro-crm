// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ access: vi.fn(), from: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/server/auth/access", () => ({ requireCrmAccess: mocks.access }));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => ({ from: mocks.from, rpc: mocks.rpc }) }));
vi.mock("@/lib/server/token-crypto", () => ({ encryptToken: (value: string) => `enc:${value}`, decryptToken: (value: string) => { if (value === "unreadable") throw new Error("bad key"); return value.replace(/^enc:/, ""); } }));

import { MAGICBRICKS_LOG_MESSAGES, hashMagicbricksWebhookToken } from "@/lib/server/magicbricks/magicbricks-lead-intake-service";
import { MagicbricksIntegrationService, magicbricksFailureReason } from "@/lib/server/magicbricks/magicbricks-integration-service";
import { MAGICBRICKS_PAYLOAD_MESSAGES } from "@/lib/server/magicbricks/magicbricks-lead-mapper";

const ORIGIN = "https://crm.example.com";
const OWNER = { tenantId: "tenant-a", userId: "owner-a", membershipRole: "owner" };
const EMPLOYEE = { tenantId: "tenant-a", userId: "employee-a", membershipRole: "employee" };
const TOKEN = "T".repeat(43);

/** A query chain: every builder call returns the chain; maybeSingle() and await resolve to `result`. */
function chain(result: { data?: unknown; error: unknown }) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "eq", "lt", "insert", "update", "order", "limit"]) query[method] = vi.fn(() => query);
  query.maybeSingle = vi.fn(() => Promise.resolve(result));
  return Object.assign(query, { then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve) });
}

const row = (extra: Record<string, unknown> = {}) => ({
  id: "mb-1", encrypted_url_token: `enc:${TOKEN}`, is_active: true, last_received_at: null, url_rotated_at: null,
  previous_valid_until: null, previous_last_received_at: null, paused_at: null, ...extra,
});

function overviewTables(integration: unknown, failedResult: { data?: unknown; error: unknown } = { data: [], error: null }, stuckResult: { data?: unknown; error: unknown } = { data: [], error: null }) {
  const integrationRead = chain({ data: integration, error: null });
  const failed = chain(failedResult);
  const stuck = chain(stuckResult);
  const logReads = [failed, stuck];
  mocks.from.mockImplementation((table: string) => {
    if (table === "magicbricks_integrations") return integrationRead;
    if (table === "magicbricks_webhook_logs") return logReads.shift();
    throw new Error(`unexpected table ${table}`);
  });
  return { integrationRead, failed, stuck };
}

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());

describe("MagicbricksIntegrationService.getOverview", () => {
  it("without details: one read of this company's row, never a URL (the /leads and dashboard check)", async () => {
    mocks.access.mockResolvedValue(OWNER);
    const { integrationRead } = overviewTables(row());
    await expect(new MagicbricksIntegrationService().getOverview(ORIGIN)).resolves.toEqual({ canManage: true, hasIntegration: true, disconnected: false, integration: null });
    expect(integrationRead.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });

  it("says Not set up when the company has no MagicBricks URL", async () => {
    mocks.access.mockResolvedValue(OWNER);
    overviewTables(null);
    await expect(new MagicbricksIntegrationService().getOverview(ORIGIN, { details: true })).resolves.toEqual({ canManage: true, hasIntegration: false, disconnected: false, integration: null });
  });

  it("gives the owner the URL, the last lead time and the failed requests with short labels", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-18T12:00:00Z") });
    mocks.access.mockResolvedValue(OWNER);
    const { failed, stuck } = overviewTables(
      row({ last_received_at: "2026-11-18T11:00:00Z" }),
      { data: [{ id: "log-2", created_at: "2026-11-18T10:00:00Z", error_message: MAGICBRICKS_PAYLOAD_MESSAGES.noContact }, { id: "log-3", created_at: "2026-11-18T09:00:00Z", error_message: MAGICBRICKS_LOG_MESSAGES.serverError }], error: null },
      { data: [{ id: "log-4", created_at: "2026-11-18T11:30:00Z", error_message: null }], error: null },
    );
    await expect(new MagicbricksIntegrationService().getOverview(ORIGIN, { details: true })).resolves.toEqual({
      canManage: true, hasIntegration: true, disconnected: false,
      integration: {
        url: `${ORIGIN}/api/webhooks/magicbricks/${TOKEN}`,
        lastLeadAt: "2026-11-18T11:00:00Z",
        previousUrl: null,
        paused: false,
        failedRequests: [
          { id: "log-4", createdAt: "2026-11-18T11:30:00Z", reason: "Not saved" },
          { id: "log-2", createdAt: "2026-11-18T10:00:00Z", reason: "Mobile number or email not found" },
          { id: "log-3", createdAt: "2026-11-18T09:00:00Z", reason: "Server error" },
        ],
      },
    });
    expect(failed.select).toHaveBeenCalledWith("id,created_at,error_message");
    expect(failed.eq).toHaveBeenCalledWith("integration_id", "mb-1");
    expect(failed.eq).toHaveBeenCalledWith("status", "failed");
    expect(stuck.eq).toHaveBeenCalledWith("status", "received");
    expect(stuck.lt).toHaveBeenCalledWith("created_at", "2026-11-18T11:50:00.000Z");
  });

  it("reads the old-URL columns, and shows the old URL only while it still works", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-21T06:00:00Z") });
    mocks.access.mockResolvedValue(OWNER);
    const { integrationRead } = overviewTables(row({ previous_valid_until: "2026-11-28T06:00:00Z", previous_last_received_at: "2026-11-21T05:00:00Z" }));
    const overview = await new MagicbricksIntegrationService().getOverview(ORIGIN, { details: true });
    expect(integrationRead.select).toHaveBeenCalledWith("id,encrypted_url_token,is_active,last_received_at,url_rotated_at,previous_valid_until,previous_last_received_at,paused_at");
    expect(overview.integration?.previousUrl).toEqual({ validUntil: "2026-11-28T06:00:00Z", lastLeadAt: "2026-11-21T05:00:00Z" });

    // Its 7 days are over: the database refuses it, so the card no longer mentions it.
    overviewTables(row({ previous_valid_until: "2026-11-21T05:59:59Z", previous_last_received_at: "2026-11-21T05:00:00Z" }));
    expect((await new MagicbricksIntegrationService().getOverview(ORIGIN, { details: true })).integration?.previousUrl).toBeNull();
  });

  it("never gives an employee the URL or the failed requests", async () => {
    mocks.access.mockResolvedValue(EMPLOYEE);
    overviewTables(row());
    await expect(new MagicbricksIntegrationService().getOverview(ORIGIN, { details: true })).resolves.toEqual({ canManage: false, hasIntegration: true, disconnected: false, integration: null });
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });

  it("ignores a lead time from before the URL was replaced", async () => {
    mocks.access.mockResolvedValue(OWNER);
    overviewTables(row({ last_received_at: "2026-11-18T09:00:00Z", url_rotated_at: "2026-11-18T10:00:00Z" }));
    await expect(new MagicbricksIntegrationService().getOverview(ORIGIN, { details: true })).resolves.toMatchObject({ integration: { lastLeadAt: null } });
  });

  it("still loads with url: null when the stored URL cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.access.mockResolvedValue(OWNER);
    overviewTables(row({ encrypted_url_token: "unreadable" }));
    await expect(new MagicbricksIntegrationService().getOverview(ORIGIN, { details: true })).resolves.toMatchObject({ integration: { url: null } });
  });

  it("fails clearly when a read fails", async () => {
    mocks.access.mockResolvedValue(OWNER);
    overviewTables(row(), { data: null, error: { message: "down" } });
    await expect(new MagicbricksIntegrationService().getOverview(ORIGIN, { details: true })).rejects.toMatchObject({ status: 500, code: "MAGICBRICKS_OVERVIEW_FAILED" });
  });
});

describe("MagicbricksIntegrationService.createOrReplace", () => {
  it("refuses anyone but the owner", async () => {
    mocks.access.mockResolvedValue(EMPLOYEE);
    await expect(new MagicbricksIntegrationService().createOrReplace(ORIGIN)).rejects.toMatchObject({ status: 403, code: "MAGICBRICKS_OWNER_REQUIRED" });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("creates or replaces the URL in one database call, storing only the token's hash and an encrypted copy", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.rpc.mockResolvedValue({ data: { replaced: false, previous_valid_until: null }, error: null });
    const { url } = await new MagicbricksIntegrationService().createOrReplace(ORIGIN);
    const token = url.split("/").pop() as string;
    expect(url).toMatch(/^https:\/\/crm\.example\.com\/api\/webhooks\/magicbricks\/[A-Za-z0-9_-]{43}$/);
    expect(mocks.rpc).toHaveBeenCalledWith("save_magicbricks_url", { p_tenant_id: "tenant-a", p_token_hash: hashMagicbricksWebhookToken(token), p_encrypted_token: `enc:${token}` });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("makes a new URL on every call (a regenerate: the old URL keeps working for 7 days in the database)", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.rpc.mockResolvedValue({ data: { replaced: true, previous_valid_until: "2026-11-28T06:00:00Z" }, error: null });
    const service = new MagicbricksIntegrationService();
    const first = await service.createOrReplace(ORIGIN);
    const second = await service.createOrReplace(ORIGIN);
    expect(first.url).not.toBe(second.url);
  });

  it("fails clearly when the save fails", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000" } });
    await expect(new MagicbricksIntegrationService().createOrReplace(ORIGIN)).rejects.toMatchObject({ status: 500, code: "MAGICBRICKS_SAVE_FAILED" });
  });
});

describe("MagicbricksIntegrationService pause", () => {
  it("reads paused_at and tells the owner's card whether MagicBricks is paused", async () => {
    mocks.access.mockResolvedValue(OWNER);
    const { integrationRead } = overviewTables(row({ paused_at: "2026-11-27T10:00:00Z" }));
    const overview = await new MagicbricksIntegrationService().getOverview(ORIGIN, { details: true });
    expect(overview.integration?.paused).toBe(true);
    expect(integrationRead.select).toHaveBeenCalledWith(expect.stringContaining("paused_at"));
  });

  it("pauses and resumes only this company's active MagicBricks URL", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-27T10:00:00Z") });
    mocks.access.mockResolvedValue(OWNER);
    const query = chain({ data: [{ id: "mb-1" }], error: null });
    mocks.from.mockReturnValue(query);
    const service = new MagicbricksIntegrationService();
    await expect(service.setPaused(true)).resolves.toEqual({ paused: true });
    expect(mocks.from).toHaveBeenCalledWith("magicbricks_integrations");
    expect(query.update).toHaveBeenLastCalledWith({ paused_at: "2026-11-27T10:00:00.000Z" });
    expect(query.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
    expect(query.eq).toHaveBeenCalledWith("is_active", true);
    expect(query.select).toHaveBeenCalledWith("id");
    await expect(service.setPaused(false)).resolves.toEqual({ paused: false });
    expect(query.update).toHaveBeenLastCalledWith({ paused_at: null });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("refuses anyone but the owner before touching the database", async () => {
    mocks.access.mockResolvedValue(EMPLOYEE);
    await expect(new MagicbricksIntegrationService().setPaused(true)).rejects.toMatchObject({ status: 403, code: "MAGICBRICKS_OWNER_REQUIRED" });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("says to generate the URL first when there is no active URL", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.from.mockReturnValue(chain({ data: [], error: null }));
    await expect(new MagicbricksIntegrationService().setPaused(true)).rejects.toMatchObject({ status: 404, code: "MAGICBRICKS_INTEGRATION_NOT_FOUND", message: "Generate the webhook URL first." });
  });

  it("fails clearly (500) when the database fails", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.from.mockReturnValue(chain({ data: null, error: { message: "down" } }));
    await expect(new MagicbricksIntegrationService().setPaused(true)).rejects.toMatchObject({ status: 500, code: "MAGICBRICKS_PAUSE_FAILED", message: "MagicBricks leads could not be paused. Try again." });
    await expect(new MagicbricksIntegrationService().setPaused(false)).rejects.toMatchObject({ status: 500, code: "MAGICBRICKS_PAUSE_FAILED", message: "MagicBricks leads could not be resumed. Try again." });
  });
});

describe("MagicbricksIntegrationService disconnect", () => {
  it("stops this company's MagicBricks URL and its old URL in one update, and clears the pause", async () => {
    mocks.access.mockResolvedValue(OWNER);
    const query = chain({ data: [{ id: "mb-1" }], error: null });
    mocks.from.mockReturnValue(query);
    await expect(new MagicbricksIntegrationService().disconnect()).resolves.toEqual({ disconnected: true });
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.from).toHaveBeenCalledWith("magicbricks_integrations");
    expect(query.update).toHaveBeenCalledTimes(1);
    expect(query.update).toHaveBeenCalledWith({ is_active: false, paused_at: null, previous_url_token_hash: null, previous_valid_until: null, previous_last_received_at: null });
    expect(query.eq).toHaveBeenCalledTimes(1);
    expect(query.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
    // Disconnecting twice (two tabs, a double click) is the same update again, never an error.
    expect(query.eq).not.toHaveBeenCalledWith("is_active", true);
    expect(query.select).toHaveBeenCalledWith("id");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("refuses an employee before touching the database", async () => {
    mocks.access.mockResolvedValue(EMPLOYEE);
    await expect(new MagicbricksIntegrationService().disconnect()).rejects.toMatchObject({ status: 403, code: "MAGICBRICKS_OWNER_REQUIRED" });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("says to generate the URL first when there is none, and 500 when the database fails", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.from.mockReturnValue(chain({ data: [], error: null }));
    await expect(new MagicbricksIntegrationService().disconnect()).rejects.toMatchObject({ status: 404, code: "MAGICBRICKS_INTEGRATION_NOT_FOUND", message: "Generate the webhook URL first." });
    mocks.from.mockReturnValue(chain({ data: null, error: { message: "down" } }));
    await expect(new MagicbricksIntegrationService().disconnect()).rejects.toMatchObject({ status: 500, code: "MAGICBRICKS_DISCONNECT_FAILED", message: "MagicBricks could not be disconnected. Try again." });
  });

  it("tells the owner and an employee that MagicBricks is disconnected, without the URL or the failed requests", async () => {
    mocks.access.mockResolvedValue(OWNER);
    overviewTables(row({ is_active: false }));
    await expect(new MagicbricksIntegrationService().getOverview(ORIGIN, { details: true })).resolves.toEqual({ canManage: true, hasIntegration: true, disconnected: true, integration: null });
    expect(mocks.from).toHaveBeenCalledTimes(1);
    mocks.access.mockResolvedValue(EMPLOYEE);
    overviewTables(row({ is_active: false }));
    await expect(new MagicbricksIntegrationService().getOverview(ORIGIN, { details: true })).resolves.toEqual({ canManage: false, hasIntegration: true, disconnected: true, integration: null });
  });

  it("keeps a disconnected MagicBricks in the Source filter (the status read counts the row, active or not)", async () => {
    mocks.access.mockResolvedValue(EMPLOYEE);
    const { integrationRead } = overviewTables(row({ is_active: false }));
    await expect(new MagicbricksIntegrationService().getOverview(ORIGIN)).resolves.toMatchObject({ hasIntegration: true });
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(integrationRead.eq).toHaveBeenCalledTimes(1);
    expect(integrationRead.eq).not.toHaveBeenCalledWith("is_active", expect.anything());
  });
});

describe("magicbricksFailureReason", () => {
  it.each([
    [MAGICBRICKS_PAYLOAD_MESSAGES.noContact, "Mobile number or email not found"],
    [MAGICBRICKS_PAYLOAD_MESSAGES.unsupportedType, "Unsupported format"],
    [MAGICBRICKS_PAYLOAD_MESSAGES.notJsonObject, "Unsupported format"],
    [MAGICBRICKS_PAYLOAD_MESSAGES.oneLeadPerRequest, "Unsupported format"],
    [MAGICBRICKS_PAYLOAD_MESSAGES.tooManyFields, "Unsupported format"],
    [MAGICBRICKS_PAYLOAD_MESSAGES.fieldNameTooLong, "Unsupported format"],
    [MAGICBRICKS_LOG_MESSAGES.unreadable, "Unsupported format"],
    [MAGICBRICKS_LOG_MESSAGES.serverError, "Server error"],
    [MAGICBRICKS_LOG_MESSAGES.urlReplaced, "Old webhook URL"],
    ["anything else", "Not saved"],
    [null, "Not saved"],
  ])("labels %s as %s", (message, label) => {
    expect(magicbricksFailureReason(message)).toBe(label);
  });
});
