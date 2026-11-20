import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MagicbricksOverview } from "@/lib/magicbricks/magicbricks";

const URL_VALUE = "https://crm.example.com/api/webhooks/magicbricks/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const FAILED = { id: "log-1", createdAt: "2026-11-18T10:00:00Z", reason: "Mobile number or email not found" as const };
const WAITING: MagicbricksOverview = { canManage: true, hasIntegration: true, integration: { url: URL_VALUE, lastLeadAt: null, failedRequests: [] } };

vi.mock("@/services/crm-api-client", () => ({
  getMagicbricksOverview: vi.fn(),
  createMagicbricksIntegration: vi.fn(),
}));

const { MagicbricksIntegrationCard, magicbricksRelativeTime } = await import("@/features/connection/magicbricks-integration-card");
const api = await import("@/services/crm-api-client");

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.mocked(api.getMagicbricksOverview).mockReset().mockResolvedValue(WAITING);
  vi.mocked(api.createMagicbricksIntegration).mockReset().mockResolvedValue({ url: URL_VALUE });
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => vi.unstubAllGlobals());

describe("MagicbricksIntegrationCard", () => {
  it("offers Generate when the company has no URL yet, then shows it", async () => {
    vi.mocked(api.getMagicbricksOverview).mockResolvedValueOnce({ canManage: true, hasIntegration: false, integration: null });
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
    expect(screen.getByText("The old URL stops working at once. Send the new URL to your MagicBricks account manager.")).toBeInTheDocument();
    expect(api.createMagicbricksIntegration).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Regenerate URL" }));
    await waitFor(() => expect(api.createMagicbricksIntegration).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("New URL created. Send it to your MagicBricks account manager.")).toBeInTheDocument();
  });

  it("shows Connected and the last lead time once a lead arrived", async () => {
    vi.mocked(api.getMagicbricksOverview).mockResolvedValueOnce({ ...WAITING, integration: { url: URL_VALUE, lastLeadAt: new Date(Date.now() - 5 * 60_000).toISOString(), failedRequests: [] } });
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
    vi.mocked(api.getMagicbricksOverview).mockResolvedValueOnce({ ...WAITING, integration: { url: URL_VALUE, lastLeadAt: null, failedRequests: [FAILED] } });
    render(<MagicbricksIntegrationCard />);
    const heading = await screen.findByRole("heading", { name: "Failed requests" });
    const section = heading.closest("div")?.parentElement?.parentElement as HTMLElement;
    expect(within(section).getByText("Mobile number or email not found")).toBeInTheDocument();
    expect(within(section).getByText("Failed")).toBeInTheDocument();
  });

  it("offers Regenerate when the stored URL cannot be shown", async () => {
    vi.mocked(api.getMagicbricksOverview).mockResolvedValueOnce({ ...WAITING, integration: { url: null, lastLeadAt: null, failedRequests: [] } });
    render(<MagicbricksIntegrationCard />);
    expect(await screen.findByText("This URL can't be shown. Regenerate it, then send the new URL to your MagicBricks account manager.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Webhook URL")).not.toBeInTheDocument();
  });

  it("shows an employee only that the owner sets it up, never the URL", async () => {
    vi.mocked(api.getMagicbricksOverview).mockResolvedValueOnce({ canManage: false, hasIntegration: true, integration: null });
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
