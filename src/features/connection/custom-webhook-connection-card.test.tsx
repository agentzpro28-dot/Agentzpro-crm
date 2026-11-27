import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const URL_VALUE = "https://crm.example.com/api/webhooks/custom/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ACTIVE = { canManage: true, hasWebhook: true, webhookStopped: false, webhook: { url: URL_VALUE, lastLeadAt: null, paused: false } };
const PAUSED = { ...ACTIVE, webhook: { url: URL_VALUE, lastLeadAt: null, paused: true } };

vi.mock("@/services/crm-api-client", () => ({
  getCustomWebhookOverview: vi.fn(),
  createCustomWebhook: vi.fn(),
  stopCustomWebhook: vi.fn(),
  setCustomWebhookPaused: vi.fn(),
}));

const { CustomWebhookConnectionCard, SAMPLE_WEBHOOK_BODY } = await import("@/features/connection/custom-webhook-connection-card");
const api = await import("@/services/crm-api-client");

beforeEach(() => {
  vi.mocked(api.getCustomWebhookOverview).mockReset().mockResolvedValue(ACTIVE);
  vi.mocked(api.createCustomWebhook).mockReset().mockResolvedValue({ url: URL_VALUE });
  vi.mocked(api.stopCustomWebhook).mockReset().mockResolvedValue({ stopped: true });
  vi.mocked(api.setCustomWebhookPaused).mockReset().mockImplementation(async (paused: boolean) => ({ paused }));
});
afterEach(() => vi.unstubAllGlobals());

