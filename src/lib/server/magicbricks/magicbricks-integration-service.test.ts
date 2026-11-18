// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ access: vi.fn(), from: vi.fn() }));
vi.mock("@/lib/server/auth/access", () => ({ requireCrmAccess: mocks.access }));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => ({ from: mocks.from }) }));
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

const row = (extra: Record<string, unknown> = {}) => ({ id: "mb-1", encrypted_url_token: `enc:${TOKEN}`, is_active: true, last_received_at: null, url_rotated_at: null, ...extra });

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
    await expect(new MagicbricksIntegrationService().getOverview(ORIGIN)).resolves.toEqual({ canManage: true, hasIntegration: true, integration: null });
    expect(integrationRead.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });

  it("says Not set up when the company has no MagicBricks URL", async () => {
    mocks.access.mockResolvedValue(OWNER);
    overviewTables(null);
    await expect(new MagicbricksIntegrationService().getOverview(ORIGIN, { details: true })).resolves.toEqual({ canManage: true, hasIntegration: false, integration: null });
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
      canManage: true, hasIntegration: true,
      integration: {
        url: `${ORIGIN}/api/webhooks/magicbricks/${TOKEN}`,
        lastLeadAt: "2026-11-18T11:00:00Z",
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

  it("never gives an employee the URL or the failed requests", async () => {
    mocks.access.mockResolvedValue(EMPLOYEE);
    overviewTables(row());
    await expect(new MagicbricksIntegrationService().getOverview(ORIGIN, { details: true })).resolves.toEqual({ canManage: false, hasIntegration: true, integration: null });
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
  });

  it("creates the company's first URL, storing only the token's hash and an encrypted copy", async () => {
    mocks.access.mockResolvedValue(OWNER);
    const read = chain({ data: null, error: null });
    const insert = chain({ error: null });
    const calls = [read, insert];
    mocks.from.mockImplementation(() => calls.shift());
    const { url } = await new MagicbricksIntegrationService().createOrReplace(ORIGIN);
    const token = url.split("/").pop() as string;
    expect(url).toMatch(/^https:\/\/crm\.example\.com\/api\/webhooks\/magicbricks\/[A-Za-z0-9_-]{43}$/);
    expect(insert.insert).toHaveBeenCalledWith({ tenant_id: "tenant-a", url_token_hash: hashMagicbricksWebhookToken(token), encrypted_url_token: `enc:${token}`, is_active: true });
  });

  it("replaces an existing URL in place and records when", async () => {
    mocks.access.mockResolvedValue(OWNER);
    const read = chain({ data: { id: "mb-1" }, error: null });
    const update = chain({ error: null });
    const calls = [read, update];
    mocks.from.mockImplementation(() => calls.shift());
    await new MagicbricksIntegrationService().createOrReplace(ORIGIN);
    expect(update.update).toHaveBeenCalledWith(expect.objectContaining({ is_active: true, url_rotated_at: expect.any(String) }));
    expect(update.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
  });

  it("replaces instead when another request created the URL at the same moment", async () => {
    mocks.access.mockResolvedValue(OWNER);
    const calls = [chain({ data: null, error: null }), chain({ error: { code: "23505" } }), chain({ error: null })];
    mocks.from.mockImplementation(() => calls.shift());
    await expect(new MagicbricksIntegrationService().createOrReplace(ORIGIN)).resolves.toMatchObject({ url: expect.stringContaining("/api/webhooks/magicbricks/") });
  });

  it("fails clearly when the save fails", async () => {
    mocks.access.mockResolvedValue(OWNER);
    const calls = [chain({ data: null, error: null }), chain({ error: { code: "XX000" } })];
    mocks.from.mockImplementation(() => calls.shift());
    await expect(new MagicbricksIntegrationService().createOrReplace(ORIGIN)).rejects.toMatchObject({ status: 500, code: "MAGICBRICKS_SAVE_FAILED" });
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
