import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HousingOverview } from "@/lib/housing/housing";

const URL_VALUE = "https://crm.example.com/api/webhooks/housing/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const FAILED = { id: "log-1", createdAt: "2026-11-20T10:00:00Z", reason: "Mobile number or email not found" as const };
const WAITING: HousingOverview = { canManage: true, hasIntegration: true, integration: { url: URL_VALUE, lastLeadAt: null, previousUrl: null, failedRequests: [] } };

vi.mock("@/services/crm-api-client", () => ({
  getHousingOverview: vi.fn(),
  createHousingIntegration: vi.fn(),
}));

const { HousingIntegrationCard, housingRelativeTime } = await import("@/features/connection/housing-integration-card");
const api = await import("@/services/crm-api-client");

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.mocked(api.getHousingOverview).mockReset().mockResolvedValue(WAITING);
  vi.mocked(api.createHousingIntegration).mockReset().mockResolvedValue({ url: URL_VALUE });
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

  it("has no setup-guide link yet (the docs come later)", async () => {
    render(<HousingIntegrationCard />);
    await screen.findByLabelText("Webhook URL");
    expect(screen.queryByRole("link", { name: /setup guide/i })).not.toBeInTheDocument();
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

describe("housingRelativeTime", () => {
  it("reads like a person would say it", () => {
    const now = Date.parse("2026-11-20T12:00:00Z");
    expect(housingRelativeTime("2026-11-20T11:59:50Z", now)).toBe("just now");
    expect(housingRelativeTime("2026-11-20T11:55:00Z", now)).toBe("5 minutes ago");
    expect(housingRelativeTime("2026-11-17T12:00:00Z", now)).toBe("3 days ago");
  });
});
