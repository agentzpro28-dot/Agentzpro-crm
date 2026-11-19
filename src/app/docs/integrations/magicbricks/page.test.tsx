import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import MagicbricksDocsPage from "./page";

afterEach(cleanup);

it("describes the 3-step account-manager setup, as its own pipeline", () => {
  render(<MagicbricksDocsPage />);
  expect(screen.getByRole("heading", { level: 1, name: "MagicBricks" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { level: 3, name: "Send it to your MagicBricks account manager" })).toBeInTheDocument();
  expect(screen.queryByText(/99acres/)).not.toBeInTheDocument();
});
