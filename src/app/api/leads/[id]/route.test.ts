import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/server/app-error";

const mocks = vi.hoisted(() => ({
  getLeadFormAnswers: vi.fn(),
  updateLeadTriage: vi.fn(),
  updateLeadSecondStatus: vi.fn(),
  resolveTenantRequestContext: vi.fn(),
}));

vi.mock("@/lib/server/lead-query-service", () => ({ getLeadFormAnswers: mocks.getLeadFormAnswers, deleteLead: vi.fn(), updateLeadTriage: mocks.updateLeadTriage, updateLeadSecondStatus: mocks.updateLeadSecondStatus }));
vi.mock("@/lib/server/tenant-context", () => ({ resolveTenantRequestContext: mocks.resolveTenantRequestContext }));

const { GET, PATCH } = await import("./route");

const CONTEXT = { tenantId: "tenant-a", userId: "11111111-1111-4111-8111-111111111111" };
const LEAD = "22222222-2222-4222-8222-222222222222";

function get(id: string) {
  const request = new Request(`https://crm.example.com/api/leads/${id}`);
  return GET(request, { params: Promise.resolve({ id }) });
}

describe("GET /api/leads/[id] (form answers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveTenantRequestContext.mockResolvedValue(CONTEXT);
  });

  it("returns the lead's form answers for the session's tenant", async () => {
    mocks.getLeadFormAnswers.mockResolvedValue({ answers: [{ name: "budget_range", values: ["70_lakhs"] }] });
    const response = await get(LEAD);
    expect(mocks.getLeadFormAnswers).toHaveBeenCalledWith(CONTEXT, LEAD);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ answers: [{ name: "budget_range", values: ["70_lakhs"] }] });
  });

  it("rejects a malformed lead id before resolving the session", async () => {
    const response = await get("not-a-uuid");
    expect(response.status).toBe(400);
    expect(mocks.resolveTenantRequestContext).not.toHaveBeenCalled();
    expect(mocks.getLeadFormAnswers).not.toHaveBeenCalled();
  });

  it("passes on 404 when the lead is not in this tenant", async () => {
    mocks.getLeadFormAnswers.mockRejectedValue(new AppError("Lead not found for this tenant.", { status: 404, code: "LEAD_NOT_FOUND" }));
    const response = await get(LEAD);
    expect(response.status).toBe(404);
  });

  it("passes on 401 when there is no signed-in member", async () => {
    mocks.resolveTenantRequestContext.mockRejectedValue(new AppError("Sign in to continue.", { status: 401, code: "UNAUTHENTICATED" }));
    const response = await get(LEAD);
    expect(response.status).toBe(401);
    expect(mocks.getLeadFormAnswers).not.toHaveBeenCalled();
  });
});

function patch(body: unknown) {
  const request = new Request(`https://crm.example.com/api/leads/${LEAD}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return PATCH(request, { params: Promise.resolve({ id: LEAD }) });
}

describe("PATCH /api/leads/[id] (second status)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveTenantRequestContext.mockResolvedValue(CONTEXT);
  });

  it("saves a second status on its own, without the status/label path", async () => {
    mocks.updateLeadSecondStatus.mockResolvedValue({ id: LEAD, status: "Site visit done", secondStatus: "Disqualified" });
    const response = await patch({ secondStatus: "Disqualified" });
    expect(response.status).toBe(200);
    expect(mocks.updateLeadSecondStatus).toHaveBeenCalledWith(CONTEXT, LEAD, "Disqualified");
    expect(mocks.updateLeadTriage).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ id: LEAD, status: "Site visit done", secondStatus: "Disqualified" });
  });

  it("removes it with null", async () => {
    mocks.updateLeadSecondStatus.mockResolvedValue({ id: LEAD, status: "Working", secondStatus: null });
    const response = await patch({ secondStatus: null });
    expect(response.status).toBe(200);
    expect(mocks.updateLeadSecondStatus).toHaveBeenCalledWith(CONTEXT, LEAD, null);
  });

  it("still sends a main status change to updateLeadTriage", async () => {
    mocks.updateLeadTriage.mockResolvedValue({ id: LEAD, status: "Working", label: "Warm", labelSource: "default" });
    const response = await patch({ status: "Working" });
    expect(response.status).toBe(200);
    expect(mocks.updateLeadTriage).toHaveBeenCalledWith(CONTEXT, LEAD, { status: "Working" });
    expect(mocks.updateLeadSecondStatus).not.toHaveBeenCalled();
  });

  it("rejects an unknown status, and more than one field in one request", async () => {
    for (const body of [{ secondStatus: "Maybe" }, { status: "Working", secondStatus: "Sale" }, { label: "Hot", secondStatus: null }, {}]) {
      const response = await patch(body);
      expect(response.status).toBe(400);
    }
    expect(mocks.updateLeadSecondStatus).not.toHaveBeenCalled();
    expect(mocks.updateLeadTriage).not.toHaveBeenCalled();
  });
});
