import "server-only";

import type { LeadField } from "@/lib/server/lead-redaction";
import { SULEKHA_DEFAULT_LEAD_NAME, SULEKHA_LABEL } from "@/lib/sulekha/sulekha";

/**
 * Reads one customer enquiry Sulekha sends to a company's Sulekha webhook URL. Sulekha's format is not known yet, so the
 * reader is tolerant:
 *   - GET: the URL parameters.
 *   - POST: the body is read as JSON first, whatever the content type says (JSON is often posted as text/plain or as
 *     form data). A multipart form is read as a form. Anything else that is not JSON is read as url-encoded form data.
 *     One lead wrapped in a list ([{...}]) is read as that lead.
 *   - A field whose value is itself a JSON object (a real object, or text such as data={"name":...}) is unpacked one
 *     level: its keys are read as lead fields too. A top-level field always wins over an unpacked one of the same name.
 * The URL parameters and the body are merged ({ ...query, ...body }: a body value wins) and each lead field is taken
 * from the first name present in its list below (capitals, spaces, underscores and hyphens in a name do not matter).
 * When no known name holds the phone (or the email), the other fields are checked by their value (see findByValue).
 *
 * Answers are stored in lead_data's field_data shape ([{ name, values }]) under the keys lead_data's contact trigger
 * reads (full_name, first_name, last_name, email, phone_number), so name / email / phone, phone cleanup (+91, 91, a leading 0, spaces, dashes:
 * the shared database normaliser), same-phone matching, search and the drawer's Form answers work on a Sulekha lead like
 * on every other lead. The phone is kept as Sulekha sent it (trimmed), so the drawer shows it unchanged. Sulekha's own
 * enquiry id is kept out of field_data: it goes to lead_data.sulekha_lead_ref. Every field not on the lists is kept as a
 * form answer under its own name, so nothing Sulekha sends is dropped.
 */
export const MAX_SULEKHA_WEBHOOK_BODY_BYTES = 64 * 1024;
export const MAX_SULEKHA_LEAD_FIELDS = 100;
export const MAX_SULEKHA_FIELD_KEY_LENGTH = 100;
/** Sulekha's lead id and the service name; the same cap as lead_data_sulekha_fields_check. */
export const MAX_SULEKHA_REF_LENGTH = 200;

/**
 * Why a request could not become a lead: the webhook's "reason" (400, or 415 for unsupportedType) and the text written
 * to the request log. The raw copy is kept and listed under Failed requests. Nothing here is ever answered 200.
 */
export const SULEKHA_PAYLOAD_MESSAGES = {
  noContact: "Mobile number or email not found.",
  notJsonObject: "The body is not a lead object.",
  oneLeadPerRequest: "More than one lead in one request.",
  tooManyFields: `More than ${MAX_SULEKHA_LEAD_FIELDS} fields.`,
  fieldNameTooLong: `A field name is longer than ${MAX_SULEKHA_FIELD_KEY_LENGTH} characters.`,
  unsupportedType: "The body is not JSON, form data or URL parameters.",
} as const;

/** The lead fields a company's field_mapping may add names for (e.g. {"phone": ["customerMobile"]}). */
export const SULEKHA_MAPPING_FIELDS = ["full_name", "phone", "email", "service_name", "city", "query", "external_lead_id"] as const;
type MappingField = (typeof SULEKHA_MAPPING_FIELDS)[number];

// For each lead field, the names that may fill it, best first. Names are compared with capitals, spaces, underscores and
// hyphens ignored (normalizeName), so "Mobile No", "mobile_no", "MobileNo" and "MOBILE-NO" are the same name. Only the
// best one present with a usable answer is used. Sulekha is a services marketplace, so the
// service (or category) the customer asked for is the lead's "ad"; a project or property name fills it only when no
// service is sent. "requirement" and "need" are the customer's own words and stay with the query, never the service.
const ALIAS_NAMES: Record<MappingField, readonly string[]> = {
  full_name: ["name", "full_name", "fullname", "customer_name", "cust_name", "lead_name", "user_name", "contact_name", "client_name", "contact_person", "buyer_name", "sender_name"],
  phone: ["mobile", "phone", "mobile_number", "phone_number", "mobile_no", "phone_no", "contact_number", "contact_no", "customer_mobile", "customer_phone", "cust_mobile", "cust_phone", "user_mobile", "user_phone", "sender_mobile", "contact"],
  email: ["email", "email_id", "email_address", "customer_email", "cust_email", "user_email", "sender_email"],
  service_name: ["service_name", "service", "category_name", "category", "sub_category", "subcategory", "sub_category_name", "service_category", "business_category", "project_name", "project", "property_name"],
  city: ["city", "city_name", "area", "locality", "location", "area_name", "locality_name"],
  query: ["requirement", "requirements", "need", "message", "query", "remarks", "remark", "comments", "comment", "description", "details"],
  external_lead_id: ["lead_id", "enquiry_id", "inquiry_id", "response_id", "need_id", "lead_ref", "lead_reference", "id"],
};
const DEFAULT_ALIASES = normalizedAliases(ALIAS_NAMES);

