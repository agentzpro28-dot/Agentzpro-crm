// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MAX_SULEKHA_LEAD_FIELDS, SULEKHA_PAYLOAD_MESSAGES, SulekhaPayloadError, isEmptySulekhaRequest, mapSulekhaLead, parseSulekhaForm, type SulekhaLeadRequest } from "@/lib/server/sulekha/sulekha-lead-mapper";

const SAMPLE = { name: "Test Customer", mobile: "9876543210", email: "customer@example.com", service: "Interior Designers", city: "Chennai", requirement: "2BHK full interiors", lead_id: "SUL-ENQ-1" };
const post = (rawBody: string, contentType: string | null = "application/json", query: Record<string, unknown> = {}): SulekhaLeadRequest => ({ method: "POST", contentType, query, rawBody });
const get = (query: Record<string, unknown>): SulekhaLeadRequest => ({ method: "GET", contentType: null, query, rawBody: "" });
const answers = (lead: { fieldData: { name: string; values: string[] }[] }) => Object.fromEntries(lead.fieldData.map((field) => [field.name, field.values]));

async function payloadError(request: SulekhaLeadRequest): Promise<string> {
  try {
    await mapSulekhaLead(request);
  } catch (error) {
    expect(error).toBeInstanceOf(SulekhaPayloadError);
    return (error as Error).message;
  }
  throw new Error("expected a SulekhaPayloadError");
}

describe("mapSulekhaLead: the three ways Sulekha may send", () => {
  it("reads POST JSON into the contact keys lead_data reads, the enquiry id and the service", async () => {
    const lead = await mapSulekhaLead(post(JSON.stringify(SAMPLE)));
    expect(lead.leadRef).toBe("SUL-ENQ-1");
    expect(lead.serviceName).toBe("Interior Designers");
    expect(answers(lead)).toEqual({ full_name: ["Test Customer"], phone_number: ["9876543210"], email: ["customer@example.com"], service_name: ["Interior Designers"], city: ["Chennai"], query: ["2BHK full interiors"] });
    expect(lead.enquirySummary).toBe("New Sulekha enquiry · Name: Test Customer · Service: Interior Designers · City: Chennai · Requirement: 2BHK full interiors");
  });

  it("reads POST form data", async () => {
    const lead = await mapSulekhaLead(post(new URLSearchParams(SAMPLE).toString(), "application/x-www-form-urlencoded"));
    expect(answers(lead)).toMatchObject({ full_name: ["Test Customer"], phone_number: ["9876543210"], email: ["customer@example.com"] });
    expect(lead.leadRef).toBe("SUL-ENQ-1");
  });

  it("reads a multipart form's text fields", async () => {
    const form = new FormData();
    form.set("name", "Test Customer");
    form.set("mobile", "9876543210");
    const encoded = new Response(form);
    const lead = await mapSulekhaLead(post(await encoded.text(), encoded.headers.get("content-type")));
    expect(answers(lead)).toMatchObject({ full_name: ["Test Customer"], phone_number: ["9876543210"] });
  });

  it("reads GET URL parameters, a repeated one as several answers", async () => {
    const lead = await mapSulekhaLead(get({ name: "Test Customer", mobile: "9876543210", message: ["a", "b"] }));
    expect(answers(lead)).toMatchObject({ full_name: ["Test Customer"], phone_number: ["9876543210"], query: ["a", "b"] });
  });

  it("merges URL parameters and body, a body value winning", async () => {
    const lead = await mapSulekhaLead(post(JSON.stringify({ mobile: "9876543210" }), "application/json", { mobile: "9000000000", city: "Pune" }));
    expect(answers(lead)).toMatchObject({ phone_number: ["9876543210"], city: ["Pune"] });
    expect(lead.rawPayload).toEqual({ mobile: "9876543210", city: "Pune" });
  });
});

