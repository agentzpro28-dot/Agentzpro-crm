// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ access: vi.fn(), from: vi.fn(), ingest: vi.fn(), find: vi.fn() }));
vi.mock("@/lib/server/auth/access", () => ({ requireCrmAccess: mocks.access }));
vi.mock("@/lib/server/supabase-admin", () => ({ getSupabaseAdminClient: () => ({ from: mocks.from }) }));
vi.mock("@/lib/server/token-crypto", () => ({ encryptToken: (value: string) => `enc:${value}`, decryptToken: (value: string) => { if (value === "unreadable") throw new Error("bad key"); return value.replace(/^enc:/, ""); } }));
vi.mock("@/lib/server/portal-leads/portal-lead-intake-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/portal-leads/portal-lead-intake-service")>()),
  PortalLeadIntakeService: class { ingestForIntegration = mocks.ingest; },
  findPortalIntegrationForTenant: mocks.find,
}));

import { hashPortalWebhookToken } from "@/lib/server/portal-leads/portal-lead-intake-service";
import { PortalIntegrationService, testLeadPayload } from "@/lib/server/portal-leads/portal-integration-service";

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
const LOG = { id: "log-1", created_at: "2026-11-17T10:00:00Z", http_method: "POST", status: "processed", error_message: null, is_test: false, headers: { "content-type": "application/json" }, query_params: {}, raw_body: "{\"name\":\"Ravi\"}" };

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
  it("gives the owner the URL, the last lead time and the last requests only when the card asks (details)", async () => {
    mocks.access.mockResolvedValue(OWNER);
    const logs = chain({ data: [LOG], error: null });
    mocks.from.mockImplementation((table: string) => table === "portal_integrations" ? chain({ data: row({ last_received_at: "2026-11-17T09:00:00Z" }), error: null }) : logs);
    const service = new PortalIntegrationService();
    await expect(service.getOverview("99acres", ORIGIN, { details: true })).resolves.toEqual({
      portal: "99acres", canManage: true, hasIntegration: true,
      integration: {
        url: `${ORIGIN}/api/webhooks/leads/99acres/${TOKEN}`, lastLeadAt: "2026-11-17T09:00:00Z",
        logs: [{ id: "log-1", createdAt: "2026-11-17T10:00:00Z", method: "POST", status: "processed", errorMessage: null, isTest: false, headers: { "content-type": "application/json" }, queryParams: {}, rawBody: "{\"name\":\"Ravi\"}", bodyCut: false }],
      },
    });
    expect(logs.eq).toHaveBeenCalledWith("tenant_id", "tenant-a");
    expect(logs.eq).toHaveBeenCalledWith("integration_id", "integration-1");
    expect(logs.limit).toHaveBeenCalledWith(10);
    await expect(service.getOverview("99acres", ORIGIN)).resolves.toEqual({ portal: "99acres", canManage: true, hasIntegration: true, integration: null });
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

  it("cuts a very long body for the card and says so", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.from.mockImplementation((table: string) => table === "portal_integrations" ? chain({ data: row(), error: null }) : chain({ data: [{ ...LOG, raw_body: "x".repeat(25_000) }], error: null }));
    const overview = await new PortalIntegrationService().getOverview("99acres", ORIGIN, { details: true });
    expect(overview.integration?.logs[0]).toMatchObject({ bodyCut: true });
    expect(overview.integration?.logs[0].rawBody).toHaveLength(20_000);
  });

  it("still loads the card, with no URL, when the stored copy cannot be decrypted (the card then offers Regenerate)", async () => {
    mocks.access.mockResolvedValue(OWNER);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.from.mockImplementation((table: string) => table === "portal_integrations" ? chain({ data: row({ encrypted_url_token: "unreadable" }), error: null }) : chain({ data: [], error: null }));
    const overview = await new PortalIntegrationService().getOverview("99acres", ORIGIN, { details: true });
    expect(overview.integration).toMatchObject({ url: null, logs: [] });
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

describe("PortalIntegrationService.sendTestLead", () => {
  const INTEGRATION = { id: "integration-1", tenant_id: "tenant-a", portal_name: "99acres", is_active: true, field_mapping: {} };

  it("sends a 99acres-style sample through the real intake as a test, for the owner's own company", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.find.mockResolvedValue(INTEGRATION);
    mocks.ingest.mockResolvedValue({ status: 200, message: "Lead received", duplicate: false, outcome: "stored", leadId: "lead-9" });
    await expect(new PortalIntegrationService().sendTestLead("99acres")).resolves.toEqual({ outcome: "stored", leadId: "lead-9" });
    expect(mocks.find).toHaveBeenCalledWith("tenant-a", "99acres");
    const [integration, request, options] = mocks.ingest.mock.calls[0];
    expect(integration).toBe(INTEGRATION);
    expect(options).toEqual({ isTest: true });
    expect(request.method).toBe("POST");
    expect(JSON.parse(request.rawBody)).toMatchObject({ cust_name: "Test Lead (99acres)", contact_no: "9000000000" });
  });

  it("asks to generate the URL first when there is none", async () => {
    mocks.access.mockResolvedValue(OWNER);
    mocks.find.mockResolvedValue(null);
    await expect(new PortalIntegrationService().sendTestLead("99acres")).rejects.toMatchObject({ status: 409, code: "PORTAL_NOT_SET_UP" });
  });

  it("refuses an employee and reports a failed save", async () => {
    mocks.access.mockResolvedValue(EMPLOYEE);
    await expect(new PortalIntegrationService().sendTestLead("99acres")).rejects.toMatchObject({ status: 403 });
    mocks.access.mockResolvedValue(OWNER);
    mocks.find.mockResolvedValue(INTEGRATION);
    mocks.ingest.mockResolvedValue({ status: 500, message: "Temporary failure, retry later." });
    await expect(new PortalIntegrationService().sendTestLead("99acres")).rejects.toMatchObject({ status: 500, code: "PORTAL_TEST_FAILED" });
  });

  it("gives every test lead a new 99acres lead id", () => {
    expect(testLeadPayload("99acres").lead_id).toMatch(/^test-\d+$/);
  });
});
