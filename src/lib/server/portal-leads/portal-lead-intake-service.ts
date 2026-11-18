import "server-only";

import { createHash } from "node:crypto";
import { parsePortalId, type PortalId, type PortalLeadOutcome } from "@/lib/portal-leads/portals";
import { checkCustomWebhookRate } from "@/lib/server/custom-webhook/webhook-rate-limit";
import { MAX_PORTAL_WEBHOOK_BODY_BYTES, PortalLeadPayloadError, isEmptyPortalRequest, mapPortalLead } from "@/lib/server/portal-leads/portal-lead-mapper";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";

/** The URL token: 32 random bytes, base64url without padding (43 characters). */
export const PORTAL_WEBHOOK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * What the portal webhook answers. 200 = saved (or already saved / added to an existing lead: `duplicate`), or "Webhook
 * ready" for an empty URL check. 4XX = a request we will never accept as sent, with a message the portal can show.
 * 429 = too many leads this minute (try again after `retryAfterSeconds`). 500 = a failure on our side; the portal may
 * retry, and a retry of the same enquiry is never saved twice.
 */
export type PortalIntakeResult =
  | { status: 200; message: "Lead received"; duplicate: boolean; outcome: PortalLeadOutcome; leadId: string }
  | { status: 200; message: "Webhook ready" }
  | { status: 400 | 404 | 413 | 415 | 500; message: string }
  | { status: 429; message: string; retryAfterSeconds: number };

export interface IncomingPortalRequest {
  method: "GET" | "POST";
  headers: Headers;
  /** The URL parameters (a repeated one is a list). */
  query: Record<string, unknown>;
  rawBody: string;
}

/** The integration row the intake needs, found by the URL token. */
export interface PortalIntegrationRow {
  id: string;
  tenant_id: string;
  portal_name: PortalId;
  is_active: boolean;
  field_mapping: unknown;
}

const UNKNOWN_WEBHOOK = "Unknown webhook.";
const TEMPORARY_FAILURE = "Temporary failure, retry later.";
const INTEGRATION_COLUMNS = "id,tenant_id,portal_name,is_active,field_mapping";
const MAX_LOGGED_HEADERS = 50;
const MAX_LOGGED_HEADER_LENGTH = 1000;
// Platform headers added by our own hosting, not sent by the portal: they would only fill the log.
const DROPPED_HEADER = /^(x-vercel-|x-middleware-|x-invoke-|x-nextjs-|x-invocation-id$|x-matched-path$|x-real-ip$|x-forwarded-host$|x-forwarded-proto$|x-forwarded-port$|forwarded$)/;
// Anything that may carry a credential is logged as hidden, never as sent.
const HIDDEN_HEADER = /(cookie|authorization|token|secret|key|signature|password|auth)/;

