/**
 * Sulekha, the local services marketplace, pushes each customer enquiry to the company's own secret URL
 * (/api/webhooks/sulekha/<token>). Sulekha is a pipeline of its own: its tables (sulekha_integrations,
 * sulekha_webhook_logs), its functions (save_sulekha_url, find_sulekha_integration, ingest_sulekha_lead), its field
 * reader, rate limit, services, API and card share no code with any other lead platform. Its leads are saved in
 * lead_data with lead_source "sulekha".
 */
export const SULEKHA_LABEL = "Sulekha";
/** The lead's name when Sulekha sends none. */
export const SULEKHA_DEFAULT_LEAD_NAME = "Sulekha Lead";
/** How long the old URL keeps working after the owner regenerates it (save_sulekha_url in the migration). */
export const SULEKHA_PREVIOUS_URL_DAYS = 7;

/** Why a Sulekha request could not be saved, as the Integrations card shows it to the owner. */
export type SulekhaFailureReason = "Mobile number or email not found" | "Unsupported format" | "Server error" | "Old webhook URL" | "Not saved";

/**
 * One request Sulekha sent that could not be saved, for the Integrations card (owner only): when, and why. The raw
 * request itself never reaches the browser; it stays in the log for our support team.
 */
export interface SulekhaFailedRequestView {
  id: string;
  createdAt: string;
  reason: SulekhaFailureReason;
}

export interface SulekhaOverview {
  canManage: boolean;
  /** The company created its Sulekha URL (it then shows in the Source filter, even if replaced later). */
  hasIntegration: boolean;
  /**
   * Only for the owner, and only when the Integrations card asks (details): the URL to give Sulekha (null when its
   * stored copy cannot be read; the card then offers Regenerate), when the last lead arrived on this URL, the old URL
   * still working after a regenerate (until when, and its last lead since then) and the last 10 failed requests. Null
   * otherwise.
   */
  integration: {
    url: string | null;
    lastLeadAt: string | null;
    previousUrl: { validUntil: string; lastLeadAt: string | null } | null;
    failedRequests: SulekhaFailedRequestView[];
  } | null;
}

/** What became of one enquiry: stored = a new lead; merged = a note on the lead with the same phone; duplicate = a retry. */
export type SulekhaLeadOutcome = "stored" | "merged" | "duplicate";

/**
 * Whether the card warns that leads still arrive on the old URL: the newest lead came on the old URL (none yet on the
 * new one, or the old URL's lead is later). It comes back if Sulekha sends to the old URL again after the new one.
 */
export function sulekhaLeadsStillOnOldUrl(currentLastLeadAt: string | null, previousLastLeadAt: string | null): boolean {
  if (!previousLastLeadAt) return false;
  if (!currentLastLeadAt) return true;
  return Date.parse(previousLastLeadAt) > Date.parse(currentLastLeadAt);
}
