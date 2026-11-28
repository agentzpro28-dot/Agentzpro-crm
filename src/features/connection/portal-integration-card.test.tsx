import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PortalIntegrationOverview } from "@/lib/portal-leads/portals";

const URL_VALUE = "https://crm.example.com/api/webhooks/leads/99acres/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const FAILED = { id: "log-1", createdAt: "2026-11-17T10:00:00Z", reason: "Mobile number or email not found" as const };
const WAITING: PortalIntegrationOverview = { portal: "99acres", canManage: true, hasIntegration: true, disconnected: false, integration: { url: URL_VALUE, lastLeadAt: null, previousUrl: null, paused: false, failedRequests: [] } };

vi.mock("@/services/crm-api-client", () => ({
  getPortalIntegrationOverview: vi.fn(),
  createPortalIntegration: vi.fn(),
  setPortalIntegrationPaused: vi.fn(),
  disconnectPortalIntegration: vi.fn(),
}));

const { PortalIntegrationCard, relativeTime } = await import("@/features/connection/portal-integration-card");
const api = await import("@/services/crm-api-client");

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.mocked(api.getPortalIntegrationOverview).mockReset().mockResolvedValue(WAITING);
  vi.mocked(api.createPortalIntegration).mockReset().mockResolvedValue({ url: URL_VALUE });
  vi.mocked(api.setPortalIntegrationPaused).mockReset().mockImplementation(async (_portal, paused) => ({ paused }));
  vi.mocked(api.disconnectPortalIntegration).mockReset().mockResolvedValue({ disconnected: true });
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => vi.unstubAllGlobals());

