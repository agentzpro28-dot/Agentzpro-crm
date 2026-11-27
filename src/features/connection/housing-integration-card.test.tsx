import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HousingOverview } from "@/lib/housing/housing";

const URL_VALUE = "https://crm.example.com/api/webhooks/housing/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const FAILED = { id: "log-1", createdAt: "2026-11-20T10:00:00Z", reason: "Mobile number or email not found" as const };
const WAITING: HousingOverview = { canManage: true, hasIntegration: true, integration: { url: URL_VALUE, lastLeadAt: null, previousUrl: null, paused: false, failedRequests: [] } };

vi.mock("@/services/crm-api-client", () => ({
  getHousingOverview: vi.fn(),
  createHousingIntegration: vi.fn(),
  setHousingPaused: vi.fn(),
}));

const { HousingIntegrationCard, housingRelativeTime } = await import("@/features/connection/housing-integration-card");
const api = await import("@/services/crm-api-client");

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.mocked(api.getHousingOverview).mockReset().mockResolvedValue(WAITING);
  vi.mocked(api.createHousingIntegration).mockReset().mockResolvedValue({ url: URL_VALUE });
  vi.mocked(api.setHousingPaused).mockReset().mockImplementation(async (paused) => ({ paused }));
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => vi.unstubAllGlobals());

