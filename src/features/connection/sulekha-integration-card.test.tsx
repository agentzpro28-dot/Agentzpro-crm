import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sulekhaLeadsStillOnOldUrl, type SulekhaOverview } from "@/lib/sulekha/sulekha";

const URL_VALUE = "https://crm.example.com/api/webhooks/sulekha/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const FAILED = { id: "log-1", createdAt: "2026-11-24T10:00:00Z", reason: "Mobile number or email not found" as const };
const WAITING: SulekhaOverview = { canManage: true, hasIntegration: true, integration: { url: URL_VALUE, lastLeadAt: null, previousUrl: null, failedRequests: [] } };
const withPrevious = (lastLeadAt: string | null, previousLastLeadAt: string | null): SulekhaOverview => ({
  ...WAITING, integration: { ...WAITING.integration!, lastLeadAt, previousUrl: { validUntil: "2026-12-01T12:00:00Z", lastLeadAt: previousLastLeadAt } },
});

vi.mock("@/services/crm-api-client", () => ({
  getSulekhaOverview: vi.fn(),
  createSulekhaIntegration: vi.fn(),
}));

const { SulekhaIntegrationCard, sulekhaRelativeTime } = await import("@/features/connection/sulekha-integration-card");
const api = await import("@/services/crm-api-client");

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.mocked(api.getSulekhaOverview).mockReset().mockResolvedValue(WAITING);
  vi.mocked(api.createSulekhaIntegration).mockReset().mockResolvedValue({ url: URL_VALUE });
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