describe("mapSulekhaLead: the service shown in the Ad Name column", () => {
  it.each([["service_name"], ["category"], ["category_name"], ["sub_category"]])("takes the service from %s", async (key) => {
    const lead = await mapSulekhaLead(post(JSON.stringify({ mobile: "9876543210", [key]: "Packers and Movers" })));
    expect(lead.serviceName).toBe("Packers and Movers");
  });

  it("prefers a service over a category, and a category over a project name", async () => {
    expect((await mapSulekhaLead(post(JSON.stringify({ mobile: "9876543210", category: "Home Services", service: "Interior Designers" })))).serviceName).toBe("Interior Designers");
    expect((await mapSulekhaLead(post(JSON.stringify({ mobile: "9876543210", project_name: "Sample Heights", category: "Real Estate" })))).serviceName).toBe("Real Estate");
  });

  it("falls back to a project or property name when no service is sent", async () => {
    expect((await mapSulekhaLead(post(JSON.stringify({ mobile: "9876543210", project_name: "Sample Heights" })))).serviceName).toBe("Sample Heights");
    expect((await mapSulekhaLead(post(JSON.stringify({ mobile: "9876543210", property_name: "Lake View Villa" })))).serviceName).toBe("Lake View Villa");
  });

  it.each([["requirement"], ["need"]])("never shows the customer's %s text as the service: it stays with the query", async (key) => {
    const lead = await mapSulekhaLead(post(JSON.stringify({ mobile: "9876543210", [key]: "Need a 2BHK painted this week" })));
    expect(lead.serviceName).toBeNull();
    expect(answers(lead)).toMatchObject({ query: ["Need a 2BHK painted this week"] });
  });

  it("caps the service at 200 characters", async () => {
    const lead = await mapSulekhaLead(post(JSON.stringify({ mobile: "9876543210", service: "s".repeat(250) })));
    expect(lead.serviceName).toHaveLength(200);
  });
});

describe("mapSulekhaLead: tolerant of what a sender really sends", () => {
  it.each([["text/plain"], ["application/x-www-form-urlencoded"], [null], ["application/octet-stream"]])("reads a JSON body sent as %s", async (contentType) => {
    const lead = await mapSulekhaLead(post(JSON.stringify(SAMPLE), contentType));
    expect(answers(lead)).toMatchObject({ full_name: ["Test Customer"], phone_number: ["9876543210"] });
  });

  it("reads one lead sent in a list", async () => {
    expect((await mapSulekhaLead(post(JSON.stringify([SAMPLE])))).leadRef).toBe("SUL-ENQ-1");
  });

  it("unpacks a form field holding the whole lead as JSON (data={...})", async () => {
    const lead = await mapSulekhaLead(post(`data=${encodeURIComponent(JSON.stringify(SAMPLE))}`, "application/x-www-form-urlencoded"));
    expect(answers(lead)).toMatchObject({ full_name: ["Test Customer"], phone_number: ["9876543210"], email: ["customer@example.com"] });
    expect(lead.leadRef).toBe("SUL-ENQ-1");
    expect(answers(lead)).not.toHaveProperty("data");
    expect(lead.rawPayload).toHaveProperty("data");
  });

  it("unpacks a nested JSON object one level, a top-level field winning over an unpacked one", async () => {
    const lead = await mapSulekhaLead(post(JSON.stringify({ mobile: "9876543210", customer: { mobile: "9000000000", name: "Nested Name", city: "Pune" } })));
    expect(answers(lead)).toMatchObject({ phone_number: ["9876543210"], full_name: ["Nested Name"], city: ["Pune"] });
  });

  it("never takes a bare id inside a nested object as the enquiry id, so a second enquiry is never dropped as a retry", async () => {
    const lead = await mapSulekhaLead(post(JSON.stringify({ name: "A", mobile: "9876543210", customer: { id: "C77" } })));
    expect(lead.leadRef).toBeNull();
    expect(answers(lead)).toMatchObject({ id: ["C77"] });
    expect((await mapSulekhaLead(post(`data=${encodeURIComponent(JSON.stringify({ mobile: "9876543210", enquiry_id: "E-1" }))}`, "application/x-www-form-urlencoded"))).leadRef).toBe("E-1");
    expect((await mapSulekhaLead(post(JSON.stringify({ mobile: "9876543210", id: "TOP-1" })))).leadRef).toBe("TOP-1");
  });

  it("ignores capitals, spaces, hyphens and underscores in field names", async () => {
    const lead = await mapSulekhaLead(post(JSON.stringify({ customerName: "Kavya", MobileNo: "9000000004", EMAIL_ID: "k@x.com", ServiceName: "Painters", "Area-Name": "Adyar", LeadId: "SUL-L9" })));
    expect(lead.leadRef).toBe("SUL-L9");
    expect(answers(lead)).toEqual({ full_name: ["Kavya"], phone_number: ["9000000004"], email: ["k@x.com"], service_name: ["Painters"], city: ["Adyar"] });
    expect(answers(await mapSulekhaLead(get({ "CONTACT PERSON": "D", customerMobile: "9000000005" })))).toEqual({ full_name: ["D"], phone_number: ["9000000005"] });
  });

  it("treats a nested mobileno and a top-level mobile_no as the same name: the top-level one wins, the nested one stays in the raw copy", async () => {
    const lead = await mapSulekhaLead(post(JSON.stringify({ mobile_no: "9876543210", customer: { mobileno: "9000000000", name: "N" } })));
    expect(answers(lead)).toEqual({ phone_number: ["9876543210"], full_name: ["N"] });
    expect(lead.rawPayload).toMatchObject({ customer: { mobileno: "9000000000" } });
  });

  it("falls back to form data when the body is JSON but not an object (a bare number)", async () => {
    await expect(payloadError(post("12345", "application/json"))).resolves.toBe(SULEKHA_PAYLOAD_MESSAGES.notJsonObject);
  });

  it("keeps a phone with no digits as a form answer, never the lead's phone", async () => {
    const lead = await mapSulekhaLead(post(JSON.stringify({ name: "A", mobile: "NA", email: "a@example.com" })));
    expect(answers(lead)).toMatchObject({ email: ["a@example.com"], mobile: ["NA"] });
    expect(answers(lead)).not.toHaveProperty("phone_number");
  });

  it("keeps the phone as sent (the shared database normaliser handles +91, 0 and dashes)", async () => {
    const lead = await mapSulekhaLead(post(JSON.stringify({ mobile: " +91 98765-43210 " })));
    expect(answers(lead).phone_number).toEqual(["+91 98765-43210"]);
  });

  it("uses a support-set field_mapping name first", async () => {
    const lead = await mapSulekhaLead(post(JSON.stringify({ customerMobile: "9876543210", name: "A", needName: "Tutors" })), { fieldMapping: { phone: ["customerMobile"], service_name: ["needName"] } });
    expect(answers(lead)).toMatchObject({ phone_number: ["9876543210"] });
    expect(lead.serviceName).toBe("Tutors");
  });

  it("names the lead 'Sulekha Lead' when no name is sent, and keeps unknown fields under their own names", async () => {
    const lead = await mapSulekhaLead(post(JSON.stringify({ mobile: "9876543210", budget: "50000", email: "not-an-email" })));
    expect(answers(lead)).toMatchObject({ full_name: ["Sulekha Lead"], budget: ["50000"], question_email: ["not-an-email"] });
  });

  it("keeps a long id sent as an unquoted number digit for digit", async () => {
    expect((await mapSulekhaLead(post('{"mobile":"9876543210","lead_id":12345678901234567890}'))).leadRef).toBe("12345678901234567890");
  });
});

