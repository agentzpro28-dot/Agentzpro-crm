import "server-only";

import type { LeadField } from "@/lib/server/lead-redaction";
import { HOUSING_DEFAULT_LEAD_NAME, HOUSING_LABEL } from "@/lib/housing/housing";

/**
 * Reads one enquiry Housing.com sends to a company's Housing.com webhook URL. Housing.com's format is not known yet, so
 * the reader is tolerant:
 *   - GET: the URL parameters.
 *   - POST: the body is read as JSON first, whatever the content type says (portals often post JSON as text/plain or
 *     as form data). A multipart form is read as a form. Anything else that is not JSON is read as url-encoded form
 *     data. One lead wrapped in a list ([{...}]) is read as that lead.
 *   - A field whose value is itself a JSON object (a real object, or text such as data={"name":...}) is unpacked one
 *     level: its keys are read as lead fields too. A top-level field always wins over an unpacked one of the same name.
 * The URL parameters and the body are merged ({ ...query, ...body }: a body value wins) and each lead field is taken
 * from the first name present in its list below (capitals, spaces, underscores and hyphens in a name do not matter).
 * When no known name holds the phone (or the email), the other fields are checked by their value (see findByValue).
 *
 * Answers are stored in lead_data's field_data shape ([{ name, values }]) under the keys lead_data's contact trigger
 * reads (full_name, first_name, last_name, email, phone_number), so name / email / phone, phone cleanup (+91, 91, a leading 0, spaces, dashes:
 * the shared database normaliser), same-phone matching, search and the drawer's Form answers work on a Housing.com lead
 * like on every other lead. The phone is kept as Housing.com sent it (trimmed), so the drawer shows it unchanged.
 * Housing.com's own enquiry id is kept out of field_data: it goes to lead_data.housing_lead_ref. Every field not on the
 * lists is kept as a form answer under its own name, so nothing Housing.com sends is dropped.
 */
export const MAX_HOUSING_WEBHOOK_BODY_BYTES = 64 * 1024;
export const MAX_HOUSING_LEAD_FIELDS = 100;
export const MAX_HOUSING_FIELD_KEY_LENGTH = 100;
/** Housing.com's lead id and the project name; the same cap as lead_data_housing_fields_check. */
export const MAX_HOUSING_REF_LENGTH = 200;

/**
 * Why a request could not become a lead: the webhook's "reason" (400, or 415 for unsupportedType) and the text written
 * to the request log. The raw copy is kept and listed under Failed requests. Nothing here is ever answered 200.
 */
export const HOUSING_PAYLOAD_MESSAGES = {
  noContact: "Mobile number or email not found.",
  notJsonObject: "The body is not a lead object.",
  oneLeadPerRequest: "More than one lead in one request.",
  tooManyFields: `More than ${MAX_HOUSING_LEAD_FIELDS} fields.`,
  fieldNameTooLong: `A field name is longer than ${MAX_HOUSING_FIELD_KEY_LENGTH} characters.`,
  unsupportedType: "The body is not JSON, form data or URL parameters.",
} as const;

/** The lead fields a company's field_mapping may add names for (e.g. {"phone": ["custMobile"]}). */
export const HOUSING_MAPPING_FIELDS = ["full_name", "phone", "email", "project_name", "city", "query", "external_lead_id"] as const;
type MappingField = (typeof HOUSING_MAPPING_FIELDS)[number];

// For each lead field, the names that may fill it, best first. Names are compared with capitals, spaces, underscores and
// hyphens ignored (normalizeKey), so "Mobile No", "mobile_no", "MobileNo" and "MOBILE-NO" are the same name. Only the
// best one present with a usable answer is used. A listing or property id fills the project only when no project name
// is sent, and is never the enquiry id.
const ALIAS_NAMES: Record<MappingField, readonly string[]> = {
  full_name: ["name", "full_name", "fullname", "cust_name", "customer_name", "lead_name", "buyer_name", "user_name", "contact_name", "client_name", "contact_person", "sender_name"],
  phone: ["mobile", "phone", "mobile_number", "phone_number", "mobile_no", "phone_no", "contact_number", "contact_no", "contact", "cust_mobile", "cust_phone", "customer_mobile", "customer_phone", "user_mobile", "user_phone", "sender_mobile"],
  email: ["email", "email_id", "email_address", "cust_email", "customer_email", "user_email", "sender_email"],
  project_name: ["project_name", "project", "property_name", "listing_name", "society_name", "property_title", "listing_title", "property_id", "listing_id", "project_id"],
  city: ["city", "city_name", "locality", "locality_name", "location", "area", "area_name"],
  query: ["message", "query", "remark", "remarks", "comment", "comments", "requirement", "requirements", "need", "description", "details"],
  external_lead_id: ["lead_id", "enquiry_id", "inquiry_id", "response_id", "need_id", "lead_ref", "lead_reference", "id"],
};
const DEFAULT_ALIASES = normalizedAliases(ALIAS_NAMES);

