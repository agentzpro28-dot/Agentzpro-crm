/**
 * OLX Home, the real-estate portal, pushes each enquiry to the company's own secret URL
 * (/api/webhooks/olx-home/<token>). OLX Home is a pipeline of its own: its tables (olx_home_integrations,
 * olx_home_webhook_logs), its functions (save_olx_home_url, find_olx_home_integration, ingest_olx_home_lead), its field
 * reader, rate limit, services, API and card share no code with any other lead platform. Its leads are saved in
 * lead_data with lead_source "olx_home".
 */
export const OLX_HOME_LABEL = "OLX Home";
/** The lead's name when OLX Home sends none. */
export const OLX_HOME_DEFAULT_LEAD_NAME = "OLX Home Lead";
/** How long the old URL keeps working after the owner regenerates it (save_olx_home_url in the migration). */
export const OLX_HOME_PREVIOUS_URL_DAYS = 7;

/** Why an OLX Home request could not be saved, as the Integrations card shows it to the owner. */
export type OlxHomeFailureReason = "Mobile number or email not found" | "Unsupported format" | "Server error" | "Old webhook URL" | "Not saved";

/**
 * One request OLX Home sent that could not be saved, for the Integrations card (owner only): when, and why. The raw
 * request itself never reaches the browser; it stays in the log for our support team.
 */
export interface OlxHomeFailedRequestView {
  id: string;
  createdAt: string;
  reason: OlxHomeFailureReason;
}

export interface OlxHomeOverview {
  canManage: boolean;
  /** The company created its OLX Home URL (it then shows in the Source filter, even if replaced or disconnected later). */
  hasIntegration: boolean;
  /** The owner disconnected OLX Home: every request is refused (404) until a new URL is generated. */
  disconnected: boolean;
  /**
   * Only for the owner, and only when the Integrations card asks (details): the URL to give OLX Home (null when its
   * stored copy cannot be read; the card then offers Regenerate), when the last lead arrived on this URL, the old URL
   * still working after a regenerate (until when, and its last lead since then) and the last 10 failed requests. Null
   * otherwise.
   */
  integration: {
    url: string | null;
    lastLeadAt: string | null;
    previousUrl: { validUntil: string; lastLeadAt: string | null } | null;
    /** The owner paused OLX Home leads: every request is refused (404) until Resume. */
    paused: boolean;
    failedRequests: OlxHomeFailedRequestView[];
  } | null;
}

/** What became of one enquiry: stored = a new lead; merged = a note on the lead with the same phone; duplicate = a retry. */
export type OlxHomeLeadOutcome = "stored" | "merged" | "duplicate";

/**
 * Whether the card warns that leads still arrive on the old URL: the newest lead came on the old URL (none yet on the
 * new one, or the old URL's lead is later). It comes back if OLX Home sends to the old URL again after the new one.
 */
export function olxHomeLeadsStillOnOldUrl(currentLastLeadAt: string | null, previousLastLeadAt: string | null): boolean {
  if (!previousLastLeadAt) return false;
  if (!currentLastLeadAt) return true;
  return Date.parse(previousLastLeadAt) > Date.parse(currentLastLeadAt);
}
