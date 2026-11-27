import { describe, expect, it } from "vitest";
import { availableLeadSources } from "@/features/leads/use-lead-sources";

const NO_META = { pages: [] };
const META_PAGE = { pages: [{ id: "page-1", connectionId: "c-1", pageName: "Chennai Homes", category: null, pageIdLastFour: "1234", status: "active" as const, lastConnectedAt: "2026-10-01T00:00:00Z" }] };
const NO_GOOGLE = { hasWebhook: false, webhookStopped: false };
const NO_WEBHOOK = { hasWebhook: false, webhookStopped: false };
const NO_PORTALS = [{ portal: "99acres" as const, hasIntegration: false }];
const NO_MAGICBRICKS = { hasIntegration: false };
const NO_HOUSING = { hasIntegration: false };
const NO_SULEKHA = { hasIntegration: false };
const NO_NOBROKER = { hasIntegration: false };
const NO_OLX_HOME = { hasIntegration: false };

describe("availableLeadSources", () => {
  it("offers only Telecaller to a company with nothing connected", () => {
    expect(availableLeadSources({ meta: NO_META, google: NO_GOOGLE, webhook: NO_WEBHOOK, portals: NO_PORTALS, magicbricks: NO_MAGICBRICKS, housing: NO_HOUSING, sulekha: NO_SULEKHA, nobroker: NO_NOBROKER, olxHome: NO_OLX_HOME })).toEqual(["telecaller"]);
  });

  it("counts Facebook once a Page was connected, not at Facebook login", () => {
    expect(availableLeadSources({ meta: NO_META, google: NO_GOOGLE, webhook: NO_WEBHOOK, portals: NO_PORTALS, magicbricks: NO_MAGICBRICKS, housing: NO_HOUSING, sulekha: NO_SULEKHA, nobroker: NO_NOBROKER, olxHome: NO_OLX_HOME })).not.toContain("facebook");
    expect(availableLeadSources({ meta: META_PAGE, google: NO_GOOGLE, webhook: NO_WEBHOOK, portals: NO_PORTALS, magicbricks: NO_MAGICBRICKS, housing: NO_HOUSING, sulekha: NO_SULEKHA, nobroker: NO_NOBROKER, olxHome: NO_OLX_HOME })).toEqual(["facebook", "telecaller"]);
  });

  it("keeps Facebook after its Page was disconnected, so old leads stay filterable", () => {
    const disconnected = { pages: [{ ...META_PAGE.pages[0], status: "disconnected" as const }] };
    expect(availableLeadSources({ meta: disconnected, google: NO_GOOGLE, webhook: NO_WEBHOOK, portals: NO_PORTALS, magicbricks: NO_MAGICBRICKS, housing: NO_HOUSING, sulekha: NO_SULEKHA, nobroker: NO_NOBROKER, olxHome: NO_OLX_HOME })).toContain("facebook");
  });

  it.each([
    ["the webhook was created", { ...NO_GOOGLE, hasWebhook: true }],
    ["the webhook was stopped", { ...NO_GOOGLE, webhookStopped: true }],
  ])("counts Google Ads once %s", (_case, google) => {
    expect(availableLeadSources({ meta: NO_META, google, webhook: NO_WEBHOOK, portals: NO_PORTALS, magicbricks: NO_MAGICBRICKS, housing: NO_HOUSING, sulekha: NO_SULEKHA, nobroker: NO_NOBROKER, olxHome: NO_OLX_HOME })).toEqual(["telecaller", "google_ads"]);
  });

  // Without a webhook no Google lead can exist yet. After "Disconnect Google" the API sends `connection: null` with the
  // same webhook flags, so counting the sign-in would make Google Ads appear and then vanish.
  it("does not count Google sign-in alone, which brings no leads", () => {
    const signedInOnly = { ...NO_GOOGLE, connection: { email: "owner@example.com", connectedAt: "2026-10-01T00:00:00Z" } };
    expect(availableLeadSources({ meta: NO_META, google: signedInOnly, webhook: NO_WEBHOOK, portals: NO_PORTALS, magicbricks: NO_MAGICBRICKS, housing: NO_HOUSING, sulekha: NO_SULEKHA, nobroker: NO_NOBROKER, olxHome: NO_OLX_HOME })).toEqual(["telecaller"]);
  });

  it.each([
    ["the webhook was created", { ...NO_WEBHOOK, hasWebhook: true }],
    ["the webhook was stopped", { ...NO_WEBHOOK, webhookStopped: true }],
  ])("counts Webhook once %s, and only then", (_case, webhook) => {
    expect(availableLeadSources({ meta: NO_META, google: NO_GOOGLE, webhook, portals: NO_PORTALS, magicbricks: NO_MAGICBRICKS, housing: NO_HOUSING, sulekha: NO_SULEKHA, nobroker: NO_NOBROKER, olxHome: NO_OLX_HOME })).toEqual(["telecaller", "custom_webhook"]);
    expect(availableLeadSources({ meta: NO_META, google: NO_GOOGLE, webhook: NO_WEBHOOK, portals: NO_PORTALS, magicbricks: NO_MAGICBRICKS, housing: NO_HOUSING, sulekha: NO_SULEKHA, nobroker: NO_NOBROKER, olxHome: NO_OLX_HOME })).not.toContain("custom_webhook");
  });

  it("lists Facebook and Google Ads in the usual order when both are connected", () => {
    expect(availableLeadSources({ meta: META_PAGE, google: { ...NO_GOOGLE, hasWebhook: true }, webhook: NO_WEBHOOK, portals: NO_PORTALS, magicbricks: NO_MAGICBRICKS, housing: NO_HOUSING, sulekha: NO_SULEKHA, nobroker: NO_NOBROKER, olxHome: NO_OLX_HOME })).toEqual(["facebook", "telecaller", "google_ads"]);
  });

  it("lists every source, in the usual order, when all are connected", () => {
    expect(availableLeadSources({ meta: META_PAGE, google: { ...NO_GOOGLE, hasWebhook: true }, webhook: { ...NO_WEBHOOK, hasWebhook: true }, portals: NO_PORTALS, magicbricks: NO_MAGICBRICKS, housing: NO_HOUSING, sulekha: NO_SULEKHA, nobroker: NO_NOBROKER, olxHome: NO_OLX_HOME }))
      .toEqual(["facebook", "telecaller", "google_ads", "custom_webhook"]);
  });

  it("keeps a source whose check could not be loaded, so an error never hides real leads", () => {
    expect(availableLeadSources({ meta: null, google: NO_GOOGLE, webhook: NO_WEBHOOK, portals: NO_PORTALS, magicbricks: NO_MAGICBRICKS, housing: NO_HOUSING, sulekha: NO_SULEKHA, nobroker: NO_NOBROKER, olxHome: NO_OLX_HOME })).toEqual(["facebook", "telecaller"]);
    expect(availableLeadSources({ meta: NO_META, google: null, webhook: NO_WEBHOOK, portals: NO_PORTALS, magicbricks: NO_MAGICBRICKS, housing: NO_HOUSING, sulekha: NO_SULEKHA, nobroker: NO_NOBROKER, olxHome: NO_OLX_HOME })).toEqual(["telecaller", "google_ads"]);
    expect(availableLeadSources({ meta: NO_META, google: NO_GOOGLE, webhook: null, portals: NO_PORTALS, magicbricks: NO_MAGICBRICKS, housing: NO_HOUSING, sulekha: NO_SULEKHA, nobroker: NO_NOBROKER, olxHome: NO_OLX_HOME })).toEqual(["telecaller", "custom_webhook"]);
  });

  it("counts 99acres once its webhook URL was generated, and only then", () => {
    const portals = [{ portal: "99acres" as const, hasIntegration: true }];
    expect(availableLeadSources({ meta: NO_META, google: NO_GOOGLE, webhook: NO_WEBHOOK, portals, magicbricks: NO_MAGICBRICKS, housing: NO_HOUSING, sulekha: NO_SULEKHA, nobroker: NO_NOBROKER, olxHome: NO_OLX_HOME })).toEqual(["telecaller", "99acres"]);
    expect(availableLeadSources({ meta: NO_META, google: NO_GOOGLE, webhook: NO_WEBHOOK, portals: NO_PORTALS, magicbricks: NO_MAGICBRICKS, housing: NO_HOUSING, sulekha: NO_SULEKHA, nobroker: NO_NOBROKER, olxHome: NO_OLX_HOME })).not.toContain("99acres");
  });

  it("keeps 99acres when the portal check could not be loaded", () => {
    expect(availableLeadSources({ meta: NO_META, google: NO_GOOGLE, webhook: NO_WEBHOOK, portals: null, magicbricks: NO_MAGICBRICKS, housing: NO_HOUSING, sulekha: NO_SULEKHA, nobroker: NO_NOBROKER, olxHome: NO_OLX_HOME })).toEqual(["telecaller", "99acres"]);
  });

  it("lists 99acres after Webhook when every source is set up", () => {
    expect(availableLeadSources({ meta: META_PAGE, google: { ...NO_GOOGLE, hasWebhook: true }, webhook: { ...NO_WEBHOOK, hasWebhook: true }, portals: [{ portal: "99acres", hasIntegration: true }], magicbricks: NO_MAGICBRICKS, housing: NO_HOUSING, sulekha: NO_SULEKHA, nobroker: NO_NOBROKER, olxHome: NO_OLX_HOME }))
      .toEqual(["facebook", "telecaller", "google_ads", "custom_webhook", "99acres"]);
  });

  it("counts MagicBricks once its webhook URL was generated, and only then", () => {
    expect(availableLeadSources({ meta: NO_META, google: NO_GOOGLE, webhook: NO_WEBHOOK, portals: NO_PORTALS, magicbricks: { hasIntegration: true }, housing: NO_HOUSING, sulekha: NO_SULEKHA, nobroker: NO_NOBROKER, olxHome: NO_OLX_HOME })).toEqual(["telecaller", "magicbricks"]);
    expect(availableLeadSources({ meta: NO_META, google: NO_GOOGLE, webhook: NO_WEBHOOK, portals: NO_PORTALS, magicbricks: NO_MAGICBRICKS, housing: NO_HOUSING, sulekha: NO_SULEKHA, nobroker: NO_NOBROKER, olxHome: NO_OLX_HOME })).not.toContain("magicbricks");
  });

  it("keeps MagicBricks when its check could not be loaded, without touching the other sources", () => {
    expect(availableLeadSources({ meta: NO_META, google: NO_GOOGLE, webhook: NO_WEBHOOK, portals: NO_PORTALS, magicbricks: null, housing: NO_HOUSING, sulekha: NO_SULEKHA, nobroker: NO_NOBROKER, olxHome: NO_OLX_HOME })).toEqual(["telecaller", "magicbricks"]);
  });

  it("lists MagicBricks after 99acres when every source is set up", () => {
    expect(availableLeadSources({ meta: META_PAGE, google: { ...NO_GOOGLE, hasWebhook: true }, webhook: { ...NO_WEBHOOK, hasWebhook: true }, portals: [{ portal: "99acres", hasIntegration: true }], magicbricks: { hasIntegration: true }, housing: NO_HOUSING, sulekha: NO_SULEKHA, nobroker: NO_NOBROKER, olxHome: NO_OLX_HOME }))
      .toEqual(["facebook", "telecaller", "google_ads", "custom_webhook", "99acres", "magicbricks"]);
  });
  it("counts Housing.com once its webhook URL was generated, and only then", () => {
    expect(availableLeadSources({ meta: NO_META, google: NO_GOOGLE, webhook: NO_WEBHOOK, portals: NO_PORTALS, magicbricks: NO_MAGICBRICKS, housing: { hasIntegration: true }, sulekha: NO_SULEKHA, nobroker: NO_NOBROKER, olxHome: NO_OLX_HOME })).toEqual(["telecaller", "housing"]);
    expect(availableLeadSources({ meta: NO_META, google: NO_GOOGLE, webhook: NO_WEBHOOK, portals: NO_PORTALS, magicbricks: NO_MAGICBRICKS, housing: NO_HOUSING, sulekha: NO_SULEKHA, nobroker: NO_NOBROKER, olxHome: NO_OLX_HOME })).not.toContain("housing");
  });

  it("keeps Housing.com when its check could not be loaded, without touching the other sources", () => {
    expect(availableLeadSources({ meta: NO_META, google: NO_GOOGLE, webhook: NO_WEBHOOK, portals: NO_PORTALS, magicbricks: NO_MAGICBRICKS, housing: null, sulekha: NO_SULEKHA, nobroker: NO_NOBROKER, olxHome: NO_OLX_HOME })).toEqual(["telecaller", "housing"]);
  });

  it("lists Housing.com after MagicBricks when every source is set up", () => {
    expect(availableLeadSources({ meta: META_PAGE, google: { ...NO_GOOGLE, hasWebhook: true }, webhook: { ...NO_WEBHOOK, hasWebhook: true }, portals: [{ portal: "99acres", hasIntegration: true }], magicbricks: { hasIntegration: true }, housing: { hasIntegration: true }, sulekha: NO_SULEKHA, nobroker: NO_NOBROKER, olxHome: NO_OLX_HOME }))
      .toEqual(["facebook", "telecaller", "google_ads", "custom_webhook", "99acres", "magicbricks", "housing"]);
  });

  it("counts Sulekha once its webhook URL was generated, and only then", () => {
    expect(availableLeadSources({ meta: NO_META, google: NO_GOOGLE, webhook: NO_WEBHOOK, portals: NO_PORTALS, magicbricks: NO_MAGICBRICKS, housing: NO_HOUSING, sulekha: { hasIntegration: true }, nobroker: NO_NOBROKER, olxHome: NO_OLX_HOME })).toEqual(["telecaller", "sulekha"]);
    expect(availableLeadSources({ meta: NO_META, google: NO_GOOGLE, webhook: NO_WEBHOOK, portals: NO_PORTALS, magicbricks: NO_MAGICBRICKS, housing: NO_HOUSING, sulekha: NO_SULEKHA, nobroker: NO_NOBROKER, olxHome: NO_OLX_HOME })).not.toContain("sulekha");
  });

  it("keeps Sulekha when its check could not be loaded, without touching the other sources", () => {
    expect(availableLeadSources({ meta: NO_META, google: NO_GOOGLE, webhook: NO_WEBHOOK, portals: NO_PORTALS, magicbricks: NO_MAGICBRICKS, housing: NO_HOUSING, sulekha: null, nobroker: NO_NOBROKER, olxHome: NO_OLX_HOME })).toEqual(["telecaller", "sulekha"]);
  });

  it("lists Sulekha after Housing.com when every source is set up", () => {
    expect(availableLeadSources({ meta: META_PAGE, google: { ...NO_GOOGLE, hasWebhook: true }, webhook: { ...NO_WEBHOOK, hasWebhook: true }, portals: [{ portal: "99acres", hasIntegration: true }], magicbricks: { hasIntegration: true }, housing: { hasIntegration: true }, sulekha: { hasIntegration: true }, nobroker: NO_NOBROKER, olxHome: NO_OLX_HOME }))
      .toEqual(["facebook", "telecaller", "google_ads", "custom_webhook", "99acres", "magicbricks", "housing", "sulekha"]);
  });

  it("counts NoBroker once its webhook URL was generated, and only then", () => {
    expect(availableLeadSources({ meta: NO_META, google: NO_GOOGLE, webhook: NO_WEBHOOK, portals: NO_PORTALS, magicbricks: NO_MAGICBRICKS, housing: NO_HOUSING, sulekha: NO_SULEKHA, nobroker: { hasIntegration: true }, olxHome: NO_OLX_HOME })).toEqual(["telecaller", "nobroker"]);
    expect(availableLeadSources({ meta: NO_META, google: NO_GOOGLE, webhook: NO_WEBHOOK, portals: NO_PORTALS, magicbricks: NO_MAGICBRICKS, housing: NO_HOUSING, sulekha: NO_SULEKHA, nobroker: NO_NOBROKER, olxHome: NO_OLX_HOME })).not.toContain("nobroker");
  });

  it("keeps NoBroker when its check could not be loaded, without touching the other sources", () => {
    expect(availableLeadSources({ meta: NO_META, google: NO_GOOGLE, webhook: NO_WEBHOOK, portals: NO_PORTALS, magicbricks: NO_MAGICBRICKS, housing: NO_HOUSING, sulekha: NO_SULEKHA, nobroker: null, olxHome: NO_OLX_HOME })).toEqual(["telecaller", "nobroker"]);
  });

  it("lists NoBroker after Sulekha when every source is set up", () => {
    expect(availableLeadSources({ meta: META_PAGE, google: { ...NO_GOOGLE, hasWebhook: true }, webhook: { ...NO_WEBHOOK, hasWebhook: true }, portals: [{ portal: "99acres", hasIntegration: true }], magicbricks: { hasIntegration: true }, housing: { hasIntegration: true }, sulekha: { hasIntegration: true }, nobroker: { hasIntegration: true }, olxHome: NO_OLX_HOME }))
      .toEqual(["facebook", "telecaller", "google_ads", "custom_webhook", "99acres", "magicbricks", "housing", "sulekha", "nobroker"]);
  });

  it("counts OLX Home once its webhook URL was generated, and only then", () => {
    expect(availableLeadSources({ meta: NO_META, google: NO_GOOGLE, webhook: NO_WEBHOOK, portals: NO_PORTALS, magicbricks: NO_MAGICBRICKS, housing: NO_HOUSING, sulekha: NO_SULEKHA, nobroker: NO_NOBROKER, olxHome: { hasIntegration: true } })).toEqual(["telecaller", "olx_home"]);
    expect(availableLeadSources({ meta: NO_META, google: NO_GOOGLE, webhook: NO_WEBHOOK, portals: NO_PORTALS, magicbricks: NO_MAGICBRICKS, housing: NO_HOUSING, sulekha: NO_SULEKHA, nobroker: NO_NOBROKER, olxHome: NO_OLX_HOME })).not.toContain("olx_home");
  });

  it("keeps OLX Home when its check could not be loaded, without touching the other sources", () => {
    expect(availableLeadSources({ meta: NO_META, google: NO_GOOGLE, webhook: NO_WEBHOOK, portals: NO_PORTALS, magicbricks: NO_MAGICBRICKS, housing: NO_HOUSING, sulekha: NO_SULEKHA, nobroker: NO_NOBROKER, olxHome: null })).toEqual(["telecaller", "olx_home"]);
  });

  it("lists OLX Home after NoBroker when every source is set up", () => {
    expect(availableLeadSources({ meta: META_PAGE, google: { ...NO_GOOGLE, hasWebhook: true }, webhook: { ...NO_WEBHOOK, hasWebhook: true }, portals: [{ portal: "99acres", hasIntegration: true }], magicbricks: { hasIntegration: true }, housing: { hasIntegration: true }, sulekha: { hasIntegration: true }, nobroker: { hasIntegration: true }, olxHome: { hasIntegration: true } }))
      .toEqual(["facebook", "telecaller", "google_ads", "custom_webhook", "99acres", "magicbricks", "housing", "sulekha", "nobroker", "olx_home"]);
  });
});
