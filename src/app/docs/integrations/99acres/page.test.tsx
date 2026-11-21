import React from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import NinetyNineAcresDocsPage from "./page";

afterEach(cleanup);

it("describes the 3-step account-manager setup, as its own pipeline", () => {
  render(<NinetyNineAcresDocsPage />);
  expect(screen.getByRole("heading", { level: 1, name: "99acres" })).toBeInTheDocument();
  expect(screen.getByText(/your 99acres account manager or 99acres support/)).toBeInTheDocument();
  expect(screen.queryByText(/MagicBricks/)).not.toBeInTheDocument();
});

it("warns clearly not to click Regenerate URL without a real reason: old URL 7 days, then leads are lost", () => {
  render(<NinetyNineAcresDocsPage />);
  const warning = screen.getByRole("note");
  expect(within(warning).getByRole("heading", { level: 2, name: /Warning: Do not click "Regenerate URL" without a real reason/ })).toBeInTheDocument();
  expect(warning).toHaveTextContent("Click Regenerate URL only if your webhook URL has leaked (someone outside your company has it).");
  expect(warning).toHaveTextContent("When you click it, a new webhook URL is created.");
  expect(warning).toHaveTextContent("Your old webhook URL keeps working for only 7 days from the time you create the new URL. After 7 days, the old URL will not accept any leads.");
  expect(warning).toHaveTextContent("These 7 days are given to save your leads. Within these 7 days, ask your 99acres account manager to connect the new URL.");
  expect(warning).toHaveTextContent("If the new URL is not connected within 7 days, your 99acres leads will be lost. AgentzPro is not responsible for these lost leads. It is fully your responsibility.");
  expect(screen.queryByText(/stops working at once/)).not.toBeInTheDocument();
});