function normalizedAliases(lists: Record<MappingField, readonly string[]>): Record<MappingField, readonly string[]> {
  const result = { ...lists };
  for (const field of SULEKHA_MAPPING_FIELDS) result[field] = [...new Set(lists[field].map(normalizeName))];
  return result;
}

// Where each lead field is stored in field_data.
const STORED_AS: Record<Exclude<MappingField, "external_lead_id">, string> = {
  full_name: "full_name", phone: "phone_number", email: "email", service_name: "service_name", city: "city", query: "query",
};
// A field that was not picked keeps its own name, unless that name is one lead_data's contact trigger reads (or would
// shadow the service, city or query): it is then prefixed, so it can never be taken as the lead's name, email or phone.
const RESERVED_NAMES = new Set(["full_name", "first_name", "last_name", "email", "phone_number", "service_name", "city", "query"]);
// first_name / last_name are used only when no full name is sent.
const NAME_PARTS: ReadonlyArray<readonly [string, readonly string[]]> = [["first_name", [normalizeName("first_name")]], ["last_name", [normalizeName("last_name")]]];

// Checking a field by its value (findByValue), when no known name holds the phone or the email.
const PHONE_VALUE_CHARACTERS = /^[+\d\s().-]+$/;
const INDIAN_MOBILE = /^[6-9]\d{9}$/;
const EMAIL_VALUE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// A field with one of these name words is never read as a phone or email by value: an id, a reference, or an amount.
// A word ending in "id" ("pid", "leadid") or starting / ending with "ref" ("refno", "leadref") counts as an id too.
const NOT_CONTACT_WORDS = new Set(["id", "ids", "price", "budget", "amount", "cost", "rate", "area", "size", "sqft", "pincode", "pin", "zip", "zipcode", "postcode"]);
// Name words that point to a phone / an email, when more than one field has a usable value. A long word may start a
// name word ("mobileno", "contactperson"); a short one must be the whole word ("ph", "wa"), so "graph" never counts.
const PHONE_HINT_PREFIXES = ["mobile", "phone", "contact", "whatsapp", "cell"];
const PHONE_HINT_WORDS = new Set(["mob", "ph", "tel", "wa", "no", "number", "num"]);
const EMAIL_HINT_PREFIXES = ["email", "mail"];

export interface SulekhaLeadRequest {
  method: "GET" | "POST";
  contentType: string | null;
  /** The URL parameters (a repeated one is a list). */
  query: Record<string, unknown>;
  rawBody: string;
}

export interface MappedSulekhaLead {
  /** Sulekha's own id for the enquiry (null when none was sent); a retry of it is never saved twice. */
  leadRef: string | null;
  /** The service or category the enquiry is about; shown in the Ad Name column. */
  serviceName: string | null;
  fieldData: LeadField[];
  /** The merged URL parameters and body, stored as lead_data.raw_lead_payload. It holds no secret: the URL is the secret. */
  rawPayload: Record<string, unknown>;
  /** The timeline note written when this phone already belongs to a lead of the company. */
  enquirySummary: string;
}

/** A request that can never become a lead as sent. The raw copy is kept; the message goes to the request log. */
export class SulekhaPayloadError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SulekhaPayloadError";
  }
}

/** One field. `nested`: unpacked from a JSON object inside the request (data={...}, {"customer": {...}}). */
type Field = { key: string; normalized: string; raw: unknown; values: string[]; nested: boolean };

/** True when the request carries nothing at all (a URL check): no URL parameter and an empty body. */
export function isEmptySulekhaRequest(request: SulekhaLeadRequest): boolean {
  return Object.keys(request.query).length === 0 && (request.method === "GET" || request.rawBody.trim() === "");
}

