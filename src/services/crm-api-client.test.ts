import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Client = typeof import("@/services/crm-api-client");

let fetchMock: ReturnType<typeof vi.fn>;
let client: Client;
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
/** Reads (GETs) of one path; the webhook's create and stop requests use the same path with POST and DELETE. */
const calls = (path: string) => fetchMock.mock.calls.filter((call) => call[0] === path && !(call[1] as RequestInit | undefined)?.method).length;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-13T10:00:00.000Z"));
  fetchMock = vi.fn(async (path: string) => ok({ path }));
  vi.stubGlobal("fetch", fetchMock);
  // A fresh module per test: the shared checks live in module state.
  vi.resetModules();
  client = await import("@/services/crm-api-client");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("shared connection checks", () => {
  it("sends one request when the banner and the page ask at the same moment", async () => {
    await Promise.all([client.getConnectionOverview({ fresh: true }), client.getConnectionOverview(), client.getConnectionOverview()]);
    expect(calls("/api/meta/connection")).toBe(1);
  });

  it("reuses an answer for 60 s, then asks again", async () => {
    await Promise.all([client.getConnectionOverview(), client.getGoogleAdsOverview(), client.getCustomWebhookOverview()]);
    vi.setSystemTime(new Date("2026-11-13T10:00:59.000Z"));
    await Promise.all([client.getConnectionOverview(), client.getGoogleAdsOverview(), client.getCustomWebhookOverview()]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.setSystemTime(new Date("2026-11-13T10:01:00.000Z"));
    await Promise.all([client.getConnectionOverview(), client.getGoogleAdsOverview(), client.getCustomWebhookOverview()]);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("asks the server again for a fresh check, whatever is stored", async () => {
    await client.getConnectionOverview();
    await client.getConnectionOverview({ fresh: true });
    expect(calls("/api/meta/connection")).toBe(2);
  });

  it("never reuses a failed check", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 }));
    await expect(client.getConnectionOverview()).rejects.toThrow("down");
    await expect(client.getConnectionOverview()).resolves.toEqual({ path: "/api/meta/connection" });
    expect(calls("/api/meta/connection")).toBe(2);
  });

  it("forgets every stored check after a connection change made here, even a failed one", async () => {
    const change = [
      () => client.startMetaConnection("token"),
      () => client.connectSelectedPages("connection-1", ["page-1"]),
      () => client.disconnectFacebookPage("page-record-1"),
      () => client.disconnectMetaConnection("connection-1"),
      () => client.createGoogleAdsWebhook(),
      () => client.saveGoogleAdsAccounts(["1234567890"]),
      () => client.disconnectGoogleAds(),
      () => client.stopGoogleAdsWebhook(),
      () => client.createCustomWebhook(),
      () => client.stopCustomWebhook(),
      () => client.setCustomWebhookPaused(true),
      () => client.setPortalIntegrationPaused("99acres", true),
      () => client.setMagicbricksPaused(true),
      () => client.setHousingPaused(true),
      () => client.setNoBrokerPaused(true),
      () => client.disconnectNoBroker(),
      () => client.setSulekhaPaused(true),
      () => client.setOlxHomePaused(true),
    ];
    for (const [index, run] of change.entries()) {
      await Promise.all([client.getConnectionOverview(), client.getGoogleAdsOverview(), client.getCustomWebhookOverview()]);
      if (index % 2 === 1) fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "x" } }), { status: 500 }));
      await run().catch(() => undefined);
      await Promise.all([client.getConnectionOverview(), client.getGoogleAdsOverview(), client.getCustomWebhookOverview()]);
    }
    expect(calls("/api/meta/connection")).toBe(change.length + 1);
    expect(calls("/api/integrations/google")).toBe(change.length + 1);
    expect(calls("/api/integrations/custom-webhook")).toBe(change.length + 1);
  });

  it("forgets stored and running checks when the session's shell clears them (logout, login)", async () => {
    await Promise.all([client.getConnectionOverview(), client.getGoogleAdsOverview(), client.getCustomWebhookOverview()]);
    const running = client.getConnectionOverview({ fresh: true });
    client.clearConnectionChecks();
    await running;
    await Promise.all([client.getConnectionOverview(), client.getGoogleAdsOverview(), client.getCustomWebhookOverview()]);
    expect(calls("/api/meta/connection")).toBe(3);
    expect(calls("/api/integrations/google")).toBe(2);
    expect(calls("/api/integrations/custom-webhook")).toBe(2);
  });

  it("always reads the Connection cards' own views fresh", async () => {
    await client.getGoogleAdsOverview({ campaigns: true });
    await client.getGoogleAdsOverview({ campaigns: true });
    await client.getCustomWebhookOverview({ details: true });
    await client.getCustomWebhookOverview({ details: true });
    expect(calls("/api/integrations/google?campaigns=1")).toBe(2);
    expect(calls("/api/integrations/custom-webhook?details=1")).toBe(2);
  });
});

describe("portal (99acres) checks", () => {
  it("shares the /leads and dashboard portal check like the other connection checks, but reads the card's view fresh", async () => {
    await Promise.all([client.getPortalIntegrationStatuses(), client.getPortalIntegrationStatuses()]);
    await client.getPortalIntegrationStatuses();
    expect(calls("/api/integrations/portals")).toBe(1);
    await client.getPortalIntegrationOverview("99acres");
    await client.getPortalIntegrationOverview("99acres");
    expect(calls("/api/integrations/portals/99acres?details=1")).toBe(2);
  });

  it("forgets the stored checks after a new URL is generated", async () => {
    await client.getPortalIntegrationStatuses();
    await client.getPortalIntegrationStatuses();
    expect(calls("/api/integrations/portals")).toBe(1);
    await client.createPortalIntegration("99acres");
    await client.getPortalIntegrationStatuses();
    expect(calls("/api/integrations/portals")).toBe(2);
    expect(fetchMock).toHaveBeenCalledWith("/api/integrations/portals/99acres", expect.objectContaining({ method: "POST" }));
  });
});
