// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ access: vi.fn(), from: vi.fn() }));
vi.mock("@/lib/server/auth/access", () => ({ requireCrmAccess: mocks.access }));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => ({ from: mocks.from }) }));
vi.mock("@/lib/server/token-crypto", () => ({ encryptToken: (value: string) => `enc:${value}`, decryptToken: (value: string) => { if (value === "unreadable") throw new Error("bad key"); return value.replace(/^enc:/, ""); } }));

import { hashPortalWebhookToken } from "@/lib/server/portal-leads/portal-lead-intake-service";
import { PortalIntegrationService } from "@/lib/server/portal-leads/portal-integration-service";

const ORIGIN = "https://crm.example.com";
const OWNER = { tenantId: "tenant-a", userId: "owner-a", membershipRole: "owner" };
const EMPLOYEE = { tenantId: "tenant-a", userId: "employee-a", membershipRole: "employee" };
const TOKEN = "T".repeat(43);

/** A query chain: every builder call returns the chain; maybeSingle(), single() and await resolve to `result`. */
function chain(result: { data?: unknown; error: unknown }) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ["select", "eq", "insert", "update", "order", "limit"]) query[method] = vi.fn(() => query);
  query.maybeSingle = vi.fn(() => Promise.resolve(result));
  return Object.assign(query, { then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve) });
}

const row = (extra: Record<string, unknown> = {}) => ({ id: "integration-1", encrypted_url_token: `enc:${TOKEN}`, is_active: true, last_received_at: null, url_rotated_at: null, ...extra });
const FAILED = { id: "log-1", created_at: "2026-11-17T10:00:00Z", error_message: "Send mobile or email." };

beforeEach(() => vi.resetAllMocks());

describe("PortalIntegrationService.listStatuses", () => {
  it("lists every portal with whether this company set it up, in one read and without a URL", async () => {
    mocks.access.mockResolvedValue(EMPLOYEE);
    const query = chain({ data: [{ portal_name: "99acres" }], error: null });
    mocks.from.mockReturnValue(query);
    await expect(new PortalIntegrationService().listStatuses()).resolves.toEqual({ portals: [{ portal: "99acres", hasIntegration: true }] });
    expect(query.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
    expect(query.select).toHaveBeenCalledWith("portal_name");
    mocks.from.mockReturnValue(chain({ data: [], error: null }));
    await expect(new PortalIntegrationService().listStatuses()).resolves.toEqual({ portals: [{ portal: "99acres", hasIntegration: false }] });
  });

  it("fails with 500 when it cannot read (the sources hook then keeps 99acres shown)", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.from.mockReturnValue(chain({ data: null, error: { message: "down" } }));
    await expect(new PortalIntegrationService().listStatuses()).rejects.toMatchObject({ status: 500 });
  });
});

