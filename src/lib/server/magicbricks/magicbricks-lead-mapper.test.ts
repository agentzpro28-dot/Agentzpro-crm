// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MAGICBRICKS_PAYLOAD_MESSAGES, MagicbricksPayloadError, isEmptyMagicbricksRequest, mapMagicbricksLead, parseMagicbricksForm, type MagicbricksLeadRequest } from "@/lib/server/magicbricks/magicbricks-lead-mapper";

const get = (query: string): MagicbricksLeadRequest => ({ method: "GET", contentType: null, query: parseMagicbricksForm(new URLSearchParams(query)), rawBody: "" });
const postJson = (body: unknown, query: Record<string, unknown> = {}): MagicbricksLeadRequest => ({ method: "POST", contentType: "application/json", query, rawBody: JSON.stringify(body) });
const answers = async (request: MagicbricksLeadRequest, options = {}) => Object.fromEntries((await mapMagicbricksLead(request, options)).fieldData.map((field) => [field.name, field.values]));
const SPEC_SAMPLE = { name: "Test Buyer", mobile: "9876543210", email: "buyer@example.com", project: "Sample Towers", pid: "MB-45892", city: "Chennai", remark: "Interested in 3BHK" };

async function payloadError(run: () => Promise<unknown>): Promise<MagicbricksPayloadError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof MagicbricksPayloadError) return error;
    throw error;
  }
  throw new Error("expected a MagicbricksPayloadError");
}

