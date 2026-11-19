import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import GoogleAdsDocsPage from "./page";

afterEach(cleanup);

it("explains the two separate steps and that the webhook delivers leads on its own", () => {
  render(<GoogleAdsDocsPage />);
  expect(screen.getByRole("heading", { level: 1, name: "Google Ads" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { level: 2, name: /Step 1: Campaign names/ })).toBeInTheDocument();
  expect(screen.getByRole("heading", { level: 2, name: /Step 2: Lead form webhook/ })).toBeInTheDocument();
  expect(screen.getByText(/never creates, changes or pauses a campaign/)).toBeInTheDocument();
});