describe("PortalIntegrationService.getOverview", () => {
  it("gives the owner the URL, the last lead time and the last 10 failed requests only when the card asks (details)", async () => {
    mocks.access.mockResolvedValue(OWNER);
    const failed = chain({ data: [FAILED], error: null });
    mocks.from.mockImplementation((table: string) => table === "portal_integrations" ? chain({ data: row({ last_received_at: "2026-11-17T09:00:00Z" }), error: null }) : failed);
    const service = new PortalIntegrationService();
    await expect(service.getOverview("99acres", ORIGIN, { details: true })).resolves.toEqual({
      portal: "99acres", canManage: true, hasIntegration: true,
      integration: {
        url: `${ORIGIN}/api/webhooks/leads/99acres/${TOKEN}`, lastLeadAt: "2026-11-17T09:00:00Z",
        failedRequests: [{ id: "log-1", createdAt: "2026-11-17T10:00:00Z", errorMessage: "Send mobile or email." }],
      },
    });
    expect(failed.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
    expect(failed.eq).toHaveBeenCalledWith("integration_id", "integration-1");
    expect(failed.eq).toHaveBeenCalledWith("status", "failed");
    expect(failed.limit).toHaveBeenCalledWith(10);
    await expect(service.getOverview("99acres", ORIGIN)).resolves.toEqual({ portal: "99acres", canManage: true, hasIntegration: true, integration: null });
  });

  it("reads only the time and reason of a failed request: the raw body, URL parameters and headers never reach the browser", async () => {
    mocks.access.mockResolvedValue(OWNER);
    const failed = chain({ data: [{ ...FAILED, error_message: null }], error: null });
    mocks.from.mockImplementation((table: string) => table === "portal_integrations" ? chain({ data: row(), error: null }) : failed);
    const overview = await new PortalIntegrationService().getOverview("99acres", ORIGIN, { details: true });
    expect(failed.select).toHaveBeenCalledWith("id,created_at,error_message");
    expect(overview.integration?.failedRequests).toEqual([{ id: "log-1", createdAt: "2026-11-17T10:00:00Z", errorMessage: "The request could not be saved." }]);
  });

  it("never gives an employee the URL or the raw requests", async () => {
    mocks.access.mockResolvedValue(EMPLOYEE);
    mocks.from.mockReturnValue(chain({ data: row(), error: null }));
    await expect(new PortalIntegrationService().getOverview("99acres", ORIGIN, { details: true })).resolves.toEqual({ portal: "99acres", canManage: false, hasIntegration: true, integration: null });
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });

  it("counts only a lead received after the URL was last regenerated", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.from.mockImplementation((table: string) => table === "portal_integrations"
      ? chain({ data: row({ last_received_at: "2026-11-17T09:00:00Z", url_rotated_at: "2026-11-17T09:30:00Z" }), error: null })
      : chain({ data: [], error: null }));
    const overview = await new PortalIntegrationService().getOverview("99acres", ORIGIN, { details: true });
    expect(overview.integration?.lastLeadAt).toBeNull();
  });

  it("still loads the card, with no URL, when the stored copy cannot be decrypted (the card then offers Regenerate)", async () => {
    mocks.access.mockResolvedValue(OWNER);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.from.mockImplementation((table: string) => table === "portal_integrations" ? chain({ data: row({ encrypted_url_token: "unreadable" }), error: null }) : chain({ data: [], error: null }));
    const overview = await new PortalIntegrationService().getOverview("99acres", ORIGIN, { details: true });
    expect(overview.integration).toMatchObject({ url: null, failedRequests: [] });
  });

  it("reports no integration as not set up", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.from.mockReturnValue(chain({ data: null, error: null }));
    await expect(new PortalIntegrationService().getOverview("99acres", ORIGIN, { details: true })).resolves.toEqual({ portal: "99acres", canManage: true, hasIntegration: false, integration: null });
  });
});

describe("PortalIntegrationService.createOrReplace", () => {
  it("refuses an employee", async () => {
    mocks.access.mockResolvedValue(EMPLOYEE);
    await expect(new PortalIntegrationService().createOrReplace("99acres", ORIGIN)).rejects.toMatchObject({ status: 403, code: "PORTAL_OWNER_REQUIRED" });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("creates the company's URL, storing only the token's hash and an encrypted copy", async () => {
    mocks.access.mockResolvedValue(OWNER);
    const read = chain({ data: null, error: null });
    const insert = chain({ error: null });
    mocks.from.mockReturnValueOnce(read).mockReturnValueOnce(insert);
    const { url } = await new PortalIntegrationService().createOrReplace("99acres", ORIGIN);
    const token = url.split("/").at(-1) ?? "";
    expect(url).toMatch(new RegExp(`^${ORIGIN}/api/webhooks/leads/99acres/[A-Za-z0-9_-]{43}$`));
    expect(insert.insert).toHaveBeenCalledWith({ tenant_id: "tenant-a", portal_name: "99acres", url_token_hash: hashPortalWebhookToken(token), encrypted_url_token: `enc:${token}`, is_active: true });
  });

  it("replaces the token in place (the old URL then answers 404) and records when", async () => {
    mocks.access.mockResolvedValue(OWNER);
    const update = chain({ error: null });
    mocks.from.mockReturnValueOnce(chain({ data: { id: "integration-1" }, error: null })).mockReturnValueOnce(update);
    const { url } = await new PortalIntegrationService().createOrReplace("99acres", ORIGIN);
    expect(update.update).toHaveBeenCalledWith(expect.objectContaining({ url_token_hash: hashPortalWebhookToken(url.split("/").at(-1) ?? ""), is_active: true, url_rotated_at: expect.any(String) }));
    expect(update.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
    expect(update.eq).toHaveBeenCalledWith("portal_name", "99acres");
  });

  it("replaces instead when another request created it at the same moment", async () => {
    mocks.access.mockResolvedValue(OWNER);
    const update = chain({ error: null });
    mocks.from.mockReturnValueOnce(chain({ data: null, error: null })).mockReturnValueOnce(chain({ error: { code: "23505" } })).mockReturnValueOnce(update);
    await new PortalIntegrationService().createOrReplace("99acres", ORIGIN);
    expect(update.update).toHaveBeenCalled();
  });

  it("fails with 500 on any other save error", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.from.mockReturnValueOnce(chain({ data: null, error: null })).mockReturnValueOnce(chain({ error: { code: "XX000" } }));
    await expect(new PortalIntegrationService().createOrReplace("99acres", ORIGIN)).rejects.toMatchObject({ status: 500, code: "PORTAL_SAVE_FAILED" });
  });
});
