import "server-only";

import { createHash } from "node:crypto";
import type { SulekhaLeadOutcome } from "@/lib/sulekha/sulekha";
import { checkSulekhaRate } from "@/lib/server/sulekha/sulekha-rate-limit";
import { MAX_SULEKHA_WEBHOOK_BODY_BYTES, SULEKHA_PAYLOAD_MESSAGES, SulekhaPayloadError, isEmptySulekhaRequest, mapSulekhaLead } from "@/lib/server/sulekha/sulekha-lead-mapper";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";

/** The URL token: 32 random bytes, base64url without padding (43 characters). */
export const SULEKHA_WEBHOOK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * What the Sulekha webhook answers.
 *   200 "Lead received"  saved (`duplicate`: already saved, or added as a note to the lead with this phone).
 *   200 "Received"       the raw copy is saved but no lead could be read from it (no mobile/email, unknown format);
 *                        `reason` says why. It is listed under Failed requests in the card and kept for support. Not a
 *                        4XX on purpose: a sender may switch a webhook off after repeated errors.
 *   200 "Webhook ready"  an empty URL check.
 *   404 / 413            a wrong, replaced or expired URL / a body over 64 KB: never accepted as sent.
 *   429                  too many leads this minute (try again after `retryAfterSeconds`).
 *   500                  a failure on our side; Sulekha may retry, and a retry of the same enquiry is never saved twice.
 */
export type SulekhaIntakeResult =
  | { status: 200; message: "Lead received"; duplicate: boolean; outcome: SulekhaLeadOutcome; leadId: string }
  | { status: 200; message: "Received"; accepted: false; reason: string }
  | { status: 200; message: "Webhook ready" }
  | { status: 404 | 413 | 500; message: string }
  | { status: 429; message: string; retryAfterSeconds: number };

export interface IncomingSulekhaRequest {
  method: "GET" | "POST";
  headers: Headers;
  /** The URL parameters (a repeated one is a list). */
  query: Record<string, unknown>;
  rawBody: string;
}

/** The integration the URL token belongs to (find_sulekha_integration), and which of its URLs was used. */
export interface SulekhaIntegrationMatch {
  id: string;
  tenant_id: string;
  field_mapping: unknown;
  url_version: "current" | "previous";
}

/**
 * What the request log's error_message says when a request was not saved (besides SULEKHA_PAYLOAD_MESSAGES). The
 * Integrations card turns each into a short label (sulekha-integration-service.ts).
 */
export const SULEKHA_LOG_MESSAGES = {
  urlReplaced: "This webhook URL is no longer active.",
  serverError: "Temporary failure on our side. Sulekha may send it again.",
} as const;

const UNKNOWN_WEBHOOK = "Unknown webhook.";
const TEMPORARY_FAILURE = "Temporary failure, retry later.";
const MAX_LOGGED_HEADERS = 50;
const MAX_LOGGED_HEADER_LENGTH = 1000;
// Headers added by our own hosting, not sent by Sulekha: they would only fill the log. The sender's IP is kept in its
// own column (source_ip).
const HOSTING_HEADER = /^(x-vercel-|x-middleware-|x-invoke-|x-nextjs-|x-invocation-id$|x-matched-path$|x-real-ip$|x-forwarded-host$|x-forwarded-proto$|x-forwarded-port$|forwarded$)/;
// Anything that may carry a credential is logged as hidden, never as sent.
const SECRET_HEADER = /(cookie|authorization|token|secret|key|signature|password|auth|session|credential)/;

