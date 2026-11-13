import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const clearConnectionChecks = vi.hoisted(() => vi.fn());
vi.mock("@/services/crm-api-client", () => ({ clearConnectionChecks }));
vi.mock("next/navigation", () => ({ usePathname: () => "/leads" }));
// Only the shell's own session housekeeping is under test; its parts have their own tests.
vi.mock("@/components/task-bell", () => ({ TaskAlertsProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/components/facebook-reconnect-banner", () => ({ FacebookReconnectBanner: () => null }));
vi.mock("@/components/company-switcher", () => ({ CompanySwitcher: () => null }));
vi.mock("@/components/user-menu", () => ({ UserMenu: () => null }));
vi.mock("@/components/sidebar-toggle", () => ({ SidebarCollapseButton: () => null, SidebarExpandButton: () => null }));
vi.mock("@/components/brand-logo", () => ({ BrandLogo: () => null }));

const { CrmShell } = await import("@/components/crm-shell");

describe("CrmShell", () => {
  it("starts with no shared connection checks and forgets them when it closes (logout, idle logout)", () => {
    const { unmount } = render(<CrmShell fullName="Owner A" tenantName="Tenant A"><p>page</p></CrmShell>);
    expect(clearConnectionChecks).toHaveBeenCalledTimes(1);
    unmount();
    expect(clearConnectionChecks).toHaveBeenCalledTimes(2);
  });
});
