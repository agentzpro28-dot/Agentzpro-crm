import React from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
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

it("warns clearly not to click Regenerate URL without a real reason: old URL 7 days, then leads are lost", () => {
  render(<HousingDocsPage />);
  const warning = screen.getByRole("note");
  expect(within(warning).getByRole("heading", { level: 2, name: /Warning: Do not click "Regenerate URL" without a real reason/ })).toBeInTheDocument();
  expect(warning).toHaveTextContent("Click Regenerate URL only if your webhook URL has leaked (someone outside your company has it).");
  expect(warning).toHaveTextContent("When you click it, a new webhook URL is created.");
  expect(warning).toHaveTextContent("Your old webhook URL keeps working for only 7 days from the time you create the new URL. After 7 days, the old URL will not accept any leads.");
  expect(warning).toHaveTextContent("These 7 days are given to save your leads. Within these 7 days, ask your Housing.com account manager to connect the new URL.");
  expect(warning).toHaveTextContent("If the new URL is not connected within 7 days, your Housing.com leads will be lost. AgentzPro is not responsible for these lost leads. It is fully your responsibility.");
  expect(warning).toHaveTextContent("If your account manager connects the new URL within 7 days, both the old URL and the new URL work until the 7 days end. The same lead will not be added twice to your account. You can also ask your account manager to remove the old URL and add the new URL.");
  expect(screen.queryByText(/stops working at once/)).not.toBeInTheDocument();
});

it("tells the account manager how Housing.com can send a lead: POST or GET, JSON, form data or URL parameters, one lead, the limits", () => {
  render(<HousingDocsPage />);
  const section = screen.getByRole("heading", { level: 2, name: "How Housing.com can send a lead" }).closest("section")!;
  expect(section).toHaveTextContent("Method: POST or GET.");
  expect(section).toHaveTextContent("Format: JSON, form data (normal or multipart) or URL parameters. JSON is read even when it is sent with another content type.");
  expect(section).toHaveTextContent("One lead per request. One lead inside a list ([{...}]) is accepted; 2 or more leads in one request are not.");
  expect(section).toHaveTextContent('A lead inside one field is accepted, for example data={...} or {"customer": {...}}.');
  expect(section).toHaveTextContent("Limits: a request up to 64 KB, up to 100 fields, each field name up to 100 characters.");
  expect(section).toHaveTextContent("Every lead needs a mobile number or an email.");
});

it("lists the field names the Housing.com reader knows, with its own Project names", () => {
  render(<HousingDocsPage />);
  const section = screen.getByRole("heading", { level: 2, name: "Field names we read" }).closest("section")!;
  const row = (detail: string) => within(section).getByRole("rowheader", { name: detail }).closest("tr")!;
  expect(row("Mobile")).toHaveTextContent("mobile, phone, mobile_number, phone_number, mobile_no, phone_no, contact_number, contact_no, contact, cust_mobile, cust_phone, customer_mobile, customer_phone, user_mobile, user_phone, sender_mobile");
  expect(row("Email")).toHaveTextContent("email, email_id, email_address, cust_email, customer_email, user_email, sender_email");
  expect(row("Name")).toHaveTextContent("or first_name + last_name");
  expect(row("Project")).toHaveTextContent("project_name, project, property_name, listing_name, society_name, property_title, listing_title, property_id, listing_id, project_id");
  expect(row("Enquiry ID")).toHaveTextContent("lead_id, enquiry_id, inquiry_id, response_id, need_id, lead_ref, lead_reference, id");
  expect(section).toHaveTextContent("When it is not clear which field holds it, nothing is guessed. The lead is refused only when neither a mobile number nor an email is found.");
});

it("lists every reply code with its reason, and says a lead is saved only on 200 with accepted 1", () => {
  render(<HousingDocsPage />);
  const section = screen.getByRole("heading", { level: 2, name: "What AgentzPro replies" }).closest("section")!;
  const row = (code: string) => within(section).getByRole("rowheader", { name: code }).closest("tr")!;
  expect(row("200")).toHaveTextContent('Lead saved ("success": true, "accepted": 1)');
  expect(row("400")).toHaveTextContent('"Mobile number or email not found."');
  expect(row("400")).toHaveTextContent('"More than one lead in one request."');
  expect(row("404")).toHaveTextContent('"Unknown webhook."');
  expect(row("413")).toHaveTextContent('"Payload too large."');
  expect(row("415")).toHaveTextContent('"The body is not JSON, form data or URL parameters."');
  expect(row("429")).toHaveTextContent('"Too many leads. Try again shortly."');
  expect(row("500")).toHaveTextContent('"Temporary failure, retry later."');
  expect(section).toHaveTextContent('A lead is saved only when the reply is 200 with "accepted": 1.');
  expect(screen.queryByText(/MagicBricks|Sulekha|99acres/)).not.toBeInTheDocument();
});
