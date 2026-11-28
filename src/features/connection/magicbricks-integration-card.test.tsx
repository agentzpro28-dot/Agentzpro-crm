import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MagicbricksOverview } from "@/lib/magicbricks/magicbricks";

const URL_VALUE = "https://crm.example.com/api/webhooks/magicbricks/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const FAILED = { id: "log-1", createdAt: "2026-11-18T10:00:00Z", reason: "Mobile number or email not found" as const };
const WAITING: MagicbricksOverview = { canManage: true, hasIntegration: true, disconnected: false, integration: { url: URL_VALUE, lastLeadAt: null, previousUrl: null, paused: false, failedRequests: [] } };

vi.mock("@/services/crm-api-client", () => ({
  getMagicbricksOverview: vi.fn(),
  createMagicbricksIntegration: vi.fn(),
  setMagicbricksPaused: vi.fn(),
  disconnectMagicbricks: vi.fn(),
}));

const { MagicbricksIntegrationCard, magicbricksRelativeTime } = await import("@/features/connection/magicbricks-integration-card");
const api = await import("@/services/crm-api-client");

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.mocked(api.getMagicbricksOverview).mockReset().mockResolvedValue(WAITING);
  vi.mocked(api.createMagicbricksIntegration).mockReset().mockResolvedValue({ url: URL_VALUE });
  vi.mocked(api.setMagicbricksPaused).mockReset().mockImplementation(async (paused) => ({ paused }));
  vi.mocked(api.disconnectMagicbricks).mockReset().mockResolvedValue({ disconnected: true });
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => vi.unstubAllGlobals());