describe("mapSulekhaLead: what can never become a lead", () => {
  it("refuses a lead with no mobile and no email", async () => {
    await expect(payloadError(post(JSON.stringify({ name: "Only A Name" })))).resolves.toBe(SULEKHA_PAYLOAD_MESSAGES.noContact);
  });

  it("refuses several leads in one request", async () => {
    await expect(payloadError(post(JSON.stringify([SAMPLE, SAMPLE])))).resolves.toBe(SULEKHA_PAYLOAD_MESSAGES.oneLeadPerRequest);
  });

  it("refuses XML and plain text", async () => {
    await expect(payloadError(post("<lead><mobile>9876543210</mobile></lead>", "application/xml"))).resolves.toBe(SULEKHA_PAYLOAD_MESSAGES.unsupportedType);
    await expect(payloadError(post("hello", "text/plain"))).resolves.toBe(SULEKHA_PAYLOAD_MESSAGES.unsupportedType);
  });

  it("counts unpacked fields toward the field cap", async () => {
    const many = Object.fromEntries(Array.from({ length: MAX_SULEKHA_LEAD_FIELDS }, (_, index) => [`f${index}`, "x"]));
    await expect(payloadError(post(JSON.stringify({ mobile: "9876543210", data: many })))).resolves.toBe(SULEKHA_PAYLOAD_MESSAGES.tooManyFields);
  });

  it("refuses an over-long field name", async () => {
    await expect(payloadError(post(JSON.stringify({ mobile: "9876543210", ["k".repeat(101)]: "x" })))).resolves.toBe(SULEKHA_PAYLOAD_MESSAGES.fieldNameTooLong);
  });
});

describe("isEmptySulekhaRequest / parseSulekhaForm", () => {
  it("treats a request with nothing in it as a URL check", () => {
    expect(isEmptySulekhaRequest(get({}))).toBe(true);
    expect(isEmptySulekhaRequest(post("   "))).toBe(true);
    expect(isEmptySulekhaRequest(post("{}"))).toBe(false);
  });

  it("stores a field named __proto__ like any other", () => {
    const form = parseSulekhaForm("__proto__=x&a=1&a=2");
    expect(form.__proto__).toBe("x");
    expect(form.a).toEqual(["1", "2"]);
  });
});