describe("HousingIntegrationCard", () => {
  it("offers Generate when the company has no URL yet, then shows it", async () => {
    vi.mocked(api.getHousingOverview).mockResolvedValueOnce({ canManage: true, hasIntegration: false, integration: null });
    render(<HousingIntegrationCard />);
    expect(await screen.findByText("Not set up")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Housing.com" })).toBeInTheDocument();
    expect(screen.getByText("Requires an active Housing.com package.")).toBeInTheDocument();
    expect(screen.getByText("Generate the webhook URL first.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Generate webhook URL" }));
    await waitFor(() => expect(api.createHousingIntegration).toHaveBeenCalledTimes(1));
    expect(await screen.findByLabelText("Webhook URL")).toHaveValue(URL_VALUE);
    expect(screen.getByText("Waiting for first lead", { selector: ".status-badge" })).toBeInTheDocument();
  });

  it("links to the Housing.com setup guide, opening it in a new tab", async () => {
    render(<HousingIntegrationCard />);
    const link = await screen.findByRole("link", { name: /Read the setup guide before you generate your webhook URL/ });
    expect(link).toHaveAttribute("href", "/docs/integrations/housing");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveTextContent("(opens in a new tab)");
  });

  it("hides the URL like a password until Show, and Copy URL copies the real URL", async () => {
    render(<HousingIntegrationCard />);
    const input = await screen.findByLabelText("Webhook URL");
    expect(input).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(input).toHaveAttribute("type", "text");
    fireEvent.click(screen.getByRole("button", { name: "Copy URL" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(URL_VALUE));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("says to send the URL to the account manager, with no Email or WhatsApp button", async () => {
    render(<HousingIntegrationCard />);
    expect(await screen.findByText("Send to your Housing.com account manager")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Email/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /WhatsApp/ })).not.toBeInTheDocument();
  });

  it("asks before Regenerate, says the old URL works 7 more days, and keeps the URL on Cancel", async () => {
    render(<HousingIntegrationCard />);
    await screen.findByLabelText("Webhook URL");
    fireEvent.click(screen.getByRole("button", { name: "Regenerate URL" }));
    expect(screen.getByText(/Your old URL keeps working for 7 days\. Send the new URL to your Housing\.com account manager before then, or Housing\.com will stop delivering leads\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.createHousingIntegration).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Regenerate URL" }));
    fireEvent.click(screen.getByRole("button", { name: "Regenerate URL" }));
    await waitFor(() => expect(api.createHousingIntegration).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("New URL created. Send it to your Housing.com account manager.")).toBeInTheDocument();
  });

  it("warns while leads still arrive only on the old URL, with the date it stops", async () => {
    vi.mocked(api.getHousingOverview).mockResolvedValue({ ...WAITING, integration: { ...WAITING.integration!, previousUrl: { validUntil: "2026-11-27T12:00:00Z", lastLeadAt: "2026-11-20T11:00:00Z" } } });
    render(<HousingIntegrationCard />);
    expect(await screen.findByText(/Leads are still arriving on your old URL\. It stops on/)).toBeInTheDocument();
    expect(screen.getByText("Waiting for first lead", { selector: ".status-badge" })).toBeInTheDocument();
  });

  it("says until when the old URL works when nothing arrived on it", async () => {
    vi.mocked(api.getHousingOverview).mockResolvedValue({ ...WAITING, integration: { ...WAITING.integration!, previousUrl: { validUntil: "2026-11-27T12:00:00Z", lastLeadAt: null } } });
    render(<HousingIntegrationCard />);
    expect(await screen.findByText(/Your old URL works until/)).toBeInTheDocument();
  });

  it("shows Connected with the last lead time once a lead arrived on the URL", async () => {
    vi.mocked(api.getHousingOverview).mockResolvedValue({ ...WAITING, integration: { ...WAITING.integration!, lastLeadAt: new Date().toISOString() } });
    render(<HousingIntegrationCard />);
    expect(await screen.findByText("Connected", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.getByText("Last lead received just now")).toBeInTheDocument();
  });

  it("lists failed requests only when there are some: time and reason", async () => {
    render(<HousingIntegrationCard />);
    await screen.findByLabelText("Webhook URL");
    expect(screen.queryByRole("heading", { name: "Failed requests" })).not.toBeInTheDocument();
    vi.mocked(api.getHousingOverview).mockResolvedValue({ ...WAITING, integration: { ...WAITING.integration!, failedRequests: [FAILED] } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    const heading = await screen.findByRole("heading", { name: "Failed requests" });
    const section = heading.closest("div")?.parentElement?.parentElement as HTMLElement;
    expect(within(section).getByText("Mobile number or email not found")).toBeInTheDocument();
  });

  it("offers Regenerate when the stored URL cannot be shown", async () => {
    vi.mocked(api.getHousingOverview).mockResolvedValue({ ...WAITING, integration: { ...WAITING.integration!, url: null } });
    render(<HousingIntegrationCard />);
    expect(await screen.findByText(/This URL can't be shown\. Regenerate it/)).toBeInTheDocument();
    expect(screen.queryByText("Send to your Housing.com account manager")).not.toBeInTheDocument();
  });

  it("tells an employee that only the owner can set it up, with no URL", async () => {
    vi.mocked(api.getHousingOverview).mockResolvedValue({ canManage: false, hasIntegration: true, integration: null });
    render(<HousingIntegrationCard />);
    expect(await screen.findByText("Only the company owner can set up Housing.com.")).toBeInTheDocument();
    expect(screen.getByText("Set up", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Webhook URL")).not.toBeInTheDocument();
  });

  it("shows the load error when the details cannot be loaded", async () => {
    vi.mocked(api.getHousingOverview).mockRejectedValue(new Error("Housing.com details could not be loaded."));
    render(<HousingIntegrationCard />);
    expect(await screen.findByText("Housing.com details could not be loaded.")).toBeInTheDocument();
  });
});

const CONNECTED_AT = "2026-11-20T09:00:00Z";
const CONNECTED: HousingOverview = { ...WAITING, integration: { ...WAITING.integration!, lastLeadAt: CONNECTED_AT } };
const PAUSED: HousingOverview = { ...WAITING, integration: { ...WAITING.integration!, lastLeadAt: CONNECTED_AT, paused: true } };

describe("HousingIntegrationCard Pause / Resume", () => {
  it("puts Regenerate URL and Pause side by side in one row", async () => {
    render(<HousingIntegrationCard />);
    const pause = await screen.findByRole("button", { name: "Pause" });
    const regenerate = screen.getByRole("button", { name: "Regenerate URL" });
    expect(pause.parentElement).toBe(regenerate.parentElement);
    expect(regenerate.className).toBe("button");
  });

  it("asks first: Cancel (focused, at the top) and Esc change nothing", async () => {
    render(<HousingIntegrationCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    const dialog = screen.getByRole("alertdialog", { name: "Pause Housing.com leads?" });
    expect(dialog).toHaveTextContent("While paused, every lead Housing.com sends is refused and cannot be recovered later. AgentzPro is not responsible for any leads lost during the pause. Click Resume at any time to start receiving Housing.com leads in your CRM again.");
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveFocus();
    fireEvent.click(cancel);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(api.setHousingPaused).not.toHaveBeenCalled();
  });

  it("OK pauses: the badge says Paused, the button turns to Resume and Connected is no longer shown", async () => {
    vi.mocked(api.getHousingOverview).mockResolvedValueOnce(CONNECTED).mockResolvedValue(PAUSED);
    render(<HousingIntegrationCard />);
    expect(await screen.findByText("Connected", { selector: ".status-badge" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "OK" }));
    await waitFor(() => expect(api.setHousingPaused).toHaveBeenCalledWith(true));
    expect(await screen.findByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(screen.getByText("Paused", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
    expect(screen.queryByText(/Last lead received/)).not.toBeInTheDocument();
    expect(screen.queryByText(/The status turns Connected/)).not.toBeInTheDocument();
    expect(screen.getByText("Lead delivery paused")).toBeInTheDocument();
    expect(screen.getByText("Last lead")).toBeInTheDocument();
    expect(screen.getByText("Click Resume to start receiving Housing.com leads again.")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("Resume needs no pop-up and brings Pause back", async () => {
    vi.mocked(api.getHousingOverview).mockResolvedValueOnce(PAUSED).mockResolvedValue(CONNECTED);
    render(<HousingIntegrationCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(api.setHousingPaused).toHaveBeenCalledWith(false));
    expect(await screen.findByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.getByText("Connected", { selector: ".status-badge" })).toBeInTheDocument();
  });

  it("stays paused after a Regenerate (Resume is still shown)", async () => {
    vi.mocked(api.getHousingOverview).mockResolvedValue(PAUSED);
    render(<HousingIntegrationCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Regenerate URL" }));
    const buttons = screen.getAllByRole("button", { name: "Regenerate URL" });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(api.createHousingIntegration).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("New URL created. Send it to your Housing.com account manager.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(api.setHousingPaused).not.toHaveBeenCalled();
  });

  it("while paused, never says leads still arrive on the old URL", async () => {
    vi.mocked(api.getHousingOverview).mockResolvedValue({ ...PAUSED, integration: { ...PAUSED.integration!, previousUrl: { validUntil: "2026-11-27T12:00:00Z", lastLeadAt: "2026-11-20T11:00:00Z" } } });
    render(<HousingIntegrationCard />);
    expect(await screen.findByText(/^Your old URL is paused too\. It stops for good on .+\.$/)).toBeInTheDocument();
    expect(screen.queryByText(/Leads are still arriving on your old URL/)).not.toBeInTheDocument();
  });

  it("shows why a pause failed and keeps Pause", async () => {
    vi.mocked(api.setHousingPaused).mockRejectedValue(new Error("Housing.com leads could not be paused. Try again."));
    render(<HousingIntegrationCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "OK" }));
    expect(await screen.findByText("Housing.com leads could not be paused. Try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  });

  it("gives an employee no Pause, no Resume and no Paused label", async () => {
    vi.mocked(api.getHousingOverview).mockResolvedValue({ canManage: false, hasIntegration: true, integration: null });
    render(<HousingIntegrationCard />);
    expect(await screen.findByText("Set up", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
    expect(screen.queryByText("Paused")).not.toBeInTheDocument();
  });
});

describe("housingRelativeTime", () => {
  it("reads like a person would say it", () => {
    const now = Date.parse("2026-11-20T12:00:00Z");
    expect(housingRelativeTime("2026-11-20T11:59:50Z", now)).toBe("just now");
    expect(housingRelativeTime("2026-11-20T11:55:00Z", now)).toBe("5 minutes ago");
    expect(housingRelativeTime("2026-11-17T12:00:00Z", now)).toBe("3 days ago");
  });
});
