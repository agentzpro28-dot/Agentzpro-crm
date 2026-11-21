import "server-only";

import { createHash } from "node:crypto";
import type { MagicbricksLeadOutcome } from "@/lib/magicbricks/magicbricks";
import { checkMagicbricksRate } from "@/lib/server/magicbricks/magicbricks-rate-limit";
import { MAX_MAGICBRICKS_WEBHOOK_BODY_BYTES, MAGICBRICKS_PAYLOAD_MESSAGES, MagicbricksPayloadError, isEmptyMagicbricksRequest, mapMagicbricksLead } from "@/lib/server/magicbricks/magicbricks-lead-mapper";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";

/** The URL token: 32 random bytes, base64url without padding (43 characters). */
export const MAGICBRICKS_WEBHOOK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * What the MagicBricks webhook answers. 200 = saved (or already saved / added to an existing lead: `duplicate`), or
 * "Webhook ready" for an empty URL check. 4XX = a request we will never accept as sent, with a message MagicBricks can
 * show. 429 = too many leads this minute (try again after `retryAfterSeconds`). 500 = a failure on our side; MagicBricks
 * may retry, and a retry of the same enquiry is never saved twice.
 */
export type MagicbricksIntakeResult =
  | { status: 200; message: "Lead received"; duplicate: boolean; outcome: MagicbricksLeadOutcome; leadId: string }
  | { status: 200; message: "Webhook ready" }
  | { status: 400 | 404 | 413 | 415 | 500; message: string }
  | { status: 429; message: string; retryAfterSeconds: number };

export interface IncomingMagicbricksRequest {
  method: "GET" | "POST";
  headers: Headers;
  /** The URL parameters (a repeated one is a list). */
  query: Record<string, unknown>;
  rawBody: string;
}

/** The active integration a URL token belongs to (find_magicbricks_integration), and which of its URLs was used. */
export interface MagicbricksIntegrationRow {
  id: string;
  tenant_id: string;
  field_mapping: unknown;
  /** current = the URL shown in the card; previous = the URL before the last regenerate, still within its 7 days. */
  url_version: "current" | "previous";
}

/**
 * What the request log's error_message says when a request was not saved (besides MAGICBRICKS_PAYLOAD_MESSAGES). The
 * Integrations card turns each into a short label (magicbricks-integration-service.ts).
 */
export const MAGICBRICKS_LOG_MESSAGES = {
  unreadable: "The request could not be read.",
  urlReplaced: "This webhook URL is no longer active.",
  serverError: "Temporary failure on our side. MagicBricks may send it again.",
} as const;

const UNKNOWN_WEBHOOK = "Unknown webhook.";
const TEMPORARY_FAILURE = "Temporary failure, retry later.";
const MAX_LOGGED_HEADERS = 50;
const MAX_LOGGED_HEADER_LENGTH = 1000;
// Headers added by our own hosting, not sent by MagicBricks: they would only fill the log.
const DROPPED_HEADER = /^(x-vercel-|x-middleware-|x-invoke-|x-nextjs-|x-invocation-id$|x-matched-path$|x-real-ip$|x-forwarded-host$|x-forwarded-proto$|x-forwarded-port$|forwarded$)/;
// Anything that may carry a credential is logged as hidden, never as sent.
const HIDDEN_HEADER = /(cookie|authorization|token|secret|key|signature|password|auth)/;

