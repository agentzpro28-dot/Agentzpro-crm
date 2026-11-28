import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sulekhaLeadsStillOnOldUrl, type SulekhaOverview } from "@/lib/sulekha/sulekha";

const URL_VALUE = "https://crm.example.com/api/webhooks/sulekha/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const FAILED = { id: "log-1", createdAt: "2026-11-24T10:00:00Z", reason: "Mobile number or email not found" as const };
const WAITING: SulekhaOverview = { canManage: true, hasIntegration: true, integration: { url: URL_VALUE, lastLeadAt: null, previousUrl: null, paused: false, failedRequests: [] } };
const withPrevious = (lastLeadAt: string | null, previousLastLeadAt: string | null): SulekhaOverview => ({
  ...WAITING, integration: { ...WAITING.integration!, lastLeadAt, previousUrl: { validUntil: "2026-12-01T12:00:00Z", lastLeadAt: previousLastLeadAt } },
});

vi.mock("@/services/crm-api-client", () => ({
  getSulekhaOverview: vi.fn(),
  createSulekhaIntegration: vi.fn(),
  setSulekhaPaused: vi.fn(),
}));

const { SulekhaIntegrationCard, sulekhaRelativeTime } = await import("@/features/connection/sulekha-integration-card");
const api = await import("@/services/crm-api-client");

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.mocked(api.getSulekhaOverview).mockReset().mockResolvedValue(WAITING);
  vi.mocked(api.createSulekhaIntegration).mockReset().mockResolvedValue({ url: URL_VALUE });
  vi.mocked(api.setSulekhaPaused).mockReset().mockImplementation(async (paused) => ({ paused }));
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => vi.unstubAllGlobals());

