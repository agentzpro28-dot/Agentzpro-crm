// @vitest-environment node
import { describe, expect, it } from "vitest";
import { HOUSING_PAYLOAD_MESSAGES, HousingPayloadError, MAX_HOUSING_LEAD_FIELDS, isEmptyHousingRequest, mapHousingLead, parseHousingForm, type HousingLeadRequest } from "@/lib/server/housing/housing-lead-mapper";

const SAMPLE = { name: "Test Buyer", mobile: "9876543210", email: "buyer@example.com", project_name: "Sample Heights", city: "Chennai", message: "Interested in 3BHK", lead_id: "HS-ENQ-1" };
const post = (rawBody: string, contentType: string | null = "application/json", query: Record<string, unknown> = {}): HousingLeadRequest => ({ method: "POST", contentType, query, rawBody });
const get = (query: Record<string, unknown>): HousingLeadRequest => ({ method: "GET", contentType: null, query, rawBody: "" });
const answers = (lead: { fieldData: { name: string; values: string[] }[] }) => Object.fromEntries(lead.fieldData.map((field) => [field.name, field.values]));

async function payloadError(request: HousingLeadRequest): Promise<string> {
  try {
    await mapHousingLead(request);
  } catch (error) {
    expect(error).toBeInstanceOf(HousingPayloadError);
    return (error as Error).message;
  }
  throw new Error("expected a HousingPayloadError");
}

describe("mapHousingLead: the three ways Housing.com may send", () => {
  it("reads POST JSON into the contact keys lead_data reads, the enquiry id and the project", async () => {
    const lead = await mapHousingLead(post(JSON.stringify(SAMPLE)));
    expect(lead.leadRef).toBe("HS-ENQ-1");
    expect(lead.projectName).toBe("Sample Heights");
    expect(answers(lead)).toEqual({ full_name: ["Test Buyer"], phone_number: ["9876543210"], email: ["buyer@example.com"], project_name: ["Sample Heights"], city: ["Chennai"], query: ["Interested in 3BHK"] });
    expect(lead.enquirySummary).toBe("New Housing.com enquiry · Name: Test Buyer · Project: Sample Heights · City: Chennai · Query: Interested in 3BHK");
  });

  it("reads POST form data", async () => {
    const lead = await mapHousingLead(post(new URLSearchParams(SAMPLE).toString(), "application/x-www-form-urlencoded"));
    expect(answers(lead)).toMatchObject({ full_name: ["Test Buyer"], phone_number: ["9876543210"], email: ["buyer@example.com"] });
    expect(lead.leadRef).toBe("HS-ENQ-1");
  });

  it("reads a multipart form's text fields", async () => {
    const form = new FormData();
    form.set("name", "Test Buyer");
    form.set("mobile", "9876543210");
    const encoded = new Response(form);
    const contentType = encoded.headers.get("content-type");
    const lead = await mapHousingLead(post(await encoded.text(), contentType));
    expect(answers(lead)).toMatchObject({ full_name: ["Test Buyer"], phone_number: ["9876543210"] });
  });

  it("reads GET URL parameters, a repeated one as several answers", async () => {
    const lead = await mapHousingLead(get({ name: "Test Buyer", mobile: "9876543210", message: ["a", "b"] }));
    expect(answers(lead)).toMatchObject({ full_name: ["Test Buyer"], phone_number: ["9876543210"], query: ["a", "b"] });
  });

  it("merges URL parameters and body, a body value winning", async () => {
    const lead = await mapHousingLead(post(JSON.stringify({ mobile: "9876543210" }), "application/json", { mobile: "9000000000", city: "Pune" }));
    expect(answers(lead)).toMatchObject({ phone_number: ["9876543210"], city: ["Pune"] });
    expect(lead.rawPayload).toEqual({ mobile: "9876543210", city: "Pune" });
  });
});

