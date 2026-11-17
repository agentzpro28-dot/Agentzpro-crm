import "server-only";

import type { LeadField } from "@/lib/server/lead-redaction";
import { PORTALS, type PortalId } from "@/lib/portal-leads/portals";

/**
 * Reads one enquiry a real-estate portal (99acres today) sends to a company's portal webhook URL. Indian portals do
 * not agree on a format: the same lead may arrive as POST JSON, as an ordinary form post or as GET URL parameters,
 * under names like "cust_name", "contact_no" or "mobile". The URL parameters and the body are merged (a body value wins)
 * and each lead field is taken from the first name present in its fallback list.
 *
 * Answers are stored in Meta's field_data shape ([{ name, values }]) and the contact fields under Meta's keys
 * (full_name, first_name, last_name, email, phone_number), so public.extract_meta_lead_contact_fields fills
 * lead_name / lead_email / lead_phone, and search, phone normalising (the 91 prefix), phone de-duplication, the AI-label
 * redaction and the drawer's Form answers all work on a portal lead exactly as on a Meta lead. The portal's own lead id
 * is kept out of field_data: it goes to lead_data.portal_lead_ref. Every field we do not recognise is kept as a form
 * answer under its own name, so nothing the portal sends is dropped.
 */
export const MAX_PORTAL_WEBHOOK_BODY_BYTES = 64 * 1024;
export const MAX_PORTAL_LEAD_FIELDS = 100;
export const MAX_PORTAL_FIELD_KEY_LENGTH = 100;
/** The portal's lead id and project name; the same cap as lead_data_portal_fields_check. */
export const MAX_PORTAL_REF_LENGTH = 200;

/** The lead fields a company's field_mapping may add names for (e.g. {"phone": ["custMobile"]}). */
export const PORTAL_MAPPING_FIELDS = ["full_name", "phone", "email", "project_name", "city", "query", "external_lead_id"] as const;
type MappingField = (typeof PORTAL_MAPPING_FIELDS)[number];

// For each lead field, the names that may fill it, best first (compared case-insensitively, with spaces and hyphens read
// as "_"). The spec's lists, then a few obvious variants. Only the best one present with an answer is used.
const DEFAULT_ALIASES: Record<MappingField, readonly string[]> = {
  full_name: ["name", "full_name", "cust_name", "customer_name", "lead_name", "sender_name", "buyer_name", "fullname"],
  phone: ["mobile", "phone", "contact_no", "mobile_no", "phone_number", "sender_mobile", "contact", "mobile_number", "phone_no", "contact_number", "cust_mobile", "customer_mobile"],
  email: ["email", "email_id", "cust_email", "sender_email", "email_address", "customer_email"],
  project_name: ["project_name", "project", "property_name", "listing_name", "pid", "property_id"],
  city: ["city", "locality", "location"],
  query: ["query", "remark", "remarks", "message", "comments", "description", "requirement"],
  external_lead_id: ["lead_id", "inquiry_id", "enquiry_id", "response_id", "id"],
};

// Where each lead field is stored in field_data. first_name / last_name are used only when no full name is sent.
const STORED_AS: Record<Exclude<MappingField, "external_lead_id">, string> = {
  full_name: "full_name", phone: "phone_number", email: "email", project_name: "project_name", city: "city", query: "query",
};
const NAME_PARTS: ReadonlyArray<readonly [string, readonly string[]]> = [["first_name", ["first_name", "firstname"]], ["last_name", ["last_name", "lastname"]]];
// A field that was not picked keeps its own name, unless that name is one of these: it would then be read as the lead's
// name / email / phone (or shadow the project, city or query), so it is prefixed, as the other lead mappers do.
const RESERVED_NAMES = new Set(["full_name", "first_name", "last_name", "email", "phone_number", "project_name", "city", "query"]);

export interface PortalLeadRequest {
  method: "GET" | "POST";
  contentType: string | null;
  /** The URL parameters (a repeated one is a list). */
  query: Record<string, unknown>;
  rawBody: string;
}