function normalizedAliases(lists: Record<MappingField, readonly string[]>): Record<MappingField, readonly string[]> {
  const result = { ...lists };
  for (const field of HOUSING_MAPPING_FIELDS) result[field] = [...new Set(lists[field].map(normalizeKey))];
  return result;
}

// Where each lead field is stored in field_data.
const STORED_AS: Record<Exclude<MappingField, "external_lead_id">, string> = {
  full_name: "full_name", phone: "phone_number", email: "email", project_name: "project_name", city: "city", query: "query",
};
// A field that was not picked keeps its own name, unless that name is one lead_data's contact trigger reads (or would
// shadow the project, city or query): it is then prefixed, so it can never be taken as the lead's name, email or phone.
const RESERVED_NAMES = new Set(["full_name", "first_name", "last_name", "email", "phone_number", "project_name", "city", "query"]);
// first_name / last_name are used only when no full name is sent.
const NAME_PARTS: ReadonlyArray<readonly [string, readonly string[]]> = [["first_name", [normalizeKey("first_name")]], ["last_name", [normalizeKey("last_name")]]];

// Checking a field by its value (findByValue), when no known name holds the phone or the email.
const PHONE_VALUE_CHARACTERS = /^[+\d\s().-]+$/;
const INDIAN_MOBILE = /^[6-9]\d{9}$/;
// An email value: at most 254 characters (the longest valid address), checked without a regex so a long value can
// never make it slow.
const MAX_EMAIL_LENGTH = 254;
// A field with one of these name words is never read as a phone or email by value: an id, a reference, or an amount.
// A word ending in "id" ("pid", "leadid") or starting / ending with "ref" ("refno", "leadref") counts as an id too.
const NOT_CONTACT_WORDS = new Set(["id", "ids", "price", "budget", "amount", "cost", "rate", "area", "size", "sqft", "pincode", "pin", "zip", "zipcode", "postcode"]);
// Name words that point to a phone / an email, when more than one field has a usable value. A long word may start a
// name word ("mobileno", "contactperson"); a short one must be the whole word ("ph", "wa"), so "graph" never counts.
const PHONE_HINT_PREFIXES = ["mobile", "phone", "contact", "whatsapp", "cell"];
const PHONE_HINT_WORDS = new Set(["mob", "ph", "tel", "wa", "no", "number", "num"]);
const EMAIL_HINT_PREFIXES = ["email", "mail"];

export interface HousingLeadRequest {
  method: "GET" | "POST";
  contentType: string | null;
  /** The URL parameters (a repeated one is a list). */
  query: Record<string, unknown>;
  rawBody: string;
}

export interface MappedHousingLead {
  /** Housing.com's own id for the enquiry (null when none was sent); a retry of it is never saved twice. */
  leadRef: string | null;
  /** The project or property the enquiry is about; shown in the Ad Name column. */
  projectName: string | null;
  fieldData: LeadField[];
  /** The merged URL parameters and body, stored as lead_data.raw_lead_payload. It holds no secret: the URL is the secret. */
  rawPayload: Record<string, unknown>;
  /** The timeline note written when this phone already belongs to a lead of the company. */
  enquirySummary: string;
}

/** A request that can never become a lead as sent. The raw copy is kept; the message goes to the request log. */
export class HousingPayloadError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "HousingPayloadError";
  }
}

/** One field. `nested`: unpacked from a JSON object inside the request (data={...}, {"user": {...}}). */
type Entry = { key: string; normalized: string; raw: unknown; values: string[]; nested: boolean };

/** True when the request carries nothing at all (a URL check): no URL parameter and an empty body. */
export function isEmptyHousingRequest(request: HousingLeadRequest): boolean {
  return Object.keys(request.query).length === 0 && (request.method === "GET" || request.rawBody.trim() === "");
}

