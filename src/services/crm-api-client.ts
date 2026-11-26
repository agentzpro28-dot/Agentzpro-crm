import type { ConnectionOverview, EligibleFacebookPage } from "@/lib/types";
import type { PortalId, PortalIntegrationOverview, PortalIntegrationStatus } from "@/lib/portal-leads/portals";
import type { MagicbricksOverview } from "@/lib/magicbricks/magicbricks";
import type { HousingOverview } from "@/lib/housing/housing";
import type { SulekhaOverview } from "@/lib/sulekha/sulekha";
import type { NoBrokerOverview } from "@/lib/nobroker/nobroker";

type ApiErrorPayload = { error?: { message?: string; code?: string; details?: Record<string, unknown> } };

/**
 * Carries the server's machine-readable error code and details alongside the message, so callers can
 * branch on the failure instead of matching on prose. Needed so the connection page can recognise
 * META_PERMISSION_DENIED and re-request exactly the Facebook permissions that were declined.
 */
export class ApiError extends Error {
  public readonly code?: string;
  public readonly details?: Record<string, unknown>;

  public constructor(message: string, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: "same-origin", headers: { "content-type": "application/json", ...init?.headers } });
  const payload = (await response.json().catch(() => null)) as T | ApiErrorPayload | null;
  if (!response.ok) {
    const apiError = payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
    throw new ApiError(apiError?.message ?? "The request could not be completed.", apiError?.code, apiError?.details);
  }
  return payload as T;
}

/**
 * The three connection checks every CRM page makes (Facebook, Google Ads, webhook: the reconnect banner, the /leads
 * Source filter, the dashboard's platform switch) are shared within the browser tab, because each one costs a full
 * access check plus its own queries:
 * - a check already running is joined, so the banner and the page opening together send it once;
 * - an answer is reused for CONNECTION_CHECK_REUSE_MS (the banner's own re-check interval), so a click from Leads to
 *   Dashboard sends none again;
 * - a failed check is never reused;
 * - `fresh` (the Integrations page, the banner's own checks) skips a stored answer, but still joins one running now;
 * - every connection change made from this tab clears them all.
 */
const CONNECTION_CHECK_REUSE_MS = 60_000;
const connectionChecks = new Map<string, { promise: Promise<unknown>; settledAt: number | null }>();

function sharedConnectionCheck<T>(path: string, fresh: boolean): Promise<T> {
  const stored = connectionChecks.get(path);
  if (stored && (stored.settledAt === null || (!fresh && Date.now() - stored.settledAt < CONNECTION_CHECK_REUSE_MS))) {
    return stored.promise as Promise<T>;
  }
  const entry: { promise: Promise<T>; settledAt: number | null } = { promise: request<T>(path), settledAt: null };
  connectionChecks.set(path, entry);
  entry.promise.then(
    () => { entry.settledAt = Date.now(); },
    () => { if (connectionChecks.get(path) === entry) connectionChecks.delete(path); },
  );
  return entry.promise;
}

/**
 * Forgets every shared connection check. The checks belong to one signed-in session: the CRM shell calls this when it
 * opens and when it closes, because login, logout and idle logout all move in-page (the module stays loaded), and one
 * person's company must never be shown to the next person in the same tab.
 */
export function clearConnectionChecks(): void {
  connectionChecks.clear();
}

/** A request that changes a connection: afterwards no stored connection check may be reused. */
async function changeConnection<T>(path: string, init: RequestInit): Promise<T> {
  try {
    return await request<T>(path, init);
  } finally {
    clearConnectionChecks();
  }
}