describe("mapHousingLead: tolerant of what portals really send", () => {
  it.each([["text/plain"], ["application/x-www-form-urlencoded"], [null], ["application/octet-stream"]])("reads a JSON body sent as %s", async (contentType) => {
    const lead = await mapHousingLead(post(JSON.stringify(SAMPLE), contentType));
    expect(answers(lead)).toMatchObject({ full_name: ["Test Buyer"], phone_number: ["9876543210"] });
  });

  it("reads one lead sent in a list", async () => {
    const lead = await mapHousingLead(post(JSON.stringify([SAMPLE])));
    expect(lead.leadRef).toBe("HS-ENQ-1");
  });

  it("unpacks a form field holding the whole lead as JSON (data={...})", async () => {
    const lead = await mapHousingLead(post(`data=${encodeURIComponent(JSON.stringify(SAMPLE))}`, "application/x-www-form-urlencoded"));
    expect(answers(lead)).toMatchObject({ full_name: ["Test Buyer"], phone_number: ["9876543210"], email: ["buyer@example.com"] });
    expect(lead.leadRef).toBe("HS-ENQ-1");
    // The JSON blob itself is kept in the raw copy only, not as a form answer.
    expect(answers(lead)).not.toHaveProperty("data");
    expect(lead.rawPayload).toHaveProperty("data");
  });

  it("unpacks a nested JSON object one level, a top-level field winning over an unpacked one", async () => {
    const lead = await mapHousingLead(post(JSON.stringify({ mobile: "9876543210", lead: { mobile: "9000000000", name: "Nested Name", city: "Pune" } })));
    expect(answers(lead)).toMatchObject({ phone_number: ["9876543210"], full_name: ["Nested Name"], city: ["Pune"] });
  });

  it("never takes a bare id inside a nested object as the enquiry id, so a second enquiry is never dropped as a retry", async () => {
    const lead = await mapHousingLead(post(JSON.stringify({ name: "A", mobile: "9876543210", user: { id: "U77" } })));
    expect(lead.leadRef).toBeNull();
    expect(answers(lead)).toMatchObject({ id: ["U77"] });
    // A named enquiry id inside data={...} still counts, and a top-level id still counts.
    expect((await mapHousingLead(post(`data=${encodeURIComponent(JSON.stringify({ mobile: "9876543210", enquiry_id: "E-1" }))}`, "application/x-www-form-urlencoded"))).leadRef).toBe("E-1");
    expect((await mapHousingLead(post(JSON.stringify({ mobile: "9876543210", id: "TOP-1" })))).leadRef).toBe("TOP-1");
  });

  it("falls back to form data when the body is JSON but not an object (a bare number)", async () => {
    await expect(payloadError(post("12345", "application/json"))).resolves.toBe(HOUSING_PAYLOAD_MESSAGES.notJsonObject);
  });

  it("keeps a phone with no digits as a form answer, never the lead's phone", async () => {
    const lead = await mapHousingLead(post(JSON.stringify({ name: "A", mobile: "NA", email: "a@example.com" })));
    expect(answers(lead)).toMatchObject({ email: ["a@example.com"], mobile: ["NA"] });
    expect(answers(lead)).not.toHaveProperty("phone_number");
  });

  it("keeps the phone as sent (the shared database normaliser handles +91, 0 and dashes)", async () => {
    const lead = await mapHousingLead(post(JSON.stringify({ mobile: " +91 98765-43210 " })));
    expect(answers(lead).phone_number).toEqual(["+91 98765-43210"]);
  });

  it("uses a support-set field_mapping name first", async () => {
    const lead = await mapHousingLead(post(JSON.stringify({ custMobile: "9876543210", name: "A" })), { fieldMapping: { phone: ["custMobile"] } });
    expect(answers(lead)).toMatchObject({ phone_number: ["9876543210"] });
  });

  it("names the lead 'Housing.com Lead' when no name is sent, and keeps unknown fields under their own names", async () => {
    const lead = await mapHousingLead(post(JSON.stringify({ mobile: "9876543210", budget: "1 Cr", email: "not-an-email" })));
    expect(answers(lead)).toMatchObject({ full_name: ["Housing.com Lead"], budget: ["1 Cr"], question_email: ["not-an-email"] });
  });

  it("keeps a long id sent as an unquoted number digit for digit", async () => {
    const lead = await mapHousingLead(post('{"mobile":"9876543210","lead_id":12345678901234567890}'));
    expect(lead.leadRef).toBe("12345678901234567890");
  });
});

describe("mapHousingLead: what can never become a lead", () => {
  it("refuses a lead with no mobile and no email", async () => {
    await expect(payloadError(post(JSON.stringify({ name: "Only A Name" })))).resolves.toBe(HOUSING_PAYLOAD_MESSAGES.noContact);
  });

  it("refuses several leads in one request", async () => {
    await expect(payloadError(post(JSON.stringify([SAMPLE, SAMPLE])))).resolves.toBe(HOUSING_PAYLOAD_MESSAGES.oneLeadPerRequest);
  });

  it("refuses XML and plain text", async () => {
    await expect(payloadError(post("<lead><mobile>9876543210</mobile></lead>", "application/xml"))).resolves.toBe(HOUSING_PAYLOAD_MESSAGES.unsupportedType);
    await expect(payloadError(post("hello", "text/plain"))).resolves.toBe(HOUSING_PAYLOAD_MESSAGES.unsupportedType);
  });

  it("counts unpacked fields toward the field cap", async () => {
    const many = Object.fromEntries(Array.from({ length: MAX_HOUSING_LEAD_FIELDS }, (_, index) => [`f${index}`, "x"]));
    await expect(payloadError(post(JSON.stringify({ mobile: "9876543210", data: many })))).resolves.toBe(HOUSING_PAYLOAD_MESSAGES.tooManyFields);
  });

  it("refuses an over-long field name", async () => {
    await expect(payloadError(post(JSON.stringify({ mobile: "9876543210", ["k".repeat(101)]: "x" })))).resolves.toBe(HOUSING_PAYLOAD_MESSAGES.fieldNameTooLong);
  });
});

describe("isEmptyHousingRequest / parseHousingForm", () => {
  it("treats a request with nothing in it as a URL check", () => {
    expect(isEmptyHousingRequest(get({}))).toBe(true);
    expect(isEmptyHousingRequest(post("   "))).toBe(true);
    expect(isEmptyHousingRequest(post("{}"))).toBe(false);
  });

  it("stores a field named __proto__ like any other", () => {
    const form = parseHousingForm("__proto__=x&a=1&a=2");
    expect(form.__proto__).toBe("x");
    expect(form.a).toEqual(["1", "2"]);
  });
});
