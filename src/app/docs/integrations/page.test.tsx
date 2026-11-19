import { expect, it, vi } from "vitest";
import DocsIntegrationsPage from "./page";

const redirect = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ redirect }));

it("defaults to the Facebook integration doc", () => {
  redirect.mockImplementation((destination: string) => { throw new Error(`redirect:${destination}`); });
  expect(() => DocsIntegrationsPage()).toThrow("redirect:/docs/integrations/facebook");
});