/** SHA-256 of the URL token, as stored in portal_integrations.url_token_hash. */
export function hashPortalWebhookToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class PortalLeadIntakeService {
  /** A request to /api/webhooks/leads/<portal>/<token>. The company comes only from the token, never from the request. */
  public async ingestFromWebhook(portalSegment: string, urlToken: string, request: IncomingPortalRequest): Promise<PortalIntakeResult> {
    const portal = parsePortalId(portalSegment);
    if (!portal || !PORTAL_WEBHOOK_TOKEN_PATTERN.test(urlToken)) return { status: 404, message: UNKNOWN_WEBHOOK };
    if (Buffer.byteLength(request.rawBody, "utf8") > MAX_PORTAL_WEBHOOK_BODY_BYTES) return { status: 413, message: "Payload too large." };

    const { data, error } = await getSupabaseAdminClient().from("portal_integrations")
      .select(INTEGRATION_COLUMNS)
      .eq("url_token_hash", hashPortalWebhookToken(urlToken))
      .eq("portal_name", portal)
      .maybeSingle();
    if (error) return failure(portal, "INTEGRATION_LOOKUP_FAILED");
    const integration = data as PortalIntegrationRow | null;
    // Not logged: a request that does not reach a company's integration must never fill anyone's log.
    if (!integration || !integration.is_active) return { status: 404, message: UNKNOWN_WEBHOOK };
    return this.ingestForIntegration(integration, request);
  }

  /**
   * One request for a known, active integration, after the public webhook's token lookup. The raw request is written to
   * portal_webhook_logs BEFORE it is read, so an enquiry that cannot be read (unexpected field names, a new format) is
   * never lost: our support team keeps its copy, and the owner sees it under Failed requests in the card.
   */
  public async ingestForIntegration(integration: PortalIntegrationRow, request: IncomingPortalRequest): Promise<PortalIntakeResult> {
    const portal = integration.portal_name;
    const tenantId = integration.tenant_id;

    const rate = await checkCustomWebhookRate(integration.id);
    if (!rate.allowed) {
      log(portal, "RATE_LIMITED", tenantId);
      return { status: 429, message: "Too many leads. Try again shortly.", retryAfterSeconds: rate.retryAfterSeconds };
    }
    // A URL check (nothing sent at all): nothing to save or log.
    if (isEmptyPortalRequest({ method: request.method, contentType: request.headers.get("content-type"), query: request.query, rawBody: request.rawBody })) {
      log(portal, "EMPTY_REQUEST", tenantId);
      return { status: 200, message: "Webhook ready" };
    }

    const db = getSupabaseAdminClient();
    const { data: logRow, error: logError } = await db.from("portal_webhook_logs")
      .insert({
        tenant_id: tenantId,
        integration_id: integration.id,
        portal_name: portal,
        http_method: request.method,
        headers: loggableHeaders(request.headers),
        query_params: request.query,
        raw_body: request.rawBody,
        is_test: false,
      })
      .select("id")
      .single();
    // Without its raw copy the lead is not taken: the portal is told to retry, so nothing is saved unseen.
    if (logError || !logRow) return failure(portal, "LOG_WRITE_FAILED", tenantId);
    const logId = String((logRow as { id: unknown }).id);

    let lead;
    try {
      lead = mapPortalLead(portal, { method: request.method, contentType: request.headers.get("content-type"), query: request.query, rawBody: request.rawBody }, { fieldMapping: integration.field_mapping });
    } catch (mapError) {
      if (mapError instanceof PortalLeadPayloadError) {
        log(portal, "INVALID_PAYLOAD", tenantId);
        await markFailed(logId, tenantId, mapError.message);
        return { status: mapError.status, message: mapError.message };
      }
      await markFailed(logId, tenantId, "The request could not be read.");
      throw mapError;
    }

    const { data: outcome, error: ingestError } = await db.rpc("ingest_portal_lead", {
      p_tenant_id: tenantId,
      p_integration_id: integration.id,
      p_log_id: logId,
      p_portal: portal,
      p_lead_ref: lead.leadRef,
      p_project_name: lead.projectName,
      p_enquiry_summary: lead.enquirySummary,
      p_field_data: lead.fieldData,
      p_raw_payload: lead.rawPayload,
      p_is_test: false,
    });
    if (ingestError) {
      // The URL was replaced or stopped between the lookup and the save.
      if (ingestError.code === "P0002") {
        await markFailed(logId, tenantId, "This webhook URL is no longer active.");
        return { status: 404, message: UNKNOWN_WEBHOOK };
      }
      // The database's own check (no phone and no email, or an over-long lead id).
      if (ingestError.code === "22023") {
        log(portal, "INVALID_PAYLOAD", tenantId);
        await markFailed(logId, tenantId, "Send mobile or email.");
        return { status: 400, message: "Send mobile or email." };
      }
      await markFailed(logId, tenantId, "Temporary failure on our side. The portal may send it again.");
      return failure(portal, "LEAD_INGEST_FAILED", tenantId);
    }
    const result = outcome as { outcome?: unknown; lead_id?: unknown } | null;
    const kind: PortalLeadOutcome = result?.outcome === "merged" || result?.outcome === "duplicate" ? result.outcome : "stored";
    log(portal, kind === "stored" ? "LEAD_STORED" : kind === "merged" ? "LEAD_MERGED" : "DUPLICATE_LEAD", tenantId);
    return { status: 200, message: "Lead received", duplicate: kind !== "stored", outcome: kind, leadId: String(result?.lead_id ?? "") };
  }
}

/**
 * The request headers as the log keeps them: our hosting's own headers dropped, anything that may carry a credential
 * hidden, at most 50, each at most 1,000 characters.
 */
export function loggableHeaders(headers: Headers): Record<string, string> {
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
    const { error } = await getSupabaseAdminClient().from("portal_webhook_logs")
      .update({ status: "failed", error_message: message.slice(0, 500), processed_at: new Date().toISOString() })
      .eq("id", logId)
      .eq("tenant_id", tenantId)
      .eq("status", "received");
    if (error) console.error(JSON.stringify({ operation: "portal_lead_webhook", code: "LOG_UPDATE_FAILED", tenant_id: tenantId }));
  } catch {
    console.error(JSON.stringify({ operation: "portal_lead_webhook", code: "LOG_UPDATE_FAILED", tenant_id: tenantId }));
  }
}

function failure(portal: PortalId, code: string, tenantId?: string): PortalIntakeResult {
  log(portal, code, tenantId);
  return { status: 500, message: TEMPORARY_FAILURE };
}

// Ids and codes only: never an answer, a phone number, an email or the URL token.
function log(portal: PortalId, code: string, tenantId?: string): void {
  const line = JSON.stringify({ operation: "portal_lead_webhook", portal, code, ...(tenantId ? { tenant_id: tenantId } : {}) });
  if (code.endsWith("FAILED")) console.error(line);
  else console.info(line);
}