/** Parses and maps one Sulekha request. Throws SulekhaPayloadError for anything unusable. */
export async function mapSulekhaLead(request: SulekhaLeadRequest, options: { fieldMapping?: unknown } = {}): Promise<MappedSulekhaLead> {
  const body = request.method === "GET" ? blankRecord() : await readBody(request.contentType, request.rawBody);
  const rawPayload = blankRecord();
  for (const [key, value] of Object.entries(request.query)) rawPayload[key] = value;
  for (const [key, value] of Object.entries(body)) rawPayload[key] = value;

  // Body fields first, so a body value wins over a URL parameter of the same name.
  const sources: Array<[string, unknown, string]> = [
    ...Object.entries(body).map(([key, value]): [string, unknown, string] => [key, value, request.rawBody]),
    ...Object.entries(request.query).filter(([key]) => !Object.hasOwn(body, key)).map(([key, value]): [string, unknown, string] => [key, value, ""]),
  ];
  const topLevel: Field[] = [];
  const inner: Array<[string, unknown, string]> = [];
  for (const [rawKey, raw, rawText] of sources) {
    const object = objectInside(raw);
    // A field holding a JSON object: its keys are read as fields (below); the field itself stays in the raw copy only.
    if (object) {
      for (const [key, value] of Object.entries(object)) inner.push([key, value, typeof raw === "string" ? raw : rawText]);
      continue;
    }
    const field = toField(rawKey, raw, rawText, false);
    if (field) topLevel.push(field);
  }
  const topNames = new Set(topLevel.map((field) => field.normalized));
  const unpacked = inner
    .map(([key, raw, rawText]) => toField(key, raw, rawText, true))
    .filter((field): field is Field => field !== null && !topNames.has(field.normalized));
  // Two unpacked objects may carry the same name: the first one wins.
  const seen = new Set<string>();
  const fields = [...topLevel, ...unpacked.filter((field) => !seen.has(field.normalized) && seen.add(field.normalized))];
  if (fields.length > MAX_SULEKHA_LEAD_FIELDS) throw new SulekhaPayloadError(SULEKHA_PAYLOAD_MESSAGES.tooManyFields);

  const aliases = aliasesFor(options.fieldMapping);
  const taken = new Set<Field>();
  const take = (names: readonly string[], accept: (field: Field) => boolean = () => true): Field | undefined => {
    for (const name of names) {
      const field = fields.find((candidate) => candidate.normalized === name && candidate.values.length > 0 && !taken.has(candidate) && accept(candidate));
      if (field) { taken.add(field); return field; }
    }
    return undefined;
  };

  // The enquiry id: one short value. A list, an object or an over-long value stays a form answer instead. A bare "id"
  // inside a nested object ({"customer": {"id": ...}}) is the id of something else (the customer, the business):
  // taking it would make the same person's next enquiry look like a retry and drop it, so only a top-level "id" counts.
  const refField = take(aliases.external_lead_id, (field) => field.values.length === 1 && (field.raw === null || typeof field.raw !== "object")
    && field.values[0].length <= MAX_SULEKHA_REF_LENGTH && !(field.nested && field.normalized === "id"));
  const storedAs = new Map<Field, string>();
  const accept: Partial<Record<MappingField, (field: Field) => boolean>> = {
    // "NA", "-" or "none" is no phone: it stays a form answer under its own name, never the lead's phone.
    phone: (field) => /\d/.test(field.values[0]),
    email: (field) => field.values[0].includes("@"),
  };
  for (const name of ["full_name", "phone", "email", "service_name", "city", "query"] as const) {
    const field = take(aliases[name], accept[name]);
    if (field) storedAs.set(field, STORED_AS[name]);
  }
  // A phone or email sent under a name no list knows ("whatsapp", "custPh"): found by its value.
  for (const kind of ["phone", "email"] as const) {
    if ([...storedAs.values()].includes(STORED_AS[kind])) continue;
    const field = findByValue(fields.filter((candidate) => candidate !== refField && !taken.has(candidate)), kind);
    if (field) { taken.add(field); storedAs.set(field, STORED_AS[kind]); }
  }
  const hasFullName = [...storedAs.values()].includes("full_name");
  if (!hasFullName) {
    for (const [stored, names] of NAME_PARTS) {
      const field = take(names);
      if (field) storedAs.set(field, stored);
    }
  }
  const hasNameParts = [...storedAs.values()].some((name) => name === "first_name" || name === "last_name");

  const fieldData: LeadField[] = [];
  if (!hasFullName && !hasNameParts) fieldData.push({ name: "full_name", values: [SULEKHA_DEFAULT_LEAD_NAME] });
  const usedNames = new Set<string>(fieldData.map((field) => field.name));
  for (const field of fields) {
    if (field === refField || field.values.length === 0) continue;
    let name = storedAs.get(field) ?? (RESERVED_NAMES.has(field.key) ? `question_${field.key}` : field.key);
    // A top-level "Mobile" and an unpacked "mobile" are different keys; keep both answers under distinct names.
    while (usedNames.has(name)) name = `question_${name}`;
    usedNames.add(name);
    fieldData.push({ name, values: field.values });
  }

  const answer = (name: string) => fieldData.find((field) => field.name === name)?.values.find((value) => value.trim()) ?? null;
  if (!answer("phone_number") && !answer("email")) throw new SulekhaPayloadError(SULEKHA_PAYLOAD_MESSAGES.noContact);

  const serviceName = answer("service_name");
  return {
    leadRef: refField ? refField.values[0] : null,
    serviceName: serviceName ? serviceName.slice(0, MAX_SULEKHA_REF_LENGTH) : null,
    fieldData,
    rawPayload,
    enquirySummary: summaryOf(hasFullName || hasNameParts ? nameOf(fieldData) : null, serviceName, answer("city"), answer("query")),
  };
}

