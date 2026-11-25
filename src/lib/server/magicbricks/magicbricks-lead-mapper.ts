import "server-only";

import type { LeadField } from "@/lib/server/lead-redaction";
import { MAGICBRICKS_DEFAULT_LEAD_NAME, MAGICBRICKS_LABEL } from "@/lib/magicbricks/magicbricks";

/**
 * Reads one enquiry MagicBricks sends to a company's MagicBricks webhook URL. MagicBricks may send it as POST JSON, as
 * an ordinary form post or as GET URL parameters. The URL parameters and the body are merged ({ ...query, ...body }: a
 * body value wins) and each lead field is taken from the first name present in its list below (capitals, spaces,
 * underscores and hyphens in a name do not matter).
 *
 * Answers are stored in lead_data's field_data shape ([{ name, values }]) under the keys lead_data's contact trigger
 * reads (full_name, email, phone_number), so name / email / phone, phone cleanup (+91), same-phone matching, search and
 * the drawer's Form answers work on a MagicBricks lead like on every other lead. MagicBricks's own enquiry id is kept
 * out of field_data: it goes to lead_data.magicbricks_lead_ref. Every field not on the lists is kept as a form answer
 * under its own name, so nothing MagicBricks sends is dropped.
 */
export const MAX_MAGICBRICKS_WEBHOOK_BODY_BYTES = 64 * 1024;
export const MAX_MAGICBRICKS_LEAD_FIELDS = 100;
export const MAX_MAGICBRICKS_FIELD_KEY_LENGTH = 100;
/** MagicBricks's lead id and the project name; the same cap as lead_data_magicbricks_fields_check. */
export const MAX_MAGICBRICKS_REF_LENGTH = 200;

/** The answers the webhook gives MagicBricks for a request it can never accept as sent. */
export const MAGICBRICKS_PAYLOAD_MESSAGES = {
  noContact: "Send mobile or email.",
  notJsonObject: "Send the lead as a JSON object.",
  oneLeadPerRequest: "Send one lead per request.",
  tooManyFields: `Send ${MAX_MAGICBRICKS_LEAD_FIELDS} fields or fewer.`,
  fieldNameTooLong: `Field names must be ${MAX_MAGICBRICKS_FIELD_KEY_LENGTH} characters or fewer.`,
  unsupportedType: "Send JSON, form data or URL parameters.",
} as const;

/** The lead fields a company's field_mapping may add names for (e.g. {"phone": ["custMobile"]}). */
export const MAGICBRICKS_MAPPING_FIELDS = ["full_name", "phone", "email", "project_name", "city", "query", "external_lead_id"] as const;
type MappingField = (typeof MAGICBRICKS_MAPPING_FIELDS)[number];

// For each lead field, the MagicBricks names that may fill it, best first. Names are compared with capitals, spaces,
// underscores and hyphens ignored (normalizeKey), so "Mobile No", "mobile_no", "MobileNo" and "MOBILE-NO" are the same
// name. Only the best one present with an answer is used. "pid" is MagicBricks's property id, which many buyers share:
// it fills the project only when no project name is sent, and is never the enquiry id.
const ALIAS_NAMES: Record<MappingField, readonly string[]> = {
  full_name: ["name", "full_name", "cust_name", "customer_name", "lead_name", "buyer_name", "sender_name"],
  phone: ["mobile", "phone", "contact_no", "mobile_no", "phone_number", "sender_mobile", "contact"],
  email: ["email", "email_id", "cust_email", "sender_email"],
  project_name: ["project", "project_name", "property_name", "listing_name", "property_id", "pid"],
  city: ["city", "locality", "location", "city_name"],
  query: ["remark", "remarks", "query", "message", "comments", "description", "requirement"],
  external_lead_id: ["lead_id", "inquiry_id", "response_id", "id"],
};
const DEFAULT_ALIASES = normalizedAliases(ALIAS_NAMES);

function normalizedAliases(lists: Record<MappingField, readonly string[]>): Record<MappingField, readonly string[]> {
  const result = { ...lists };
  for (const field of MAGICBRICKS_MAPPING_FIELDS) result[field] = [...new Set(lists[field].map(normalizeKey))];
  return result;
}

