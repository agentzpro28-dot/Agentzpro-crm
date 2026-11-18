import "server-only";

import { randomBytes } from "node:crypto";
import { AppError } from "@/lib/server/app-error";
import { requireCrmAccess } from "@/lib/server/auth/access";
import { MAGICBRICKS_LABEL, type MagicbricksFailedRequestView, type MagicbricksFailureReason, type MagicbricksOverview } from "@/lib/magicbricks/magicbricks";
import { MAGICBRICKS_LOG_MESSAGES, hashMagicbricksWebhookToken } from "@/lib/server/magicbricks/magicbricks-lead-intake-service";
import { MAGICBRICKS_PAYLOAD_MESSAGES } from "@/lib/server/magicbricks/magicbricks-lead-mapper";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { decryptToken, encryptToken } from "@/lib/server/token-crypto";

/** How many failed requests the Integrations card shows. */
export const MAGICBRICKS_FAILED_REQUEST_LIMIT = 10;
/**
 * A request still "received" this long after it arrived was never saved: its save stopped part-way (the function was
 * stopped, or the database could not be reached to record the failure), so it counts as failed. The webhook route sets
 * no maxDuration, so the hosting's default limit of 300 s applies and such a request can no longer be in progress.
 */
export const MAGICBRICKS_STUCK_REQUEST_MINUTES = 10;
/** Only when and why: the raw request (body, URL parameters, headers) never leaves the server. */
const FAILED_REQUEST_COLUMNS = "id,created_at,error_message";

/**
 * The stored error_message of a failed request → the short label the owner sees. Built from the same constants the
 * intake and the field reader write, so the two can never drift apart. Anything not listed, and a request stuck at
 * "received" (no message), shows as "Not saved".
 */
const FAILURE_REASONS: ReadonlyMap<string, MagicbricksFailureReason> = new Map<string, MagicbricksFailureReason>([
  [MAGICBRICKS_PAYLOAD_MESSAGES.noContact, "Mobile number or email not found"],
  [MAGICBRICKS_PAYLOAD_MESSAGES.unsupportedType, "Unsupported format"],
  [MAGICBRICKS_PAYLOAD_MESSAGES.notJsonObject, "Unsupported format"],
  [MAGICBRICKS_PAYLOAD_MESSAGES.oneLeadPerRequest, "Unsupported format"],
  [MAGICBRICKS_PAYLOAD_MESSAGES.tooManyFields, "Unsupported format"],
  [MAGICBRICKS_PAYLOAD_MESSAGES.fieldNameTooLong, "Unsupported format"],
  [MAGICBRICKS_LOG_MESSAGES.unreadable, "Unsupported format"],
  [MAGICBRICKS_LOG_MESSAGES.serverError, "Server error"],
  [MAGICBRICKS_LOG_MESSAGES.urlReplaced, "Old webhook URL"],
]);

/** The label for a failed request's stored error_message. */
export function magicbricksFailureReason(errorMessage: string | null): MagicbricksFailureReason {
  return (errorMessage && FAILURE_REASONS.get(errorMessage)) || "Not saved";
}

type IntegrationRow = { id: string; encrypted_url_token: string; is_active: boolean; last_received_at: string | null; url_rotated_at: string | null };
type FailedRequestRow = { id: string; created_at: string; error_message: string | null };

export class MagicbricksIntegrationService {
  /**
   * The company's MagicBricks status. Without `details` (the /leads Source filter, the dashboard): only whether the URL
   * was created, one read, never a URL. With `details` (the Integrations card) the owner also gets the URL, the last lead
   * time and the last 10 failed requests.
   */
  public async getOverview(origin: string, options: { details?: boolean } = {}): Promise<MagicbricksOverview> {
    const access = await requireCrmAccess();
    const canManage = access.membershipRole === "owner";
    const db = getSupabaseAdminClient();
    const { data, error } = await db.from("magicbricks_integrations")
      .select("id,encrypted_url_token,is_active,last_received_at,url_rotated_at")
      .eq("tenant_id", access.tenantId)
      .maybeSingle();
    if (error) throw new AppError("MagicBricks details could not be loaded.", { status: 500, code: "MAGICBRICKS_OVERVIEW_FAILED" });
    const row = data as IntegrationRow | null;
    const overview: MagicbricksOverview = { canManage, hasIntegration: Boolean(row), integration: null };
    if (!canManage || !options.details || !row || !row.is_active) return overview;

    // Two reads at the same time: the requests marked failed, and the ones whose save stopped part-way (still "received").
    const logs = () => db.from("magicbricks_webhook_logs")
      .select(FAILED_REQUEST_COLUMNS)
      .eq("tenant_id", access.tenantId)
      .eq("integration_id", row.id);
    const stuckBefore = new Date(Date.now() - MAGICBRICKS_STUCK_REQUEST_MINUTES * 60_000).toISOString();
    const [failed, stuck] = await Promise.all([
      logs().eq("status", "failed").order("created_at", { ascending: false }).limit(MAGICBRICKS_FAILED_REQUEST_LIMIT),
      logs().eq("status", "received").lt("created_at", stuckBefore).order("created_at", { ascending: false }).limit(MAGICBRICKS_FAILED_REQUEST_LIMIT),
    ]);
    if (failed.error || stuck.error) throw new AppError("MagicBricks details could not be loaded.", { status: 500, code: "MAGICBRICKS_OVERVIEW_FAILED" });
    return {
      ...overview,
      integration: {
        url: readableUrl(origin, row.encrypted_url_token),
        lastLeadAt: sinceRotation(row.last_received_at, row.url_rotated_at),
        failedRequests: newestFailedRequests((stuck.data ?? []) as FailedRequestRow[], (failed.data ?? []) as FailedRequestRow[]).map(toFailedRequestView),
      },
    };
  }

