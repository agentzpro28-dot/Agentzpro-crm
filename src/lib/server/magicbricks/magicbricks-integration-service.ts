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
 * "received" (no message), shows as "Not saved". The texts the field reader wrote before 2026-11-26 are listed as
 * written, so older failed requests keep their label.
 */
const FAILURE_REASONS: ReadonlyMap<string, MagicbricksFailureReason> = new Map<string, MagicbricksFailureReason>([
  [MAGICBRICKS_PAYLOAD_MESSAGES.noContact, "Mobile number or email not found"],
  ["Send mobile or email.", "Mobile number or email not found"],
  ["Send the lead as a JSON object.", "Unsupported format"],
  ["Send one lead per request.", "Unsupported format"],
  ["Send 100 fields or fewer.", "Unsupported format"],
  ["Field names must be 100 characters or fewer.", "Unsupported format"],
  ["Send JSON, form data or URL parameters.", "Unsupported format"],
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

type IntegrationRow = {
  id: string;
  encrypted_url_token: string;
  is_active: boolean;
  last_received_at: string | null;
  url_rotated_at: string | null;
  previous_valid_until: string | null;
  previous_last_received_at: string | null;
  paused_at: string | null;
};
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
      .select("id,encrypted_url_token,is_active,last_received_at,url_rotated_at,previous_valid_until,previous_last_received_at,paused_at")
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
    // Shown only while the old URL still works (the database refuses it after previous_valid_until).
    const previousUrl = row.previous_valid_until && Date.parse(row.previous_valid_until) > Date.now()
      ? { validUntil: row.previous_valid_until, lastLeadAt: row.previous_last_received_at }
      : null;
    return {
      ...overview,
      integration: {
        url: readableUrl(origin, row.encrypted_url_token),
        // save_magicbricks_url clears last_received_at on a regenerate; sinceRotation also covers URLs replaced before that.
        lastLeadAt: sinceRotation(row.last_received_at, row.url_rotated_at),
        previousUrl,
        paused: Boolean(row.paused_at),
        failedRequests: newestFailedRequests((stuck.data ?? []) as FailedRequestRow[], (failed.data ?? []) as FailedRequestRow[]).map(toFailedRequestView),
      },
    };
  }

  /**
   * Creates the company's MagicBricks webhook URL, or replaces it (owner only). A new URL is made every time; after a
   * replace the old URL keeps working for MAGICBRICKS_PREVIOUS_URL_DAYS days (save_magicbricks_url), then it is refused
   * (404).
   */
  public async createOrReplace(origin: string): Promise<{ url: string }> {
    const access = await requireCrmAccess();
    if (access.membershipRole !== "owner") {
      throw new AppError(`Only the company owner can manage ${MAGICBRICKS_LABEL}.`, { status: 403, code: "MAGICBRICKS_OWNER_REQUIRED" });
    }
    const token = randomBytes(32).toString("base64url");
    const { error } = await getSupabaseAdminClient().rpc("save_magicbricks_url", {
      p_tenant_id: access.tenantId,
      p_token_hash: hashMagicbricksWebhookToken(token),
      p_encrypted_token: encryptToken(token),
    });
    if (error) throw saveFailed();
    return { url: buildMagicbricksWebhookUrl(origin, token) };
  }

  /**
   * Pauses MagicBricks leads, or resumes them (owner only). While paused, find_magicbricks_integration finds nothing, so
   * every request to the current URL and to the old URL gets 404 and nothing is saved. A Regenerate keeps the pause.
   */
  public async setPaused(paused: boolean): Promise<{ paused: boolean }> {
    const access = await requireCrmAccess();
    if (access.membershipRole !== "owner") {
      throw new AppError(`Only the company owner can manage ${MAGICBRICKS_LABEL}.`, { status: 403, code: "MAGICBRICKS_OWNER_REQUIRED" });
    }
    const { data, error } = await getSupabaseAdminClient().from("magicbricks_integrations")
      .update({ paused_at: paused ? new Date().toISOString() : null })
      .eq("tenant_id", access.tenantId)
      .eq("is_active", true)
      .select("id");
    if (error) {
      throw new AppError(paused ? `${MAGICBRICKS_LABEL} leads could not be paused. Try again.` : `${MAGICBRICKS_LABEL} leads could not be resumed. Try again.`, { status: 500, code: "MAGICBRICKS_PAUSE_FAILED" });
    }
    if (!data || data.length === 0) throw new AppError("Generate the webhook URL first.", { status: 404, code: "MAGICBRICKS_INTEGRATION_NOT_FOUND" });
    return { paused };
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
