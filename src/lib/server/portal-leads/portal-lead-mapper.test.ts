// @vitest-environment node
import { describe, expect, it } from "vitest";
import { PortalLeadPayloadError, isEmptyPortalRequest, mapPortalLead, parseForm, type PortalLeadRequest } from "@/lib/server/portal-leads/portal-lead-mapper";

const post = (body: unknown, contentType: string | null = "application/json", query: Record<string, unknown> = {}): PortalLeadRequest => ({
  method: "POST", contentType, query, rawBody: typeof body === "string" ? body : JSON.stringify(body),
});
const get = (query: string): PortalLeadRequest => ({ method: "GET", contentType: null, query: parseForm(new URLSearchParams(query)), rawBody: "" });
const fields = (lead: { fieldData: Array<{ name: string; values: string[] }> }) => Object.fromEntries(lead.fieldData.map((field) => [field.name, field.values]));

describe("mapPortalLead", () => {
  it("reads a 99acres-style JSON body (cust_name, contact_no, project_name, query) into Meta's contact keys", async () => {
    const lead = await mapPortalLead("99acres", post({ cust_name: "Ravi Kumar", contact_no: "+91-98765-43210", project_name: "Green Valley", query: "2 BHK?", lead_id: "ENQ-1" }));
    expect(lead.leadRef).toBe("ENQ-1");
    expect(lead.projectName).toBe("Green Valley");
    expect(fields(lead)).toEqual({ full_name: ["Ravi Kumar"], phone_number: ["+91-98765-43210"], project_name: ["Green Valley"], query: ["2 BHK?"] });
    expect(lead.rawPayload).toEqual({ cust_name: "Ravi Kumar", contact_no: "+91-98765-43210", project_name: "Green Valley", query: "2 BHK?", lead_id: "ENQ-1" });
    expect(lead.enquirySummary).toBe("New 99acres enquiry · Name: Ravi Kumar · Project: Green Valley · Query: 2 BHK?");
  });

  it("reads a form post", async () => {
    const lead = await mapPortalLead("99acres", post("name=Asha&mobile=9876543210&email=asha%40example.com&city=Chennai&remarks=Call+after+6", "application/x-www-form-urlencoded"));
    expect(fields(lead)).toEqual({ full_name: ["Asha"], phone_number: ["9876543210"], email: ["asha@example.com"], city: ["Chennai"], query: ["Call after 6"] });
  });

  it("reads GET URL parameters", async () => {
    const lead = await mapPortalLead("99acres", get("customer_name=Vijay&mobile_no=9123456789&property_name=Sea%20View&locality=OMR&inquiry_id=77"));
    expect(lead.leadRef).toBe("77");
    expect(fields(lead)).toEqual({ full_name: ["Vijay"], phone_number: ["9123456789"], project_name: ["Sea View"], city: ["OMR"] });
  });

  it("merges URL parameters and the body; a body value wins", async () => {
    const lead = await mapPortalLead("99acres", post({ name: "From Body", phone: "9876543210" }, "application/json", { name: "From Query", city: "Pune" }));
    expect(fields(lead)).toEqual({ full_name: ["From Body"], phone_number: ["9876543210"], city: ["Pune"] });
    expect(lead.rawPayload).toEqual({ name: "From Body", phone: "9876543210", city: "Pune" });
  });

  it("matches names with capitals, spaces, hyphens and underscores ignored", async () => {
    const lead = await mapPortalLead("99acres", post({ "Customer Name": "Meena", "Mobile-No": "9000000001", "Email ID": "m@example.com" }));
    expect(fields(lead)).toEqual({ full_name: ["Meena"], phone_number: ["9000000001"], email: ["m@example.com"] });
    const joined = await mapPortalLead("99acres", post({ customerName: "Ravi", MobileNo: "9000000002", EMAIL_ID: "r@example.com", ProjectName: "Sea View", LeadId: "L-9", Remarks: "Call" }));
    expect(joined.leadRef).toBe("L-9");
    expect(fields(joined)).toEqual({ full_name: ["Ravi"], phone_number: ["9000000002"], email: ["r@example.com"], project_name: ["Sea View"], query: ["Call"] });
    expect(fields(await mapPortalLead("99acres", post({ FirstName: "Anu", LAST_NAME: "R", "mobile no": "9000000003" })))).toEqual({ first_name: ["Anu"], last_name: ["R"], phone_number: ["9000000003"] });
  });

  it("uses the best name present and keeps the rest as form answers, prefixing names that would shadow a contact field", async () => {
    const lead = await mapPortalLead("99acres", post({ cust_name: "Second", name: "First", full_name: "Third", phone: "9876543210", budget: "80L" }));
    expect(fields(lead)).toEqual({ full_name: ["First"], cust_name: ["Second"], question_full_name: ["Third"], phone_number: ["9876543210"], budget: ["80L"] });
  });

  it("names a lead with no name '99acres Lead', but keeps first and last names when sent", async () => {
    expect(fields(await mapPortalLead("99acres", post({ mobile: "9876543210" })))).toEqual({ full_name: ["99acres Lead"], phone_number: ["9876543210"] });
    expect(fields(await mapPortalLead("99acres", post({ first_name: "Anu", last_name: "R", mobile: "9876543210" })))).toEqual({ first_name: ["Anu"], last_name: ["R"], phone_number: ["9876543210"] });
  });

  it("accepts an email-only lead and refuses one with neither mobile nor email", async () => {
    expect(fields(await mapPortalLead("99acres", post({ email_id: "x@example.com" })))).toMatchObject({ email: ["x@example.com"] });
    await expect(mapPortalLead("99acres", post({ name: "No Contact" }))).rejects.toThrow(new PortalLeadPayloadError("Mobile number or email not found."));
  });

  it("puts the company's own field names (field_mapping) first", async () => {
    const lead = await mapPortalLead("99acres", post({ custMobile: "9876543210", mobile: "9111111111" }), { fieldMapping: { phone: ["custMobile"] } });
    expect(fields(lead)).toMatchObject({ phone_number: ["9876543210"], mobile: ["9111111111"] });
    // A malformed mapping is ignored, never fatal.
    expect(fields(await mapPortalLead("99acres", post({ mobile: "9876543210" }), { fieldMapping: { phone: "x", email: [1] } }))).toMatchObject({ phone_number: ["9876543210"] });
  });

  it("keeps a lead id that is a list, an object or over 200 characters as a form answer instead of using it", async () => {
    const lead = await mapPortalLead("99acres", post({ mobile: "9876543210", lead_id: "x".repeat(201), id: "short-id" }));
    expect(lead.leadRef).toBe("short-id");
    expect(fields(lead).lead_id).toEqual(["x".repeat(201)]);
  });

  it("keeps numbers as written, including long ones JSON would round", async () => {
    const lead = await mapPortalLead("99acres", post('{"mobile": 9876543210, "response_id": 12345678901234567890}'));
    expect(lead.leadRef).toBe("12345678901234567890");
    expect(fields(lead).phone_number).toEqual(["9876543210"]);
  });

  it("refuses formats it cannot read: 415 for XML or broken JSON, 400 for a list of leads or a bare JSON value", async () => {
    await expect(mapPortalLead("99acres", post("<lead/>", "application/xml"))).rejects.toThrow(expect.objectContaining({ status: 415 }));
    await expect(mapPortalLead("99acres", post("{bad"))).rejects.toThrow(expect.objectContaining({ status: 415, message: "The body is not JSON, form data or URL parameters." }));
    await expect(mapPortalLead("99acres", post("[{\"mobile\":\"9876543210\"},{\"mobile\":\"9123456789\"}]"))).rejects.toThrow(expect.objectContaining({ status: 400, message: "More than one lead in one request." }));
    await expect(mapPortalLead("99acres", post("123"))).rejects.toThrow(expect.objectContaining({ status: 400, message: "The body is not a lead object." }));
  });

  it("caps field count and field name length", async () => {
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`f${index}`, "v"]));
    await expect(mapPortalLead("99acres", post({ ...many, mobile: "9876543210" }))).rejects.toThrow("More than 100 fields.");
    await expect(mapPortalLead("99acres", post({ ["k".repeat(101)]: "v", mobile: "9876543210" }))).rejects.toThrow("A field name is longer than 100 characters.");
  });

  it("stores a field named __proto__ like any other", async () => {
    const lead = await mapPortalLead("99acres", post('{"__proto__": "x", "mobile": "9876543210"}'));
    expect(fields(lead).__proto__).toEqual(["x"]);
  });

  it("starts every note text with New 99acres enquiry", async () => {
    expect((await mapPortalLead("99acres", post({ mobile: "9876543210" }))).enquirySummary).toBe("New 99acres enquiry");
  });
});

