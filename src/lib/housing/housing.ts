/**
 * Housing.com, the real-estate portal, pushes each enquiry to the company's own secret URL
 * (/api/webhooks/housing/<token>). Housing.com is a pipeline of its own: its tables (housing_integrations,
 * housing_webhook_logs), its functions (save_housing_url, find_housing_integration, ingest_housing_lead), its field
 * reader, rate limit, services, API and card share no code with any other lead platform. Its leads are saved in
 * lead_data with lead_source "housing".
 */
export const HOUSING_LABEL = "Housing.com";
/** The lead's name when Housing.com sends none. */
export const HOUSING_DEFAULT_LEAD_NAME = "Housing.com Lead";
/** How long the old URL keeps working after the owner regenerates it (save_housing_url in the migration). */
export const HOUSING_PREVIOUS_URL_DAYS = 7;

/** Why a Housing.com request could not be saved, as the Integrations card shows it to the owner. */
export type HousingFailureReason = "Mobile number or email not found" | "Unsupported format" | "Server error" | "Old webhook URL" | "Not saved";

/**
 * One request Housing.com sent that could not be saved, for the Integrations card (owner only): when, and why. The raw
 * request itself never reaches the browser; it stays in the log for our support team.
 */
export interface HousingFailedRequestView {
  id: string;
  createdAt: string;
  reason: HousingFailureReason;
}

export interface HousingOverview {
  canManage: boolean;
  /** The company created its Housing.com URL (it then shows in the Source filter, even if replaced later). */
  hasIntegration: boolean;
  /**
   * Only for the owner, and only when the Integrations card asks (details): the URL to give Housing.com (null when its
   * stored copy cannot be read; the card then offers Regenerate), when the last lead arrived on this URL, the old URL
   * still working after a regenerate (until when, and its last lead since then) and the last 10 failed requests. Null
   * otherwise.
   */
  integration: {
    url: string | null;
    lastLeadAt: string | null;
    previousUrl: { validUntil: string; lastLeadAt: string | null } | null;
    /** The owner paused Housing.com leads: every request is refused (404) until Resume. */
    paused: boolean;
    failedRequests: HousingFailedRequestView[];
  } | null;
}

/** What became of one enquiry: stored = a new lead; merged = a note on the lead with the same phone; duplicate = a retry. */
export type HousingLeadOutcome = "stored" | "merged" | "duplicate";
