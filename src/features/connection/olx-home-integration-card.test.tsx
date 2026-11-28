import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { olxHomeLeadsStillOnOldUrl, type OlxHomeOverview } from "@/lib/olx-home/olx-home";

const URL_VALUE = "https://crm.example.com/api/webhooks/olx-home/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const FAILED = { id: "log-1", createdAt: "2026-11-24T10:00:00Z", reason: "Mobile number or email not found" as const };
const WAITING: OlxHomeOverview = { canManage: true, hasIntegration: true, disconnected: false, integration: { url: URL_VALUE, lastLeadAt: null, previousUrl: null, paused: false, failedRequests: [] } };
const withPrevious = (lastLeadAt: string | null, previousLastLeadAt: string | null): OlxHomeOverview => ({
  ...WAITING, integration: { ...WAITING.integration!, lastLeadAt, previousUrl: { validUntil: "2026-12-01T12:00:00Z", lastLeadAt: previousLastLeadAt } },
});

vi.mock("@/services/crm-api-client", () => ({
  getOlxHomeOverview: vi.fn(),
  createOlxHomeIntegration: vi.fn(),
  setOlxHomePaused: vi.fn(),
  disconnectOlxHome: vi.fn(),
}));

const { OlxHomeIntegrationCard, olxHomeRelativeTime } = await import("@/features/connection/olx-home-integration-card");
const api = await import("@/services/crm-api-client");

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.mocked(api.getOlxHomeOverview).mockReset().mockResolvedValue(WAITING);
  vi.mocked(api.createOlxHomeIntegration).mockReset().mockResolvedValue({ url: URL_VALUE });
  vi.mocked(api.setOlxHomePaused).mockReset().mockImplementation(async (paused) => ({ paused }));
  vi.mocked(api.disconnectOlxHome).mockReset().mockResolvedValue({ disconnected: true });
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => vi.unstubAllGlobals());

