import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ deleteLeads: vi.fn(), resolveTenantRequestContext: vi.fn() }));
vi.mock("@/lib/server/lead-query-service", () => ({ deleteLeads: mocks.deleteLeads }));
vi.mock("@/lib/server/tenant-context", () => ({ resolveTenantRequestContext: mocks.resolveTenantRequestContext }));

const { POST } = await import("@/app/api/leads/bulk-delete/route");

const ID = "11111111-1111-4111-8111-111111111111";
const post = (body: unknown) => POST(new Request("http://localhost/api/leads/bulk-delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolveTenantRequestContext.mockResolvedValue({ tenantId: "tenant-a", userId: "user-a" });
  mocks.deleteLeads.mockResolvedValue({ deletedIds: [ID] });
});

describe("POST /api/leads/bulk-delete", () => {
  it("deletes the selection for the signed-in tenant with one access check", async () => {
    const response = await post({ ids: [ID] });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ deletedIds: [ID] });
    expect(mocks.resolveTenantRequestContext).toHaveBeenCalledTimes(1);
    expect(mocks.deleteLeads).toHaveBeenCalledWith({ tenantId: "tenant-a", userId: "user-a" }, [ID]);
  });

  it("refuses an empty selection, a non-UUID id, more than 100 ids and extra fields, before any access check", async () => {
    for (const body of [{ ids: [] }, { ids: ["lead-1"] }, { ids: Array.from({ length: 101 }, () => ID) }, { ids: [ID], tenantId: "tenant-b" }]) {
      const response = await post(body);
      expect(response.status).toBe(400);
    }
    expect(mocks.resolveTenantRequestContext).not.toHaveBeenCalled();
    expect(mocks.deleteLeads).not.toHaveBeenCalled();
  });
});
