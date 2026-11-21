/**
 * Real-estate portals that push leads to a company's portal webhook URL. One entry per portal; the id is also the
 * lead_data.lead_source value, the URL segment (/api/webhooks/leads/<id>/<token>) and portal_integrations.portal_name.
 *
 * Adding a portal (MagicBricks, NoBroker, RoofandFloor): add it here and to LEAD_SOURCES / DASHBOARD_PLATFORMS, and widen
 * portal_integrations' portal_name check, lead_data_lead_source_check and lead_data_portal_fields_check in a migration.
 */
export const PORTAL_IDS = ["99acres"] as const;
export type PortalId = (typeof PORTAL_IDS)[number];

export interface PortalDefinition {
  id: PortalId;
  /** The portal's name as people write it. */
  label: string;
  /** The lead's name when the portal sends none. */
  defaultLeadName: string;
}

export const PORTALS: Record<PortalId, PortalDefinition> = {
  "99acres": { id: "99acres", label: "99acres", defaultLeadName: "99acres Lead" },
};

export function parsePortalId(value: unknown): PortalId | null {
  return typeof value === "string" && (PORTAL_IDS as readonly string[]).includes(value) ? value as PortalId : null;
}

/** How long a portal's old URL keeps working after the owner regenerates it (save_portal_url in the migration). */
export const PORTAL_PREVIOUS_URL_DAYS = 7;

/** Which portals a company has set up: the /leads Source filter and the dashboard's platform switch. */
export interface PortalIntegrationStatus { portal: PortalId; hasIntegration: boolean }

/** Why a portal request could not be saved, as the Integrations card shows it to the owner. */
export type PortalFailureReason = "Mobile number or email not found" | "Unsupported format" | "Server error" | "Old webhook URL" | "Not saved";

/**
 * One request the portal sent that could not be saved, for the Integrations card (owner only): when, and why. The raw
 * request itself never reaches the browser; it stays in the log for our support team.
 */
export interface PortalFailedRequestView {
  id: string;
  createdAt: string;
  reason: PortalFailureReason;
}

export interface PortalIntegrationOverview {
  portal: PortalId;
  canManage: boolean;
  /** The company created this portal's URL (it then shows in the Source filter, even if replaced later). */
  hasIntegration: boolean;
  /**
   * Only for the owner, and only when the Integrations card asks (details): the URL to give the portal (null when its
   * stored copy cannot be read; the card then offers Regenerate), when the last lead arrived on this URL, the old URL
   * while it still works after a regenerate (until when, and its last lead) and the last 10 failed requests. Null
   * otherwise.
   */
  integration: {
    url: string | null;
    lastLeadAt: string | null;
    previousUrl: { validUntil: string; lastLeadAt: string | null } | null;
    failedRequests: PortalFailedRequestView[];
  } | null;
}

/** What became of one enquiry: stored = a new lead; merged = a note on the lead with the same phone; duplicate = a retry. */
export type PortalLeadOutcome = "stored" | "merged" | "duplicate";