describe("OlxHomeIntegrationCard", () => {
  it("offers Generate when the company has no URL yet, then shows it", async () => {
    vi.mocked(api.getOlxHomeOverview).mockResolvedValueOnce({ canManage: true, hasIntegration: false, disconnected: false, integration: null });
    render(<OlxHomeIntegrationCard />);
    expect(await screen.findByText("Not set up")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "OLX Home" })).toBeInTheDocument();
    expect(screen.getByText("Receive property enquiries from your OLX Home account automatically.")).toBeInTheDocument();
    expect(screen.queryByText(/Requires an active/)).not.toBeInTheDocument();
    expect(screen.getByText("Generate the webhook URL first.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Generate webhook URL" }));
    await waitFor(() => expect(api.createOlxHomeIntegration).toHaveBeenCalledTimes(1));
    expect(await screen.findByLabelText("Webhook URL")).toHaveValue(URL_VALUE);
    expect(screen.getByText("Waiting for first lead", { selector: ".status-badge" })).toBeInTheDocument();
  });

  it("links to the OLX Home setup guide, opening it in a new tab", async () => {
    render(<OlxHomeIntegrationCard />);
    const link = await screen.findByRole("link", { name: /Read the setup guide before you generate your webhook URL/ });
    expect(link).toHaveAttribute("href", "/docs/integrations/olx-home");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("hides the URL like a password until Show, and Copy URL copies the real URL", async () => {
    render(<OlxHomeIntegrationCard />);
    const input = await screen.findByLabelText("Webhook URL");
    expect(input).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(input).toHaveAttribute("type", "text");
    fireEvent.click(screen.getByRole("button", { name: "Copy URL" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(URL_VALUE));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("says to send the URL to the account manager, with no Email or WhatsApp button", async () => {
    render(<OlxHomeIntegrationCard />);
    expect(await screen.findByText("Ask your OLX Home account manager to set up a PUSH integration to this URL, send a test lead, and share a sample payload.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Email/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /WhatsApp/ })).not.toBeInTheDocument();
  });

  it("asks before Regenerate, says the old URL works 7 more days, and keeps the URL on Cancel", async () => {
    render(<OlxHomeIntegrationCard />);
    await screen.findByLabelText("Webhook URL");
    fireEvent.click(screen.getByRole("button", { name: "Regenerate URL" }));
    expect(screen.getByText(/Your old URL keeps working for 7 days\. Send the new URL to your OLX Home account manager before then, or OLX Home will stop delivering leads\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.createOlxHomeIntegration).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Regenerate URL" }));
    fireEvent.click(screen.getByRole("button", { name: "Regenerate URL" }));
    await waitFor(() => expect(api.createOlxHomeIntegration).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("New URL created. Send it to your OLX Home account manager.")).toBeInTheDocument();
  });

  it("warns while leads still arrive only on the old URL, with the date it stops", async () => {
    vi.mocked(api.getOlxHomeOverview).mockResolvedValue(withPrevious(null, "2026-11-24T11:00:00Z"));
    render(<OlxHomeIntegrationCard />);
    expect(await screen.findByText(/Leads are still arriving on your old URL\. It stops on/)).toBeInTheDocument();
    expect(screen.getByText("Waiting for first lead", { selector: ".status-badge" })).toBeInTheDocument();
  });

  it("stops warning once the newest lead came on the new URL", async () => {
    vi.mocked(api.getOlxHomeOverview).mockResolvedValue(withPrevious("2026-11-24T12:00:00Z", "2026-11-24T11:00:00Z"));
    render(<OlxHomeIntegrationCard />);
    expect(await screen.findByText(/Your old URL works until/)).toBeInTheDocument();
    expect(screen.queryByText(/Leads are still arriving on your old URL/)).not.toBeInTheDocument();
  });

  it("warns again when the old URL gets a lead after the new one did", async () => {
    vi.mocked(api.getOlxHomeOverview).mockResolvedValue(withPrevious("2026-11-24T11:00:00Z", "2026-11-24T12:00:00Z"));
    render(<OlxHomeIntegrationCard />);
    expect(await screen.findByText(/Leads are still arriving on your old URL\. It stops on/)).toBeInTheDocument();
  });

  it("says until when the old URL works when nothing arrived on it", async () => {
    vi.mocked(api.getOlxHomeOverview).mockResolvedValue(withPrevious(null, null));
    render(<OlxHomeIntegrationCard />);
    expect(await screen.findByText(/Your old URL works until/)).toBeInTheDocument();
  });

  it("shows Connected with the last lead time once a lead arrived on the URL", async () => {
    vi.mocked(api.getOlxHomeOverview).mockResolvedValue({ ...WAITING, integration: { ...WAITING.integration!, lastLeadAt: new Date().toISOString() } });
    render(<OlxHomeIntegrationCard />);
    expect(await screen.findByText("Connected", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.getByText("Last lead received just now")).toBeInTheDocument();
  });

  it("lists failed requests only when there are some: time and reason", async () => {
    render(<OlxHomeIntegrationCard />);
    await screen.findByLabelText("Webhook URL");
    expect(screen.queryByRole("heading", { name: "Failed requests" })).not.toBeInTheDocument();
    vi.mocked(api.getOlxHomeOverview).mockResolvedValue({ ...WAITING, integration: { ...WAITING.integration!, failedRequests: [FAILED] } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    const heading = await screen.findByRole("heading", { name: "Failed requests" });
    const section = heading.closest("div")?.parentElement?.parentElement as HTMLElement;
    expect(within(section).getByText("Mobile number or email not found")).toBeInTheDocument();
  });

  it("offers Regenerate when the stored URL cannot be shown", async () => {
    vi.mocked(api.getOlxHomeOverview).mockResolvedValue({ ...WAITING, integration: { ...WAITING.integration!, url: null } });
    render(<OlxHomeIntegrationCard />);
    expect(await screen.findByText(/This URL can't be shown\. Regenerate it/)).toBeInTheDocument();
    expect(screen.queryByText("Ask your OLX Home account manager to set up a PUSH integration to this URL, send a test lead, and share a sample payload.")).not.toBeInTheDocument();
  });

  it("tells an employee that only the owner can set it up, with no URL", async () => {
    vi.mocked(api.getOlxHomeOverview).mockResolvedValue({ canManage: false, hasIntegration: true, disconnected: false, integration: null });
    render(<OlxHomeIntegrationCard />);
    expect(await screen.findByText("Only the company owner can set up OLX Home.")).toBeInTheDocument();
    expect(screen.getByText("Set up", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Webhook URL")).not.toBeInTheDocument();
  });

  it("shows the load error when the details cannot be loaded", async () => {
    vi.mocked(api.getOlxHomeOverview).mockRejectedValue(new Error("OLX Home details could not be loaded."));
    render(<OlxHomeIntegrationCard />);
    expect(await screen.findByText("OLX Home details could not be loaded.")).toBeInTheDocument();
  });
});

const CONNECTED_AT = "2026-11-24T09:00:00Z";
const CONNECTED: OlxHomeOverview = { ...WAITING, integration: { ...WAITING.integration!, lastLeadAt: CONNECTED_AT } };
const PAUSED: OlxHomeOverview = { ...WAITING, integration: { ...WAITING.integration!, lastLeadAt: CONNECTED_AT, paused: true } };

describe("OlxHomeIntegrationCard Pause / Resume", () => {
  it("puts Regenerate URL and Pause side by side in one row", async () => {
    render(<OlxHomeIntegrationCard />);
    const pause = await screen.findByRole("button", { name: "Pause" });
    const regenerate = screen.getByRole("button", { name: "Regenerate URL" });
    expect(pause.parentElement).toBe(regenerate.parentElement);
    // One fixed blue in light and dark mode, from this card's own CSS.
    expect(regenerate.className).toMatch(/^button \S*regenerateButton\S*$/);
  });

  it("asks first: Cancel (focused, at the top) and Esc change nothing", async () => {
    render(<OlxHomeIntegrationCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    const dialog = screen.getByRole("alertdialog", { name: "Pause OLX Home leads?" });
    expect(dialog).toHaveTextContent("While paused, every lead OLX Home sends is refused and cannot be recovered later. AgentzPro is not responsible for any leads lost during the pause. Click Resume at any time to start receiving OLX Home leads in your CRM again.");
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveFocus();
    fireEvent.click(cancel);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(api.setOlxHomePaused).not.toHaveBeenCalled();
  });

  it("OK pauses: the badge says Paused, the button turns to Resume and Connected is no longer shown", async () => {
    vi.mocked(api.getOlxHomeOverview).mockResolvedValueOnce(CONNECTED).mockResolvedValue(PAUSED);
    render(<OlxHomeIntegrationCard />);
    expect(await screen.findByText("Connected", { selector: ".status-badge" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "OK" }));
    await waitFor(() => expect(api.setOlxHomePaused).toHaveBeenCalledWith(true));
    expect(await screen.findByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(screen.getByText("Paused", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
    expect(screen.queryByText(/Last lead received/)).not.toBeInTheDocument();
    expect(screen.queryByText(/The status turns Connected/)).not.toBeInTheDocument();
    expect(screen.getByText("Lead delivery paused")).toBeInTheDocument();
    expect(screen.getByText("Last lead")).toBeInTheDocument();
    expect(screen.getByText("Click Resume to start receiving OLX Home leads again.")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("Resume needs no pop-up and brings Pause back", async () => {
    vi.mocked(api.getOlxHomeOverview).mockResolvedValueOnce(PAUSED).mockResolvedValue(CONNECTED);
    render(<OlxHomeIntegrationCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(api.setOlxHomePaused).toHaveBeenCalledWith(false));
    expect(await screen.findByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.getByText("Connected", { selector: ".status-badge" })).toBeInTheDocument();
  });

  it("stays paused after a Regenerate (Resume is still shown)", async () => {
    vi.mocked(api.getOlxHomeOverview).mockResolvedValue(PAUSED);
    render(<OlxHomeIntegrationCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Regenerate URL" }));
    const buttons = screen.getAllByRole("button", { name: "Regenerate URL" });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(api.createOlxHomeIntegration).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("New URL created. Send it to your OLX Home account manager.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(api.setOlxHomePaused).not.toHaveBeenCalled();
  });

  it("while paused, never says leads still arrive on the old URL", async () => {
    vi.mocked(api.getOlxHomeOverview).mockResolvedValue({ ...PAUSED, integration: { ...PAUSED.integration!, lastLeadAt: null, previousUrl: { validUntil: "2026-12-01T12:00:00Z", lastLeadAt: "2026-11-24T11:00:00Z" } } });
    render(<OlxHomeIntegrationCard />);
    expect(await screen.findByText(/^Your old URL is paused too\. It stops for good on .+\.$/)).toBeInTheDocument();
    expect(screen.queryByText(/Leads are still arriving on your old URL/)).not.toBeInTheDocument();
    expect(screen.getByText("None yet")).toBeInTheDocument();
  });

  it("shows why a pause failed and keeps Pause", async () => {
    vi.mocked(api.setOlxHomePaused).mockRejectedValue(new Error("OLX Home leads could not be paused. Try again."));
    render(<OlxHomeIntegrationCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "OK" }));
    expect(await screen.findByText("OLX Home leads could not be paused. Try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  });

  it("gives an employee no Pause, no Resume and no Paused label", async () => {
    vi.mocked(api.getOlxHomeOverview).mockResolvedValue({ canManage: false, hasIntegration: true, disconnected: false, integration: null });
    render(<OlxHomeIntegrationCard />);
    expect(await screen.findByText("Set up", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
    expect(screen.queryByText("Paused")).not.toBeInTheDocument();
  });
});

const DISCONNECTED: OlxHomeOverview = { canManage: true, hasIntegration: true, disconnected: true, integration: null };

describe("OlxHomeIntegrationCard Disconnect", () => {
  it("puts Disconnect in the same row as Regenerate URL and Pause, in one fixed red", async () => {
    render(<OlxHomeIntegrationCard />);
    const disconnect = await screen.findByRole("button", { name: "Disconnect" });
    expect(disconnect.parentElement).toBe(screen.getByRole("button", { name: "Pause" }).parentElement);
    expect(disconnect.parentElement).toBe(screen.getByRole("button", { name: "Regenerate URL" }).parentElement);
    expect(disconnect.className).toMatch(/^button \S*disconnectButton\S*$/);
  });

  it("disconnects on one click with no pop-up, then shows Disconnected and Generate new webhook URL", async () => {
    vi.mocked(api.getOlxHomeOverview).mockResolvedValueOnce(CONNECTED).mockResolvedValue(DISCONNECTED);
    render(<OlxHomeIntegrationCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(api.disconnectOlxHome).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Disconnected", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.getByText("Lead delivery stopped")).toBeInTheDocument();
    expect(screen.getByText("To receive OLX Home leads again, generate a new URL and send it to your OLX Home account manager.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate new webhook URL" })).toBeEnabled();
    // One fixed blue in light and dark mode, from this card's own CSS (the theme blue is too faint in dark mode).
    expect(screen.getByRole("button", { name: "Generate new webhook URL" }).className).toMatch(/^button \S*generateNewButton\S*$/);
    expect(screen.queryByLabelText("Webhook URL")).not.toBeInTheDocument();
    for (const name of ["Disconnect", "Pause", "Resume", "Regenerate URL", "Refresh"]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    expect(screen.getByText("Generate the webhook URL first.")).toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
    expect(api.setOlxHomePaused).not.toHaveBeenCalled();
    expect(api.createOlxHomeIntegration).not.toHaveBeenCalled();
  });

  it("disconnects a paused URL too", async () => {
    vi.mocked(api.getOlxHomeOverview).mockResolvedValueOnce(PAUSED).mockResolvedValue(DISCONNECTED);
    render(<OlxHomeIntegrationCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("Disconnected", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.queryByText("Paused")).not.toBeInTheDocument();
  });

  it("Generate new webhook URL connects again with a new URL", async () => {
    vi.mocked(api.getOlxHomeOverview).mockResolvedValueOnce(DISCONNECTED).mockResolvedValue(WAITING);
    render(<OlxHomeIntegrationCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Generate new webhook URL" }));
    await waitFor(() => expect(api.createOlxHomeIntegration).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("New URL created. Send it to your OLX Home account manager.")).toBeInTheDocument();
    expect(screen.getByLabelText("Webhook URL")).toHaveValue(URL_VALUE);
    expect(screen.getByText("Waiting for first lead", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.queryByText("Disconnected")).not.toBeInTheDocument();
  });

  it("shows why a disconnect failed and keeps the URL and Disconnect", async () => {
    vi.mocked(api.disconnectOlxHome).mockRejectedValue(new Error("OLX Home could not be disconnected. Try again."));
    render(<OlxHomeIntegrationCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("OLX Home could not be disconnected. Try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeEnabled();
    expect(screen.getByLabelText("Webhook URL")).toHaveValue(URL_VALUE);
  });

  it("tells an employee OLX Home is disconnected, with no buttons", async () => {
    vi.mocked(api.getOlxHomeOverview).mockResolvedValue({ ...DISCONNECTED, canManage: false });
    render(<OlxHomeIntegrationCard />);
    expect(await screen.findByText("Disconnected", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.getByText("Only the company owner can set up OLX Home.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate new webhook URL" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
  });

  it("gives an employee no Disconnect while OLX Home is set up", async () => {
    vi.mocked(api.getOlxHomeOverview).mockResolvedValue({ canManage: false, hasIntegration: true, disconnected: false, integration: null });
    render(<OlxHomeIntegrationCard />);
    expect(await screen.findByText("Set up", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
  });
});

describe("olxHomeLeadsStillOnOldUrl", () => {
  it("is true only while the newest lead came on the old URL", () => {
    expect(olxHomeLeadsStillOnOldUrl(null, null)).toBe(false);
    expect(olxHomeLeadsStillOnOldUrl("2026-11-24T10:00:00Z", null)).toBe(false);
    expect(olxHomeLeadsStillOnOldUrl(null, "2026-11-24T10:00:00Z")).toBe(true);
    expect(olxHomeLeadsStillOnOldUrl("2026-11-24T11:00:00Z", "2026-11-24T10:00:00Z")).toBe(false);
    expect(olxHomeLeadsStillOnOldUrl("2026-11-24T10:00:00Z", "2026-11-24T11:00:00Z")).toBe(true);
  });
});

describe("olxHomeRelativeTime", () => {
  it("reads like a person would say it", () => {
    const now = Date.parse("2026-11-24T12:00:00Z");
    expect(olxHomeRelativeTime("2026-11-24T11:59:50Z", now)).toBe("just now");
    expect(olxHomeRelativeTime("2026-11-24T11:55:00Z", now)).toBe("5 minutes ago");
    expect(olxHomeRelativeTime("2026-11-21T12:00:00Z", now)).toBe("3 days ago");
  });
});
