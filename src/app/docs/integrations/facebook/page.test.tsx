import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import FacebookDocsPage from "./page";

afterEach(cleanup);

it("explains the Page requirements and that leads arrive on their own", () => {
  render(<FacebookDocsPage />);
  expect(screen.getByRole("heading", { level: 1, name: "Facebook Lead Ads" })).toBeInTheDocument();
  expect(screen.getByText(/advertising access/)).toBeInTheDocument();
  expect(screen.getByText("Create content")).toBeInTheDocument();
  expect(screen.getByText(/Only the company owner can connect or disconnect/)).toBeInTheDocument();
});
