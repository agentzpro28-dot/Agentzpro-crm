import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DocsSidebar } from "./docs-sidebar";

const mocks = vi.hoisted(() => ({ usePathname: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: mocks.usePathname }));

afterEach(cleanup);

it("links to all 6 integration docs", () => {
  mocks.usePathname.mockReturnValue("/docs/integrations/facebook");
  render(<DocsSidebar />);
  expect(screen.getAllByRole("link", { name: "Facebook" })[0]).toHaveAttribute("href", "/docs/integrations/facebook");
  expect(screen.getAllByRole("link", { name: "Google Ads" })[0]).toHaveAttribute("href", "/docs/integrations/google-ads");
  expect(screen.getAllByRole("link", { name: "Webhook" })[0]).toHaveAttribute("href", "/docs/integrations/webhook");
  expect(screen.getAllByRole("link", { name: "99acres" })[0]).toHaveAttribute("href", "/docs/integrations/99acres");
  expect(screen.getAllByRole("link", { name: "MagicBricks" })[0]).toHaveAttribute("href", "/docs/integrations/magicbricks");
  expect(screen.getAllByRole("link", { name: "Housing.com" })[0]).toHaveAttribute("href", "/docs/integrations/housing");
});

it("marks the current page's link as the active one", () => {
  mocks.usePathname.mockReturnValue("/docs/integrations/webhook");
  render(<DocsSidebar />);
  const activeLinks = screen.getAllByRole("link", { name: "Webhook", current: "page" });
  expect(activeLinks.length).toBeGreaterThan(0);
  expect(screen.queryAllByRole("link", { name: "Facebook", current: "page" })).toHaveLength(0);
});