export interface MappedPortalLead {
  /** The portal's own id for the enquiry (null when none was sent); a retry of it is never saved twice. */
  leadRef: string | null;
  /** The project or listing the enquiry is about; shown in the Ad Name column. */
  projectName: string | null;
  fieldData: LeadField[];
  /** The merged URL parameters and body, stored as lead_data.raw_lead_payload. It holds no secret: the URL is the secret. */
  rawPayload: Record<string, unknown>;
  /** The timeline note written when this phone already belongs to a lead of the company. */
  enquirySummary: string;
}

/** A request that can never become a lead. `status` is what the intake answers: 400, or 415 for an unsupported format. */
export class PortalLeadPayloadError extends Error {
  public readonly status: 400 | 415;

  public constructor(message: string, status: 400 | 415 = 400) {
    super(message);
    this.name = "PortalLeadPayloadError";
    this.status = status;
  }
}

type Entry = { key: string; normalized: string; raw: unknown; values: string[] };

/** True when the request carries nothing at all (a URL check): no URL parameter and an empty body. */
export function isEmptyPortalRequest(request: PortalLeadRequest): boolean {
  return Object.keys(request.query).length === 0 && (request.method === "GET" || request.rawBody.trim() === "");
}

/** Parses and maps one portal request. Throws PortalLeadPayloadError for anything unusable. */
export function mapPortalLead(portal: PortalId, request: PortalLeadRequest, options: { fieldMapping?: unknown; isTest?: boolean } = {}): MappedPortalLead {
  const body = request.method === "GET" ? emptyRecord() : parseBody(request.contentType, request.rawBody);
  const rawPayload = emptyRecord();
  for (const [key, value] of Object.entries(request.query)) rawPayload[key] = value;
  for (const [key, value] of Object.entries(body)) rawPayload[key] = value;

  // Body fields first, so a body value wins over a URL parameter of the same (normalised) name.
  const sources: Array<[string, unknown, string]> = [
    ...Object.entries(body).map(([key, value]): [string, unknown, string] => [key, value, request.rawBody]),
    ...Object.entries(request.query).filter(([key]) => !Object.hasOwn(body, key)).map(([key, value]): [string, unknown, string] => [key, value, ""]),
  ];
  const entries = sources.flatMap(([rawKey, raw, rawText]): Entry[] => {
    const key = rawKey.trim();
    if (!key) return [];
    if (key.length > MAX_PORTAL_FIELD_KEY_LENGTH) throw new PortalLeadPayloadError(`Field names must be ${MAX_PORTAL_FIELD_KEY_LENGTH} characters or fewer.`);
    return [{ key, normalized: normalizeKey(key), raw, values: toValues(raw, rawKey, rawText) }];
  });
  if (entries.length > MAX_PORTAL_LEAD_FIELDS) throw new PortalLeadPayloadError(`Send ${MAX_PORTAL_LEAD_FIELDS} fields or fewer.`);

  const aliases = withOverrides(options.fieldMapping);
  const picked = new Set<Entry>();
  const pick = (names: readonly string[], accept: (entry: Entry) => boolean = () => true): Entry | undefined => {
    for (const name of names) {
      const entry = entries.find((candidate) => candidate.normalized === name && candidate.values.length > 0 && !picked.has(candidate) && accept(candidate));
      if (entry) { picked.add(entry); return entry; }
    }
    return undefined;
  };

  // The portal's lead id: one short value. A list, an object or an over-long value stays a form answer instead.
  const refEntry = pick(aliases.external_lead_id, (entry) => entry.values.length === 1 && (entry.raw === null || typeof entry.raw !== "object") && entry.values[0].length <= MAX_PORTAL_REF_LENGTH);
  const storedAs = new Map<Entry, string>();
  for (const field of ["full_name", "phone", "email", "project_name", "city", "query"] as const) {
    const entry = pick(aliases[field]);
    if (entry) storedAs.set(entry, STORED_AS[field]);
  }
  const hasFullName = [...storedAs.values()].includes("full_name");
  if (!hasFullName) {
    for (const [stored, names] of NAME_PARTS) {
      const entry = pick(names);
      if (entry) storedAs.set(entry, stored);
    }
  }

  const fieldData: LeadField[] = [];
  const hasNameParts = [...storedAs.values()].some((name) => name === "first_name" || name === "last_name");
  if (!hasFullName && !hasNameParts) fieldData.push({ name: "full_name", values: [PORTALS[portal].defaultLeadName] });
  for (const entry of entries) {
    if (entry === refEntry || entry.values.length === 0) continue;
    const stored = storedAs.get(entry);
    const name = stored ?? (RESERVED_NAMES.has(entry.key) ? `question_${entry.key}` : entry.key);
    fieldData.push({ name, values: entry.values });
  }

  const answer = (name: string) => fieldData.find((field) => field.name === name)?.values.find((value) => value.trim()) ?? null;
  if (!answer("phone_number") && !answer("email")) throw new PortalLeadPayloadError("Send mobile or email.");

  const projectName = answer("project_name");
  return {
    leadRef: refEntry ? refEntry.values[0] : null,
    projectName: projectName ? projectName.slice(0, MAX_PORTAL_REF_LENGTH) : null,
    fieldData,
    rawPayload,
    enquirySummary: buildSummary(portal, options.isTest === true, hasFullName || hasNameParts ? nameOf(fieldData) : null, projectName, answer("city"), answer("query")),
  };
}

