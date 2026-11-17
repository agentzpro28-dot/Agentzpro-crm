"use client";

import { useEffect, useState } from "react";
import { LEAD_SOURCES, type LeadSource } from "@/features/leads/lead-options";
import type { ConnectionOverview } from "@/lib/types";
import type { PortalIntegrationStatus } from "@/lib/portal-leads/portals";
import { getConnectionOverview, getCustomWebhookOverview, getGoogleAdsOverview, getPortalIntegrationStatuses, type CustomWebhookOverview, type GoogleAdsOverview } from "@/services/crm-api-client";

/** The connection details the dashboard's warning needs; null where that check could not be loaded. */
export type ConnectionHealth = {
  meta: ConnectionOverview["connectionStatus"] | null;
  google: { hasWebhook: boolean; webhookStopped: boolean; needsReconnect: boolean } | null;
  webhook: { hasWebhook: boolean; webhookStopped: boolean } | null;
};

/** What each connection check returned; null where it could not be loaded. */
export type SourceChecks = {
  meta: Pick<ConnectionOverview, "pages"> | null;
  google: Pick<GoogleAdsOverview, "hasWebhook" | "webhookStopped"> | null;
  webhook: Pick<CustomWebhookOverview, "hasWebhook" | "webhookStopped"> | null;
  /** Which real-estate portals (99acres, ...) the company has set up. */
  portals: PortalIntegrationStatus[] | null;
};

/**
 * The lead sources this company uses, in LEAD_SOURCES order. Telecaller (the + button) always works. Facebook counts
 * once a Page was connected, not at Facebook login: the login is saved before the owner picks a Page. Google Ads counts
 * once the webhook was created, the only way Google leads arrive; "Sign in with Google" alone only adds campaign
 * names, and "Disconnect Google" would otherwise make it vanish again. Webhook counts once the company's custom
 * webhook was created. A portal (99acres) counts once its webhook URL was generated. Disconnected Pages and a stopped
 * webhook still count (neither row is ever deleted), so the company's existing leads stay filterable. A check that could
 * not be loaded keeps its source, so an error never hides real leads.
 */
export function availableLeadSources({ meta, google, webhook, portals }: SourceChecks): LeadSource[] {
  const portal = (id: PortalIntegrationStatus["portal"]) => portals === null || portals.some((item) => item.portal === id && item.hasIntegration);
  const shown: Record<LeadSource, boolean> = {
    facebook: meta === null || meta.pages.length > 0,
    google_ads: google === null || google.hasWebhook || google.webhookStopped,
    custom_webhook: webhook === null || webhook.hasWebhook || webhook.webhookStopped,
    "99acres": portal("99acres"),
    telecaller: true,
  };
  return LEAD_SOURCES.filter((source) => shown[source]);
}

/**
 * Loads the connection checks once, for the /leads Source filter and the dashboard's platform switch. `sources` is
 * null while loading. `health` is handed to the dashboard's connection warning so it doesn't ask again. The webhook
 * and portal checks never ask for a URL (that is the Integrations cards' alone). All checks run at the same time.
 */
export function useLeadSources(): { sources: LeadSource[] | null; health: ConnectionHealth } {
  const [state, setState] = useState<{ sources: LeadSource[] | null; health: ConnectionHealth }>({ sources: null, health: { meta: null, google: null, webhook: null } });

  useEffect(() => {
    let active = true;
    void Promise.allSettled([getConnectionOverview(), getGoogleAdsOverview(), getCustomWebhookOverview(), getPortalIntegrationStatuses()]).then(([metaResult, googleResult, webhookResult, portalResult]) => {
      if (!active) return;
      const meta = metaResult.status === "fulfilled" ? metaResult.value : null;
      const google = googleResult.status === "fulfilled" ? googleResult.value : null;
      const webhook = webhookResult.status === "fulfilled" ? webhookResult.value : null;
      const portals = portalResult.status === "fulfilled" ? portalResult.value.portals : null;
      setState({
        sources: availableLeadSources({ meta, google, webhook, portals }),
        health: {
          meta: meta?.connectionStatus ?? null,
          google: google ? { hasWebhook: google.hasWebhook, webhookStopped: google.webhookStopped, needsReconnect: google.needsReconnect } : null,
          webhook: webhook ? { hasWebhook: webhook.hasWebhook, webhookStopped: webhook.webhookStopped } : null,
        },
      });
    });
    return () => { active = false; };
  }, []);

  return state;
}
