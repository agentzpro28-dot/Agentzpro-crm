import "server-only";

import { randomBytes } from "node:crypto";
import { AppError } from "@/lib/server/app-error";
import { requireCrmAccess } from "@/lib/server/auth/access";
import { HOUSING_LABEL, type HousingFailedRequestView, type HousingFailureReason, type HousingOverview } from "@/lib/housing/housing";
import { HOUSING_LOG_MESSAGES, hashHousingWebhookToken } from "@/lib/server/housing/housing-lead-intake-service";
import { HOUSING_PAYLOAD_MESSAGES } from "@/lib/server/housing/housing-lead-mapper";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { decryptToken, encryptToken } from "@/lib/server/token-crypto";

/** How many failed requests the Integrations card shows. */
export const HOUSING_FAILED_REQUEST_LIMIT = 10;
/**
 * A request still "received" this long after it arrived was never saved: its save stopped part-way (the function was
 * stopped, or the database could not be reached to record the failure), so it counts as failed. The webhook route sets
 * no maxDuration, so the hosting's default limit of 300 s applies and such a request can no longer be in progress.
 */
export const HOUSING_STUCK_REQUEST_MINUTES = 10;
/** Only when and why: the raw request (body, URL parameters, headers) never leaves the server. */
const FAILED_REQUEST_COLUMNS = "id,created_at,error_message";

/**
 * The stored error_message of a failed request → the short label the owner sees. Built from the same constants the
 * intake and the field reader write, so the two can never drift apart. Anything not listed, and a request stuck at
 * "received" (no message), shows as "Not saved".
 */
const FAILURE_REASONS: ReadonlyMap<string, HousingFailureReason> = new Map<string, HousingFailureReason>([
  [HOUSING_PAYLOAD_MESSAGES.noContact, "Mobile number or email not found"],
  [HOUSING_PAYLOAD_MESSAGES.unsupportedType, "Unsupported format"],
  [HOUSING_PAYLOAD_MESSAGES.notJsonObject, "Unsupported format"],
  [HOUSING_PAYLOAD_MESSAGES.oneLeadPerRequest, "Unsupported format"],
  [HOUSING_PAYLOAD_MESSAGES.tooManyFields, "Unsupported format"],
  [HOUSING_PAYLOAD_MESSAGES.fieldNameTooLong, "Unsupported format"],
  [HOUSING_LOG_MESSAGES.serverError, "Server error"],
  [HOUSING_LOG_MESSAGES.urlReplaced, "Old webhook URL"],
]);

/** The label for a failed request's stored error_message. */
export function housingFailureReason(errorMessage: string | null): HousingFailureReason {
  return (errorMessage && FAILURE_REASONS.get(errorMessage)) || "Not saved";
}

type IntegrationRow = {
  id: string;
  encrypted_url_token: string;
  is_active: boolean;
  last_received_at: string | null;
  previous_valid_until: string | null;
  previous_last_received_at: string | null;
  paused_at: string | null;
};
type FailedRequestRow = { id: string; created_at: string; error_message: string | null };

export class HousingIntegrationService {
  /**
   * The company's Housing.com status. Without `details` (the /leads Source filter, the dashboard): only whether the URL
   * was created, one read, never a URL. With `details` (the Integrations card) the owner also gets the URL, the last
   * lead time, the old URL's handover and the last 10 failed requests.
   */
  public async getOverview(origin: string, options: { details?: boolean } = {}): Promise<HousingOverview> {
    const access = await requireCrmAccess();
    const canManage = access.membershipRole === "owner";
    const db = getSupabaseAdminClient();
    const { data, error } = await db.from("housing_integrations")
      .select("id,encrypted_url_token,is_active,last_received_at,previous_valid_until,previous_last_received_at,paused_at")
      .eq("tenant_id", access.tenantId)
      .maybeSingle();
    if (error) throw loadFailed();
    const row = data as IntegrationRow | null;
    const overview: HousingOverview = { canManage, hasIntegration: Boolean(row), disconnected: Boolean(row && !row.is_active), integration: null };
    if (!canManage || !options.details || !row || !row.is_active) return overview;

    // Two reads at the same time: the requests marked failed, and the ones whose save stopped part-way (still "received").
    const logs = () => db.from("housing_webhook_logs")
      .select(FAILED_REQUEST_COLUMNS)
      .eq("tenant_id", access.tenantId)
      .eq("integration_id", row.id);
    const stuckBefore = new Date(Date.now() - HOUSING_STUCK_REQUEST_MINUTES * 60_000).toISOString();
    const [failed, stuck] = await Promise.all([
      logs().eq("status", "failed").order("created_at", { ascending: false }).limit(HOUSING_FAILED_REQUEST_LIMIT),
      logs().eq("status", "received").lt("created_at", stuckBefore).order("created_at", { ascending: false }).limit(HOUSING_FAILED_REQUEST_LIMIT),
    ]);
    if (failed.error || stuck.error) throw loadFailed();
    // Shown only while the old URL still works (the database refuses it after previous_valid_until).
    const previousUrl = row.previous_valid_until && Date.parse(row.previous_valid_until) > Date.now()
      ? { validUntil: row.previous_valid_until, lastLeadAt: row.previous_last_received_at }
      : null;
    return {
      ...overview,
      integration: {
        url: readableUrl(origin, row.encrypted_url_token),
        // save_housing_url clears it on a regenerate, so it is always a lead on the current URL.
        lastLeadAt: row.last_received_at,
        previousUrl,
        paused: Boolean(row.paused_at),
        failedRequests: newestFailedRequests((stuck.data ?? []) as FailedRequestRow[], (failed.data ?? []) as FailedRequestRow[]).map(toFailedRequestView),
      },
    };
  }