describe("PortalIntegrationCard (99acres)", () => {
  it("offers Generate when the company has no URL yet, then shows it", async () => {
    vi.mocked(api.getPortalIntegrationOverview).mockResolvedValueOnce({ portal: "99acres", canManage: true, hasIntegration: false, disconnected: false, integration: null });
    render(<PortalIntegrationCard portal="99acres" />);
    expect(await screen.findByText("Not set up")).toBeInTheDocument();
    expect(screen.getAllByText("Generate the webhook URL first.")).toHaveLength(1);
    expect(screen.queryByText("Waiting for first lead")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Generate webhook URL" }));
    await waitFor(() => expect(api.createPortalIntegration).toHaveBeenCalledWith("99acres"));
    expect(await screen.findByLabelText("Webhook URL")).toHaveValue(URL_VALUE);
    expect(screen.getByText("Waiting for first lead", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.queryByText("Generate the webhook URL first.")).not.toBeInTheDocument();
  });

  it("links to the 99acres setup guide, opening it in a new tab", async () => {
    render(<PortalIntegrationCard portal="99acres" />);
    const link = await screen.findByRole("link", { name: /Read the setup guide before you generate your webhook URL/ });
    expect(link).toHaveAttribute("href", "/docs/integrations/99acres");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveTextContent("(opens in a new tab)");
  });

  it("hides the URL like a password until Show, and Copy URL copies the real URL", async () => {
    render(<PortalIntegrationCard portal="99acres" />);
    const input = await screen.findByLabelText("Webhook URL") as HTMLInputElement;
    expect(api.getPortalIntegrationOverview).toHaveBeenCalledWith("99acres");
    expect(input.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Copy URL" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(URL_VALUE));
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(input.type).toBe("text");
  });

  it("has only 2 steps (no 'send it to' step), with no email to copy and no test lead", async () => {
    render(<PortalIntegrationCard portal="99acres" />);
    await screen.findByLabelText("Webhook URL");
    expect(screen.queryByText(/Send it to/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "1Generate your webhook URL",
      "2Check that leads arrive",
    ]);
    expect(screen.getByText("Waiting for first lead", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("The status turns Connected when 99acres sends the first lead.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /email/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /test lead/i })).not.toBeInTheDocument();
  });

  it("says Connected with the last lead time once a lead arrived", async () => {
    vi.mocked(api.getPortalIntegrationOverview).mockResolvedValue({ ...WAITING, integration: { url: URL_VALUE, lastLeadAt: new Date(Date.now() - 5 * 60_000).toISOString(), previousUrl: null, paused: false, failedRequests: [] } });
    render(<PortalIntegrationCard portal="99acres" />);
    expect(await screen.findByText("Connected", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.getByText("Last lead received 5 minutes ago")).toBeInTheDocument();
  });

  it("asks before regenerating, then replaces the URL", async () => {
    render(<PortalIntegrationCard portal="99acres" />);
    fireEvent.click(await screen.findByRole("button", { name: "Regenerate URL" }));
    expect(screen.getByText("Your old URL keeps working for 7 days. Send the new URL to 99acres before then, or 99acres will stop delivering leads.")).toBeInTheDocument();
    expect(screen.queryByText(/stops working at once/)).not.toBeInTheDocument();
    expect(api.createPortalIntegration).not.toHaveBeenCalled();
    const buttons = screen.getAllByRole("button", { name: "Regenerate URL" });
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(api.createPortalIntegration).toHaveBeenCalledWith("99acres"));
    expect(await screen.findByText("New URL created. Send it to 99acres.")).toBeInTheDocument();
  });

  it("after a regenerate, says until when the old URL works", async () => {
    vi.mocked(api.getPortalIntegrationOverview).mockResolvedValue({ ...WAITING, integration: { url: URL_VALUE, lastLeadAt: null, previousUrl: { validUntil: "2026-11-28T10:00:00Z", lastLeadAt: null }, paused: false, failedRequests: [] } });
    render(<PortalIntegrationCard portal="99acres" />);
    expect(await screen.findByText(/^Your old URL works until /)).toBeInTheDocument();
    expect(screen.queryByText(/Leads are still arriving on your old URL/)).not.toBeInTheDocument();
  });

  it("warns when leads still arrive on the old URL", async () => {
    vi.mocked(api.getPortalIntegrationOverview).mockResolvedValue({ ...WAITING, integration: { url: URL_VALUE, lastLeadAt: null, previousUrl: { validUntil: "2026-11-28T10:00:00Z", lastLeadAt: "2026-11-21T10:00:00Z" }, paused: false, failedRequests: [] } });
    render(<PortalIntegrationCard portal="99acres" />);
    expect(await screen.findByText(/^Leads are still arriving on your old URL\. It stops on .+\. Send the new URL to 99acres\.$/)).toBeInTheDocument();
  });

  it("shows no old-URL notice when there is no old URL", async () => {
    render(<PortalIntegrationCard portal="99acres" />);
    await screen.findByLabelText("Webhook URL");
    expect(screen.queryByText(/old URL/)).not.toBeInTheDocument();
  });

  it("lists only the failed requests, each with its time and reason, and never the raw request", async () => {
    vi.mocked(api.getPortalIntegrationOverview).mockResolvedValue({ ...WAITING, integration: { url: URL_VALUE, lastLeadAt: null, previousUrl: null, paused: false, failedRequests: [FAILED, { id: "log-2", createdAt: "2026-11-16T08:00:00Z", reason: "Unsupported format" }] } });
    render(<PortalIntegrationCard portal="99acres" />);
    expect(await screen.findByRole("heading", { name: "Failed requests" })).toBeInTheDocument();
    expect(screen.getByText("These 99acres enquiries could not be saved. Contact AgentzPro support with the time shown.")).toBeInTheDocument();
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText("Failed")).toBeInTheDocument();
    expect(within(items[0]).getByText("Mobile number or email not found")).toBeInTheDocument();
    expect(within(items[1]).getByText("Unsupported format")).toBeInTheDocument();
    expect(screen.queryByText(/Send mobile or email/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View" })).not.toBeInTheDocument();
    expect(screen.queryByText("Recent requests")).not.toBeInTheDocument();
  });

  it("hides the failed requests section when nothing failed, and Refresh in step 2 reloads the status", async () => {
    render(<PortalIntegrationCard portal="99acres" />);
    await screen.findByLabelText("Webhook URL");
    expect(screen.queryByRole("heading", { name: "Failed requests" })).not.toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(api.getPortalIntegrationOverview).toHaveBeenCalledTimes(2));
  });

  it("shows an employee the status only, never the URL or the requests", async () => {
    vi.mocked(api.getPortalIntegrationOverview).mockResolvedValue({ portal: "99acres", canManage: false, hasIntegration: true, disconnected: false, integration: null });
    render(<PortalIntegrationCard portal="99acres" />);
    expect(await screen.findByText("Only the company owner can set up 99acres.")).toBeInTheDocument();
    expect(screen.getByText("Set up")).toBeInTheDocument();
    expect(screen.queryByLabelText("Webhook URL")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Regenerate URL" })).not.toBeInTheDocument();
  });

  it("offers Regenerate when the URL cannot be shown, and still shows the real status", async () => {
    vi.mocked(api.getPortalIntegrationOverview).mockResolvedValue({ ...WAITING, integration: { url: null, lastLeadAt: null, previousUrl: null, paused: false, failedRequests: [] } });
    render(<PortalIntegrationCard portal="99acres" />);
    expect(await screen.findByText("This URL can't be shown. Regenerate it, then send the new URL to 99acres.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Webhook URL")).not.toBeInTheDocument();
    expect(screen.queryByText("Generate the webhook URL first.")).not.toBeInTheDocument();
    expect(screen.getByText("Waiting for first lead", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Regenerate URL" })).toBeEnabled();
  });

  it("shows a load failure", async () => {
    vi.mocked(api.getPortalIntegrationOverview).mockRejectedValue(new Error("99acres details could not be loaded. Try again."));
    render(<PortalIntegrationCard portal="99acres" />);
    expect(await screen.findByText("99acres details could not be loaded. Try again.")).toBeInTheDocument();
  });
});

const CONNECTED_AT = "2026-11-17T09:00:00Z";
const CONNECTED: PortalIntegrationOverview = { ...WAITING, integration: { ...WAITING.integration!, lastLeadAt: CONNECTED_AT } };
const PAUSED: PortalIntegrationOverview = { ...WAITING, integration: { ...WAITING.integration!, lastLeadAt: CONNECTED_AT, paused: true } };

describe("PortalIntegrationCard (99acres) Pause / Resume", () => {
  it("puts Regenerate URL and Pause side by side in one row", async () => {
    render(<PortalIntegrationCard portal="99acres" />);
    const pause = await screen.findByRole("button", { name: "Pause" });
    const regenerate = screen.getByRole("button", { name: "Regenerate URL" });
    expect(pause.parentElement).toBe(regenerate.parentElement);
    // One fixed blue in light and dark mode, from this card's own CSS.
    expect(regenerate.className).toMatch(/^button \S*regenerateButton\S*$/);
  });

  it("asks first: Cancel (focused, at the top) and Esc change nothing", async () => {
    render(<PortalIntegrationCard portal="99acres" />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    const dialog = screen.getByRole("alertdialog", { name: "Pause 99acres leads?" });
    expect(dialog).toHaveTextContent("While paused, every lead 99acres sends is refused and cannot be recovered later. AgentzPro is not responsible for any leads lost during the pause. Click Resume at any time to start receiving 99acres leads in your CRM again.");
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveFocus();
    fireEvent.click(cancel);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(api.setPortalIntegrationPaused).not.toHaveBeenCalled();
  });

  it("OK pauses: the badge says Paused, the button turns to Resume and Connected is no longer shown", async () => {
    vi.mocked(api.getPortalIntegrationOverview).mockResolvedValueOnce(CONNECTED).mockResolvedValue(PAUSED);
    render(<PortalIntegrationCard portal="99acres" />);
    expect(await screen.findByText("Connected", { selector: ".status-badge" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "OK" }));
    await waitFor(() => expect(api.setPortalIntegrationPaused).toHaveBeenCalledWith("99acres", true));
    expect(await screen.findByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(screen.getByText("Paused", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
    expect(screen.queryByText(/Last lead received/)).not.toBeInTheDocument();
    expect(screen.queryByText(/The status turns Connected/)).not.toBeInTheDocument();
    expect(screen.getByText("Lead delivery paused")).toBeInTheDocument();
    expect(screen.getByText("Last lead")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("Resume needs no pop-up and brings Pause back", async () => {
    vi.mocked(api.getPortalIntegrationOverview).mockResolvedValueOnce(PAUSED).mockResolvedValue(CONNECTED);
    render(<PortalIntegrationCard portal="99acres" />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(api.setPortalIntegrationPaused).toHaveBeenCalledWith("99acres", false));
    expect(await screen.findByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.getByText("Connected", { selector: ".status-badge" })).toBeInTheDocument();
  });

  it("stays paused after a Regenerate (Resume is still shown)", async () => {
    vi.mocked(api.getPortalIntegrationOverview).mockResolvedValue(PAUSED);
    render(<PortalIntegrationCard portal="99acres" />);
    fireEvent.click(await screen.findByRole("button", { name: "Regenerate URL" }));
    const buttons = screen.getAllByRole("button", { name: "Regenerate URL" });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(api.createPortalIntegration).toHaveBeenCalledWith("99acres"));
    expect(await screen.findByText("New URL created. Send it to 99acres.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
  });

  it("while paused, never says leads still arrive on the old URL", async () => {
    vi.mocked(api.getPortalIntegrationOverview).mockResolvedValue({ ...PAUSED, integration: { ...PAUSED.integration!, previousUrl: { validUntil: "2026-11-28T10:00:00Z", lastLeadAt: "2026-11-21T10:00:00Z" } } });
    render(<PortalIntegrationCard portal="99acres" />);
    expect(await screen.findByText(/Your old URL is paused too/)).toBeInTheDocument();
    expect(screen.queryByText(/Leads are still arriving on your old URL/)).not.toBeInTheDocument();
  });

  it("shows why a pause failed and keeps Pause", async () => {
    vi.mocked(api.setPortalIntegrationPaused).mockRejectedValue(new Error("99acres leads could not be paused. Try again."));
    render(<PortalIntegrationCard portal="99acres" />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "OK" }));
    expect(await screen.findByText("99acres leads could not be paused. Try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  });

  it("gives an employee no Pause, no Resume and no Paused label", async () => {
    vi.mocked(api.getPortalIntegrationOverview).mockResolvedValue({ portal: "99acres", canManage: false, hasIntegration: true, disconnected: false, integration: null });
    render(<PortalIntegrationCard portal="99acres" />);
    expect(await screen.findByText("Set up", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
    expect(screen.queryByText("Paused")).not.toBeInTheDocument();
  });
});

const DISCONNECTED: PortalIntegrationOverview = { portal: "99acres", canManage: true, hasIntegration: true, disconnected: true, integration: null };

describe("PortalIntegrationCard (99acres) Disconnect", () => {
  it("puts Disconnect in the same row as Regenerate URL and Pause, in one fixed red", async () => {
    render(<PortalIntegrationCard portal="99acres" />);
    const disconnect = await screen.findByRole("button", { name: "Disconnect" });
    expect(disconnect.parentElement).toBe(screen.getByRole("button", { name: "Pause" }).parentElement);
    expect(disconnect.parentElement).toBe(screen.getByRole("button", { name: "Regenerate URL" }).parentElement);
    expect(disconnect.className).toMatch(/^button \S*disconnectButton\S*$/);
  });

  it("disconnects on one click with no pop-up, then shows Disconnected and Generate new webhook URL", async () => {
    vi.mocked(api.getPortalIntegrationOverview).mockResolvedValueOnce(CONNECTED).mockResolvedValue(DISCONNECTED);
    render(<PortalIntegrationCard portal="99acres" />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(api.disconnectPortalIntegration).toHaveBeenCalledWith("99acres"));
    expect(await screen.findByText("Disconnected", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.getByText("Lead delivery stopped")).toBeInTheDocument();
    expect(screen.getByText("To receive 99acres leads again, generate a new URL and send it to your 99acres account manager.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate new webhook URL" })).toBeEnabled();
    // One fixed blue in light and dark mode, from this card's own CSS (the theme blue is too faint in dark mode).
    expect(screen.getByRole("button", { name: "Generate new webhook URL" }).className).toMatch(/^button \S*generateNewButton\S*$/);
    expect(screen.queryByLabelText("Webhook URL")).not.toBeInTheDocument();
    for (const name of ["Disconnect", "Pause", "Resume", "Regenerate URL", "Refresh"]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    expect(screen.getByText("Generate the webhook URL first.")).toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
    expect(api.setPortalIntegrationPaused).not.toHaveBeenCalled();
    expect(api.createPortalIntegration).not.toHaveBeenCalled();
  });

  it("disconnects a paused URL too", async () => {
    vi.mocked(api.getPortalIntegrationOverview).mockResolvedValueOnce(PAUSED).mockResolvedValue(DISCONNECTED);
    render(<PortalIntegrationCard portal="99acres" />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("Disconnected", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.queryByText("Paused")).not.toBeInTheDocument();
  });

  it("Generate new webhook URL connects again with a new URL", async () => {
    vi.mocked(api.getPortalIntegrationOverview).mockResolvedValueOnce(DISCONNECTED).mockResolvedValue(WAITING);
    render(<PortalIntegrationCard portal="99acres" />);
    fireEvent.click(await screen.findByRole("button", { name: "Generate new webhook URL" }));
    await waitFor(() => expect(api.createPortalIntegration).toHaveBeenCalledWith("99acres"));
    expect(await screen.findByText("New URL created. Send it to 99acres.")).toBeInTheDocument();
    expect(screen.getByLabelText("Webhook URL")).toHaveValue(URL_VALUE);
    expect(screen.getByText("Waiting for first lead", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.queryByText("Disconnected")).not.toBeInTheDocument();
  });

  it("shows why a disconnect failed and keeps the URL and Disconnect", async () => {
    vi.mocked(api.disconnectPortalIntegration).mockRejectedValue(new Error("99acres could not be disconnected. Try again."));
    render(<PortalIntegrationCard portal="99acres" />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("99acres could not be disconnected. Try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeEnabled();
    expect(screen.getByLabelText("Webhook URL")).toHaveValue(URL_VALUE);
  });

  it("tells an employee 99acres is disconnected, with no buttons", async () => {
    vi.mocked(api.getPortalIntegrationOverview).mockResolvedValue({ ...DISCONNECTED, canManage: false });
    render(<PortalIntegrationCard portal="99acres" />);
    expect(await screen.findByText("Disconnected", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.getByText("Only the company owner can set up 99acres.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate new webhook URL" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
  });

  it("gives an employee no Disconnect while 99acres is set up", async () => {
    vi.mocked(api.getPortalIntegrationOverview).mockResolvedValue({ portal: "99acres", canManage: false, hasIntegration: true, disconnected: false, integration: null });
    render(<PortalIntegrationCard portal="99acres" />);
    expect(await screen.findByText("Set up", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
  });
});

describe("helpers", () => {
  it("says how long ago, in plain words", () => {
    const now = Date.parse("2026-11-17T10:00:00Z");
    expect(relativeTime("2026-11-17T09:59:40Z", now)).toBe("just now");
    expect(relativeTime("2026-11-17T09:55:00Z", now)).toBe("5 minutes ago");
    expect(relativeTime("2026-11-17T07:00:00Z", now)).toBe("3 hours ago");
    expect(relativeTime("2026-11-16T10:00:00Z", now)).toBe("yesterday");
  });
});