/** Parses and maps one Housing.com request. Throws HousingPayloadError for anything unusable. */
export async function mapHousingLead(request: HousingLeadRequest, options: { fieldMapping?: unknown } = {}): Promise<MappedHousingLead> {
  const body = request.method === "GET" ? emptyRecord() : await parseBody(request.contentType, request.rawBody);
  const rawPayload = emptyRecord();
  for (const [key, value] of Object.entries(request.query)) rawPayload[key] = value;
  for (const [key, value] of Object.entries(body)) rawPayload[key] = value;

  // Body fields first, so a body value wins over a URL parameter of the same name.
  const sources: Array<[string, unknown, string]> = [
    ...Object.entries(body).map(([key, value]): [string, unknown, string] => [key, value, request.rawBody]),
    ...Object.entries(request.query).filter(([key]) => !Object.hasOwn(body, key)).map(([key, value]): [string, unknown, string] => [key, value, ""]),
  ];
  const topLevel: Entry[] = [];
  const nested: Array<[string, unknown, string]> = [];
  for (const [rawKey, raw, rawText] of sources) {
    const object = jsonObjectOf(raw);
    // A field holding a JSON object: its keys are read as fields (below); the field itself stays in the raw copy only.
    if (object) {
      for (const [key, value] of Object.entries(object)) nested.push([key, value, typeof raw === "string" ? raw : rawText]);
      continue;
    }
    const entry = toEntry(rawKey, raw, rawText, false);
    if (entry) topLevel.push(entry);
  }
  const topNames = new Set(topLevel.map((entry) => entry.normalized));
  const unpacked = nested
    .map(([key, raw, rawText]) => toEntry(key, raw, rawText, true))
    .filter((entry): entry is Entry => entry !== null && !topNames.has(entry.normalized));
  // Two unpacked objects may carry the same name: the first one wins.
  const seen = new Set<string>();
  const entries = [...topLevel, ...unpacked.filter((entry) => !seen.has(entry.normalized) && seen.add(entry.normalized))];
  if (entries.length > MAX_HOUSING_LEAD_FIELDS) throw new HousingPayloadError(HOUSING_PAYLOAD_MESSAGES.tooManyFields);

  const aliases = withOverrides(options.fieldMapping);
  const picked = new Set<Entry>();
  const pick = (names: readonly string[], accept: (entry: Entry) => boolean = () => true): Entry | undefined => {
    for (const name of names) {
      const entry = entries.find((candidate) => candidate.normalized === name && candidate.values.length > 0 && !picked.has(candidate) && accept(candidate));
      if (entry) { picked.add(entry); return entry; }
    }
    return undefined;
  };

  // The enquiry id: one short value. A list, an object or an over-long value stays a form answer instead. A bare "id"
  // inside a nested object ({"user": {"id": ...}}) is the id of something else (the buyer, the listing): taking it would
  // make the same person's next enquiry look like a retry and drop it, so only a top-level "id" counts.
  const refEntry = pick(aliases.external_lead_id, (entry) => entry.values.length === 1 && (entry.raw === null || typeof entry.raw !== "object") && entry.values[0].length <= MAX_HOUSING_REF_LENGTH
    && !(entry.nested && entry.normalized === "id"));
  const storedAs = new Map<Entry, string>();
  const accept: Partial<Record<MappingField, (entry: Entry) => boolean>> = {
    // "NA", "-" or "none" is no phone: it stays a form answer under its own name, never the lead's phone.
    phone: (entry) => /\d/.test(entry.values[0]),
    email: (entry) => entry.values[0].includes("@"),
  };
  for (const field of ["full_name", "phone", "email", "project_name", "city", "query"] as const) {
    const entry = pick(aliases[field], accept[field]);
    if (entry) storedAs.set(entry, STORED_AS[field]);
  }
  // A phone or email sent under a name no list knows ("whatsapp", "custPh"): found by its value.
  for (const kind of ["phone", "email"] as const) {
    if ([...storedAs.values()].includes(STORED_AS[kind])) continue;
    const entry = findByValue(entries.filter((candidate) => candidate !== refEntry && !picked.has(candidate)), kind);
    if (entry) { picked.add(entry); storedAs.set(entry, STORED_AS[kind]); }
  }
  const hasFullName = [...storedAs.values()].includes("full_name");
  if (!hasFullName) {
    for (const [stored, names] of NAME_PARTS) {
      const entry = pick(names);
      if (entry) storedAs.set(entry, stored);
    }
  }
  const hasNameParts = [...storedAs.values()].some((name) => name === "first_name" || name === "last_name");

  const fieldData: LeadField[] = [];
  if (!hasFullName && !hasNameParts) fieldData.push({ name: "full_name", values: [HOUSING_DEFAULT_LEAD_NAME] });
  const usedNames = new Set<string>(fieldData.map((field) => field.name));
  for (const entry of entries) {
    if (entry === refEntry || entry.values.length === 0) continue;
    let name = storedAs.get(entry) ?? (RESERVED_NAMES.has(entry.key) ? `question_${entry.key}` : entry.key);
    // A top-level "Mobile" and an unpacked "mobile" are different keys; keep both answers under distinct names.
    while (usedNames.has(name)) name = `question_${name}`;
    usedNames.add(name);
    fieldData.push({ name, values: entry.values });
  }

  const answer = (name: string) => fieldData.find((field) => field.name === name)?.values.find((value) => value.trim()) ?? null;
  if (!answer("phone_number") && !answer("email")) throw new HousingPayloadError(HOUSING_PAYLOAD_MESSAGES.noContact);

  const projectName = answer("project_name");
  return {
    leadRef: refEntry ? refEntry.values[0] : null,
    projectName: projectName ? projectName.slice(0, MAX_HOUSING_REF_LENGTH) : null,
    fieldData,
    rawPayload,
    enquirySummary: buildSummary(hasFullName || hasNameParts ? nameOf(fieldData) : null, projectName, answer("city"), answer("query")),
  };
}

