import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import WebhookDocsPage from "./page";

afterEach(cleanup);

it("gives the required fields and status codes", () => {
  render(<WebhookDocsPage />);
  expect(screen.getByRole("heading", { level: 1, name: "Webhook" })).toBeInTheDocument();
  expect(screen.getByText(/requests sent from a web browser are refused/i)).toBeInTheDocument();
  expect(screen.getByText("lead_id")).toBeInTheDocument();
  expect(screen.getByText(/Too many leads sent in a short time/)).toBeInTheDocument();
});
