// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MAGICBRICKS_PAYLOAD_MESSAGES, MagicbricksPayloadError, isEmptyMagicbricksRequest, mapMagicbricksLead, parseMagicbricksForm, type MagicbricksLeadRequest } from "@/lib/server/magicbricks/magicbricks-lead-mapper";

const get = (query: string): MagicbricksLeadRequest => ({ method: "GET", contentType: null, query: parseMagicbricksForm(new URLSearchParams(query)), rawBody: "" });
const postJson = (body: unknown, query: Record<string, unknown> = {}): MagicbricksLeadRequest => ({ method: "POST", contentType: "application/json", query, rawBody: JSON.stringify(body) });
const answers = (request: MagicbricksLeadRequest, options = {}) => Object.fromEntries(mapMagicbricksLead(request, options).fieldData.map((field) => [field.name, field.values]));
const SPEC_SAMPLE = { name: "Test Buyer", mobile: "9876543210", email: "buyer@example.com", project: "Sample Towers", pid: "MB-45892", city: "Chennai", remark: "Interested in 3BHK" };

function payloadError(run: () => unknown): MagicbricksPayloadError {
  try {
    run();
  } catch (error) {
    if (error instanceof MagicbricksPayloadError) return error;
    throw error;
  }
  throw new Error("expected a MagicbricksPayloadError");
}