/**
 * The one field whose value is an Indian mobile number (10 digits starting 6-9, after +91 / 91 / a leading 0, spaces,
 * dashes, dots and brackets are removed; no letters) or an email address. A field named like an id, a reference or an
 * amount is never used. When several fields match, the one whose name points to it ("whatsapp", "custPh", "buyerMail")
 * is used; if that still leaves none or more than one, nothing is guessed (the same number in two fields counts once).
 */
function findByValue(fields: Field[], kind: "phone" | "email"): Field | undefined {
  const matches = fields.filter((field) => field.values.length === 1 && !isNotContactName(field.key)
    && (kind === "phone" ? mobileDigits(field.values[0]) !== null : EMAIL_VALUE.test(field.values[0])));
  const single = (list: Field[]) => {
    const distinct = new Set(list.map((field) => (kind === "phone" ? mobileDigits(field.values[0]) : field.values[0].toLowerCase())));
    return distinct.size === 1 ? list[0] : undefined;
  };
  return single(matches) ?? single(matches.filter((field) => hasHint(field.key, kind)));
}

/** The 10-digit Indian mobile in a value, or null. */
function mobileDigits(value: string): string | null {
  if (!PHONE_VALUE_CHARACTERS.test(value)) return null;
  let digits = value.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return INDIAN_MOBILE.test(digits) ? digits : null;
}