describe("isEmptyPortalRequest", async () => {
  it("is true only when there is no URL parameter and no body", async () => {
    expect(isEmptyPortalRequest({ method: "GET", contentType: null, query: {}, rawBody: "" })).toBe(true);
    expect(isEmptyPortalRequest({ method: "POST", contentType: "application/json", query: {}, rawBody: "  " })).toBe(true);
    expect(isEmptyPortalRequest({ method: "POST", contentType: "application/json", query: {}, rawBody: "{}" })).toBe(false);
    expect(isEmptyPortalRequest({ method: "GET", contentType: null, query: { mobile: "1" }, rawBody: "" })).toBe(false);
  });
});

// The same reading rules on every portal: this table is copied, unchanged, into the 99acres, MagicBricks, Housing.com
// and Sulekha reader tests (each portal keeps its own code). A difference between portals fails one of them.
describe("the same reading rules as every portal", () => {
  const tablePost = (body: unknown, contentType: string | null = "application/json"): PortalLeadRequest => ({ method: "POST", contentType, query: {}, rawBody: typeof body === "string" ? body : JSON.stringify(body) });
  const tableGet = (query: string): PortalLeadRequest => ({ method: "GET", contentType: null, query: parseForm(new URLSearchParams(query)), rawBody: "" });
  const tableFields = (lead: { fieldData: Array<{ name: string; values: string[] }> }) => Object.fromEntries(lead.fieldData.map((field) => [field.name, field.values]));
  const MOBILE = "9876543210";
  const OTHER_MOBILE = "9123456789";
  const multipart = (parts: Record<string, string>) => {
    const body = Object.entries(parts).map(([name, value]) => `--B\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join("") + "--B--\r\n";
    return tablePost(body, "multipart/form-data; boundary=B");
  };
  type Case = { title: string; request: () => PortalLeadRequest; phone?: string; email?: string; name?: string; firstLast?: [string, string]; error?: string };
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
    { title: "a very long value is never an email, and is checked quickly", request: () => tablePost({ note: `a@${"a.".repeat(30000)}` }), error: "Mobile number or email not found." },
    { title: "XML", request: () => tablePost("<lead><mobile>9876543210</mobile></lead>", "application/xml"), error: "The body is not JSON, form data or URL parameters." },
    { title: "a bare JSON number", request: () => tablePost("123"), error: "The body is not a lead object." },
    { title: "more than 100 fields", request: () => tablePost({ ...Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`f${index}`, "v"])), mobile: MOBILE }), error: "More than 100 fields." },
    { title: "a field name over 100 characters", request: () => tablePost({ ["k".repeat(101)]: "v", mobile: MOBILE }), error: "A field name is longer than 100 characters." },
  ];

  it.each(cases)("$title", async ({ request, phone, email, name, firstLast, error }) => {
    if (error) {
      await expect(mapPortalLead("99acres", request())).rejects.toThrow(error);
      return;
    }
    const answers = tableFields(await mapPortalLead("99acres", request()));
    expect(answers.phone_number).toEqual(phone ? [phone] : undefined);
    expect(answers.email).toEqual(email ? [email] : undefined);
    if (name) expect(answers.full_name).toEqual([name]);
    if (firstLast) expect([answers.first_name, answers.last_name]).toEqual([[firstLast[0]], [firstLast[1]]]);
  });
});
