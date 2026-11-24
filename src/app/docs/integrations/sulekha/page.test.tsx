import React from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import SulekhaDocsPage from "./page";

afterEach(cleanup);

it("describes the 3-step account-manager setup, as its own pipeline", () => {
  render(<SulekhaDocsPage />);
  expect(screen.getByRole("heading", { level: 1, name: "Sulekha" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { level: 3, name: "Generate your webhook URL" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { level: 3, name: "Send it to your Sulekha account manager" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { level: 3, name: "Check that leads arrive" })).toBeInTheDocument();
  expect(screen.getByText(/You need an active Sulekha package/)).toBeInTheDocument();
  expect(screen.getByText(/customer enquiries/)).toBeInTheDocument();
  expect(screen.queryByText(/Housing\.com|99acres|MagicBricks|property/)).not.toBeInTheDocument();
});

it("warns clearly not to click Regenerate URL without a real reason: old URL 7 days, then leads are lost", () => {
  render(<SulekhaDocsPage />);
  const warning = screen.getByRole("note");
  expect(within(warning).getByRole("heading", { level: 2, name: /Warning: Do not click "Regenerate URL" without a real reason/ })).toBeInTheDocument();
  expect(warning).toHaveTextContent("Click Regenerate URL only if your webhook URL has leaked (someone outside your company has it).");
  expect(warning).toHaveTextContent("Your old webhook URL keeps working for only 7 days from the time you create the new URL. After 7 days, the old URL will not accept any leads.");
  expect(warning).toHaveTextContent("These 7 days are given to save your leads. Within these 7 days, ask your Sulekha account manager to connect the new URL.");
  expect(warning).toHaveTextContent("If your account manager connects the new URL within 7 days, both the old URL and the new URL work until the 7 days end. The same lead will not be added twice to your account. You can also ask your account manager to remove the old URL and add the new URL.");
  expect(warning).toHaveTextContent("If the new URL is not connected within 7 days, your Sulekha leads will be lost. AgentzPro is not responsible for these lost leads. It is fully your responsibility.");
});
