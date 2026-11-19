import { expect, it, vi } from "vitest";
import DocsPage from "./page";

const redirect = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ redirect }));

it("opens straight on the Facebook integration doc", () => {
  redirect.mockImplementation((destination: string) => { throw new Error(`redirect:${destination}`); });
  expect(() => DocsPage()).toThrow("redirect:/docs/integrations/facebook");
});
