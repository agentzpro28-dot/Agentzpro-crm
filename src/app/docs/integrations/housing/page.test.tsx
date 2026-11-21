import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import HousingDocsPage from "./page";

afterEach(cleanup);

it("describes the 3-step account-manager setup, as its own pipeline", () => {
  render(<HousingDocsPage />);
  expect(screen.getByRole("heading", { level: 1, name: "Housing.com" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { level: 3, name: "Generate your webhook URL" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { level: 3, name: "Send it to your Housing.com account manager" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { level: 3, name: "Check that leads arrive" })).toBeInTheDocument();
  expect(screen.getByText(/You need an active Housing\.com package/)).toBeInTheDocument();
  expect(screen.queryByText(/99acres/)).not.toBeInTheDocument();
  expect(screen.queryByText(/MagicBricks/)).not.toBeInTheDocument();
});

it("says the old URL keeps working for 7 days after a regenerate", () => {
  render(<HousingDocsPage />);
  expect(screen.getByText("Your old URL keeps working for 7 days. Send the new URL to your Housing.com account manager before then, or Housing.com will stop delivering leads.")).toBeInTheDocument();
});