describe("SulekhaIntegrationCard", () => {
  it("offers Generate when the company has no URL yet, then shows it", async () => {
    vi.mocked(api.getSulekhaOverview).mockResolvedValueOnce({ canManage: true, hasIntegration: false, integration: null });
    render(<SulekhaIntegrationCard />);
    expect(await screen.findByText("Not set up")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sulekha" })).toBeInTheDocument();
    expect(screen.getByText("Receive customer enquiries from your Sulekha account automatically.")).toBeInTheDocument();
    expect(screen.getByText("Requires an active Sulekha package.")).toBeInTheDocument();
    expect(screen.getByText("Generate the webhook URL first.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Generate webhook URL" }));
    await waitFor(() => expect(api.createSulekhaIntegration).toHaveBeenCalledTimes(1));
    expect(await screen.findByLabelText("Webhook URL")).toHaveValue(URL_VALUE);
    expect(screen.getByText("Waiting for first lead", { selector: ".status-badge" })).toBeInTheDocument();
  });

  it("links to the Sulekha setup guide, opening it in a new tab", async () => {
    render(<SulekhaIntegrationCard />);
    const link = await screen.findByRole("link", { name: /Read the setup guide before you generate your webhook URL/ });
    expect(link).toHaveAttribute("href", "/docs/integrations/sulekha");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("hides the URL like a password until Show, and Copy URL copies the real URL", async () => {
    render(<SulekhaIntegrationCard />);
    const input = await screen.findByLabelText("Webhook URL");
    expect(input).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(input).toHaveAttribute("type", "text");
    fireEvent.click(screen.getByRole("button", { name: "Copy URL" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(URL_VALUE));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("says to send the URL to the account manager, with no Email or WhatsApp button", async () => {
    render(<SulekhaIntegrationCard />);
    expect(await screen.findByText("Send to your Sulekha account manager")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Email/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /WhatsApp/ })).not.toBeInTheDocument();
  });

  it("asks before Regenerate, says the old URL works 7 more days, and keeps the URL on Cancel", async () => {
    render(<SulekhaIntegrationCard />);
    await screen.findByLabelText("Webhook URL");
    fireEvent.click(screen.getByRole("button", { name: "Regenerate URL" }));
    expect(screen.getByText(/Your old URL keeps working for 7 days\. Send the new URL to your Sulekha account manager before then, or Sulekha will stop delivering leads\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.createSulekhaIntegration).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Regenerate URL" }));
    fireEvent.click(screen.getByRole("button", { name: "Regenerate URL" }));
    await waitFor(() => expect(api.createSulekhaIntegration).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("New URL created. Send it to your Sulekha account manager.")).toBeInTheDocument();
  });

  it("warns while leads still arrive only on the old URL, with the date it stops", async () => {
    vi.mocked(api.getSulekhaOverview).mockResolvedValue(withPrevious(null, "2026-11-24T11:00:00Z"));
    render(<SulekhaIntegrationCard />);
    expect(await screen.findByText(/Leads are still arriving on your old URL\. It stops on/)).toBeInTheDocument();
    expect(screen.getByText("Waiting for first lead", { selector: ".status-badge" })).toBeInTheDocument();
  });

  it("stops warning once the newest lead came on the new URL", async () => {
    vi.mocked(api.getSulekhaOverview).mockResolvedValue(withPrevious("2026-11-24T12:00:00Z", "2026-11-24T11:00:00Z"));
    render(<SulekhaIntegrationCard />);
    expect(await screen.findByText(/Your old URL works until/)).toBeInTheDocument();
    expect(screen.queryByText(/Leads are still arriving on your old URL/)).not.toBeInTheDocument();
  });

  it("warns again when the old URL gets a lead after the new one did", async () => {
    vi.mocked(api.getSulekhaOverview).mockResolvedValue(withPrevious("2026-11-24T11:00:00Z", "2026-11-24T12:00:00Z"));
    render(<SulekhaIntegrationCard />);
    expect(await screen.findByText(/Leads are still arriving on your old URL\. It stops on/)).toBeInTheDocument();
  });

  it("says until when the old URL works when nothing arrived on it", async () => {
    vi.mocked(api.getSulekhaOverview).mockResolvedValue(withPrevious(null, null));
    render(<SulekhaIntegrationCard />);
    expect(await screen.findByText(/Your old URL works until/)).toBeInTheDocument();
  });

  it("shows Connected with the last lead time once a lead arrived on the URL", async () => {
    vi.mocked(api.getSulekhaOverview).mockResolvedValue({ ...WAITING, integration: { ...WAITING.integration!, lastLeadAt: new Date().toISOString() } });
    render(<SulekhaIntegrationCard />);
    expect(await screen.findByText("Connected", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.getByText("Last lead received just now")).toBeInTheDocument();
  });

  it("lists failed requests only when there are some: time and reason", async () => {
    render(<SulekhaIntegrationCard />);
    await screen.findByLabelText("Webhook URL");
    expect(screen.queryByRole("heading", { name: "Failed requests" })).not.toBeInTheDocument();
    vi.mocked(api.getSulekhaOverview).mockResolvedValue({ ...WAITING, integration: { ...WAITING.integration!, failedRequests: [FAILED] } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    const heading = await screen.findByRole("heading", { name: "Failed requests" });
    const section = heading.closest("div")?.parentElement?.parentElement as HTMLElement;
    expect(within(section).getByText("Mobile number or email not found")).toBeInTheDocument();
  });

  it("offers Regenerate when the stored URL cannot be shown", async () => {
    vi.mocked(api.getSulekhaOverview).mockResolvedValue({ ...WAITING, integration: { ...WAITING.integration!, url: null } });
    render(<SulekhaIntegrationCard />);
    expect(await screen.findByText(/This URL can't be shown\. Regenerate it/)).toBeInTheDocument();
    expect(screen.queryByText("Send to your Sulekha account manager")).not.toBeInTheDocument();
  });

  it("tells an employee that only the owner can set it up, with no URL", async () => {
    vi.mocked(api.getSulekhaOverview).mockResolvedValue({ canManage: false, hasIntegration: true, integration: null });
    render(<SulekhaIntegrationCard />);
    expect(await screen.findByText("Only the company owner can set up Sulekha.")).toBeInTheDocument();
    expect(screen.getByText("Set up", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Webhook URL")).not.toBeInTheDocument();
  });

  it("shows the load error when the details cannot be loaded", async () => {
    vi.mocked(api.getSulekhaOverview).mockRejectedValue(new Error("Sulekha details could not be loaded."));
    render(<SulekhaIntegrationCard />);
    expect(await screen.findByText("Sulekha details could not be loaded.")).toBeInTheDocument();
  });
});

const CONNECTED_AT = "2026-11-24T09:00:00Z";
const CONNECTED: SulekhaOverview = { ...WAITING, integration: { ...WAITING.integration!, lastLeadAt: CONNECTED_AT } };
const PAUSED: SulekhaOverview = { ...WAITING, integration: { ...WAITING.integration!, lastLeadAt: CONNECTED_AT, paused: true } };

describe("SulekhaIntegrationCard Pause / Resume", () => {
  it("puts Regenerate URL and Pause side by side in one row", async () => {
    render(<SulekhaIntegrationCard />);
    const pause = await screen.findByRole("button", { name: "Pause" });
    const regenerate = screen.getByRole("button", { name: "Regenerate URL" });
    expect(pause.parentElement).toBe(regenerate.parentElement);
    expect(regenerate.className).toBe("button");
  });

  it("asks first: Cancel (focused, at the top) and Esc change nothing", async () => {
    render(<SulekhaIntegrationCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    const dialog = screen.getByRole("alertdialog", { name: "Pause Sulekha leads?" });
    expect(dialog).toHaveTextContent("While paused, every lead Sulekha sends is refused and cannot be recovered later. AgentzPro is not responsible for any leads lost during the pause. Click Resume at any time to start receiving Sulekha leads in your CRM again.");
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveFocus();
    fireEvent.click(cancel);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(api.setSulekhaPaused).not.toHaveBeenCalled();
  });

  it("OK pauses: the badge says Paused, the button turns to Resume and Connected is no longer shown", async () => {
    vi.mocked(api.getSulekhaOverview).mockResolvedValueOnce(CONNECTED).mockResolvedValue(PAUSED);
    render(<SulekhaIntegrationCard />);
    expect(await screen.findByText("Connected", { selector: ".status-badge" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "OK" }));
    await waitFor(() => expect(api.setSulekhaPaused).toHaveBeenCalledWith(true));
    expect(await screen.findByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(screen.getByText("Paused", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
    expect(screen.queryByText(/Last lead received/)).not.toBeInTheDocument();
    expect(screen.queryByText(/The status turns Connected/)).not.toBeInTheDocument();
    expect(screen.getByText("Lead delivery paused")).toBeInTheDocument();
    expect(screen.getByText("Last lead")).toBeInTheDocument();
    expect(screen.getByText("Click Resume to start receiving Sulekha leads again.")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("Resume needs no pop-up and brings Pause back", async () => {
    vi.mocked(api.getSulekhaOverview).mockResolvedValueOnce(PAUSED).mockResolvedValue(CONNECTED);
    render(<SulekhaIntegrationCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(api.setSulekhaPaused).toHaveBeenCalledWith(false));
    expect(await screen.findByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.getByText("Connected", { selector: ".status-badge" })).toBeInTheDocument();
  });

  it("stays paused after a Regenerate (Resume is still shown)", async () => {
    vi.mocked(api.getSulekhaOverview).mockResolvedValue(PAUSED);
    render(<SulekhaIntegrationCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Regenerate URL" }));
    fireEvent.click(screen.getByRole("button", { name: "Regenerate URL" }));
    await waitFor(() => expect(api.createSulekhaIntegration).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("New URL created. Send it to your Sulekha account manager.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(api.setSulekhaPaused).not.toHaveBeenCalled();
  });

  it("while paused, never says leads still arrive on the old URL", async () => {
    vi.mocked(api.getSulekhaOverview).mockResolvedValue({ ...PAUSED, integration: { ...PAUSED.integration!, lastLeadAt: null, previousUrl: { validUntil: "2026-12-01T12:00:00Z", lastLeadAt: "2026-11-24T11:00:00Z" } } });
    render(<SulekhaIntegrationCard />);
    expect(await screen.findByText(/^Your old URL is paused too\. It stops for good on .+\.$/)).toBeInTheDocument();
    expect(screen.queryByText(/Leads are still arriving on your old URL/)).not.toBeInTheDocument();
    expect(screen.getByText("None yet")).toBeInTheDocument();
  });

  it("shows why a pause failed and keeps Pause", async () => {
    vi.mocked(api.setSulekhaPaused).mockRejectedValue(new Error("Sulekha leads could not be paused. Try again."));
    render(<SulekhaIntegrationCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "OK" }));
    expect(await screen.findByText("Sulekha leads could not be paused. Try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  });

  it("gives an employee no Pause, no Resume and no Paused label", async () => {
    vi.mocked(api.getSulekhaOverview).mockResolvedValue({ canManage: false, hasIntegration: true, integration: null });
    render(<SulekhaIntegrationCard />);
    expect(await screen.findByText("Set up", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
    expect(screen.queryByText("Paused")).not.toBeInTheDocument();
  });
});

describe("sulekhaLeadsStillOnOldUrl", () => {
  it("is true only while the newest lead came on the old URL", () => {
    expect(sulekhaLeadsStillOnOldUrl(null, null)).toBe(false);
    expect(sulekhaLeadsStillOnOldUrl("2026-11-24T10:00:00Z", null)).toBe(false);
    expect(sulekhaLeadsStillOnOldUrl(null, "2026-11-24T10:00:00Z")).toBe(true);
    expect(sulekhaLeadsStillOnOldUrl("2026-11-24T11:00:00Z", "2026-11-24T10:00:00Z")).toBe(false);
    expect(sulekhaLeadsStillOnOldUrl("2026-11-24T10:00:00Z", "2026-11-24T11:00:00Z")).toBe(true);
  });
});

describe("sulekhaRelativeTime", () => {
  it("reads like a person would say it", () => {
    const now = Date.parse("2026-11-24T12:00:00Z");
    expect(sulekhaRelativeTime("2026-11-24T11:59:50Z", now)).toBe("just now");
    expect(sulekhaRelativeTime("2026-11-24T11:55:00Z", now)).toBe("5 minutes ago");
    expect(sulekhaRelativeTime("2026-11-21T12:00:00Z", now)).toBe("3 days ago");
  });
});