/** SHA-256 of the URL token, as stored in sulekha_integrations.url_token_hash / previous_url_token_hash. */
export function hashSulekhaWebhookToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class SulekhaLeadIntakeService {
  /** A request to /api/webhooks/sulekha/<token>. The company comes only from the token, never from the request. */
  public async ingestFromWebhook(urlToken: string, request: IncomingSulekhaRequest): Promise<SulekhaIntakeResult> {
    if (!SULEKHA_WEBHOOK_TOKEN_PATTERN.test(urlToken)) return { status: 404, message: UNKNOWN_WEBHOOK };
    // The real size too: a chunked post carries no content-length for the route to check.
    if (Buffer.byteLength(request.rawBody, "utf8") > MAX_SULEKHA_WEBHOOK_BODY_BYTES) return { status: 413, message: "Payload too large." };

    const tokenHash = hashSulekhaWebhookToken(urlToken);
    const { data, error } = await getSupabaseAdminClient().rpc("find_sulekha_integration", { p_token_hash: tokenHash });
    if (error) return failure("INTEGRATION_LOOKUP_FAILED");
    const match = (Array.isArray(data) ? data[0] : data) as SulekhaIntegrationMatch | null | undefined;
    // Not logged: a request that does not reach a company's integration must never fill anyone's log.
    if (!match) return { status: 404, message: UNKNOWN_WEBHOOK };
    return this.ingestForIntegration(match, tokenHash, request);
  }

  /**
   * One request for a known, active integration. The raw request is written to sulekha_webhook_logs BEFORE it is read,
   * so an enquiry that cannot be read (unexpected field names, a new format) is never lost: our support team keeps its
   * copy, and the owner sees it under Failed requests in the card.
   */
  public async ingestForIntegration(integration: SulekhaIntegrationMatch, tokenHash: string, request: IncomingSulekhaRequest): Promise<SulekhaIntakeResult> {
    const tenantId = integration.tenant_id;

    const rate = await checkSulekhaRate(integration.id);
    if (!rate.allowed) {
      log("RATE_LIMITED", tenantId);
      return { status: 429, message: "Too many leads. Try again shortly.", retryAfterSeconds: rate.retryAfterSeconds };
    }
    const contentType = request.headers.get("content-type");
    const leadRequest = { method: request.method, contentType, query: request.query, rawBody: request.rawBody };
    // A URL check (nothing sent at all): nothing to save or log.
    if (isEmptySulekhaRequest(leadRequest)) {
      log("EMPTY_REQUEST", tenantId);
      return { status: 200, message: "Webhook ready" };
    }

    const db = getSupabaseAdminClient();
    const { data: logRow, error: logError } = await db.from("sulekha_webhook_logs")
      .insert({
        tenant_id: tenantId,
        integration_id: integration.id,
        http_method: request.method,
        url_version: integration.url_version,
        headers: loggableSulekhaHeaders(request.headers),
        query_params: request.query,
        raw_body: request.rawBody,
        content_type: clip(contentType, 300),
        user_agent: clip(request.headers.get("user-agent"), 500),
        source_ip: clip(sulekhaSourceIp(request.headers), 100),
      })
      .select("id")
      .single();
    // Without its raw copy the lead is not taken: Sulekha is told to retry, so nothing is saved unseen.
    if (logError || !logRow) return failure("LOG_WRITE_FAILED", tenantId);
    const logId = String((logRow as { id: unknown }).id);

    let lead;
    try {
      lead = await mapSulekhaLead(leadRequest, { fieldMapping: integration.field_mapping });
    } catch (mapError) {
      if (mapError instanceof SulekhaPayloadError) return notReadable(logId, tenantId, mapError.message);
      await markFailed(logId, tenantId, SULEKHA_LOG_MESSAGES.serverError);
      return failure("LEAD_MAP_FAILED", tenantId);
    }

    const { data: outcome, error: ingestError } = await db.rpc("ingest_sulekha_lead", {
      p_tenant_id: tenantId,
      p_integration_id: integration.id,
      p_log_id: logId,
      p_token_hash: tokenHash,
      p_lead_ref: lead.leadRef,
      p_service_name: lead.serviceName,
      p_enquiry_summary: lead.enquirySummary,
      p_field_data: lead.fieldData,
      p_raw_payload: lead.rawPayload,
    });
    if (ingestError) {
      // The URL was replaced, expired or stopped between the lookup and the save.
      if (ingestError.code === "P0002") {
        await markFailed(logId, tenantId, SULEKHA_LOG_MESSAGES.urlReplaced);
        return { status: 404, message: UNKNOWN_WEBHOOK };
      }
      // The database's own check: no usable mobile and no email (e.g. a phone with no digits).
      if (ingestError.code === "22023") return notReadable(logId, tenantId, SULEKHA_PAYLOAD_MESSAGES.noContact);
      await markFailed(logId, tenantId, SULEKHA_LOG_MESSAGES.serverError);
      return failure("LEAD_INGEST_FAILED", tenantId);
    }
    const result = outcome as { outcome?: unknown; lead_id?: unknown } | null;
    const kind: SulekhaLeadOutcome = result?.outcome === "merged" || result?.outcome === "duplicate" ? result.outcome : "stored";
    log(kind === "stored" ? "LEAD_STORED" : kind === "merged" ? "LEAD_MERGED" : "DUPLICATE_LEAD", tenantId);
    return { status: 200, message: "Lead received", duplicate: kind !== "stored", outcome: kind, leadId: String(result?.lead_id ?? "") };
  }
}

/** Kept, listed as failed, answered 200: see SulekhaIntakeResult. */
async function notReadable(logId: string, tenantId: string, message: string): Promise<SulekhaIntakeResult> {
  log("NOT_READABLE", tenantId);
  await markFailed(logId, tenantId, message);
  return { status: 200, message: "Received", accepted: false, reason: message };
}

/**
 * The request headers as the log keeps them: our hosting's own headers dropped, anything that may carry a credential
 * hidden, at most 50, each at most 1,000 characters.
 */
export function loggableSulekhaHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  let count = 0;
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    if (HOSTING_HEADER.test(key)) continue;
    if (count >= MAX_LOGGED_HEADERS) break;
    result[key] = SECRET_HEADER.test(key) ? "[hidden]" : value.slice(0, MAX_LOGGED_HEADER_LENGTH);
    count += 1;
  }
  return result;
}

/** The sender's IP as our hosting saw it: the first x-forwarded-for value, else x-real-ip. */
export function sulekhaSourceIp(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers.get("x-real-ip")?.trim() || null;
}

function clip(value: string | null, max: number): string | null {
  const text = value?.trim();
  return text ? text.slice(0, max) : null;
}

/** Best effort: a log row left "received" still shows under Failed requests ("Not saved") after a few minutes. */
async function markFailed(logId: string, tenantId: string, message: string): Promise<void> {
  try {
    const { error } = await getSupabaseAdminClient().from("sulekha_webhook_logs")
      .update({ status: "failed", error_message: message.slice(0, 500), processed_at: new Date().toISOString() })
      .eq("id", logId)
      .eq("tenant_id", tenantId)
      .eq("status", "received");
    if (error) log("LOG_UPDATE_FAILED", tenantId);
  } catch {
    log("LOG_UPDATE_FAILED", tenantId);
  }
}

function failure(code: string, tenantId?: string): SulekhaIntakeResult {
  log(code, tenantId);
  return { status: 500, message: TEMPORARY_FAILURE };
}

// Ids and codes only: never an answer, a phone number, an email or the URL token.
function log(code: string, tenantId?: string): void {
  const line = JSON.stringify({ operation: "sulekha_lead_webhook", code, ...(tenantId ? { tenant_id: tenantId } : {}) });
  if (code.endsWith("FAILED")) console.error(line);
  else console.info(line);
}
