import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import NinetyNineAcresDocsPage from "./page";

afterEach(cleanup);

it("describes the 3-step account-manager setup, as its own pipeline", () => {
  render(<NinetyNineAcresDocsPage />);
  expect(screen.getByRole("heading", { level: 1, name: "99acres" })).toBeInTheDocument();
  expect(screen.getByText(/your 99acres account manager or 99acres support/)).toBeInTheDocument();
  expect(screen.queryByText(/MagicBricks/)).not.toBeInTheDocument();
});
