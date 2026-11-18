import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PortalIntegrationOverview } from "@/lib/portal-leads/portals";

const URL_VALUE = "https://crm.example.com/api/webhooks/leads/99acres/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const FAILED = { id: "log-1", createdAt: "2026-11-17T10:00:00Z", errorMessage: "Send mobile or email." };
const WAITING: PortalIntegrationOverview = { portal: "99acres", canManage: true, hasIntegration: true, integration: { url: URL_VALUE, lastLeadAt: null, failedRequests: [] } };

vi.mock("@/services/crm-api-client", () => ({
  getPortalIntegrationOverview: vi.fn(),
  createPortalIntegration: vi.fn(),
}));

const { PortalIntegrationCard, relativeTime } = await import("@/features/connection/portal-integration-card");
const api = await import("@/services/crm-api-client");

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.mocked(api.getPortalIntegrationOverview).mockReset().mockResolvedValue(WAITING);
  vi.mocked(api.createPortalIntegration).mockReset().mockResolvedValue({ url: URL_VALUE });
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => vi.unstubAllGlobals());

describe("PortalIntegrationCard (99acres)", () => {
  it("offers Generate when the company has no URL yet, then shows it", async () => {
    vi.mocked(api.getPortalIntegrationOverview).mockResolvedValueOnce({ portal: "99acres", canManage: true, hasIntegration: false, integration: null });
    render(<PortalIntegrationCard portal="99acres" />);
    expect(await screen.findByText("Not set up")).toBeInTheDocument();
    expect(screen.getAllByText("Generate the webhook URL first.")).toHaveLength(2);
    expect(screen.queryByText("Waiting for first lead")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Generate webhook URL" }));
    await waitFor(() => expect(api.createPortalIntegration).toHaveBeenCalledWith("99acres"));
    expect(await screen.findByLabelText("Webhook URL")).toHaveValue(URL_VALUE);
    expect(screen.getByText("Waiting for first lead", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.queryByText("Generate the webhook URL first.")).not.toBeInTheDocument();
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

  it("tells the owner to send the URL to 99acres, with no email to copy and no test lead", async () => {
    render(<PortalIntegrationCard portal="99acres" />);
    expect(await screen.findByText("Copy the URL above and send it to your 99acres account manager or 99acres support.")).toBeInTheDocument();
    expect(screen.getByText("Waiting for first lead", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("The status turns Connected when 99acres sends the first lead.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /email/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /test lead/i })).not.toBeInTheDocument();
  });

  it("says Connected with the last lead time once a lead arrived", async () => {
    vi.mocked(api.getPortalIntegrationOverview).mockResolvedValue({ ...WAITING, integration: { url: URL_VALUE, lastLeadAt: new Date(Date.now() - 5 * 60_000).toISOString(), failedRequests: [] } });
    render(<PortalIntegrationCard portal="99acres" />);
    expect(await screen.findByText("Connected", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.getByText("Last lead received 5 minutes ago")).toBeInTheDocument();
  });

  it("asks before regenerating, then replaces the URL", async () => {
    render(<PortalIntegrationCard portal="99acres" />);
    fireEvent.click(await screen.findByRole("button", { name: "Regenerate URL" }));
    expect(screen.getByText(/The old URL stops working at once/)).toBeInTheDocument();
    expect(api.createPortalIntegration).not.toHaveBeenCalled();
    const buttons = screen.getAllByRole("button", { name: "Regenerate URL" });
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(api.createPortalIntegration).toHaveBeenCalledWith("99acres"));
    expect(await screen.findByText("New URL created. Send it to 99acres.")).toBeInTheDocument();
  });

  it("lists only the failed requests, each with its time and reason, and never the raw request", async () => {
    vi.mocked(api.getPortalIntegrationOverview).mockResolvedValue({ ...WAITING, integration: { url: URL_VALUE, lastLeadAt: null, failedRequests: [FAILED, { id: "log-2", createdAt: "2026-11-16T08:00:00Z", errorMessage: "Send JSON, form data or URL parameters." }] } });
    render(<PortalIntegrationCard portal="99acres" />);
    expect(await screen.findByRole("heading", { name: "Failed requests" })).toBeInTheDocument();
    expect(screen.getByText("These 99acres enquiries could not be saved. Contact AgentzPro support with the time shown.")).toBeInTheDocument();
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText("Failed")).toBeInTheDocument();
    expect(within(items[0]).getByText("Send mobile or email.")).toBeInTheDocument();
    expect(within(items[1]).getByText("Send JSON, form data or URL parameters.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View" })).not.toBeInTheDocument();
    expect(screen.queryByText("Recent requests")).not.toBeInTheDocument();
  });

  it("hides the failed requests section when nothing failed, and Refresh in step 3 reloads the status", async () => {
    render(<PortalIntegrationCard portal="99acres" />);
    await screen.findByLabelText("Webhook URL");
    expect(screen.queryByRole("heading", { name: "Failed requests" })).not.toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(api.getPortalIntegrationOverview).toHaveBeenCalledTimes(2));
  });

  it("shows an employee the status only, never the URL or the requests", async () => {
    vi.mocked(api.getPortalIntegrationOverview).mockResolvedValue({ portal: "99acres", canManage: false, hasIntegration: true, integration: null });
    render(<PortalIntegrationCard portal="99acres" />);
    expect(await screen.findByText("Only the company owner can set up 99acres.")).toBeInTheDocument();
    expect(screen.getByText("Set up")).toBeInTheDocument();
    expect(screen.queryByLabelText("Webhook URL")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Regenerate URL" })).not.toBeInTheDocument();
  });

  it("offers Regenerate when the URL cannot be shown, and still shows the real status", async () => {
    vi.mocked(api.getPortalIntegrationOverview).mockResolvedValue({ ...WAITING, integration: { url: null, lastLeadAt: null, failedRequests: [] } });
    render(<PortalIntegrationCard portal="99acres" />);
    expect(await screen.findByText("This URL can't be shown. Regenerate it, then send the new URL to 99acres.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Webhook URL")).not.toBeInTheDocument();
    expect(screen.getAllByText("Generate the webhook URL first.")).toHaveLength(1);
    expect(screen.getByText("Waiting for first lead", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Regenerate URL" })).toBeEnabled();
  });

  it("shows a load failure", async () => {
    vi.mocked(api.getPortalIntegrationOverview).mockRejectedValue(new Error("99acres details could not be loaded. Try again."));
    render(<PortalIntegrationCard portal="99acres" />);
    expect(await screen.findByText("99acres details could not be loaded. Try again.")).toBeInTheDocument();
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