export async function getConnectionOverview(options: { fresh?: boolean } = {}): Promise<ConnectionOverview> { return sharedConnectionCheck<ConnectionOverview>("/api/meta/connection", options.fresh === true); }
export async function startMetaConnection(shortLivedUserAccessToken: string): Promise<{ connectionId: string; pages: EligibleFacebookPage[] }> { return changeConnection("/api/meta/connections", { method: "POST", body: JSON.stringify({ short_lived_user_access_token: shortLivedUserAccessToken }) }); }
export async function connectSelectedPages(connectionId: string, facebookPageIds: string[]): Promise<ConnectionOverview> { return changeConnection("/api/meta/pages/connect", { method: "POST", body: JSON.stringify({ connection_id: connectionId, facebook_page_ids: facebookPageIds }) }); }
export async function disconnectFacebookPage(pageRecordId: string): Promise<ConnectionOverview> { return changeConnection("/api/meta/pages/disconnect", { method: "POST", body: JSON.stringify({ page_record_id: pageRecordId }) }); }
export async function disconnectMetaConnection(connectionId: string): Promise<ConnectionOverview> { return changeConnection("/api/meta/disconnect", { method: "POST", body: JSON.stringify({ connection_id: connectionId }) }); }

export type GoogleAdsOverview = {
  canManage: boolean;
  connection: { email: string; connectedAt: string } | null;
  needsReconnect: boolean;
  linkedAccounts: Array<{ customerId: string; name: string | null }>;
  /** lastLeadAt / lastTestAt count only deliveries made with the current key. campaigns: see getGoogleAdsOverview. */
  webhook: { url: string; key: string; lastLeadAt: string | null; lastTestAt: string | null; campaigns: Array<{ id: string; name: string }> | null } | null;
  hasWebhook: boolean;
  webhookStopped: boolean;
};
export type GoogleAdsAccountOption = { customerId: string; name: string | null; loginCustomerId: string | null; selected: boolean };

/**
 * campaigns: true (Connection card only) also lists the campaigns Google has delivered leads from with the current
 * key; without it webhook.campaigns is null, so /leads and the dashboard do no extra read.
 */
export async function getGoogleAdsOverview(options: { campaigns?: boolean } = {}): Promise<GoogleAdsOverview> {
  // The Connection card's view (with campaigns) is always read fresh; the plain check is shared (see above).
  return options.campaigns ? request<GoogleAdsOverview>("/api/integrations/google?campaigns=1") : sharedConnectionCheck<GoogleAdsOverview>("/api/integrations/google", false);
}
export async function createGoogleAdsWebhook(): Promise<{ url: string; key: string }> { return changeConnection("/api/integrations/google/webhook", { method: "POST", body: "{}" }); }
export async function getGoogleAdsAccountOptions(): Promise<{ accounts: GoogleAdsAccountOption[] }> { return request("/api/integrations/google/accounts"); }
export async function saveGoogleAdsAccounts(customerIds: string[]): Promise<{ saved: boolean }> { return changeConnection("/api/integrations/google/accounts", { method: "POST", body: JSON.stringify({ customerIds }) }); }
export async function disconnectGoogleAds(): Promise<{ disconnected: boolean }> { return changeConnection("/api/integrations/google/disconnect", { method: "POST", body: "{}" }); }
export async function stopGoogleAdsWebhook(): Promise<{ stopped: boolean }> { return changeConnection("/api/integrations/google/webhook", { method: "DELETE" }); }

export type CustomWebhookOverview = {
  canManage: boolean;
  hasWebhook: boolean;
  webhookStopped: boolean;
  /** Owner only, and only with details: true (the Connection card). lastLeadAt counts only leads sent to the current URL. */
  webhook: { url: string; lastLeadAt: string | null } | null;
};

/** details: true (Connection card only) adds the owner's webhook URL; /leads and the dashboard never ask for it. */
export async function getCustomWebhookOverview(options: { details?: boolean } = {}): Promise<CustomWebhookOverview> {
  // The Connection card's view (with the URL) is always read fresh; the plain check is shared (see above).
  return options.details ? request<CustomWebhookOverview>("/api/integrations/custom-webhook?details=1") : sharedConnectionCheck<CustomWebhookOverview>("/api/integrations/custom-webhook", false);
}
export async function createCustomWebhook(): Promise<{ url: string }> { return changeConnection("/api/integrations/custom-webhook", { method: "POST", body: "{}" }); }
export async function stopCustomWebhook(): Promise<{ stopped: boolean }> { return changeConnection("/api/integrations/custom-webhook", { method: "DELETE" }); }