describe("mapMagicbricksLead", () => {
  it("reads a GET enquiry from the URL parameters", () => {
    const lead = mapMagicbricksLead(get("name=Ravi&mobile=9876543210&project=Green%20Valley&pid=MB-1&remark=2%20BHK"));
    expect(Object.fromEntries(lead.fieldData.map((field) => [field.name, field.values]))).toEqual({
      full_name: ["Ravi"], phone_number: ["9876543210"], project_name: ["Green Valley"], pid: ["MB-1"], query: ["2 BHK"],
    });
    expect(lead.leadRef).toBeNull();
    expect(lead.projectName).toBe("Green Valley");
    expect(lead.rawPayload).toEqual({ name: "Ravi", mobile: "9876543210", project: "Green Valley", pid: "MB-1", remark: "2 BHK" });
  });

  it("reads a POST JSON enquiry (the spec's sample) and writes the timeline summary", () => {
    const lead = mapMagicbricksLead(postJson(SPEC_SAMPLE));
    expect(Object.fromEntries(lead.fieldData.map((field) => [field.name, field.values]))).toEqual({
      full_name: ["Test Buyer"], phone_number: ["9876543210"], email: ["buyer@example.com"], project_name: ["Sample Towers"], pid: ["MB-45892"], city: ["Chennai"], query: ["Interested in 3BHK"],
    });
    expect(lead.enquirySummary).toBe("New MagicBricks enquiry · Name: Test Buyer · Project: Sample Towers · City: Chennai · Query: Interested in 3BHK");
    expect(lead.leadRef).toBeNull();
  });

  it("reads a form post", () => {
    const lead = mapMagicbricksLead({ method: "POST", contentType: "application/x-www-form-urlencoded; charset=utf-8", query: {}, rawBody: "cust_name=Anu&contact_no=9000000001&email_id=anu%40x.com" });
    expect(Object.fromEntries(lead.fieldData.map((field) => [field.name, field.values]))).toEqual({ full_name: ["Anu"], phone_number: ["9000000001"], email: ["anu@x.com"] });
  });

  it("uses pid as the project only when no project name is sent, and never as the enquiry id", () => {
    const lead = mapMagicbricksLead(postJson({ mobile: "9876543210", pid: "MB-45892" }));
    expect(lead.projectName).toBe("MB-45892");
    expect(lead.leadRef).toBeNull();
    expect(answers(postJson({ mobile: "9876543210", pid: "MB-45892" })).project_name).toEqual(["MB-45892"]);
  });

  it("keeps MagicBricks's enquiry id out of the answers and returns it as the lead ref", () => {
    const lead = mapMagicbricksLead(postJson({ ...SPEC_SAMPLE, lead_id: 778899 }));
    expect(lead.leadRef).toBe("778899");
    expect(lead.fieldData.some((field) => field.name === "lead_id")).toBe(false);
    expect(mapMagicbricksLead(postJson({ mobile: "9876543210", inquiry_id: "INQ-1" })).leadRef).toBe("INQ-1");
  });

  it("reads each lead field from MagicBricks's other names", () => {
    expect(answers(postJson({ customer_name: "A", sender_mobile: "9000000002", cust_email: "a@x.com", property_name: "Tower", city_name: "Madurai", comments: "Call me" }))).toEqual({
      full_name: ["A"], phone_number: ["9000000002"], email: ["a@x.com"], project_name: ["Tower"], city: ["Madurai"], query: ["Call me"],
    });
    expect(answers(postJson({ "Buyer Name": "B", "Mobile-No": "9000000003", locality: "Adyar" }))).toEqual({ full_name: ["B"], phone_number: ["9000000003"], city: ["Adyar"] });
  });

  it("names the lead \"MagicBricks Lead\" when MagicBricks sends no name", () => {
    expect(answers(postJson({ mobile: "9876543210" })).full_name).toEqual(["MagicBricks Lead"]);
    expect(mapMagicbricksLead(postJson({ mobile: "9876543210" })).enquirySummary).toBe("New MagicBricks enquiry");
  });

  it("lets a body value win over a URL parameter of the same name", () => {
    expect(answers(postJson({ mobile: "9111111111" }, { mobile: "9000000000", city: "Chennai" }))).toEqual({ full_name: ["MagicBricks Lead"], phone_number: ["9111111111"], city: ["Chennai"] });
  });

  it("keeps unknown fields as form answers, and prefixes names the contact fields would otherwise take", () => {
    expect(answers(postJson({ mobile: "9876543210", budget: "80L", first_name: "X", phone_number_2: "1" }))).toEqual({
      full_name: ["MagicBricks Lead"], phone_number: ["9876543210"], budget: ["80L"], question_first_name: ["X"], phone_number_2: ["1"],
    });
  });

  it("tries the company's own field names first (field_mapping), ignoring anything malformed", () => {
    expect(answers(postJson({ custMobile: "9876543210", mobile: "9000000000" }), { fieldMapping: { phone: ["custMobile"], email: "nope" } }).phone_number).toEqual(["9876543210"]);
    expect(answers(postJson({ mobile: "9876543210" }), { fieldMapping: ["bad"] }).phone_number).toEqual(["9876543210"]);
  });

  it("accepts an email-only enquiry and refuses one with no mobile and no email", () => {
    expect(answers(postJson({ email: "only@x.com" })).email).toEqual(["only@x.com"]);
    const error = payloadError(() => mapMagicbricksLead(postJson({ name: "No contact", city: "Chennai" })));
    expect(error.message).toBe(MAGICBRICKS_PAYLOAD_MESSAGES.noContact);
    expect(error.status).toBe(400);
  });

  it("refuses unreadable or unsupported bodies with a clear answer", () => {
    expect(payloadError(() => mapMagicbricksLead({ method: "POST", contentType: "application/json", query: {}, rawBody: "{bad" })).message).toBe(MAGICBRICKS_PAYLOAD_MESSAGES.notJsonObject);
    expect(payloadError(() => mapMagicbricksLead(postJson([{ mobile: "9876543210" }]))).message).toBe(MAGICBRICKS_PAYLOAD_MESSAGES.oneLeadPerRequest);
    const unsupported = payloadError(() => mapMagicbricksLead({ method: "POST", contentType: "application/xml", query: {}, rawBody: "<lead/>" }));
    expect([unsupported.message, unsupported.status]).toEqual([MAGICBRICKS_PAYLOAD_MESSAGES.unsupportedType, 415]);
    const tooMany = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`f${index}`, "x"]));
    expect(payloadError(() => mapMagicbricksLead(postJson({ ...tooMany, mobile: "9876543210" }))).message).toBe(MAGICBRICKS_PAYLOAD_MESSAGES.tooManyFields);
    expect(payloadError(() => mapMagicbricksLead(postJson({ ["k".repeat(101)]: "x", mobile: "9876543210" }))).message).toBe(MAGICBRICKS_PAYLOAD_MESSAGES.fieldNameTooLong);
  });

  it("keeps the digits of a long unquoted number", () => {
    const lead = mapMagicbricksLead({ method: "POST", contentType: "application/json", query: {}, rawBody: "{\"mobile\":\"9876543210\",\"lead_id\":12345678901234567890}" });
    expect(lead.leadRef).toBe("12345678901234567890");
  });

  it("treats a request with nothing in it as a URL check", () => {
    expect(isEmptyMagicbricksRequest(get(""))).toBe(true);
    expect(isEmptyMagicbricksRequest({ method: "POST", contentType: "application/json", query: {}, rawBody: "  " })).toBe(true);
    expect(isEmptyMagicbricksRequest(get("mobile=1"))).toBe(false);
  });
});

describe("parseMagicbricksForm", () => {
  it("turns a repeated field into a list of answers", () => {
    expect(parseMagicbricksForm("a=1&a=2&b=3")).toEqual({ a: ["1", "2"], b: "3" });
  });
});