  /**
   * Creates the company's MagicBricks webhook URL, or replaces it (owner only). A new URL is made every time: after a
   * replace the old URL is refused at once (404), so MagicBricks must be given the new one.
   */
  public async createOrReplace(origin: string): Promise<{ url: string }> {
    const access = await requireCrmAccess();
    if (access.membershipRole !== "owner") {
      throw new AppError(`Only the company owner can manage ${MAGICBRICKS_LABEL}.`, { status: 403, code: "MAGICBRICKS_OWNER_REQUIRED" });
    }
    const db = getSupabaseAdminClient();
    const token = randomBytes(32).toString("base64url");
    const secret = { url_token_hash: hashMagicbricksWebhookToken(token), encrypted_url_token: encryptToken(token), is_active: true };

    const { data: existing, error: readError } = await db.from("magicbricks_integrations").select("id").eq("tenant_id", access.tenantId).maybeSingle();
    if (readError) throw saveFailed();
    if (!existing) {
      const { error } = await db.from("magicbricks_integrations").insert({ tenant_id: access.tenantId, ...secret });
      if (!error) return { url: buildMagicbricksWebhookUrl(origin, token) };
      // Another request created it at the same moment (one per company): replace that one instead.
      if (error.code !== "23505") throw saveFailed();
    }
    const { error } = await db.from("magicbricks_integrations")
      .update({ ...secret, url_rotated_at: new Date().toISOString() })
      .eq("tenant_id", access.tenantId);
    if (error) throw saveFailed();
    return { url: buildMagicbricksWebhookUrl(origin, token) };
  }
}

/**
 * The stuck and the failed requests as one list: newest first, each request once (if a request was marked failed
 * between the two reads, its failed copy and reason win), at most MAGICBRICKS_FAILED_REQUEST_LIMIT.
 */
function newestFailedRequests(stuck: FailedRequestRow[], failed: FailedRequestRow[]): FailedRequestRow[] {
  const byId = new Map<string, FailedRequestRow>();
  for (const entry of [...stuck, ...failed]) byId.set(entry.id, entry);
  return [...byId.values()]
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, MAGICBRICKS_FAILED_REQUEST_LIMIT);
}

function toFailedRequestView(row: FailedRequestRow): MagicbricksFailedRequestView {
  return { id: row.id, createdAt: row.created_at, reason: magicbricksFailureReason(row.error_message) };
}

/**
 * The URL, or null when its stored copy cannot be decrypted (for example after the encryption key changed). The card
 * then still loads and offers Regenerate; the old URL keeps working for MagicBricks until it is regenerated, because the
 * intake finds the company by the token's hash, not by the encrypted copy.
 */
function readableUrl(origin: string, encryptedToken: string): string | null {
  try {
    return buildMagicbricksWebhookUrl(origin, decryptToken(encryptedToken));
  } catch {
    console.error(JSON.stringify({ operation: "magicbricks_integration", code: "URL_DECRYPT_FAILED" }));
    return null;
  }
}

function saveFailed(): AppError {
  return new AppError("The webhook URL could not be saved. Try again.", { status: 500, code: "MAGICBRICKS_SAVE_FAILED" });
}

/** A lead time counts only when it came after the URL was last replaced; with no replacement yet, it always does. */
function sinceRotation(at: string | null, rotatedAt: string | null): string | null {
  if (!at) return null;
  return !rotatedAt || Date.parse(at) > Date.parse(rotatedAt) ? at : null;
}

export function buildMagicbricksWebhookUrl(origin: string, token: string): string {
  return new URL(`/api/webhooks/magicbricks/${token}`, origin).toString();
}