/** A field name's words: "whatsapp_no" → whatsapp, no; "custPh" → cust, ph; "PROPERTY-ID" → property, id. */
function nameWords(key: string): string[] {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** True for a name that holds an id, a reference or an amount ("property_id", "pid", "leadRef", "budget"). */
function isNotContactName(key: string): boolean {
  return nameWords(key).some((word) => NOT_CONTACT_WORDS.has(word) || word.endsWith("id") || word.startsWith("ref") || word.endsWith("ref"));
}

/** True when a name word points to a phone / an email: "whatsapp_no", "custPh", "buyerContact", "buyerMail". */
function hasHint(key: string, kind: "phone" | "email"): boolean {
  const words = nameWords(key);
  if (kind === "email") return words.some((word) => EMAIL_HINT_PREFIXES.some((hint) => word.startsWith(hint)));
  return words.some((word) => PHONE_HINT_WORDS.has(word) || PHONE_HINT_PREFIXES.some((hint) => word.startsWith(hint)));
}

function nameOf(fieldData: LeadField[]): string | null {
  const value = (name: string) => fieldData.find((field) => field.name === name)?.values[0]?.trim() || null;
  return value("full_name") ?? ([value("first_name"), value("last_name")].filter(Boolean).join(" ") || null);
}

function toField(rawKey: string, raw: unknown, rawText: string, nested: boolean): Field | null {
  const key = rawKey.trim();
  if (!key) return null;
  if (key.length > MAX_SULEKHA_FIELD_KEY_LENGTH) throw new SulekhaPayloadError(SULEKHA_PAYLOAD_MESSAGES.fieldNameTooLong);
  return { key, normalized: normalizeName(key), raw, values: valuesOf(raw, rawKey, rawText), nested };
}

/** The object a field holds: a real JSON object, or text that is a JSON object. Null otherwise. */
function objectInside(raw: unknown): Record<string, unknown> | null {
  if (isRecord(raw)) return raw;
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function summaryOf(name: string | null, service: string | null, city: string | null, query: string | null): string {
  const parts = [`New ${SULEKHA_LABEL} enquiry`];
  if (name) parts.push(`Name: ${name}`);
  if (service) parts.push(`Service: ${service}`);
  if (city) parts.push(`City: ${city}`);
  if (query) parts.push(`Requirement: ${query}`);
  // lead_activities.summary holds at most 500 characters (the database cuts it too).
  return parts.join(" · ").replace(/\s+/g, " ").slice(0, 500);
}

/** The default names, with the company's own names (field_mapping) tried first. Anything malformed is ignored. */
function aliasesFor(fieldMapping: unknown): Record<MappingField, readonly string[]> {
  const result = { ...DEFAULT_ALIASES };
  if (!isRecord(fieldMapping)) return result;
  for (const field of SULEKHA_MAPPING_FIELDS) {
    const names = fieldMapping[field];
    if (!Array.isArray(names)) continue;
    const extra = names.filter((name): name is string => typeof name === "string" && name.trim().length > 0).map(normalizeName);
    result[field] = [...new Set([...extra, ...DEFAULT_ALIASES[field]])];
  }
  return result;
}

async function readBody(contentType: string | null, rawBody: string): Promise<Record<string, unknown>> {
  const text = rawBody.replace(/^﻿/, "");
  if (text.trim() === "") return blankRecord();
  const mediaType = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (mediaType === "multipart/form-data") return readMultipart(contentType ?? "", text);

  // JSON first, whatever the content type says.
  const json = parseJson(text);
  if (json.ok) {
    if (isRecord(json.value)) return copyRecord(json.value);
    if (Array.isArray(json.value)) {
      if (json.value.length === 1 && isRecord(json.value[0])) return copyRecord(json.value[0]);
      throw new SulekhaPayloadError(SULEKHA_PAYLOAD_MESSAGES.oneLeadPerRequest);
    }
    // A bare number, string, true/false or null: not a lead object; tried as form data below.
  }
  const trimmed = text.trim();
  // XML / HTML, or text with no name=value pair: not a format we can read.
  if (trimmed.startsWith("<") || !trimmed.includes("=")) {
    throw new SulekhaPayloadError(json.ok ? SULEKHA_PAYLOAD_MESSAGES.notJsonObject : SULEKHA_PAYLOAD_MESSAGES.unsupportedType);
  }
  return parseSulekhaForm(trimmed);
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** A multipart form's text fields (a file part is not a lead field and is skipped). */
async function readMultipart(contentType: string, text: string): Promise<Record<string, unknown>> {
  let form: FormData;
  try {
    form = await new Response(text, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new SulekhaPayloadError(SULEKHA_PAYLOAD_MESSAGES.unsupportedType);
  }
  const result = blankRecord();
  for (const [key, value] of form) {
    if (typeof value === "string") addValue(result, key, value);
  }
  return result;
}

/** A form post or URL parameters: a repeated field becomes a list of answers. */
export function parseSulekhaForm(text: string | URLSearchParams): Record<string, unknown> {
  const result = blankRecord();
  for (const [key, value] of (typeof text === "string" ? new URLSearchParams(text) : text)) addValue(result, key, value);
  return result;
}

function addValue(result: Record<string, unknown>, key: string, value: string): void {
  if (!Object.hasOwn(result, key)) result[key] = value;
  else result[key] = [...(Array.isArray(result[key]) ? result[key] as unknown[] : [result[key]]), value];
}

function copyRecord(value: Record<string, unknown>): Record<string, unknown> {
  const result = blankRecord();
  for (const [key, item] of Object.entries(value)) result[key] = item;
  return result;
}

/** No prototype, so a field named "__proto__" is stored as a field like any other. */
function blankRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

/** A field name with capitals, spaces, underscores and hyphens ignored: "Mobile No", "mobile_no", "MobileNo" → "mobileno". */
function normalizeName(key: string): string {
  return key.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

/** Every answer as text: numbers and true/false as written, a list as several answers, a nested object as JSON text. */
function valuesOf(raw: unknown, rawKey: string, rawText: string): string[] {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) return raw.flatMap((item) => (item === null || item === undefined ? [] : [asText(item)])).filter(Boolean);
  if (typeof raw === "number" && Number.isInteger(raw) && !Number.isSafeInteger(raw)) return [exactDigits(raw, rawKey, rawText)];
  const text = asText(raw);
  return text ? [text] : [];
}

function asText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return String(value);
  return JSON.stringify(value) ?? "";
}

/**
 * JSON.parse loses digits past 2^53 (a long id or phone sent as an unquoted number). The digits are read again from the
 * raw text; if that is not possible the parsed number is kept.
 */
function exactDigits(value: number, rawKey: string, rawText: string): string {
  const escapedKey = JSON.stringify(rawKey).slice(1, -1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`"${escapedKey}"\\s*:\\s*(-?\\d+)(?=\\s*[,}])`).exec(rawText)?.[1] ?? String(value);
}
