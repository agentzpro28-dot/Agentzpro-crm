import { describe, expect, it, vi } from "vitest";

type TableResponse = { data: unknown; error: unknown };

let tableResponses: Record<string, TableResponse> = {};
let reads: { table: string; columns: string; filterColumn: string; filterValue: string }[] = [];

// Every table is read via maybeSingle(): one login belongs to at most one company. The membership
// read embeds its tenant and the tenant's subscription, so its fake row carries them nested.
function createFakeSupabaseAdminClient() {
  return {
    from(table: string) {
      return {
        select(columns: string) {
          return {
            eq(column: string, value: string) {
              reads.push({ table, columns, filterColumn: column, filterValue: value });
              return {
                maybeSingle: async () => tableResponses[table] ?? { data: null, error: null },
              };
            },
          };
        },
      };
    },
  };
}

vi.mock("@/lib/server/supabase-admin", () => ({
  getSupabaseAdminClient: () => createFakeSupabaseAdminClient(),
}));

const { resolveLoginState } = await import("@/lib/server/auth/login-state");

const USER_ID = "00000000-0000-0000-0000-000000000001";
const TENANT_ID = "10000000-0000-0000-0000-000000000001";

const TRIAL = { subscription_status: "trialing", trial_ends_at: "2026-09-17T00:00:00.000Z", current_period_ends_at: null };
const TENANT_A = { tenant_name: "Tenant A", tenant_status: "active", timezone: "Asia/Kolkata", tenants_subscriptions: TRIAL };
const OWNER_MEMBERSHIP = { tenant_id: TENANT_ID, membership_role: "owner", membership_status: "active", tenants: TENANT_A };

function setResponses(responses: Record<string, TableResponse>): void {
  tableResponses = responses;
  reads = [];
}

describe("resolveLoginState", () => {
  it("returns needs_onboarding when neither a membership nor a profile row exists", async () => {
    setResponses({
      tenant_memberships: { data: null, error: null },
      profiles: { data: null, error: null },
    });

    const state = await resolveLoginState(USER_ID);

    expect(state).toEqual({ status: "needs_onboarding" });
  });

  it("returns ready with the full ownership chain for a single, consistent membership", async () => {
    setResponses({
      tenant_memberships: { data: OWNER_MEMBERSHIP, error: null },
      profiles: { data: { user_id: USER_ID, full_name: "Owner A" }, error: null },
    });

    const state = await resolveLoginState(USER_ID);

    expect(state).toStrictEqual({
      status: "ready",
      tenantId: TENANT_ID,
      tenantName: "Tenant A",
      fullName: "Owner A",
      membershipRole: "owner",
      membershipStatus: "active",
      tenantStatus: "active",
      timezone: "Asia/Kolkata",
      subscriptionStatus: "trialing",
      trialEndsAt: "2026-09-17T00:00:00.000Z",
      currentPeriodEndsAt: null,
      isInternal: false,
    });
  });

  it("costs exactly two reads, both filtered by the signed-in user: the membership (tenant and subscription embedded) and the profile", async () => {
    setResponses({
      tenant_memberships: { data: OWNER_MEMBERSHIP, error: null },
      profiles: { data: { user_id: USER_ID, full_name: "Owner A" }, error: null },
    });

    await resolveLoginState(USER_ID);

    expect(reads.map(({ table, filterColumn, filterValue }) => ({ table, filterColumn, filterValue }))).toEqual([
      { table: "tenant_memberships", filterColumn: "user_id", filterValue: USER_ID },
      { table: "profiles", filterColumn: "user_id", filterValue: USER_ID },
    ]);
    const membershipColumns = reads[0].columns;
    expect(membershipColumns).toContain("tenants!tenant_memberships_tenant_id_fkey(tenant_name, tenant_status, timezone, ");
    expect(membershipColumns).toContain("tenants_subscriptions!tenants_subscriptions_tenant_id_fkey(");
    // Left embeds only: an inner embed would turn a missing tenant into "no company" instead of an integrity error.
    expect(membershipColumns).not.toContain("!inner");
  });

  it("reads the internal-company flag from the subscription row", async () => {
    setResponses({
      tenant_memberships: {
        data: { ...OWNER_MEMBERSHIP, tenants: { ...TENANT_A, tenants_subscriptions: { ...TRIAL, is_internal: true } } },
        error: null,
      },
      profiles: { data: { user_id: USER_ID, full_name: "Owner A" }, error: null },
    });

    await expect(resolveLoginState(USER_ID)).resolves.toMatchObject({ status: "ready", isInternal: true });
  });

  it("returns no_company for a person with a profile but no company (the owner removed them)", async () => {
    setResponses({
      tenant_memberships: { data: null, error: null },
      profiles: { data: { user_id: USER_ID }, error: null },
    });

    await expect(resolveLoginState(USER_ID)).resolves.toEqual({ status: "no_company" });
  });

  it("returns integrity_error, and never fabricates a tenant, when a membership exists without a profile", async () => {
    setResponses({
      tenant_memberships: { data: OWNER_MEMBERSHIP, error: null },
      profiles: { data: null, error: null },
    });

    const state = await resolveLoginState(USER_ID);

    expect(state).toEqual({ status: "integrity_error", reason: "PARTIAL_ONBOARDING_STATE" });
  });

  it("returns integrity_error when the membership's tenant row is missing", async () => {
    setResponses({
      tenant_memberships: { data: { ...OWNER_MEMBERSHIP, tenants: null }, error: null },
      profiles: { data: { user_id: USER_ID }, error: null },
    });

    const state = await resolveLoginState(USER_ID);

    expect(state).toEqual({ status: "integrity_error", reason: "TENANT_MISSING" });
  });

  it("returns integrity_error when the tenant's subscription row is missing", async () => {
    setResponses({
      tenant_memberships: {
        data: { ...OWNER_MEMBERSHIP, tenants: { tenant_status: "active", tenants_subscriptions: null } },
        error: null,
      },
      profiles: { data: { user_id: USER_ID }, error: null },
    });

    const state = await resolveLoginState(USER_ID);

    expect(state).toEqual({ status: "integrity_error", reason: "SUBSCRIPTION_MISSING" });
  });

  it("returns integrity_error when the membership query itself fails", async () => {
    setResponses({
      tenant_memberships: { data: null, error: { message: "connection reset" } },
    });

    const state = await resolveLoginState(USER_ID);

    expect(state).toEqual({ status: "integrity_error", reason: "MEMBERSHIP_QUERY_FAILED" });
  });

  it("returns integrity_error when the profile query fails", async () => {
    setResponses({
      tenant_memberships: { data: OWNER_MEMBERSHIP, error: null },
      profiles: { data: null, error: { message: "connection reset" } },
    });

    const state = await resolveLoginState(USER_ID);

    expect(state).toEqual({ status: "integrity_error", reason: "PROFILE_QUERY_FAILED" });
  });
});