/** SHA-256 of the URL token, as stored in magicbricks_integrations.url_token_hash. */
export function hashMagicbricksWebhookToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class MagicbricksLeadIntakeService {
  /** A request to /api/webhooks/magicbricks/<token>. The company comes only from the token, never from the request. */
  public async ingestFromWebhook(urlToken: string, request: IncomingMagicbricksRequest): Promise<MagicbricksIntakeResult> {
    if (!MAGICBRICKS_WEBHOOK_TOKEN_PATTERN.test(urlToken)) return { status: 404, message: UNKNOWN_WEBHOOK };
    if (Buffer.byteLength(request.rawBody, "utf8") > MAX_MAGICBRICKS_WEBHOOK_BODY_BYTES) return { status: 413, message: "Payload too large." };

    const tokenHash = hashMagicbricksWebhookToken(urlToken);
    // The current URL, or the old one while its 7 days last; the database's own clock decides.
    const { data, error } = await getSupabaseAdminClient().rpc("find_magicbricks_integration", { p_token_hash: tokenHash });
    if (error) return failure("INTEGRATION_LOOKUP_FAILED");
    const integration = (Array.isArray(data) ? data[0] : null) as MagicbricksIntegrationRow | undefined | null;
    // Not logged: a request that does not reach a company's integration must never fill anyone's log.
    if (!integration) return { status: 404, message: UNKNOWN_WEBHOOK };
    return this.ingestForIntegration(integration, tokenHash, request);
  }

  /**
   * One request for a known, active integration. The raw request is written to magicbricks_webhook_logs BEFORE it is
   * read, so an enquiry that cannot be read (unexpected field names, a new format) is never lost: our support team keeps
   * its copy, and the owner sees it under Failed requests in the card.
   */
  public async ingestForIntegration(integration: MagicbricksIntegrationRow, tokenHash: string, request: IncomingMagicbricksRequest): Promise<MagicbricksIntakeResult> {
    const tenantId = integration.tenant_id;

    const rate = await checkMagicbricksRate(integration.id);
    if (!rate.allowed) {
      log("RATE_LIMITED", tenantId);
      return { status: 429, message: "Too many leads. Try again shortly.", retryAfterSeconds: rate.retryAfterSeconds };
    }
    const leadRequest = { method: request.method, contentType: request.headers.get("content-type"), query: request.query, rawBody: request.rawBody };
    // A URL check (nothing sent at all): nothing to save or log.
    if (isEmptyMagicbricksRequest(leadRequest)) {
      log("EMPTY_REQUEST", tenantId);
      return { status: 200, message: "Webhook ready" };
    }

    const db = getSupabaseAdminClient();
    const { data: logRow, error: logError } = await db.from("magicbricks_webhook_logs")
      .insert({
        tenant_id: tenantId,
        integration_id: integration.id,
        http_method: request.method,
        headers: loggableMagicbricksHeaders(request.headers),
        query_params: request.query,
        raw_body: request.rawBody,
        url_version: integration.url_version,
      })
      .select("id")
      .single();
    // Without its raw copy the lead is not taken: MagicBricks is told to retry, so nothing is saved unseen.
    if (logError || !logRow) return failure("LOG_WRITE_FAILED", tenantId);
    const logId = String((logRow as { id: unknown }).id);

    let lead;
    try {
      lead = mapMagicbricksLead(leadRequest, { fieldMapping: integration.field_mapping });
    } catch (mapError) {
      if (mapError instanceof MagicbricksPayloadError) {
        log("INVALID_PAYLOAD", tenantId);
        await markFailed(logId, tenantId, mapError.message);
        return { status: mapError.status, message: mapError.message };
      }
      await markFailed(logId, tenantId, MAGICBRICKS_LOG_MESSAGES.unreadable);
      throw mapError;
    }

    const { data: outcome, error: ingestError } = await db.rpc("ingest_magicbricks_lead_on_url", {
      p_tenant_id: tenantId,
      p_integration_id: integration.id,
      p_log_id: logId,
      p_token_hash: tokenHash,
      p_lead_ref: lead.leadRef,
      p_project_name: lead.projectName,
      p_enquiry_summary: lead.enquirySummary,
      p_field_data: lead.fieldData,
      p_raw_payload: lead.rawPayload,
    });
    if (ingestError) {
      // The URL was replaced, stopped or reached the end of its 7 days between the lookup and the save.
      if (ingestError.code === "P0002") {
        await markFailed(logId, tenantId, MAGICBRICKS_LOG_MESSAGES.urlReplaced);
        return { status: 404, message: UNKNOWN_WEBHOOK };
      }
      // The database's own check: no mobile and no email (or an over-long enquiry id).
      if (ingestError.code === "22023") {
        log("INVALID_PAYLOAD", tenantId);
        await markFailed(logId, tenantId, MAGICBRICKS_PAYLOAD_MESSAGES.noContact);
        return { status: 400, message: MAGICBRICKS_PAYLOAD_MESSAGES.noContact };
      }
      await markFailed(logId, tenantId, MAGICBRICKS_LOG_MESSAGES.serverError);
      return failure("LEAD_INGEST_FAILED", tenantId);
    }
    const result = outcome as { outcome?: unknown; lead_id?: unknown } | null;
    const kind: MagicbricksLeadOutcome = result?.outcome === "merged" || result?.outcome === "duplicate" ? result.outcome : "stored";
    log(kind === "stored" ? "LEAD_STORED" : kind === "merged" ? "LEAD_MERGED" : "DUPLICATE_LEAD", tenantId);
    return { status: 200, message: "Lead received", duplicate: kind !== "stored", outcome: kind, leadId: String(result?.lead_id ?? "") };
  }
}

/**
 * The request headers as the log keeps them: our hosting's own headers dropped, anything that may carry a credential
 * hidden, at most 50, each at most 1,000 characters.
 */
export function loggableMagicbricksHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  let count = 0;
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    if (DROPPED_HEADER.test(key)) continue;
    if (count >= MAX_LOGGED_HEADERS) break;
    result[key] = HIDDEN_HEADER.test(key) ? "[hidden]" : value.slice(0, MAX_LOGGED_HEADER_LENGTH);
    count += 1;
  }
  return result;
}

/** Best effort: a log row left "received" still shows under Failed requests ("Not saved") after a few minutes. */
async function markFailed(logId: string, tenantId: string, message: string): Promise<void> {
  try {
    const { error } = await getSupabaseAdminClient().from("magicbricks_webhook_logs")
      .update({ status: "failed", error_message: message.slice(0, 500), processed_at: new Date().toISOString() })
      .eq("id", logId)
      .eq("tenant_id", tenantId)
      .eq("status", "received");
    if (error) log("LOG_UPDATE_FAILED", tenantId);
  } catch {
    log("LOG_UPDATE_FAILED", tenantId);
  }
}

function failure(code: string, tenantId?: string): MagicbricksIntakeResult {
  log(code, tenantId);
  return { status: 500, message: TEMPORARY_FAILURE };
}

// Ids and codes only: never an answer, a phone number, an email or the URL token.
function log(code: string, tenantId?: string): void {
  const line = JSON.stringify({ operation: "magicbricks_lead_webhook", code, ...(tenantId ? { tenant_id: tenantId } : {}) });
  if (code.endsWith("FAILED")) console.error(line);
  else console.info(line);
}