/**
 * The one field whose value is an Indian mobile number (10 digits starting 6-9, after +91 / 91 / a leading 0, spaces,
 * dashes, dots and brackets are removed; no letters) or an email address. A field named like an id, a reference or an
 * amount is never used. When several fields match, the one whose name points to it ("whatsapp", "custPh", "buyerMail")
 * is used; if that still leaves none or more than one, nothing is guessed (the same number in two fields counts once).
 */
function findByValue(entries: Entry[], kind: "phone" | "email"): Entry | undefined {
  const matches = entries.filter((entry) => entry.values.length === 1 && !isNotContactName(entry.key)
    && (kind === "phone" ? mobileDigits(entry.values[0]) !== null : isEmailValue(entry.values[0])));
  const single = (list: Entry[]) => {
    const distinct = new Set(list.map((entry) => (kind === "phone" ? mobileDigits(entry.values[0]) : entry.values[0].toLowerCase())));
    return distinct.size === 1 ? list[0] : undefined;
  };
  return single(matches) ?? single(matches.filter((entry) => hasHint(entry.key, kind)));
}

/** True for one address shaped like name@domain.tld: one "@", no spaces, a dot inside the domain. */
function isEmailValue(value: string): boolean {
  if (value.length > MAX_EMAIL_LENGTH || /\s/.test(value)) return false;
  const at = value.indexOf("@");
  if (at <= 0 || at !== value.lastIndexOf("@")) return false;
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  return dot > 0 && dot < domain.length - 1;
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

function toEntry(rawKey: string, raw: unknown, rawText: string, nested: boolean): Entry | null {
  const key = rawKey.trim();
  if (!key) return null;
  if (key.length > MAX_HOUSING_FIELD_KEY_LENGTH) throw new HousingPayloadError(HOUSING_PAYLOAD_MESSAGES.fieldNameTooLong);
  return { key, normalized: normalizeKey(key), raw, values: toValues(raw, rawKey, rawText), nested };
}

/** The object a field holds: a real JSON object, or text that is a JSON object. Null otherwise. */
function jsonObjectOf(raw: unknown): Record<string, unknown> | null {
  if (isPlainObject(raw)) return raw;
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function buildSummary(name: string | null, project: string | null, city: string | null, query: string | null): string {
  const parts = [`New ${HOUSING_LABEL} enquiry`];
  if (name) parts.push(`Name: ${name}`);
  if (project) parts.push(`Project: ${project}`);
  if (city) parts.push(`City: ${city}`);
  if (query) parts.push(`Query: ${query}`);
  // lead_activities.summary holds at most 500 characters (the database cuts it too).
  return parts.join(" · ").replace(/\s+/g, " ").slice(0, 500);
}

/** The default names, with the company's own names (field_mapping) tried first. Anything malformed is ignored. */
function withOverrides(fieldMapping: unknown): Record<MappingField, readonly string[]> {
  const result = { ...DEFAULT_ALIASES };
  if (!fieldMapping || typeof fieldMapping !== "object" || Array.isArray(fieldMapping)) return result;
  for (const field of HOUSING_MAPPING_FIELDS) {
    const names = (fieldMapping as Record<string, unknown>)[field];
    if (!Array.isArray(names)) continue;
    const extra = names.filter((name): name is string => typeof name === "string" && name.trim().length > 0).map(normalizeKey);
    result[field] = [...new Set([...extra, ...DEFAULT_ALIASES[field]])];
  }
  return result;
}

async function parseBody(contentType: string | null, rawBody: string): Promise<Record<string, unknown>> {
  const text = rawBody.replace(/^﻿/, "");
  if (text.trim() === "") return emptyRecord();
  const mediaType = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (mediaType === "multipart/form-data") return parseMultipart(contentType ?? "", text);

  // JSON first, whatever the content type says.
  const json = tryJson(text);
  if (json.ok) {
    const value = json.value;
    if (isPlainObject(value)) return toRecord(value);
    if (Array.isArray(value)) {
      if (value.length === 1 && isPlainObject(value[0])) return toRecord(value[0]);
      throw new HousingPayloadError(HOUSING_PAYLOAD_MESSAGES.oneLeadPerRequest);
    }
    // A bare number, string, true/false or null: not a lead object; tried as form data below.
  }
  const trimmed = text.trim();
  // XML / HTML, or text with no name=value pair: not a format we can read.
  if (trimmed.startsWith("<") || !trimmed.includes("=")) {
    throw new HousingPayloadError(json.ok ? HOUSING_PAYLOAD_MESSAGES.notJsonObject : HOUSING_PAYLOAD_MESSAGES.unsupportedType);
  }
  return parseHousingForm(trimmed);
}

function tryJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** A multipart form's text fields (a file part is not a lead field and is skipped). */
async function parseMultipart(contentType: string, text: string): Promise<Record<string, unknown>> {
  let form: FormData;
  try {
    form = await new Response(text, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new HousingPayloadError(HOUSING_PAYLOAD_MESSAGES.unsupportedType);
  }
  const result = emptyRecord();
  for (const [key, value] of form) {
    if (typeof value !== "string") continue;
    if (!Object.hasOwn(result, key)) result[key] = value;
    else result[key] = [...(Array.isArray(result[key]) ? result[key] as unknown[] : [result[key]]), value];
  }
  return result;
}

/** A form post or URL parameters: a repeated field becomes a list of answers. */
export function parseHousingForm(text: string | URLSearchParams): Record<string, unknown> {
  const result = emptyRecord();
  for (const [key, value] of (typeof text === "string" ? new URLSearchParams(text) : text)) {
    if (!Object.hasOwn(result, key)) result[key] = value;
    else result[key] = [...(Array.isArray(result[key]) ? result[key] as unknown[] : [result[key]]), value];
  }
  return result;
}

function toRecord(value: Record<string, unknown>): Record<string, unknown> {
  const result = emptyRecord();
  for (const [key, item] of Object.entries(value)) result[key] = item;
  return result;
}

/** No prototype, so a field named "__proto__" is stored as a field like any other. */
function emptyRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

/** A field name with capitals, spaces, underscores and hyphens ignored: "Mobile No", "mobile_no", "MobileNo" → "mobileno". */
function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

/** Every answer as text: numbers and true/false as written, a list as several answers, a nested object as JSON text. */
function toValues(raw: unknown, rawKey: string, rawText: string): string[] {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) return raw.flatMap((item) => (item === null || item === undefined ? [] : [scalarText(item)])).filter(Boolean);
  if (typeof raw === "number" && Number.isInteger(raw) && !Number.isSafeInteger(raw)) return [unsafeIntegerText(raw, rawKey, rawText)];
  const text = scalarText(raw);
  return text ? [text] : [];
}

function scalarText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return String(value);
  return JSON.stringify(value) ?? "";
}

/**
 * JSON.parse loses digits past 2^53 (a long id or phone sent as an unquoted number). The digits are read again from the
 * raw text; if that is not possible the parsed number is kept.
 */
function unsafeIntegerText(value: number, rawKey: string, rawText: string): string {
  const escapedKey = JSON.stringify(rawKey).slice(1, -1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`"${escapedKey}"\\s*:\\s*(-?\\d+)(?=\\s*[,}])`).exec(rawText)?.[1] ?? String(value);
}