describe("mapMagicbricksLead", () => {
  it("reads a GET enquiry from the URL parameters", async () => {
    const lead = await mapMagicbricksLead(get("name=Ravi&mobile=9876543210&project=Green%20Valley&pid=MB-1&remark=2%20BHK"));
    expect(Object.fromEntries(lead.fieldData.map((field) => [field.name, field.values]))).toEqual({
      full_name: ["Ravi"], phone_number: ["9876543210"], project_name: ["Green Valley"], pid: ["MB-1"], query: ["2 BHK"],
    });
    expect(lead.leadRef).toBeNull();
    expect(lead.projectName).toBe("Green Valley");
    expect(lead.rawPayload).toEqual({ name: "Ravi", mobile: "9876543210", project: "Green Valley", pid: "MB-1", remark: "2 BHK" });
  });

  it("reads a POST JSON enquiry (the spec's sample) and writes the timeline summary", async () => {
    const lead = await mapMagicbricksLead(postJson(SPEC_SAMPLE));
    expect(Object.fromEntries(lead.fieldData.map((field) => [field.name, field.values]))).toEqual({
      full_name: ["Test Buyer"], phone_number: ["9876543210"], email: ["buyer@example.com"], project_name: ["Sample Towers"], pid: ["MB-45892"], city: ["Chennai"], query: ["Interested in 3BHK"],
    });
    expect(lead.enquirySummary).toBe("New MagicBricks enquiry · Name: Test Buyer · Project: Sample Towers · City: Chennai · Query: Interested in 3BHK");
    expect(lead.leadRef).toBeNull();
  });

  it("reads a form post", async () => {
    const lead = await mapMagicbricksLead({ method: "POST", contentType: "application/x-www-form-urlencoded; charset=utf-8", query: {}, rawBody: "cust_name=Anu&contact_no=9000000001&email_id=anu%40x.com" });
    expect(Object.fromEntries(lead.fieldData.map((field) => [field.name, field.values]))).toEqual({ full_name: ["Anu"], phone_number: ["9000000001"], email: ["anu@x.com"] });
  });

  it("uses pid as the project only when no project name is sent, and never as the enquiry id", async () => {
    const lead = await mapMagicbricksLead(postJson({ mobile: "9876543210", pid: "MB-45892" }));
    expect(lead.projectName).toBe("MB-45892");
    expect(lead.leadRef).toBeNull();
    expect((await answers(postJson({ mobile: "9876543210", pid: "MB-45892" }))).project_name).toEqual(["MB-45892"]);
  });

  it("keeps MagicBricks's enquiry id out of the answers and returns it as the lead ref", async () => {
    const lead = await mapMagicbricksLead(postJson({ ...SPEC_SAMPLE, lead_id: 778899 }));
    expect(lead.leadRef).toBe("778899");
    expect(lead.fieldData.some((field) => field.name === "lead_id")).toBe(false);
    expect((await mapMagicbricksLead(postJson({ mobile: "9876543210", inquiry_id: "INQ-1" }))).leadRef).toBe("INQ-1");
  });

  it("reads each lead field from MagicBricks's other names", async () => {
    expect(await answers(postJson({ customer_name: "A", sender_mobile: "9000000002", cust_email: "a@x.com", property_name: "Tower", city_name: "Madurai", comments: "Call me" }))).toEqual({
      full_name: ["A"], phone_number: ["9000000002"], email: ["a@x.com"], project_name: ["Tower"], city: ["Madurai"], query: ["Call me"],
    });
    expect(await answers(postJson({ "Buyer Name": "B", "Mobile-No": "9000000003", locality: "Adyar" }))).toEqual({ full_name: ["B"], phone_number: ["9000000003"], city: ["Adyar"] });
  });

  it("ignores capitals, spaces, hyphens and underscores in field names", async () => {
    const lead = await mapMagicbricksLead(postJson({ customerName: "C", MobileNo: "9000000004", EMAIL_ID: "c@x.com", PropertyName: "Tower C", CityName: "Salem", LeadId: "MB-L9" }));
    expect(lead.leadRef).toBe("MB-L9");
    expect(Object.fromEntries(lead.fieldData.map((field) => [field.name, field.values]))).toEqual({
      full_name: ["C"], phone_number: ["9000000004"], email: ["c@x.com"], project_name: ["Tower C"], city: ["Salem"],
    });
    expect(await answers(get("CUST_NAME=D&contactNo=9000000005"))).toEqual({ full_name: ["D"], phone_number: ["9000000005"] });
  });

  it("names the lead \"MagicBricks Lead\" when MagicBricks sends no name", async () => {
    expect((await answers(postJson({ mobile: "9876543210" }))).full_name).toEqual(["MagicBricks Lead"]);
    expect((await mapMagicbricksLead(postJson({ mobile: "9876543210" }))).enquirySummary).toBe("New MagicBricks enquiry");
  });

  it("lets a body value win over a URL parameter of the same name", async () => {
    expect(await answers(postJson({ mobile: "9111111111" }, { mobile: "9000000000", city: "Chennai" }))).toEqual({ full_name: ["MagicBricks Lead"], phone_number: ["9111111111"], city: ["Chennai"] });
  });

  it("keeps unknown fields as form answers, and prefixes names the contact fields would otherwise take", async () => {
    expect(await answers(postJson({ mobile: "9876543210", budget: "80L", full_name: "Y", name: "Z", first_name: "X", phone_number_2: "1" }))).toEqual({
      full_name: ["Z"], phone_number: ["9876543210"], budget: ["80L"], question_full_name: ["Y"], question_first_name: ["X"], phone_number_2: ["1"],
    });
    // With no full name, first_name + last_name are the name (as on every portal).
    expect(await answers(postJson({ mobile: "9876543210", first_name: "X" }))).toEqual({ first_name: ["X"], phone_number: ["9876543210"] });
  });

  it("tries the company's own field names first (field_mapping), ignoring anything malformed", async () => {
    expect((await answers(postJson({ custMobile: "9876543210", mobile: "9000000000" }), { fieldMapping: { phone: ["custMobile"], email: "nope" } })).phone_number).toEqual(["9876543210"]);
    expect((await answers(postJson({ mobile: "9876543210" }), { fieldMapping: ["bad"] })).phone_number).toEqual(["9876543210"]);
  });

  it("accepts an email-only enquiry and refuses one with no mobile and no email", async () => {
    expect((await answers(postJson({ email: "only@x.com" }))).email).toEqual(["only@x.com"]);
    const error = await payloadError(() => mapMagicbricksLead(postJson({ name: "No contact", city: "Chennai" })));
    expect(error.message).toBe(MAGICBRICKS_PAYLOAD_MESSAGES.noContact);
    expect(error.status).toBe(400);
  });

  it("refuses unreadable or unsupported bodies with a clear answer", async () => {
    const broken = await payloadError(() => mapMagicbricksLead({ method: "POST", contentType: "application/json", query: {}, rawBody: "{bad" }));
    expect([broken.message, broken.status]).toEqual([MAGICBRICKS_PAYLOAD_MESSAGES.unsupportedType, 415]);
    expect((await payloadError(() => mapMagicbricksLead(postJson(123)))).message).toBe(MAGICBRICKS_PAYLOAD_MESSAGES.notJsonObject);
    expect((await payloadError(() => mapMagicbricksLead(postJson([{ mobile: "9876543210" }, { mobile: "9123456789" }])))).message).toBe(MAGICBRICKS_PAYLOAD_MESSAGES.oneLeadPerRequest);
    const unsupported = await payloadError(() => mapMagicbricksLead({ method: "POST", contentType: "application/xml", query: {}, rawBody: "<lead/>" }));
    expect([unsupported.message, unsupported.status]).toEqual([MAGICBRICKS_PAYLOAD_MESSAGES.unsupportedType, 415]);
    const tooMany = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`f${index}`, "x"]));
    expect((await payloadError(() => mapMagicbricksLead(postJson({ ...tooMany, mobile: "9876543210" })))).message).toBe(MAGICBRICKS_PAYLOAD_MESSAGES.tooManyFields);
    expect((await payloadError(() => mapMagicbricksLead(postJson({ ["k".repeat(101)]: "x", mobile: "9876543210" })))).message).toBe(MAGICBRICKS_PAYLOAD_MESSAGES.fieldNameTooLong);
  });

  it("keeps the digits of a long unquoted number", async () => {
    const lead = await mapMagicbricksLead({ method: "POST", contentType: "application/json", query: {}, rawBody: "{\"mobile\":\"9876543210\",\"lead_id\":12345678901234567890}" });
    expect(lead.leadRef).toBe("12345678901234567890");
  });

  it("treats a request with nothing in it as a URL check", async () => {
    expect(isEmptyMagicbricksRequest(get(""))).toBe(true);
    expect(isEmptyMagicbricksRequest({ method: "POST", contentType: "application/json", query: {}, rawBody: "  " })).toBe(true);
    expect(isEmptyMagicbricksRequest(get("mobile=1"))).toBe(false);
  });
});