  /**
   * Creates the company's Housing.com webhook URL, or replaces it (owner only). A new URL is made every time; after a
   * replace the old URL keeps working for 7 days (save_housing_url), then it is refused (404).
   */
  public async createOrReplace(origin: string): Promise<{ url: string }> {
    const access = await requireCrmAccess();
    if (access.membershipRole !== "owner") {
      throw new AppError(`Only the company owner can manage ${HOUSING_LABEL}.`, { status: 403, code: "HOUSING_OWNER_REQUIRED" });
    }
    const token = randomBytes(32).toString("base64url");
    const { error } = await getSupabaseAdminClient().rpc("save_housing_url", {
      p_tenant_id: access.tenantId,
      p_token_hash: hashHousingWebhookToken(token),
      p_encrypted_token: encryptToken(token),
    });
    if (error) throw new AppError("The webhook URL could not be saved. Try again.", { status: 500, code: "HOUSING_SAVE_FAILED" });
    return { url: buildHousingWebhookUrl(origin, token) };
  }

  /**
   * Pauses the company's Housing.com leads, or resumes them (owner only). While paused, find_housing_integration finds
   * nothing, so every request to the current URL and to the old URL gets 404 and nothing is saved. A Regenerate keeps
   * the pause.
   */
  public async setPaused(paused: boolean): Promise<{ paused: boolean }> {
    const access = await requireCrmAccess();
    if (access.membershipRole !== "owner") {
      throw new AppError(`Only the company owner can manage ${HOUSING_LABEL}.`, { status: 403, code: "HOUSING_OWNER_REQUIRED" });
    }
    const { data, error } = await getSupabaseAdminClient().from("housing_integrations")
      .update({ paused_at: paused ? new Date().toISOString() : null })
      .eq("tenant_id", access.tenantId)
      .eq("is_active", true)
      .select("id");
    if (error) {
      throw new AppError(paused ? `${HOUSING_LABEL} leads could not be paused. Try again.` : `${HOUSING_LABEL} leads could not be resumed. Try again.`, { status: 500, code: "HOUSING_PAUSE_FAILED" });
    }
    if (!data || data.length === 0) throw new AppError("Generate the webhook URL first.", { status: 404, code: "HOUSING_INTEGRATION_NOT_FOUND" });
    return { paused };
  }

  /**
   * Disconnects Housing.com (owner only). One UPDATE: is_active = false, and the pause and the old URL are cleared, so
   * every request to the current URL and to the old URL gets 404 at once and nothing is saved (find_housing_integration
   * and ingest_housing_lead both require is_active). The row stays, so leads already received keep their link and
   * Housing.com stays in the /leads Source filter. Generating a URL again makes a brand-new one with no old URL
   * (save_housing_url). Disconnecting twice changes nothing more.
   */
  public async disconnect(): Promise<{ disconnected: true }> {
    const access = await requireCrmAccess();
    if (access.membershipRole !== "owner") {
      throw new AppError(`Only the company owner can manage ${HOUSING_LABEL}.`, { status: 403, code: "HOUSING_OWNER_REQUIRED" });
    }
    const { data, error } = await getSupabaseAdminClient().from("housing_integrations")
      .update({ is_active: false, paused_at: null, previous_url_token_hash: null, previous_valid_until: null, previous_last_received_at: null })
      .eq("tenant_id", access.tenantId)
      .select("id");
    if (error) throw new AppError(`${HOUSING_LABEL} could not be disconnected. Try again.`, { status: 500, code: "HOUSING_DISCONNECT_FAILED" });
    if (!data || data.length === 0) throw new AppError("Generate the webhook URL first.", { status: 404, code: "HOUSING_INTEGRATION_NOT_FOUND" });
    return { disconnected: true };
  }
}

/**
 * The stuck and the failed requests as one list: newest first, each request once (if a request was marked failed
 * between the two reads, its failed copy and reason win), at most HOUSING_FAILED_REQUEST_LIMIT.
 */
function newestFailedRequests(stuck: FailedRequestRow[], failed: FailedRequestRow[]): FailedRequestRow[] {
  const byId = new Map<string, FailedRequestRow>();
  for (const entry of [...stuck, ...failed]) byId.set(entry.id, entry);
  return [...byId.values()]
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, HOUSING_FAILED_REQUEST_LIMIT);
}

function toFailedRequestView(row: FailedRequestRow): HousingFailedRequestView {
  return { id: row.id, createdAt: row.created_at, reason: housingFailureReason(row.error_message) };
}

/**
 * The URL, or null when its stored copy cannot be decrypted (for example after the encryption key changed). The card
 * then still loads and offers Regenerate; the URL keeps working for Housing.com until it is regenerated, because the
 * intake finds the company by the token's hash, not by the encrypted copy.
 */
function readableUrl(origin: string, encryptedToken: string): string | null {
  try {
    return buildHousingWebhookUrl(origin, decryptToken(encryptedToken));
  } catch {
    console.error(JSON.stringify({ operation: "housing_integration", code: "URL_DECRYPT_FAILED" }));
    return null;
  }
}

function loadFailed(): AppError {
  return new AppError(`${HOUSING_LABEL} details could not be loaded.`, { status: 500, code: "HOUSING_OVERVIEW_FAILED" });
}

export function buildHousingWebhookUrl(origin: string, token: string): string {
  return new URL(`/api/webhooks/housing/${token}`, origin).toString();
}
