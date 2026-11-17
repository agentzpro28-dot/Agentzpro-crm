// @vitest-environment node
import { describe, expect, it } from "vitest";
import { PortalLeadPayloadError, isEmptyPortalRequest, mapPortalLead, parseForm, type PortalLeadRequest } from "@/lib/server/portal-leads/portal-lead-mapper";

const post = (body: unknown, contentType = "application/json", query: Record<string, unknown> = {}): PortalLeadRequest => ({
  method: "POST", contentType, query, rawBody: typeof body === "string" ? body : JSON.stringify(body),
});
const get = (query: string): PortalLeadRequest => ({ method: "GET", contentType: null, query: parseForm(new URLSearchParams(query)), rawBody: "" });
const fields = (lead: { fieldData: Array<{ name: string; values: string[] }> }) => Object.fromEntries(lead.fieldData.map((field) => [field.name, field.values]));

describe("mapPortalLead", () => {
  it("reads a 99acres-style JSON body (cust_name, contact_no, project_name, query) into Meta's contact keys", () => {
    const lead = mapPortalLead("99acres", post({ cust_name: "Ravi Kumar", contact_no: "+91-98765-43210", project_name: "Green Valley", query: "2 BHK?", lead_id: "ENQ-1" }));
    expect(lead.leadRef).toBe("ENQ-1");
    expect(lead.projectName).toBe("Green Valley");
    expect(fields(lead)).toEqual({ full_name: ["Ravi Kumar"], phone_number: ["+91-98765-43210"], project_name: ["Green Valley"], query: ["2 BHK?"] });
    expect(lead.rawPayload).toEqual({ cust_name: "Ravi Kumar", contact_no: "+91-98765-43210", project_name: "Green Valley", query: "2 BHK?", lead_id: "ENQ-1" });
    expect(lead.enquirySummary).toBe("New 99acres enquiry · Name: Ravi Kumar · Project: Green Valley · Query: 2 BHK?");
  });

  it("reads a form post", () => {
    const lead = mapPortalLead("99acres", post("name=Asha&mobile=9876543210&email=asha%40example.com&city=Chennai&remarks=Call+after+6", "application/x-www-form-urlencoded"));
    expect(fields(lead)).toEqual({ full_name: ["Asha"], phone_number: ["9876543210"], email: ["asha@example.com"], city: ["Chennai"], query: ["Call after 6"] });
  });

  it("reads GET URL parameters", () => {
    const lead = mapPortalLead("99acres", get("customer_name=Vijay&mobile_no=9123456789&property_name=Sea%20View&locality=OMR&inquiry_id=77"));
    expect(lead.leadRef).toBe("77");
    expect(fields(lead)).toEqual({ full_name: ["Vijay"], phone_number: ["9123456789"], project_name: ["Sea View"], city: ["OMR"] });
  });

  it("merges URL parameters and the body; a body value wins", () => {
    const lead = mapPortalLead("99acres", post({ name: "From Body", phone: "9876543210" }, "application/json", { name: "From Query", city: "Pune" }));
    expect(fields(lead)).toEqual({ full_name: ["From Body"], phone_number: ["9876543210"], city: ["Pune"] });
    expect(lead.rawPayload).toEqual({ name: "From Body", phone: "9876543210", city: "Pune" });
  });

  it("matches names case-insensitively, with spaces and hyphens read as _", () => {
    const lead = mapPortalLead("99acres", post({ "Customer Name": "Meena", "Mobile-No": "9000000001", "Email ID": "m@example.com" }));
    expect(fields(lead)).toEqual({ full_name: ["Meena"], phone_number: ["9000000001"], email: ["m@example.com"] });
  });

  it("uses the best name present and keeps the rest as form answers, prefixing names that would shadow a contact field", () => {
    const lead = mapPortalLead("99acres", post({ cust_name: "Second", name: "First", full_name: "Third", phone: "9876543210", budget: "80L" }));
    expect(fields(lead)).toEqual({ full_name: ["First"], cust_name: ["Second"], question_full_name: ["Third"], phone_number: ["9876543210"], budget: ["80L"] });
  });

  it("names a lead with no name '99acres Lead', but keeps first and last names when sent", () => {
    expect(fields(mapPortalLead("99acres", post({ mobile: "9876543210" })))).toEqual({ full_name: ["99acres Lead"], phone_number: ["9876543210"] });
    expect(fields(mapPortalLead("99acres", post({ first_name: "Anu", last_name: "R", mobile: "9876543210" })))).toEqual({ first_name: ["Anu"], last_name: ["R"], phone_number: ["9876543210"] });
  });

  it("accepts an email-only lead and refuses one with neither mobile nor email", () => {
    expect(fields(mapPortalLead("99acres", post({ email_id: "x@example.com" })))).toMatchObject({ email: ["x@example.com"] });
    expect(() => mapPortalLead("99acres", post({ name: "No Contact" }))).toThrow(new PortalLeadPayloadError("Send mobile or email."));
  });

  it("puts the company's own field names (field_mapping) first", () => {
    const lead = mapPortalLead("99acres", post({ custMobile: "9876543210", mobile: "9111111111" }), { fieldMapping: { phone: ["custMobile"] } });
    expect(fields(lead)).toMatchObject({ phone_number: ["9876543210"], mobile: ["9111111111"] });
    // A malformed mapping is ignored, never fatal.
    expect(fields(mapPortalLead("99acres", post({ mobile: "9876543210" }), { fieldMapping: { phone: "x", email: [1] } }))).toMatchObject({ phone_number: ["9876543210"] });
  });

  it("keeps a lead id that is a list, an object or over 200 characters as a form answer instead of using it", () => {
    const lead = mapPortalLead("99acres", post({ mobile: "9876543210", lead_id: "x".repeat(201), id: "short-id" }));
    expect(lead.leadRef).toBe("short-id");
    expect(fields(lead).lead_id).toEqual(["x".repeat(201)]);
  });

  it("keeps numbers as written, including long ones JSON would round", () => {
    const lead = mapPortalLead("99acres", post('{"mobile": 9876543210, "response_id": 12345678901234567890}'));
    expect(lead.leadRef).toBe("12345678901234567890");
    expect(fields(lead).phone_number).toEqual(["9876543210"]);
  });

  it("refuses formats it cannot read: 415 for XML, 400 for a JSON list or broken JSON", () => {
    expect(() => mapPortalLead("99acres", post("<lead/>", "application/xml"))).toThrow(expect.objectContaining({ status: 415 }));
    expect(() => mapPortalLead("99acres", post("[{}]"))).toThrow("Send one lead per request.");
    expect(() => mapPortalLead("99acres", post("{bad"))).toThrow("Send the lead as a JSON object.");
  });

  it("caps field count and field name length", () => {
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`f${index}`, "v"]));
    expect(() => mapPortalLead("99acres", post({ ...many, mobile: "9876543210" }))).toThrow("Send 100 fields or fewer.");
    expect(() => mapPortalLead("99acres", post({ ["k".repeat(101)]: "v", mobile: "9876543210" }))).toThrow("Field names must be 100 characters or fewer.");
  });

  it("stores a field named __proto__ like any other", () => {
    const lead = mapPortalLead("99acres", post('{"__proto__": "x", "mobile": "9876543210"}'));
    expect(fields(lead).__proto__).toEqual(["x"]);
  });

  it("starts every note text with New 99acres enquiry", () => {
    expect(mapPortalLead("99acres", post({ mobile: "9876543210" })).enquirySummary).toBe("New 99acres enquiry");
  });
});

describe("isEmptyPortalRequest", () => {
  it("is true only when there is no URL parameter and no body", () => {
    expect(isEmptyPortalRequest({ method: "GET", contentType: null, query: {}, rawBody: "" })).toBe(true);
    expect(isEmptyPortalRequest({ method: "POST", contentType: "application/json", query: {}, rawBody: "  " })).toBe(true);
    expect(isEmptyPortalRequest({ method: "POST", contentType: "application/json", query: {}, rawBody: "{}" })).toBe(false);
    expect(isEmptyPortalRequest({ method: "GET", contentType: null, query: { mobile: "1" }, rawBody: "" })).toBe(false);
  });
});