// Where each lead field is stored in field_data.
const STORED_AS: Record<Exclude<MappingField, "external_lead_id">, string> = {
  full_name: "full_name", phone: "phone_number", email: "email", project_name: "project_name", city: "city", query: "query",
};
// A field that was not picked keeps its own name, unless that name is one lead_data's contact trigger reads (or would
// shadow the project, city or query): it is then prefixed, so it can never be taken as the lead's name, email or phone.
const RESERVED_NAMES = new Set(["full_name", "first_name", "last_name", "email", "phone_number", "project_name", "city", "query"]);

export interface MagicbricksLeadRequest {
  method: "GET" | "POST";
  contentType: string | null;
  /** The URL parameters (a repeated one is a list). */
  query: Record<string, unknown>;
  rawBody: string;
}

export interface MappedMagicbricksLead {
  /** MagicBricks's own id for the enquiry (null when none was sent); a retry of it is never saved twice. */
  leadRef: string | null;
  /** The project or property the enquiry is about; shown in the Ad Name column. */
  projectName: string | null;
  fieldData: LeadField[];
  /** The merged URL parameters and body, stored as lead_data.raw_lead_payload. It holds no secret: the URL is the secret. */
  rawPayload: Record<string, unknown>;
  /** The timeline note written when this phone already belongs to a lead of the company. */
  enquirySummary: string;
}

/** A request that can never become a lead. `status` is what the webhook answers: 400, or 415 for an unsupported format. */
export class MagicbricksPayloadError extends Error {
  public readonly status: 400 | 415;

  public constructor(message: string, status: 400 | 415 = 400) {
    super(message);
    this.name = "MagicbricksPayloadError";
    this.status = status;
  }
}

type Entry = { key: string; normalized: string; raw: unknown; values: string[] };

/** True when the request carries nothing at all (a URL check): no URL parameter and an empty body. */
export function isEmptyMagicbricksRequest(request: MagicbricksLeadRequest): boolean {
  return Object.keys(request.query).length === 0 && (request.method === "GET" || request.rawBody.trim() === "");
}

/** Parses and maps one MagicBricks request. Throws MagicbricksPayloadError for anything unusable. */
export function mapMagicbricksLead(request: MagicbricksLeadRequest, options: { fieldMapping?: unknown } = {}): MappedMagicbricksLead {
  const body = request.method === "GET" ? emptyRecord() : parseBody(request.contentType, request.rawBody);
  const rawPayload = emptyRecord();
  for (const [key, value] of Object.entries(request.query)) rawPayload[key] = value;
  for (const [key, value] of Object.entries(body)) rawPayload[key] = value;

  // Body fields first, so a body value wins over a URL parameter of the same name.
  const sources: Array<[string, unknown, string]> = [
    ...Object.entries(body).map(([key, value]): [string, unknown, string] => [key, value, request.rawBody]),
    ...Object.entries(request.query).filter(([key]) => !Object.hasOwn(body, key)).map(([key, value]): [string, unknown, string] => [key, value, ""]),
  ];
  const entries = sources.flatMap(([rawKey, raw, rawText]): Entry[] => {
    const key = rawKey.trim();
    if (!key) return [];
    if (key.length > MAX_MAGICBRICKS_FIELD_KEY_LENGTH) throw new MagicbricksPayloadError(MAGICBRICKS_PAYLOAD_MESSAGES.fieldNameTooLong);
    return [{ key, normalized: normalizeKey(key), raw, values: toValues(raw, rawKey, rawText) }];
  });
  if (entries.length > MAX_MAGICBRICKS_LEAD_FIELDS) throw new MagicbricksPayloadError(MAGICBRICKS_PAYLOAD_MESSAGES.tooManyFields);

  const aliases = withOverrides(options.fieldMapping);
  const picked = new Set<Entry>();
  const pick = (names: readonly string[], accept: (entry: Entry) => boolean = () => true): Entry | undefined => {
    for (const name of names) {
      const entry = entries.find((candidate) => candidate.normalized === name && candidate.values.length > 0 && !picked.has(candidate) && accept(candidate));
      if (entry) { picked.add(entry); return entry; }
    }
    return undefined;
  };

  // The enquiry id: one short value. A list, an object or an over-long value stays a form answer instead.
  const refEntry = pick(aliases.external_lead_id, (entry) => entry.values.length === 1 && (entry.raw === null || typeof entry.raw !== "object") && entry.values[0].length <= MAX_MAGICBRICKS_REF_LENGTH);
  const storedAs = new Map<Entry, string>();
  for (const field of ["full_name", "phone", "email", "project_name", "city", "query"] as const) {
    const entry = pick(aliases[field]);
    if (entry) storedAs.set(entry, STORED_AS[field]);
  }
  const hasName = [...storedAs.values()].includes("full_name");

  const fieldData: LeadField[] = [];
  if (!hasName) fieldData.push({ name: "full_name", values: [MAGICBRICKS_DEFAULT_LEAD_NAME] });
  for (const entry of entries) {
    if (entry === refEntry || entry.values.length === 0) continue;
    const name = storedAs.get(entry) ?? (RESERVED_NAMES.has(entry.key) ? `question_${entry.key}` : entry.key);
    fieldData.push({ name, values: entry.values });
  }

  const answer = (name: string) => fieldData.find((field) => field.name === name)?.values.find((value) => value.trim()) ?? null;
  if (!answer("phone_number") && !answer("email")) throw new MagicbricksPayloadError(MAGICBRICKS_PAYLOAD_MESSAGES.noContact);

  const projectName = answer("project_name");
  return {
    leadRef: refEntry ? refEntry.values[0] : null,
    projectName: projectName ? projectName.slice(0, MAX_MAGICBRICKS_REF_LENGTH) : null,
    fieldData,
    rawPayload,
    enquirySummary: buildSummary(hasName ? answer("full_name") : null, projectName, answer("city"), answer("query")),
  };
}

