import "server-only";

import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";

/**
 * login_system_plan.md section 6.3: after OTP verification, exactly one of
 * these three states must result. A partial or contradictory record set is
 * never silently repaired by creating another tenant — it blocks access
 * and is logged for backend investigation instead.
 */
export type LoginState =
  | { status: "needs_onboarding" }
  // The person finished account setup but no longer belongs to a company: the owner removed them.
  // One login belongs to one company, so they cannot join or create another.
  | { status: "no_company" }
  | {
      status: "ready";
      tenantId: string;
      tenantName: string;
      fullName: string;
      membershipRole: string;
      membershipStatus: string;
      tenantStatus: string;
      subscriptionStatus: string;
      trialEndsAt: string | null;
      currentPeriodEndsAt: string | null;
      /** AgentzPro's own company: CRM access without a trial or paid period. Set only by hand in SQL. */
      isInternal: boolean;
    }
  | { status: "integrity_error"; reason: string };

function logIntegrityError(userId: string, reason: string): void {
  console.error(JSON.stringify({ operation: "resolve_login_state", code: "LOGIN_STATE_INTEGRITY_ERROR", userId, reason }));
}

/** The membership row with its tenant and that tenant's subscription embedded (null when missing). */
interface MembershipRow {
  tenant_id: string;
  membership_role: string;
  membership_status: string;
  tenants: {
    tenant_name: string;
    tenant_status: string;
    tenants_subscriptions: {
      subscription_status: string;
      trial_ends_at: string | null;
      current_period_ends_at: string | null;
      is_internal: boolean | null;
    } | null;
  } | null;
}

/**
 * Embeds the tenant (many-to-one) and its subscription (one-to-one: tenants_subscriptions is unique
 * on tenant_id, so it comes back as one object). Both are LEFT embeds on purpose: a missing tenant or
 * subscription must still surface as its own integrity error below, never as "no company".
 */
const MEMBERSHIP_WITH_TENANT_SELECT =
  "tenant_id, membership_role, membership_status, " +
  "tenants!tenant_memberships_tenant_id_fkey(tenant_name, tenant_status, " +
  "tenants_subscriptions!tenants_subscriptions_tenant_id_fkey(subscription_status, trial_ends_at, current_period_ends_at, is_internal))";

/**
 * Resolves the current login state for a verified `userId` by reading the
 * profile / membership / tenant / subscription chain with the trusted
 * service-role client (bypassing RLS, since this check itself determines
 * what the user is authorized to see).
 *
 * One login belongs to exactly one company: tenant_memberships is unique on
 * user_id, so there is at most one membership row to read.
 *
 * This runs on every CRM API call, so it costs exactly two reads sent together (one round trip):
 * the membership with its tenant and subscription embedded, and the profile. The checks below keep
 * the same order and outcomes as reading the four tables one by one.
 */
export async function resolveLoginState(userId: string): Promise<LoginState> {
  const db = getSupabaseAdminClient();

  const [membershipResult, profileResult] = await Promise.all([
    db
      .from("tenant_memberships")
      .select(MEMBERSHIP_WITH_TENANT_SELECT)
      .eq("user_id", userId)
      .maybeSingle<MembershipRow>(),
    db
      .from("profiles")
      .select("user_id, full_name")
      .eq("user_id", userId)
      .maybeSingle<{ user_id: string; full_name: string }>(),
  ]);

  const { data: membership, error: membershipError } = membershipResult;

  if (membershipError) {
    logIntegrityError(userId, "MEMBERSHIP_QUERY_FAILED");
    return { status: "integrity_error", reason: "MEMBERSHIP_QUERY_FAILED" };
  }

  const { data: profile, error: profileError } = profileResult;

  if (profileError) {
    logIntegrityError(userId, "PROFILE_QUERY_FAILED");
    return { status: "integrity_error", reason: "PROFILE_QUERY_FAILED" };
  }

  if (!membership && !profile) {
    return { status: "needs_onboarding" };
  }

  if (!profile) {
    // A membership without a profile can only come from a failure outside
    // the onboarding/accept RPCs' own transactions — never paper over it.
    logIntegrityError(userId, "PARTIAL_ONBOARDING_STATE");
    return { status: "integrity_error", reason: "PARTIAL_ONBOARDING_STATE" };
  }

  // A profile with no membership: the owner removed this person from their company. The profile is
  // kept (remove_tenant_member deletes only the membership), so this is a known state, not an error.
  if (!membership) {
    return { status: "no_company" };
  }

  const tenant = membership.tenants;

  if (!tenant) {
    logIntegrityError(userId, "TENANT_MISSING");
    return { status: "integrity_error", reason: "TENANT_MISSING" };
  }

  const subscription = tenant.tenants_subscriptions;

  if (!subscription) {
    logIntegrityError(userId, "SUBSCRIPTION_MISSING");
    return { status: "integrity_error", reason: "SUBSCRIPTION_MISSING" };
  }

  return {
    status: "ready",
    tenantId: membership.tenant_id,
    tenantName: tenant.tenant_name,
    fullName: profile.full_name,
    membershipRole: membership.membership_role,
    membershipStatus: membership.membership_status,
    tenantStatus: tenant.tenant_status,
    subscriptionStatus: subscription.subscription_status,
    trialEndsAt: subscription.trial_ends_at,
    currentPeriodEndsAt: subscription.current_period_ends_at,
    isInternal: subscription.is_internal === true,
  };
}