describe("MagicbricksIntegrationCard", () => {
  it("offers Generate when the company has no URL yet, then shows it", async () => {
    vi.mocked(api.getMagicbricksOverview).mockResolvedValueOnce({ canManage: true, hasIntegration: false, disconnected: false, integration: null });
    render(<MagicbricksIntegrationCard />);
    expect(await screen.findByText("Not set up")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "MagicBricks" })).toBeInTheDocument();
    expect(screen.getAllByText("Generate the webhook URL first.")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Generate webhook URL" }));
    await waitFor(() => expect(api.createMagicbricksIntegration).toHaveBeenCalledTimes(1));
    expect(await screen.findByLabelText("Webhook URL")).toHaveValue(URL_VALUE);
    expect(screen.getByText("Waiting for first lead", { selector: ".status-badge" })).toBeInTheDocument();
  });

  it("links to the MagicBricks setup guide, opening it in a new tab", async () => {
    render(<MagicbricksIntegrationCard />);
    const link = await screen.findByRole("link", { name: /Read the setup guide before you generate your webhook URL/ });
    expect(link).toHaveAttribute("href", "/docs/integrations/magicbricks");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveTextContent("(opens in a new tab)");
  });

  it("hides the URL like a password until Show, and Copy URL copies the real URL", async () => {
    render(<MagicbricksIntegrationCard />);
    const input = await screen.findByLabelText("Webhook URL");
    expect(input).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(input).toHaveAttribute("type", "text");
    fireEvent.click(screen.getByRole("button", { name: "Copy URL" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(URL_VALUE));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("has only 2 steps (no 'send it to' step), with no unverified menu path", async () => {
    render(<MagicbricksIntegrationCard />);
    await screen.findByLabelText("Webhook URL");
    expect(screen.queryByText(/Send it to/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "1Generate your webhook URL",
      "2Check that leads arrive",
    ]);
    expect(screen.queryByText(/My Account/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /test lead/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /email/i })).not.toBeInTheDocument();
  });

  it("asks before Regenerate, then replaces the URL and says so", async () => {
    render(<MagicbricksIntegrationCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Regenerate URL" }));
    expect(screen.getByText("Your old URL keeps working for 7 days. Send the new URL to your MagicBricks account manager before then, or MagicBricks will stop delivering leads.")).toBeInTheDocument();
    expect(screen.queryByText(/stops working at once/)).not.toBeInTheDocument();
    expect(api.createMagicbricksIntegration).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Regenerate URL" }));
    await waitFor(() => expect(api.createMagicbricksIntegration).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("New URL created. Send it to your MagicBricks account manager.")).toBeInTheDocument();
  });

  it("after a regenerate, says until when the old URL works", async () => {
    vi.mocked(api.getMagicbricksOverview).mockResolvedValueOnce({ ...WAITING, integration: { url: URL_VALUE, lastLeadAt: null, previousUrl: { validUntil: "2026-11-28T10:00:00Z", lastLeadAt: null }, paused: false, failedRequests: [] } });
    render(<MagicbricksIntegrationCard />);
    expect(await screen.findByText(/^Your old URL works until /)).toBeInTheDocument();
    expect(screen.queryByText(/Leads are still arriving on your old URL/)).not.toBeInTheDocument();
  });

  it("warns when leads still arrive on the old URL", async () => {
    vi.mocked(api.getMagicbricksOverview).mockResolvedValueOnce({ ...WAITING, integration: { url: URL_VALUE, lastLeadAt: null, previousUrl: { validUntil: "2026-11-28T10:00:00Z", lastLeadAt: "2026-11-21T10:00:00Z" }, paused: false, failedRequests: [] } });
    render(<MagicbricksIntegrationCard />);
    expect(await screen.findByText(/^Leads are still arriving on your old URL\. It stops on .+\. Send the new URL to your MagicBricks account manager\.$/)).toBeInTheDocument();
  });

  it("shows no old-URL notice when there is no old URL", async () => {
    render(<MagicbricksIntegrationCard />);
    await screen.findByLabelText("Webhook URL");
    expect(screen.queryByText(/old URL/)).not.toBeInTheDocument();
  });

  it("shows Connected and the last lead time once a lead arrived", async () => {
    vi.mocked(api.getMagicbricksOverview).mockResolvedValueOnce({ ...WAITING, integration: { url: URL_VALUE, lastLeadAt: new Date(Date.now() - 5 * 60_000).toISOString(), previousUrl: null, paused: false, failedRequests: [] } });
    render(<MagicbricksIntegrationCard />);
    expect(await screen.findByText("Connected", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.getByText("Last lead received 5 minutes ago")).toBeInTheDocument();
  });

  it("lists failed requests (time and reason) only when there are some", async () => {
    render(<MagicbricksIntegrationCard />);
    await screen.findByLabelText("Webhook URL");
    expect(screen.queryByText("Failed requests")).not.toBeInTheDocument();
  });

  it("shows each failed request's time and short reason", async () => {
    vi.mocked(api.getMagicbricksOverview).mockResolvedValueOnce({ ...WAITING, integration: { url: URL_VALUE, lastLeadAt: null, previousUrl: null, paused: false, failedRequests: [FAILED] } });
    render(<MagicbricksIntegrationCard />);
    const heading = await screen.findByRole("heading", { name: "Failed requests" });
    const section = heading.closest("div")?.parentElement?.parentElement as HTMLElement;
    expect(within(section).getByText("Mobile number or email not found")).toBeInTheDocument();
    expect(within(section).getByText("Failed")).toBeInTheDocument();
  });

  it("offers Regenerate when the stored URL cannot be shown", async () => {
    vi.mocked(api.getMagicbricksOverview).mockResolvedValueOnce({ ...WAITING, integration: { url: null, lastLeadAt: null, previousUrl: null, paused: false, failedRequests: [] } });
    render(<MagicbricksIntegrationCard />);
    expect(await screen.findByText("This URL can't be shown. Regenerate it, then send the new URL to your MagicBricks account manager.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Webhook URL")).not.toBeInTheDocument();
  });

  it("shows an employee only that the owner sets it up, never the URL", async () => {
    vi.mocked(api.getMagicbricksOverview).mockResolvedValueOnce({ canManage: false, hasIntegration: true, disconnected: false, integration: null });
    render(<MagicbricksIntegrationCard />);
    expect(await screen.findByText("Only the company owner can set up MagicBricks.")).toBeInTheDocument();
    expect(screen.getByText("Set up", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Webhook URL")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate webhook URL" })).not.toBeInTheDocument();
  });

  it("shows the server's message when the details cannot be loaded", async () => {
    vi.mocked(api.getMagicbricksOverview).mockRejectedValueOnce(new Error("MagicBricks details could not be loaded."));
    render(<MagicbricksIntegrationCard />);
    expect(await screen.findByText("MagicBricks details could not be loaded.")).toBeInTheDocument();
  });
});

const CONNECTED_AT = "2026-11-18T09:00:00Z";
const CONNECTED: MagicbricksOverview = { ...WAITING, integration: { ...WAITING.integration!, lastLeadAt: CONNECTED_AT } };
const PAUSED: MagicbricksOverview = { ...WAITING, integration: { ...WAITING.integration!, lastLeadAt: CONNECTED_AT, paused: true } };

describe("MagicbricksIntegrationCard Pause / Resume", () => {
  it("puts Regenerate URL and Pause side by side in one row", async () => {
    render(<MagicbricksIntegrationCard />);
    const pause = await screen.findByRole("button", { name: "Pause" });
    const regenerate = screen.getByRole("button", { name: "Regenerate URL" });
    expect(pause.parentElement).toBe(regenerate.parentElement);
    // One fixed blue in light and dark mode, from this card's own CSS.
    expect(regenerate.className).toMatch(/^button \S*regenerateButton\S*$/);
  });

  it("asks first: Cancel (focused, at the top) and Esc change nothing", async () => {
    render(<MagicbricksIntegrationCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    const dialog = screen.getByRole("alertdialog", { name: "Pause MagicBricks leads?" });
    expect(dialog).toHaveTextContent("While paused, every lead MagicBricks sends is refused and cannot be recovered later. AgentzPro is not responsible for any leads lost during the pause. Click Resume at any time to start receiving MagicBricks leads in your CRM again.");
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveFocus();
    fireEvent.click(cancel);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(api.setMagicbricksPaused).not.toHaveBeenCalled();
  });

  it("OK pauses: the badge says Paused, the button turns to Resume and Connected is no longer shown", async () => {
    vi.mocked(api.getMagicbricksOverview).mockResolvedValueOnce(CONNECTED).mockResolvedValue(PAUSED);
    render(<MagicbricksIntegrationCard />);
    expect(await screen.findByText("Connected", { selector: ".status-badge" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "OK" }));
    await waitFor(() => expect(api.setMagicbricksPaused).toHaveBeenCalledWith(true));
    expect(await screen.findByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(screen.getByText("Paused", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
    expect(screen.queryByText(/Last lead received/)).not.toBeInTheDocument();
    expect(screen.queryByText(/The status turns Connected/)).not.toBeInTheDocument();
    expect(screen.getByText("Lead delivery paused")).toBeInTheDocument();
    expect(screen.getByText("Last lead")).toBeInTheDocument();
    expect(screen.getByText("Click Resume to start receiving MagicBricks leads again.")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("Resume needs no pop-up and brings Pause back", async () => {
    vi.mocked(api.getMagicbricksOverview).mockResolvedValueOnce(PAUSED).mockResolvedValue(CONNECTED);
    render(<MagicbricksIntegrationCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(api.setMagicbricksPaused).toHaveBeenCalledWith(false));
    expect(await screen.findByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.getByText("Connected", { selector: ".status-badge" })).toBeInTheDocument();
  });

  it("stays paused after a Regenerate (Resume is still shown)", async () => {
    vi.mocked(api.getMagicbricksOverview).mockResolvedValue(PAUSED);
    render(<MagicbricksIntegrationCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Regenerate URL" }));
    const buttons = screen.getAllByRole("button", { name: "Regenerate URL" });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(api.createMagicbricksIntegration).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("New URL created. Send it to your MagicBricks account manager.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(api.setMagicbricksPaused).not.toHaveBeenCalled();
  });

  it("while paused, never says leads still arrive on the old URL", async () => {
    vi.mocked(api.getMagicbricksOverview).mockResolvedValue({ ...PAUSED, integration: { ...PAUSED.integration!, previousUrl: { validUntil: "2026-11-28T10:00:00Z", lastLeadAt: "2026-11-21T10:00:00Z" } } });
    render(<MagicbricksIntegrationCard />);
    expect(await screen.findByText(/^Your old URL is paused too\. It stops for good on .+\.$/)).toBeInTheDocument();
    expect(screen.queryByText(/Leads are still arriving on your old URL/)).not.toBeInTheDocument();
  });

  it("shows why a pause failed and keeps Pause", async () => {
    vi.mocked(api.setMagicbricksPaused).mockRejectedValue(new Error("MagicBricks leads could not be paused. Try again."));
    render(<MagicbricksIntegrationCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "OK" }));
    expect(await screen.findByText("MagicBricks leads could not be paused. Try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  });

  it("gives an employee no Pause, no Resume and no Paused label", async () => {
    vi.mocked(api.getMagicbricksOverview).mockResolvedValue({ canManage: false, hasIntegration: true, disconnected: false, integration: null });
    render(<MagicbricksIntegrationCard />);
    expect(await screen.findByText("Only the company owner can set up MagicBricks.")).toBeInTheDocument();
    expect(screen.getByText("Set up", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
    expect(screen.queryByText("Paused")).not.toBeInTheDocument();
  });
});

const DISCONNECTED: MagicbricksOverview = { canManage: true, hasIntegration: true, disconnected: true, integration: null };

describe("MagicbricksIntegrationCard Disconnect", () => {
  it("puts Disconnect in the same row as Regenerate URL and Pause, in one fixed red", async () => {
    render(<MagicbricksIntegrationCard />);
    const disconnect = await screen.findByRole("button", { name: "Disconnect" });
    expect(disconnect.parentElement).toBe(screen.getByRole("button", { name: "Pause" }).parentElement);
    expect(disconnect.parentElement).toBe(screen.getByRole("button", { name: "Regenerate URL" }).parentElement);
    expect(disconnect.className).toMatch(/^button \S*disconnectButton\S*$/);
  });

  it("disconnects on one click with no pop-up, then shows Disconnected and Generate new webhook URL", async () => {
    vi.mocked(api.getMagicbricksOverview).mockResolvedValueOnce(CONNECTED).mockResolvedValue(DISCONNECTED);
    render(<MagicbricksIntegrationCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(api.disconnectMagicbricks).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Disconnected", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.getByText("Lead delivery stopped")).toBeInTheDocument();
    expect(screen.getByText("To receive MagicBricks leads again, generate a new URL and send it to your MagicBricks account manager.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate new webhook URL" })).toBeEnabled();
    // One fixed blue in light and dark mode, from this card's own CSS (the theme blue is too faint in dark mode).
    expect(screen.getByRole("button", { name: "Generate new webhook URL" }).className).toMatch(/^button \S*generateNewButton\S*$/);
    expect(screen.queryByLabelText("Webhook URL")).not.toBeInTheDocument();
    for (const name of ["Disconnect", "Pause", "Resume", "Regenerate URL", "Refresh"]) expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    expect(screen.getByText("Generate the webhook URL first.")).toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
    expect(api.setMagicbricksPaused).not.toHaveBeenCalled();
    expect(api.createMagicbricksIntegration).not.toHaveBeenCalled();
  });

  it("disconnects a paused URL too", async () => {
    vi.mocked(api.getMagicbricksOverview).mockResolvedValueOnce(PAUSED).mockResolvedValue(DISCONNECTED);
    render(<MagicbricksIntegrationCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("Disconnected", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.queryByText("Paused")).not.toBeInTheDocument();
    expect(screen.queryByText("Lead delivery paused")).not.toBeInTheDocument();
  });

  it("Generate new webhook URL connects again with a new URL", async () => {
    vi.mocked(api.getMagicbricksOverview).mockResolvedValueOnce(DISCONNECTED).mockResolvedValue(WAITING);
    render(<MagicbricksIntegrationCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Generate new webhook URL" }));
    await waitFor(() => expect(api.createMagicbricksIntegration).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("New URL created. Send it to your MagicBricks account manager.")).toBeInTheDocument();
    expect(screen.getByLabelText("Webhook URL")).toHaveValue(URL_VALUE);
    expect(screen.getByText("Waiting for first lead", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.queryByText("Disconnected")).not.toBeInTheDocument();
  });

  it("shows why a disconnect failed and keeps the URL and Disconnect", async () => {
    vi.mocked(api.disconnectMagicbricks).mockRejectedValue(new Error("MagicBricks could not be disconnected. Try again."));
    render(<MagicbricksIntegrationCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("MagicBricks could not be disconnected. Try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeEnabled();
    expect(screen.getByLabelText("Webhook URL")).toHaveValue(URL_VALUE);
  });

  it("tells an employee MagicBricks is disconnected, with no buttons", async () => {
    vi.mocked(api.getMagicbricksOverview).mockResolvedValue({ ...DISCONNECTED, canManage: false });
    render(<MagicbricksIntegrationCard />);
    expect(await screen.findByText("Disconnected", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.getByText("Only the company owner can set up MagicBricks.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate new webhook URL" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
  });

  it("gives an employee no Disconnect while MagicBricks is set up", async () => {
    vi.mocked(api.getMagicbricksOverview).mockResolvedValue({ canManage: false, hasIntegration: true, disconnected: false, integration: null });
    render(<MagicbricksIntegrationCard />);
    expect(await screen.findByText("Set up", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
  });
});

describe("magicbricksRelativeTime", () => {
  it.each([
    [10_000, "just now"],
    [5 * 60_000, "5 minutes ago"],
    [3 * 3_600_000, "3 hours ago"],
    [24 * 3_600_000, "yesterday"],
    [3 * 24 * 3_600_000, "3 days ago"],
  ])("writes %i ms ago as %s", (ago, text) => {
    const now = Date.parse("2026-11-18T12:00:00Z");
    expect(magicbricksRelativeTime(new Date(now - ago).toISOString(), now)).toBe(text);
  });
});