/** Whether this company created its MagicBricks URL (canManage, hasIntegration); shared like the checks above. Never carries a URL. */
export async function getMagicbricksStatus(): Promise<MagicbricksOverview> { return sharedConnectionCheck<MagicbricksOverview>("/api/integrations/magicbricks", false); }
/** The Integrations card's MagicBricks view: always read fresh, with the owner's URL and the last 10 failed requests. */
export async function getMagicbricksOverview(): Promise<MagicbricksOverview> { return request<MagicbricksOverview>("/api/integrations/magicbricks?details=1"); }
export async function createMagicbricksIntegration(): Promise<{ url: string }> { return changeConnection("/api/integrations/magicbricks", { method: "POST", body: "{}" }); }

/** Whether this company created its Housing.com URL (canManage, hasIntegration); shared like the checks above. Never carries a URL. */
export async function getHousingStatus(): Promise<HousingOverview> { return sharedConnectionCheck<HousingOverview>("/api/integrations/housing", false); }
/** The Integrations card's Housing.com view: always read fresh, with the owner's URL, the old URL's handover and the last 10 failed requests. */
export async function getHousingOverview(): Promise<HousingOverview> { return request<HousingOverview>("/api/integrations/housing?details=1"); }
export async function createHousingIntegration(): Promise<{ url: string }> { return changeConnection("/api/integrations/housing", { method: "POST", body: "{}" }); }

/** Whether this company created its Sulekha URL (canManage, hasIntegration); shared like the checks above. Never carries a URL. */
export async function getSulekhaStatus(): Promise<SulekhaOverview> { return sharedConnectionCheck<SulekhaOverview>("/api/integrations/sulekha", false); }
/** The Integrations card's Sulekha view: always read fresh, with the owner's URL, the old URL's handover and the last 10 failed requests. */
export async function getSulekhaOverview(): Promise<SulekhaOverview> { return request<SulekhaOverview>("/api/integrations/sulekha?details=1"); }
export async function createSulekhaIntegration(): Promise<{ url: string }> { return changeConnection("/api/integrations/sulekha", { method: "POST", body: "{}" }); }

/** Whether this company created its NoBroker URL (canManage, hasIntegration); shared like the checks above. Never carries a URL. */
export async function getNoBrokerStatus(): Promise<NoBrokerOverview> { return sharedConnectionCheck<NoBrokerOverview>("/api/integrations/nobroker", false); }
/** The Integrations card's NoBroker view: always read fresh, with the owner's URL, the old URL's handover and the last 10 failed requests. */
export async function getNoBrokerOverview(): Promise<NoBrokerOverview> { return request<NoBrokerOverview>("/api/integrations/nobroker?details=1"); }
export async function createNoBrokerIntegration(): Promise<{ url: string }> { return changeConnection("/api/integrations/nobroker", { method: "POST", body: "{}" }); }

/** Which real-estate portals (99acres, ...) this company has set up; shared like the checks above. Never carries a URL. */
export async function getPortalIntegrationStatuses(): Promise<{ portals: PortalIntegrationStatus[] }> { return sharedConnectionCheck<{ portals: PortalIntegrationStatus[] }>("/api/integrations/portals", false); }
/** The Integrations card's view of one portal: always read fresh, with the owner's URL and the last 10 failed requests. */
export async function getPortalIntegrationOverview(portal: PortalId): Promise<PortalIntegrationOverview> { return request<PortalIntegrationOverview>(`/api/integrations/portals/${encodeURIComponent(portal)}?details=1`); }
export async function createPortalIntegration(portal: PortalId): Promise<{ url: string }> { return changeConnection(`/api/integrations/portals/${encodeURIComponent(portal)}`, { method: "POST", body: "{}" }); }