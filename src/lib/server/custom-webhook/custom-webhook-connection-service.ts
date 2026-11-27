import "server-only";

import { randomBytes } from "node:crypto";
import { AppError } from "@/lib/server/app-error";
import { requireCrmAccess } from "@/lib/server/auth/access";
import { hashCustomWebhookToken } from "@/lib/server/custom-webhook/custom-lead-webhook-service";
import { decryptToken, encryptToken } from "@/lib/server/token-crypto";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";

export interface CustomWebhookOverview {
  canManage: boolean;
  /** The company's webhook is on: leads sent to its URL are saved. */
  hasWebhook: boolean;
  /** The owner stopped it: its URL is refused; creating it again issues a new URL. */
  webhookStopped: boolean;
  /**
   * Only for the owner, and only when the Connection card asks (`includeUrl`): the URL to paste into the company's
   * tools, when the last lead arrived on this URL (a lead sent before Replace URL does not count) and whether the owner
   * paused webhook leads (every request is then refused and nothing is saved). The /leads and
   * dashboard source check never asks, so the secret URL never travels to those pages.
   */
  webhook: { url: string; lastLeadAt: string | null; paused: boolean } | null;
}

type WebhookRow = { encrypted_url_token: string; is_active: boolean; last_lead_received_at: string | null; url_rotated_at: string | null; paused_at: string | null };

async function resolveOwner(): Promise<{ tenantId: string }> {
  const access = await requireCrmAccess();
  if (access.membershipRole !== "owner") {
    throw new AppError("Only the company owner can manage the webhook.", { status: 403, code: "CUSTOM_WEBHOOK_OWNER_REQUIRED" });
  }
  return { tenantId: access.tenantId };
}

export class CustomWebhookConnectionService {
  public async getOverview(origin: string, options: { includeUrl?: boolean } = {}): Promise<CustomWebhookOverview> {
    const access = await requireCrmAccess();
    const canManage = access.membershipRole === "owner";
    const { data, error } = await getSupabaseAdminClient().from("custom_lead_webhooks")
      .select("encrypted_url_token,is_active,last_lead_received_at,url_rotated_at,paused_at")
      .eq("tenant_id", access.tenantId)
      .maybeSingle();
    if (error) throw new AppError("Webhook details could not be loaded.", { status: 500, code: "CUSTOM_WEBHOOK_OVERVIEW_FAILED" });
    const row = data as WebhookRow | null;
    const active = Boolean(row?.is_active);
    return {
      canManage,
      hasWebhook: active,
      webhookStopped: Boolean(row && !row.is_active),
      webhook: canManage && options.includeUrl && row && active ? {
        url: buildWebhookUrl(origin, decryptToken(row.encrypted_url_token)),
        lastLeadAt: sinceRotation(row.last_lead_received_at, row.url_rotated_at),
        paused: row.paused_at !== null,
      } : null,
    };
  }

  /**
   * Creates the company's webhook URL, or replaces it. A new URL is made every time: after Replace URL (or Stop and
   * create again) the old URL is refused at once, so the company's tools must be given the new one.
   */
  public async createOrReplace(origin: string): Promise<{ url: string }> {
    const owner = await resolveOwner();
    const db = getSupabaseAdminClient();
    const token = randomBytes(32).toString("base64url");
    const secret = { url_token_hash: hashCustomWebhookToken(token), encrypted_url_token: encryptToken(token), is_active: true };

    const { data: existing, error: readError } = await db.from("custom_lead_webhooks").select("id").eq("tenant_id", owner.tenantId).maybeSingle();
    if (readError) throw saveFailed();
    if (!existing) {
      const { error } = await db.from("custom_lead_webhooks").insert({ tenant_id: owner.tenantId, ...secret });
      if (!error) return { url: buildWebhookUrl(origin, token) };
      // Another request created it at the same moment (one webhook per company): replace that one instead.
      if (error.code !== "23505") throw saveFailed();
    }
    const { error } = await db.from("custom_lead_webhooks")
      .update({ ...secret, url_rotated_at: new Date().toISOString() })
      .eq("tenant_id", owner.tenantId);
    if (error) throw saveFailed();
    return { url: buildWebhookUrl(origin, token) };
  }

  /**
   * Stops webhook leads for this company: every request to the URL is refused with 404 and nothing is saved (the
   * webhook route and ingest_custom_webhook_lead both require is_active). Leads already received stay. A pause ends
   * with it, so a webhook created again after Stop receives leads at once.
   */
  public async stop(): Promise<void> {
    const owner = await resolveOwner();
    const { error } = await getSupabaseAdminClient().from("custom_lead_webhooks")
      .update({ is_active: false, paused_at: null })
      .eq("tenant_id", owner.tenantId);
    if (error) throw new AppError("Webhook leads could not be stopped. Try again.", { status: 500, code: "CUSTOM_WEBHOOK_STOP_FAILED" });
  }

  /**
   * Pauses webhook leads (`paused` true) or resumes them (false), owner only. While paused, every request to the URL is
   * refused with 404 like a wrong URL and nothing is read, logged or saved (custom-lead-webhook-service.ts); Replace
   * URL keeps the pause. Only an active webhook can be paused or resumed: none yet, or stopped = 404.
   */
  public async setPaused(paused: boolean): Promise<{ paused: boolean }> {
    const owner = await resolveOwner();
    const { data, error } = await getSupabaseAdminClient().from("custom_lead_webhooks")
      .update({ paused_at: paused ? new Date().toISOString() : null })
      .eq("tenant_id", owner.tenantId)
      .eq("is_active", true)
      .select("id");
    if (error) {
      throw new AppError(paused ? "Webhook leads could not be paused. Try again." : "Webhook leads could not be resumed. Try again.", { status: 500, code: "CUSTOM_WEBHOOK_PAUSE_FAILED" });
    }
    if (!data || data.length === 0) throw new AppError("Create the webhook URL first.", { status: 404, code: "CUSTOM_WEBHOOK_NOT_FOUND" });
    return { paused };
  }
}

function saveFailed(): AppError {
  return new AppError("The webhook could not be saved. Try again.", { status: 500, code: "CUSTOM_WEBHOOK_SAVE_FAILED" });
}

/** A lead time counts only when it came after the URL was last replaced; with no replacement yet, it always does. */
function sinceRotation(at: string | null, rotatedAt: string | null): string | null {
  if (!at) return null;
  return !rotatedAt || Date.parse(at) > Date.parse(rotatedAt) ? at : null;
}

function buildWebhookUrl(origin: string, token: string): string {
  return new URL(`/api/webhooks/custom/${token}`, origin).toString();
}
