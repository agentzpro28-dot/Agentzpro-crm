import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PortalIntegrationOverview } from "@/lib/portal-leads/portals";

const URL_VALUE = "https://crm.example.com/api/webhooks/leads/99acres/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const LOG = { id: "log-1", createdAt: "2026-11-17T10:00:00Z", method: "POST" as const, status: "failed" as const, errorMessage: "Send mobile or email.", isTest: false, headers: { "content-type": "application/json" }, queryParams: { src: "99" }, rawBody: "{\"custName\":\"Ravi\"}", bodyCut: false };
const WAITING: PortalIntegrationOverview = { portal: "99acres", canManage: true, hasIntegration: true, integration: { url: URL_VALUE, lastLeadAt: null, logs: [] } };

vi.mock("@/services/crm-api-client", () => ({
  getPortalIntegrationOverview: vi.fn(),
  createPortalIntegration: vi.fn(),
  sendPortalTestLead: vi.fn(),
}));

const { PortalIntegrationCard, prettyBody, relativeTime } = await import("@/features/connection/portal-integration-card");
const api = await import("@/services/crm-api-client");

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.mocked(api.getPortalIntegrationOverview).mockReset().mockResolvedValue(WAITING);
  vi.mocked(api.createPortalIntegration).mockReset().mockResolvedValue({ url: URL_VALUE });
  vi.mocked(api.sendPortalTestLead).mockReset().mockResolvedValue({ outcome: "stored", leadId: "lead-1" });
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => vi.unstubAllGlobals());

describe("PortalIntegrationCard (99acres)", () => {
  it("offers Generate when the company has no URL yet, then shows it", async () => {
    vi.mocked(api.getPortalIntegrationOverview).mockResolvedValueOnce({ portal: "99acres", canManage: true, hasIntegration: false, integration: null });
    render(<PortalIntegrationCard portal="99acres" />);
    expect(await screen.findByText("Not set up")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send test lead" })).toBeDisabled();
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

  it("tells the owner to send the URL to 99acres, with no email to copy", async () => {
    render(<PortalIntegrationCard portal="99acres" />);
    expect(await screen.findByText("Copy the URL above and send it to your 99acres account manager or 99acres support.")).toBeInTheDocument();
    expect(screen.getByText("Waiting for first lead", { selector: "strong" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /email/i })).not.toBeInTheDocument();
  });

  it("says Connected with the last lead time once a lead arrived", async () => {
    vi.mocked(api.getPortalIntegrationOverview).mockResolvedValue({ ...WAITING, integration: { url: URL_VALUE, lastLeadAt: new Date(Date.now() - 5 * 60_000).toISOString(), logs: [] } });
    render(<PortalIntegrationCard portal="99acres" />);
    expect(await screen.findByText("Connected", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.getByText("Last lead received 5 minutes ago")).toBeInTheDocument();
  });

  it("sends a test lead, reloads the request log and says where to find the lead", async () => {
    render(<PortalIntegrationCard portal="99acres" />);
    fireEvent.click(await screen.findByRole("button", { name: "Send test lead" }));
    await waitFor(() => expect(api.sendPortalTestLead).toHaveBeenCalledWith("99acres"));
    expect(await screen.findByText("Test lead saved. Open Leads to see \"Test Lead (99acres)\".")).toBeInTheDocument();
    expect(api.getPortalIntegrationOverview).toHaveBeenCalledTimes(2);
  });

  it("says a repeated test lead was added as a note", async () => {
    vi.mocked(api.sendPortalTestLead).mockResolvedValue({ outcome: "merged", leadId: "lead-1" });
    render(<PortalIntegrationCard portal="99acres" />);
    fireEvent.click(await screen.findByRole("button", { name: "Send test lead" }));
    expect(await screen.findByText("The test lead is already in Leads, so a note was added to it.")).toBeInTheDocument();
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

  it("lists the last requests and shows exactly what was sent on View", async () => {
    vi.mocked(api.getPortalIntegrationOverview).mockResolvedValue({ ...WAITING, integration: { url: URL_VALUE, lastLeadAt: null, logs: [LOG, { ...LOG, id: "log-2", status: "processed", errorMessage: null, isTest: true }] } });
    render(<PortalIntegrationCard portal="99acres" />);
    const list = await screen.findByRole("list");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText("Failed")).toBeInTheDocument();
    expect(within(items[0]).getByText("Send mobile or email.")).toBeInTheDocument();
    expect(within(items[1]).getByText("Saved")).toBeInTheDocument();
    expect(within(items[1]).getByText("Test")).toBeInTheDocument();
    fireEvent.click(within(items[0]).getByRole("button", { name: "View" }));
    expect(within(items[0]).getByText(/"custName": "Ravi"/)).toBeInTheDocument();
    expect(within(items[0]).getByText(/"src": "99"/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(api.getPortalIntegrationOverview).toHaveBeenCalledTimes(2));
  });

  it("shows an employee the status only, never the URL or the requests", async () => {
    vi.mocked(api.getPortalIntegrationOverview).mockResolvedValue({ portal: "99acres", canManage: false, hasIntegration: true, integration: null });
    render(<PortalIntegrationCard portal="99acres" />);
    expect(await screen.findByText("Only the company owner can set up 99acres.")).toBeInTheDocument();
    expect(screen.getByText("Set up")).toBeInTheDocument();
    expect(screen.queryByLabelText("Webhook URL")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send test lead" })).not.toBeInTheDocument();
  });

  it("offers Regenerate when the URL cannot be shown, and still shows the real status", async () => {
    vi.mocked(api.getPortalIntegrationOverview).mockResolvedValue({ ...WAITING, integration: { url: null, lastLeadAt: null, logs: [] } });
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
  it("indents a JSON body and shows anything else as sent", () => {
    expect(prettyBody("{\"a\":1}")).toBe("{\n  \"a\": 1\n}");
    expect(prettyBody("name=Ravi&mobile=1")).toBe("name=Ravi&mobile=1");
  });

  it("says how long ago, in plain words", () => {
    const now = Date.parse("2026-11-17T10:00:00Z");
    expect(relativeTime("2026-11-17T09:59:40Z", now)).toBe("just now");
    expect(relativeTime("2026-11-17T09:55:00Z", now)).toBe("5 minutes ago");
    expect(relativeTime("2026-11-17T07:00:00Z", now)).toBe("3 hours ago");
    expect(relativeTime("2026-11-16T10:00:00Z", now)).toBe("yesterday");
  });
});
