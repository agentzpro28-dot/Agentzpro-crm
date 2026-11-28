/**
 * NoBroker, the real-estate portal, pushes each enquiry to the company's own secret URL
 * (/api/webhooks/nobroker/<token>). NoBroker is a pipeline of its own: its tables (nobroker_integrations,
 * nobroker_webhook_logs), its functions (save_nobroker_url, find_nobroker_integration, ingest_nobroker_lead), its field
 * reader, rate limit, services, API and card share no code with any other lead platform. Its leads are saved in
 * lead_data with lead_source "nobroker".
 */
export const NOBROKER_LABEL = "NoBroker";
/** The lead's name when NoBroker sends none. */
export const NOBROKER_DEFAULT_LEAD_NAME = "NoBroker Lead";
/** How long the old URL keeps working after the owner regenerates it (save_nobroker_url in the migration). */
export const NOBROKER_PREVIOUS_URL_DAYS = 7;

/** Why a NoBroker request could not be saved, as the Integrations card shows it to the owner. */
export type NoBrokerFailureReason = "Mobile number or email not found" | "Unsupported format" | "Server error" | "Old webhook URL" | "Not saved";

/**
 * One request NoBroker sent that could not be saved, for the Integrations card (owner only): when, and why. The raw
 * request itself never reaches the browser; it stays in the log for our support team.
 */
export interface NoBrokerFailedRequestView {
  id: string;
  createdAt: string;
  reason: NoBrokerFailureReason;
}

export interface NoBrokerOverview {
  canManage: boolean;
  /** The company created its NoBroker URL (it then shows in the Source filter, even if replaced or disconnected later). */
  hasIntegration: boolean;
  /** The owner disconnected NoBroker: every request is refused (404) until a new URL is generated. */
  disconnected: boolean;
  /**
   * Only for the owner, and only when the Integrations card asks (details): the URL to give NoBroker (null when its
   * stored copy cannot be read; the card then offers Regenerate), when the last lead arrived on this URL, the old URL
   * still working after a regenerate (until when, and its last lead since then) and the last 10 failed requests. Null
   * otherwise.
   */
  integration: {
    url: string | null;
    lastLeadAt: string | null;
    previousUrl: { validUntil: string; lastLeadAt: string | null } | null;
    /** The owner paused NoBroker leads: every request is refused (404) until Resume. */
    paused: boolean;
    failedRequests: NoBrokerFailedRequestView[];
  } | null;
}

/** What became of one enquiry: stored = a new lead; merged = a note on the lead with the same phone; duplicate = a retry. */
export type NoBrokerLeadOutcome = "stored" | "merged" | "duplicate";

/**
 * Whether the card warns that leads still arrive on the old URL: the newest lead came on the old URL (none yet on the
 * new one, or the old URL's lead is later). It comes back if NoBroker sends to the old URL again after the new one.
 */
export function nobrokerLeadsStillOnOldUrl(currentLastLeadAt: string | null, previousLastLeadAt: string | null): boolean {
  if (!previousLastLeadAt) return false;
  if (!currentLastLeadAt) return true;
  return Date.parse(previousLastLeadAt) > Date.parse(currentLastLeadAt);
}
