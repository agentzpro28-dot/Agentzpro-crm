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

// The same reading rules on every portal: this table is copied, unchanged, into the 99acres, MagicBricks, Housing.com
// and Sulekha reader tests (each portal keeps its own code). A difference between portals fails one of them.
describe("the same reading rules as every portal", () => {
  const tablePost = (body: unknown, contentType: string | null = "application/json"): SulekhaLeadRequest => ({ method: "POST", contentType, query: {}, rawBody: typeof body === "string" ? body : JSON.stringify(body) });
  const tableGet = (query: string): SulekhaLeadRequest => ({ method: "GET", contentType: null, query: parseSulekhaForm(new URLSearchParams(query)), rawBody: "" });
  const tableFields = (lead: { fieldData: Array<{ name: string; values: string[] }> }) => Object.fromEntries(lead.fieldData.map((field) => [field.name, field.values]));
  const MOBILE = "9876543210";
  const OTHER_MOBILE = "9123456789";
  const multipart = (parts: Record<string, string>) => {
    const body = Object.entries(parts).map(([name, value]) => `--B\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join("") + "--B--\r\n";
    return tablePost(body, "multipart/form-data; boundary=B");
  };
  type Case = { title: string; request: () => SulekhaLeadRequest; phone?: string; email?: string; name?: string; firstLast?: [string, string]; error?: string };
  const cases: Case[] = [
    ...["mobile", "phone", "mobile_number", "phone_number", "mobile_no", "phone_no", "contact_number", "contact_no", "contact", "cust_mobile", "cust_phone", "customer_mobile", "customer_phone", "user_mobile", "user_phone", "sender_mobile", "MobileNo", "MOBILE-NO", "Mobile Number"]
      .map((key): Case => ({ title: `a phone under "${key}"`, request: () => tablePost({ [key]: MOBILE }), phone: MOBILE })),
    ...["email", "email_id", "email_address", "cust_email", "customer_email", "user_email", "sender_email", "EmailID"]
      .map((key): Case => ({ title: `an email under "${key}"`, request: () => tablePost({ [key]: "a@example.com" }), email: "a@example.com" })),
    ...["name", "full_name", "fullname", "cust_name", "customer_name", "lead_name", "buyer_name", "user_name", "contact_name", "client_name", "contact_person", "sender_name"]
      .map((key): Case => ({ title: `a name under "${key}"`, request: () => tablePost({ [key]: "Ravi", mobile: MOBILE }), name: "Ravi", phone: MOBILE })),
    { title: "JSON sent as form data", request: () => tablePost(JSON.stringify({ name: "Ravi", mobile: MOBILE }), "application/x-www-form-urlencoded"), name: "Ravi", phone: MOBILE },
    { title: "JSON sent as text/plain", request: () => tablePost(JSON.stringify({ mobile: MOBILE }), "text/plain"), phone: MOBILE },
    { title: "JSON sent with no content type", request: () => tablePost(JSON.stringify({ mobile: MOBILE }), null), phone: MOBILE },
    { title: "an ordinary form post", request: () => tablePost(`name=Ravi&mobile=${MOBILE}`, "application/x-www-form-urlencoded"), name: "Ravi", phone: MOBILE },
    { title: "one lead inside a list", request: () => tablePost([{ name: "Ravi", mobile: MOBILE }]), name: "Ravi", phone: MOBILE },
    { title: "two leads inside a list", request: () => tablePost([{ mobile: MOBILE }, { mobile: OTHER_MOBILE }]), error: "More than one lead in one request." },
    { title: "a lead inside a form field data={...}", request: () => tablePost(`data=${encodeURIComponent(JSON.stringify({ name: "Ravi", mobile: MOBILE }))}`, "application/x-www-form-urlencoded"), name: "Ravi", phone: MOBILE },
    { title: "a lead inside a JSON object {customer:{...}}", request: () => tablePost({ customer: { name: "Ravi", mobile: MOBILE } }), name: "Ravi", phone: MOBILE },
    { title: "a multipart form", request: () => multipart({ name: "Ravi", mobile: MOBILE }), name: "Ravi", phone: MOBILE },
    { title: "GET URL parameters", request: () => tableGet(`name=Ravi&mobile=${MOBILE}`), name: "Ravi", phone: MOBILE },
    { title: "first_name + last_name", request: () => tablePost({ first_name: "Anu", last_name: "R", mobile: MOBILE }), firstLast: ["Anu", "R"], phone: MOBILE },
    { title: "\"NA\" in mobile and the real phone in phone", request: () => tablePost({ mobile: "NA", phone: MOBILE }), phone: MOBILE },
    { title: "a +91 phone with spaces, kept as sent", request: () => tablePost({ mobile: "+91 98765 43210" }), phone: "+91 98765 43210" },
    ...["whatsapp", "custPh", "buyerContact", "alternate"]
      .map((key): Case => ({ title: `a phone under the unfamiliar name "${key}"`, request: () => tablePost({ name: "Ravi", [key]: MOBILE }), name: "Ravi", phone: MOBILE })),
    { title: "an email under an unfamiliar name", request: () => tablePost({ buyer_address_mail: "a@example.com" }), email: "a@example.com" },
    { title: "a known email and the phone under an unfamiliar name", request: () => tablePost({ email: "a@example.com", whatsapp: MOBILE }), email: "a@example.com", phone: MOBILE },
    { title: "two unlabelled mobiles: nothing is guessed", request: () => tablePost({ first: MOBILE, second: OTHER_MOBILE }), error: "Mobile number or email not found." },
    { title: "two unlabelled mobiles, one under a phone-like name", request: () => tablePost({ alternate: MOBILE, whatsapp_no: OTHER_MOBILE }), phone: OTHER_MOBILE },
    { title: "the same mobile in two unfamiliar fields", request: () => tablePost({ first: MOBILE, second: `+91${MOBILE}` }), phone: MOBILE },
    ...["pid", "property_id", "lead_ref", "budget", "listingId"]
      .map((key): Case => ({ title: `a 10-digit "${key}" is never the phone`, request: () => tablePost({ [key]: MOBILE }), error: "Mobile number or email not found." })),
    { title: "a number with letters is never the phone", request: () => tablePost({ note: `call ${MOBILE}` }), error: "Mobile number or email not found." },
    { title: "a landline is never taken by value", request: () => tablePost({ office: "04423456789" }), error: "Mobile number or email not found." },
    { title: "no phone and no email", request: () => tablePost({ name: "Ravi" }), error: "Mobile number or email not found." },
    { title: "XML", request: () => tablePost("<lead><mobile>9876543210</mobile></lead>", "application/xml"), error: "The body is not JSON, form data or URL parameters." },
    { title: "a bare JSON number", request: () => tablePost("123"), error: "The body is not a lead object." },
    { title: "more than 100 fields", request: () => tablePost({ ...Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`f${index}`, "v"])), mobile: MOBILE }), error: "More than 100 fields." },
    { title: "a field name over 100 characters", request: () => tablePost({ ["k".repeat(101)]: "v", mobile: MOBILE }), error: "A field name is longer than 100 characters." },
  ];

  it.each(cases)("$title", async ({ request, phone, email, name, firstLast, error }) => {
    if (error) {
      await expect(mapSulekhaLead(request())).rejects.toThrow(error);
      return;
    }
    const answers = tableFields(await mapSulekhaLead(request()));
    expect(answers.phone_number).toEqual(phone ? [phone] : undefined);
    expect(answers.email).toEqual(email ? [email] : undefined);
    if (name) expect(answers.full_name).toEqual([name]);
    if (firstLast) expect([answers.first_name, answers.last_name]).toEqual([[firstLast[0]], [firstLast[1]]]);
  });
});
