import { NextResponse } from "next/server";
import { z } from "zod";
import { createErrorResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";
import { ASSIGNEE_FILTER_SHORTCUTS, GOOGLE_CAMPAIGN_ID_PATTERN, LEAD_LABELS, LEAD_SOURCES, LEAD_STATUSES } from "@/features/leads/lead-options";
import { getLeadsCursor, queryLeads, resolveTenantTimezone, type LeadRow, type PaginatedLeadRows } from "@/lib/server/lead-query-service";
import { resolveTenantRequestContext } from "@/lib/server/tenant-context";

const requestSchema = z.object({ search: z.string().max(200).optional(), quickFilter: z.enum(["all", "today", "month"]).optional(), dateFrom: z.string().optional(), dateTo: z.string().optional(), pageRecordId: z.string().uuid().optional(), adId: z.string().min(1).max(100).or(z.literal("unattributed")).optional(), campaignId: z.string().regex(GOOGLE_CAMPAIGN_ID_PATTERN).or(z.literal("unattributed")).optional(), status: z.enum(LEAD_STATUSES).optional(), label: z.enum(LEAD_LABELS).optional(), assignee: z.union([z.enum(ASSIGNEE_FILTER_SHORTCUTS), z.string().uuid()]).optional(), source: z.enum(LEAD_SOURCES).optional(), sortField: z.enum(["leadName", "leadDate"]).optional(), sortDirection: z.enum(["asc", "desc"]).optional() }).strict();
const HEADER = "Lead ID,Lead Name,Lead Date,Status,Label,Email,Phone,Facebook Page,Ad Name,Ad ID,Assigned To";
/** Rows per read: Supabase's API answers at most 1,000 rows per request by default (its "Max rows" setting). */
const EXPORT_PAGE_ROWS = 1000;

/**
 * Every lead the table's filters match, as a CSV file. It is read page by page and streamed out as it goes: one read
 * would stop at the API's row cap, and Vercel caps a response that is not streamed at 4.5 MB. Pages continue until
 * one comes back empty (whatever the row cap is set to), and only leads saved before the download began are read, so
 * a lead arriving meanwhile cannot shift them. A failure before the first row returns the usual error; a failure
 * after it ends the download with an error, so a cut-off file is never saved as if it were complete.
 */
export async function POST(request: Request) {
  let first: PaginatedLeadRows;
  let read: (offset: number) => Promise<PaginatedLeadRows>;
  try {
    const context = await resolveTenantRequestContext();
    const filters = await parseJsonBody(request, requestSchema);
    const savedBefore = await getLeadsCursor(context.tenantId);
    if (savedBefore === null) {
      // No leads at all: nothing to read, but the company clock is still checked as before (same 503 when unset).
      const timezone = await resolveTenantTimezone(context);
      first = { items: [], total: 0, page: 1, pageSize: 0, totalPages: 1, timezone };
      read = async () => first;
    } else {
      read = (offset) => queryLeads(context, filters, { offset, limit: EXPORT_PAGE_ROWS, savedBefore });
      first = await read(0);
    }
  } catch (error) { return createErrorResponse(error); }

  const encoder = new TextEncoder();
  let next: PaginatedLeadRows | null = first;
  let offset = 0;
  let headerSent = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!headerSent) { headerSent = true; controller.enqueue(encoder.encode(`﻿${HEADER}`)); return; }
        const page = next ?? await read(offset);
        next = null;
        if (page.items.length === 0) { controller.close(); return; }
        offset += page.items.length;
        const date = new Intl.DateTimeFormat("en-IN", { timeZone: page.timezone, dateStyle: "medium", timeStyle: "short" });
        controller.enqueue(encoder.encode(page.items.map((row) => `\r\n${csvRow(row, date)}`).join("")));
      } catch (error) {
        console.error(JSON.stringify({ operation: "lead_export", code: "LEAD_EXPORT_STREAM_FAILED", rowsSent: offset, message: error instanceof Error ? error.message : "unknown" }));
        controller.error(error);
      }
    },
  });
  return new NextResponse(body, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename=leads-${new Date().toISOString().slice(0, 10)}.csv` } });
}

function csvRow(row: LeadRow, date: Intl.DateTimeFormat): string {
  return [row.leadgenId, row.leadName, date.format(new Date(row.leadDate)), row.status, row.label, row.email, row.phone, row.source === "telecaller" ? null : row.facebookPage, exportAdName(row), row.adId, row.assigneeName].map(csvValue).join(",");
}
/**
 * A call-in lead's Ad Name cell stays empty. So does a webhook lead's when its tool sent no "source", and a 99acres
 * lead's when the portal sent no project: the table shows a "-" placeholder there, which csvValue's formula guard would
 * otherwise write as '-.
 */
function exportAdName(row: { source: string; adName: string }): string | null {
  if (row.source === "telecaller") return null;
  if ((row.source === "custom_webhook" || row.source === "99acres") && row.adName === "-") return null;
  // A MagicBricks lead's too, when MagicBricks sent no project.
  if (row.source === "magicbricks" && row.adName === "-") return null;
  // A Housing.com lead's too, when Housing.com sent no project.
  if (row.source === "housing" && row.adName === "-") return null;
  return row.adName;
}
function csvValue(value: string | null): string { const safe = String(value ?? "").replace(/^[=+\-@\t\r]/, "'$&"); return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe; }