function buildSummary(name: string | null, project: string | null, city: string | null, query: string | null): string {
  const parts = [`New ${MAGICBRICKS_LABEL} enquiry`];
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
  for (const field of MAGICBRICKS_MAPPING_FIELDS) {
    const names = (fieldMapping as Record<string, unknown>)[field];
    if (!Array.isArray(names)) continue;
    const extra = names.filter((name): name is string => typeof name === "string" && name.trim().length > 0).map(normalizeKey);
    result[field] = [...new Set([...extra, ...DEFAULT_ALIASES[field]])];
  }
  return result;
}

function parseBody(contentType: string | null, rawBody: string): Record<string, unknown> {
  if (rawBody.trim() === "") return emptyRecord();
  const mediaType = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (mediaType === "application/x-www-form-urlencoded") return parseMagicbricksForm(rawBody);
  // A missing or text/plain type is read as JSON: some senders post JSON without saying so.
  if (mediaType === "" || mediaType === "text/plain" || mediaType === "application/json" || mediaType.endsWith("+json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.replace(/^﻿/, ""));
    } catch {
      throw new MagicbricksPayloadError(MAGICBRICKS_PAYLOAD_MESSAGES.notJsonObject);
    }
    if (Array.isArray(parsed)) throw new MagicbricksPayloadError(MAGICBRICKS_PAYLOAD_MESSAGES.oneLeadPerRequest);
    if (!parsed || typeof parsed !== "object") throw new MagicbricksPayloadError(MAGICBRICKS_PAYLOAD_MESSAGES.notJsonObject);
    const result = emptyRecord();
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) result[key] = value;
    return result;
  }
  throw new MagicbricksPayloadError(MAGICBRICKS_PAYLOAD_MESSAGES.unsupportedType, 415);
}

/** A form post or URL parameters: a repeated field becomes a list of answers. */
export function parseMagicbricksForm(text: string | URLSearchParams): Record<string, unknown> {
  const result = emptyRecord();
  for (const [key, value] of (typeof text === "string" ? new URLSearchParams(text) : text)) {
    if (!Object.hasOwn(result, key)) result[key] = value;
    else result[key] = [...(Array.isArray(result[key]) ? result[key] as unknown[] : [result[key]]), value];
  }
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
 * JSON.parse loses digits past 2^53 (a long id sent as an unquoted number). The digits are read again from the raw
 * text; if that is not possible the parsed number is kept.
 */
function unsafeIntegerText(value: number, rawKey: string, rawText: string): string {
  const escapedKey = JSON.stringify(rawKey).slice(1, -1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`"${escapedKey}"\\s*:\\s*(-?\\d+)(?=\\s*[,}])`).exec(rawText)?.[1] ?? String(value);
}
