/**
 * MagicBricks, the real-estate portal, pushes each enquiry to the company's own secret URL
 * (/api/webhooks/magicbricks/<token>). MagicBricks is a pipeline of its own: its tables (magicbricks_integrations,
 * magicbricks_webhook_logs), its save function (ingest_magicbricks_lead_on_url), its field reader, rate limit, services, API
 * and card share no code with any other lead platform. Its leads are saved in lead_data with lead_source "magicbricks".
 */
export const MAGICBRICKS_LABEL = "MagicBricks";
/** The lead's name when MagicBricks sends none. */
export const MAGICBRICKS_DEFAULT_LEAD_NAME = "MagicBricks Lead";

/** How long the old MagicBricks URL keeps working after the owner regenerates it (save_magicbricks_url in the migration). */
export const MAGICBRICKS_PREVIOUS_URL_DAYS = 7;

/** Why a MagicBricks request could not be saved, as the Integrations card shows it to the owner. */
export type MagicbricksFailureReason = "Mobile number or email not found" | "Unsupported format" | "Server error" | "Old webhook URL" | "Not saved";

/**
 * One request MagicBricks sent that could not be saved, for the Integrations card (owner only): when, and why. The raw
 * request itself never reaches the browser; it stays in the log for our support team.
 */
export interface MagicbricksFailedRequestView {
  id: string;
  createdAt: string;
  reason: MagicbricksFailureReason;
}

export interface MagicbricksOverview {
  canManage: boolean;
  /** The company created its MagicBricks URL (it then shows in the Source filter, even if replaced or disconnected later). */
  hasIntegration: boolean;
  /** The owner disconnected MagicBricks: every request is refused (404) until a new URL is generated. */
  disconnected: boolean;
  /**
   * Only for the owner, and only when the Integrations card asks (details): the URL to give MagicBricks (null when its
   * stored copy cannot be read; the card then offers Regenerate), when the last lead arrived on this URL, the old URL
   * while it still works after a regenerate (until when, and its last lead) and the last 10 failed requests. Null
   * otherwise.
   */
  integration: {
    url: string | null;
    lastLeadAt: string | null;
    previousUrl: { validUntil: string; lastLeadAt: string | null } | null;
    /** The owner paused MagicBricks leads: every request is refused (404) until Resume. */
    paused: boolean;
    failedRequests: MagicbricksFailedRequestView[];
  } | null;
}

/** What became of one enquiry: stored = a new lead; merged = a note on the lead with the same phone; duplicate = a retry. */
export type MagicbricksLeadOutcome = "stored" | "merged" | "duplicate";