describe("CustomWebhookConnectionCard", () => {
  it("asks for the URL (details) and hides it like a password until Show; Copy copies the real URL", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<CustomWebhookConnectionCard />);
    const input = await screen.findByLabelText("Webhook URL") as HTMLInputElement;
    expect(api.getCustomWebhookOverview).toHaveBeenCalledWith({ details: true });
    expect(input.type).toBe("password");
    expect(input.value).toBe(URL_VALUE);
    fireEvent.click(screen.getAllByRole("button", { name: "Copy" })[0]);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(URL_VALUE));
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(input.type).toBe("text");
  });

  it("links to the Webhook setup guide, opening it in a new tab", async () => {
    render(<CustomWebhookConnectionCard />);
    const link = await screen.findByRole("link", { name: /Read the setup guide before you create your webhook URL/ });
    expect(link).toHaveAttribute("href", "/docs/integrations/webhook");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveTextContent("(opens in a new tab)");
  });

  it("shows the example body and tells the owner never to put the URL in website code", async () => {
    render(<CustomWebhookConnectionCard />);
    expect(await screen.findByLabelText("Example webhook body")).toHaveTextContent("\"lead_id\": \"optional-your-own-id\"");
    expect(SAMPLE_WEBHOOK_BODY).toContain("\"source\": \"Landing Page\"");
    expect(screen.getByText(/Never put it in your website/)).toHaveTextContent("Leads sent from a web page are refused.");
    expect(screen.getByText(/Phone or email is required/)).toBeInTheDocument();
    expect(screen.getByText("None yet")).toBeInTheDocument();
  });

  it("shows Leads arriving once a lead came in on this URL", async () => {
    vi.mocked(api.getCustomWebhookOverview).mockResolvedValue({ ...ACTIVE, webhook: { url: URL_VALUE, lastLeadAt: "2026-11-11T10:00:00Z", paused: false } });
    render(<CustomWebhookConnectionCard />);
    expect(await screen.findByText("Leads arriving")).toBeInTheDocument();
  });

  it("replaces the URL only after the owner confirms", async () => {
    render(<CustomWebhookConnectionCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Replace URL" }));
    expect(api.createCustomWebhook).not.toHaveBeenCalled();
    expect(screen.getByText(/old URL stops working at once/)).toBeInTheDocument();
    const confirm = screen.getAllByRole("button", { name: "Replace URL" }).find((button) => button.className.includes("button--danger"));
    fireEvent.click(confirm as HTMLElement);
    await waitFor(() => expect(api.createCustomWebhook).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("New URL created. Paste it into your tools.")).toBeInTheDocument();
  });

  it("stops leads and shows the OK pop-up", async () => {
    vi.mocked(api.getCustomWebhookOverview).mockResolvedValueOnce(ACTIVE).mockResolvedValue({ canManage: true, hasWebhook: false, webhookStopped: true, webhook: null });
    render(<CustomWebhookConnectionCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop receiving webhook leads" }));
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("Webhook leads stopped");
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByText("Lead arrival stopped")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create new webhook URL" })).toBeInTheDocument();
  });

  it("Pause opens the warning pop-up; Cancel at the top closes it and pauses nothing", async () => {
    render(<CustomWebhookConnectionCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    const popup = await screen.findByRole("alertdialog");
    expect(popup).toHaveTextContent("Pause webhook leads?");
    // A stray Enter must never pause leads: focus starts on Cancel.
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(popup).toHaveTextContent("While paused, every lead sent to your webhook is refused and cannot be recovered later. AgentzPro is not responsible for any leads lost during the pause. Click Resume at any time to start receiving webhook leads in your CRM again.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(api.setCustomWebhookPaused).not.toHaveBeenCalled();
    expect(screen.getByText("Receiving leads")).toBeInTheDocument();
  });

  it("Esc in the pop-up cancels too", async () => {
    render(<CustomWebhookConnectionCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    fireEvent.keyDown(await screen.findByRole("alertdialog"), { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(api.setCustomWebhookPaused).not.toHaveBeenCalled();
  });

  it("OK pauses: the badge says Paused and the button turns into Resume", async () => {
    vi.mocked(api.getCustomWebhookOverview).mockResolvedValueOnce(ACTIVE).mockResolvedValue(PAUSED);
    render(<CustomWebhookConnectionCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    fireEvent.click(await screen.findByRole("button", { name: "OK" }));
    await waitFor(() => expect(api.setCustomWebhookPaused).toHaveBeenCalledWith(true));
    expect(await screen.findByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getByText("Lead delivery paused")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
  });

  it("Resume starts leads again at once, with no pop-up, and the button turns back into Pause", async () => {
    vi.mocked(api.getCustomWebhookOverview).mockResolvedValueOnce(PAUSED).mockResolvedValue(ACTIVE);
    render(<CustomWebhookConnectionCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    await waitFor(() => expect(api.setCustomWebhookPaused).toHaveBeenCalledWith(false));
    expect(await screen.findByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByText("Receiving leads")).toBeInTheDocument();
    expect(screen.queryByText("Lead delivery paused")).not.toBeInTheDocument();
  });

  it("keeps Stop available while paused", async () => {
    vi.mocked(api.getCustomWebhookOverview).mockResolvedValue(PAUSED);
    render(<CustomWebhookConnectionCard />);
    expect(await screen.findByRole("button", { name: "Stop receiving webhook leads" })).toBeInTheDocument();
  });

  it("shows the error and stays as it was when pausing fails", async () => {
    vi.mocked(api.setCustomWebhookPaused).mockRejectedValue(new Error("Webhook leads could not be paused. Try again."));
    render(<CustomWebhookConnectionCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    fireEvent.click(await screen.findByRole("button", { name: "OK" }));
    expect(await screen.findByText("Webhook leads could not be paused. Try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  });

  it("shows no Pause or Resume after Stop", async () => {
    vi.mocked(api.getCustomWebhookOverview).mockResolvedValue({ canManage: true, hasWebhook: false, webhookStopped: true, webhook: null });
    render(<CustomWebhookConnectionCard />);
    expect(await screen.findByText("Lead arrival stopped")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
  });

  it("offers Create webhook URL when none exists", async () => {
    vi.mocked(api.getCustomWebhookOverview).mockResolvedValueOnce({ canManage: true, hasWebhook: false, webhookStopped: false, webhook: null }).mockResolvedValue(ACTIVE);
    render(<CustomWebhookConnectionCard />);
    expect(await screen.findByText("Not set up")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create webhook URL" }));
    await waitFor(() => expect(api.createCustomWebhook).toHaveBeenCalledTimes(1));
    expect(await screen.findByLabelText("Webhook URL")).toBeInTheDocument();
  });

  it("shows an employee the status only, never the URL or any button", async () => {
    vi.mocked(api.getCustomWebhookOverview).mockResolvedValue({ canManage: false, hasWebhook: true, webhookStopped: false, webhook: null });
    render(<CustomWebhookConnectionCard />);
    expect(await screen.findByText("Only the company owner can set up the webhook.")).toBeInTheDocument();
    expect(screen.getByText("Receiving leads")).toBeInTheDocument();
    expect(screen.queryByLabelText("Webhook URL")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("says so when the details cannot be loaded", async () => {
    vi.mocked(api.getCustomWebhookOverview).mockRejectedValue(new Error("Webhook details could not be loaded."));
    render(<CustomWebhookConnectionCard />);
    expect(await screen.findByText("Webhook details could not be loaded.")).toBeInTheDocument();
  });
});