function buildSummary(portal: PortalId, isTest: boolean, name: string | null, project: string | null, city: string | null, query: string | null): string {
  const parts = [`${isTest ? "Test" : "New"} ${PORTALS[portal].label} enquiry`];
  if (name) parts.push(`Name: ${name}`);
  if (project) parts.push(`Project: ${project}`);
  if (city) parts.push(`City: ${city}`);
  if (query) parts.push(`Query: ${query}`);
  // lead_activities.summary holds at most 500 characters (the database cuts it too).
  return parts.join(" · ").replace(/\s+/g, " ").slice(0, 500);
}

function nameOf(fieldData: LeadField[]): string | null {
  const value = (name: string) => fieldData.find((field) => field.name === name)?.values[0]?.trim() || null;
  return value("full_name") ?? ([value("first_name"), value("last_name")].filter(Boolean).join(" ") || null);
}

/** The default names, with the company's own names (field_mapping) tried first. Anything malformed is ignored. */
function withOverrides(fieldMapping: unknown): Record<MappingField, readonly string[]> {
  const result = { ...DEFAULT_ALIASES };
  if (!fieldMapping || typeof fieldMapping !== "object" || Array.isArray(fieldMapping)) return result;
  for (const field of PORTAL_MAPPING_FIELDS) {
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
  if (mediaType === "application/x-www-form-urlencoded") return parseForm(rawBody);
  // A missing or text/plain type is read as JSON: some senders post JSON without saying so.
  if (mediaType === "" || mediaType === "text/plain" || mediaType === "application/json" || mediaType.endsWith("+json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.replace(/^﻿/, ""));
    } catch {
      throw new PortalLeadPayloadError("Send the lead as a JSON object.");
    }
    if (Array.isArray(parsed)) throw new PortalLeadPayloadError("Send one lead per request.");
    if (!parsed || typeof parsed !== "object") throw new PortalLeadPayloadError("Send the lead as a JSON object.");
    const result = emptyRecord();
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) result[key] = value;
    return result;
  }
  throw new PortalLeadPayloadError("Send JSON, form data or URL parameters.", 415);
}

/** A form post or a URL query: a repeated field becomes a list of answers. */
export function parseForm(text: string | URLSearchParams): Record<string, unknown> {
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

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[\s-]+/g, "_");
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
 * JSON.parse loses digits past 2^53 (a long number sent unquoted). The digits are read again from the raw text; if
 * that is not possible the parsed number is kept.
 */
function unsafeIntegerText(value: number, rawKey: string, rawText: string): string {
  const escapedKey = JSON.stringify(rawKey).slice(1, -1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`"${escapedKey}"\\s*:\\s*(-?\\d+)(?=\\s*[,}])`).exec(rawText)?.[1] ?? String(value);
}
