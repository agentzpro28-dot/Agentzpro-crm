import type { Metadata } from "next";
import { ConnectionPageClient } from "@/features/connection/connection-page-client";
import { CustomWebhookConnectionCard } from "@/features/connection/custom-webhook-connection-card";
import { GoogleAdsConnectionCard } from "@/features/connection/google-ads-connection-card";
import { HousingIntegrationCard } from "@/features/connection/housing-integration-card";
import { MagicbricksIntegrationCard } from "@/features/connection/magicbricks-integration-card";
import { PortalIntegrationCard } from "@/features/connection/portal-integration-card";
import { SulekhaIntegrationCard } from "@/features/connection/sulekha-integration-card";
import { NoBrokerIntegrationCard } from "@/features/connection/nobroker-integration-card";

export const metadata: Metadata = {
  title: "Integrations",
};

export default function ConnectionPage() {
  return <div className="stack">
    <ConnectionPageClient />
    <GoogleAdsConnectionCard />
    <CustomWebhookConnectionCard />
    <PortalIntegrationCard portal="99acres" />
    <MagicbricksIntegrationCard />
    <HousingIntegrationCard />
    <SulekhaIntegrationCard />
    <NoBrokerIntegrationCard />
  </div>;
}