describe("parseMagicbricksForm", () => {
  it("turns a repeated field into a list of answers", async () => {
    expect(parseMagicbricksForm("a=1&a=2&b=3")).toEqual({ a: ["1", "2"], b: "3" });
  });
});

// The same reading rules on every portal: this table is copied, unchanged, into the 99acres, MagicBricks, Housing.com
// and Sulekha reader tests (each portal keeps its own code). A difference between portals fails one of them.
describe("the same reading rules as every portal", () => {
  const tablePost = (body: unknown, contentType: string | null = "application/json"): MagicbricksLeadRequest => ({ method: "POST", contentType, query: {}, rawBody: typeof body === "string" ? body : JSON.stringify(body) });
  const tableGet = (query: string): MagicbricksLeadRequest => ({ method: "GET", contentType: null, query: parseMagicbricksForm(new URLSearchParams(query)), rawBody: "" });
  const tableFields = (lead: { fieldData: Array<{ name: string; values: string[] }> }) => Object.fromEntries(lead.fieldData.map((field) => [field.name, field.values]));
  const MOBILE = "9876543210";
  const OTHER_MOBILE = "9123456789";
  const multipart = (parts: Record<string, string>) => {
    const body = Object.entries(parts).map(([name, value]) => `--B\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join("") + "--B--\r\n";
    return tablePost(body, "multipart/form-data; boundary=B");
  };
  type Case = { title: string; request: () => MagicbricksLeadRequest; phone?: string; email?: string; name?: string; firstLast?: [string, string]; error?: string };
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
      await expect(mapMagicbricksLead(request())).rejects.toThrow(error);
      return;
    }
    const answers = tableFields(await mapMagicbricksLead(request()));
    expect(answers.phone_number).toEqual(phone ? [phone] : undefined);
    expect(answers.email).toEqual(email ? [email] : undefined);
    if (name) expect(answers.full_name).toEqual([name]);
    if (firstLast) expect([answers.first_name, answers.last_name]).toEqual([[firstLast[0]], [firstLast[1]]]);
  });
});
