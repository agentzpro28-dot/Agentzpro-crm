import type { Metadata } from "next";
import { ConnectionPageClient } from "@/features/connection/connection-page-client";
import { CustomWebhookConnectionCard } from "@/features/connection/custom-webhook-connection-card";
import { GoogleAdsConnectionCard } from "@/features/connection/google-ads-connection-card";
import { PortalIntegrationCard } from "@/features/connection/portal-integration-card";

export const metadata: Metadata = {
  title: "Integrations",
};

export default function ConnectionPage() {
  return <div className="stack">
    <ConnectionPageClient />
    <GoogleAdsConnectionCard />
    <CustomWebhookConnectionCard />
    <PortalIntegrationCard portal="99acres" />
  </div>;
}
