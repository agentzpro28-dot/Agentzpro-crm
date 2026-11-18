import "server-only";

import { randomBytes } from "node:crypto";
import { AppError } from "@/lib/server/app-error";
import { requireCrmAccess } from "@/lib/server/auth/access";
import { PORTAL_IDS, PORTALS, type PortalFailedRequestView, type PortalId, type PortalIntegrationOverview, type PortalIntegrationStatus } from "@/lib/portal-leads/portals";
import { hashPortalWebhookToken } from "@/lib/server/portal-leads/portal-lead-intake-service";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { decryptToken, encryptToken } from "@/lib/server/token-crypto";

/** How many failed requests the Integrations card shows. */
export const PORTAL_FAILED_REQUEST_LIMIT = 10;
/** Only when and why: the raw request (body, URL parameters, headers) never leaves the server. */
const FAILED_REQUEST_COLUMNS = "id,created_at,error_message";
const FAILED_REQUEST_FALLBACK = "The request could not be saved.";

type IntegrationRow = { encrypted_url_token: string; is_active: boolean; last_received_at: string | null; url_rotated_at: string | null; id: string };
type FailedRequestRow = { id: string; created_at: string; error_message: string | null };

async function resolveOwner(portal: PortalId): Promise<{ tenantId: string }> {
  const access = await requireCrmAccess();
  if (access.membershipRole !== "owner") {
    throw new AppError(`Only the company owner can manage ${PORTALS[portal].label}.`, { status: 403, code: "PORTAL_OWNER_REQUIRED" });
  }
  return { tenantId: access.tenantId };
}

export class PortalIntegrationService {
  /**
   * Which portals this company has set up, for the /leads Source filter and the dashboard. One read for every portal.
   * Never returns a URL.
   */
  public async listStatuses(): Promise<{ portals: PortalIntegrationStatus[] }> {
    const access = await requireCrmAccess();
    const { data, error } = await getSupabaseAdminClient().from("portal_integrations")
      .select("portal_name")
      .eq("tenant_id", access.tenantId);
    if (error) throw new AppError("Portal details could not be loaded.", { status: 500, code: "PORTAL_STATUS_FAILED" });
    const existing = new Set((data ?? []).map((row) => String((row as { portal_name: unknown }).portal_name)));
    return { portals: PORTAL_IDS.map((portal) => ({ portal, hasIntegration: existing.has(portal) })) };
  }

  /** The Integrations card. With `details` the owner also gets the URL, the last lead time and the last 10 failed requests. */
  public async getOverview(portal: PortalId, origin: string, options: { details?: boolean } = {}): Promise<PortalIntegrationOverview> {
    const access = await requireCrmAccess();
    const canManage = access.membershipRole === "owner";
    const db = getSupabaseAdminClient();
    const { data, error } = await db.from("portal_integrations")
      .select("id,encrypted_url_token,is_active,last_received_at,url_rotated_at")
      .eq("tenant_id", access.tenantId)
      .eq("portal_name", portal)
      .maybeSingle();
    if (error) throw new AppError("Portal details could not be loaded.", { status: 500, code: "PORTAL_OVERVIEW_FAILED" });
    const row = data as IntegrationRow | null;
    const overview: PortalIntegrationOverview = { portal, canManage, hasIntegration: Boolean(row), integration: null };
    if (!canManage || !options.details || !row || !row.is_active) return overview;

    const { data: failed, error: failedError } = await db.from("portal_webhook_logs")
      .select(FAILED_REQUEST_COLUMNS)
      .eq("tenant_id", access.tenantId)
      .eq("integration_id", row.id)
      .eq("status", "failed")
      .order("created_at", { ascending: false })
      .limit(PORTAL_FAILED_REQUEST_LIMIT);
    if (failedError) throw new AppError("Portal details could not be loaded.", { status: 500, code: "PORTAL_OVERVIEW_FAILED" });
    return {
      ...overview,
      integration: {
        url: readableUrl(origin, portal, row.encrypted_url_token),
        lastLeadAt: sinceRotation(row.last_received_at, row.url_rotated_at),
        failedRequests: ((failed ?? []) as FailedRequestRow[]).map(toFailedRequestView),
      },
    };
  }

  /**
   * Creates this portal's webhook URL for the company, or replaces it. A new URL is made every time: after a replace the
   * old URL is refused at once (404), so the portal must be given the new one.
   */
  public async createOrReplace(portal: PortalId, origin: string): Promise<{ url: string }> {
    const owner = await resolveOwner(portal);
    const db = getSupabaseAdminClient();
    const token = randomBytes(32).toString("base64url");
    const secret = { url_token_hash: hashPortalWebhookToken(token), encrypted_url_token: encryptToken(token), is_active: true };

    const { data: existing, error: readError } = await db.from("portal_integrations").select("id")
      .eq("tenant_id", owner.tenantId).eq("portal_name", portal).maybeSingle();
    if (readError) throw saveFailed();
    if (!existing) {
      const { error } = await db.from("portal_integrations").insert({ tenant_id: owner.tenantId, portal_name: portal, ...secret });
      if (!error) return { url: buildPortalWebhookUrl(origin, portal, token) };
      // Another request created it at the same moment (one per portal per company): replace that one instead.
      if (error.code !== "23505") throw saveFailed();
    }
    const { error } = await db.from("portal_integrations")
      .update({ ...secret, url_rotated_at: new Date().toISOString() })
      .eq("tenant_id", owner.tenantId)
      .eq("portal_name", portal);
    if (error) throw saveFailed();
    return { url: buildPortalWebhookUrl(origin, portal, token) };
  }
}

function toFailedRequestView(row: FailedRequestRow): PortalFailedRequestView {
  return { id: row.id, createdAt: row.created_at, errorMessage: row.error_message || FAILED_REQUEST_FALLBACK };
}

/**
 * The URL, or null when its stored copy cannot be decrypted (for example after the encryption key changed). The card
 * then still loads and offers Regenerate, instead of failing as a whole; the old URL keeps working for the portal until
 * it is regenerated, because the intake finds the company by the token's hash, not by the encrypted copy.
 */
function readableUrl(origin: string, portal: PortalId, encryptedToken: string): string | null {
  try {
    return buildPortalWebhookUrl(origin, portal, decryptToken(encryptedToken));
  } catch {
    console.error(JSON.stringify({ operation: "portal_integration", code: "URL_DECRYPT_FAILED", portal }));
    return null;
  }
}

function saveFailed(): AppError {
  return new AppError("The webhook URL could not be saved. Try again.", { status: 500, code: "PORTAL_SAVE_FAILED" });
}

/** A lead time counts only when it came after the URL was last replaced; with no replacement yet, it always does. */
function sinceRotation(at: string | null, rotatedAt: string | null): string | null {
  if (!at) return null;
  return !rotatedAt || Date.parse(at) > Date.parse(rotatedAt) ? at : null;
}

export function buildPortalWebhookUrl(origin: string, portal: PortalId, token: string): string {
  return new URL(`/api/webhooks/leads/${portal}/${token}`, origin).toString();
}
