import { z } from "zod";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";
import { LEAD_LABELS, LEAD_STATUSES } from "@/features/leads/lead-options";
import { AppError } from "@/lib/server/app-error";
import { deleteLead, getLeadFormAnswers, updateLeadSecondStatus, updateLeadTriage } from "@/lib/server/lead-query-service";
import { resolveTenantRequestContext } from "@/lib/server/tenant-context";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bodySchema = z
  .object({ status: z.enum(LEAD_STATUSES).optional(), label: z.enum(LEAD_LABELS).optional(), secondStatus: z.enum(LEAD_STATUSES).nullable().optional() })
  .strict()
  .refine((value) => [value.status, value.label, value.secondStatus].filter((field) => field !== undefined).length === 1, {
    message: "Provide exactly one of status, label or secondStatus.",
  });

// Read-only: the lead's Meta form answers (minus name/email/phone), for the lead drawer.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!UUID_PATTERN.test(id)) throw new AppError("A valid lead id is required.", { status: 400, code: "INVALID_LEAD_ID" });
    const context = await resolveTenantRequestContext();
    return createSuccessResponse(await getLeadFormAnswers(context, id));
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

// This route is the only place a lead's status/label/second status may be written — it
// persists straight to lead_data, tenant-scoped. It must never be driven by
// the leads-list filter controls, which only read these columns.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!UUID_PATTERN.test(id)) throw new AppError("A valid lead id is required.", { status: 400, code: "INVALID_LEAD_ID" });
    const body = await parseJsonBody(request, bodySchema);
    const context = await resolveTenantRequestContext();
    // The second status (null removes it) is saved on its own and never reaches the timeline.
    if (body.secondStatus !== undefined) return createSuccessResponse(await updateLeadSecondStatus(context, id, body.secondStatus));
    const update = body.status !== undefined ? { status: body.status } : { label: body.label! };
    return createSuccessResponse(await updateLeadTriage(context, id, update));
  } catch (error) {
    return createErrorResponse(error);
  }
}

// Permanently deletes one lead. The client only calls this after the user has explicitly
// confirmed the action, since a deleted lead can never be recovered.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!UUID_PATTERN.test(id)) throw new AppError("A valid lead id is required.", { status: 400, code: "INVALID_LEAD_ID" });
    const context = await resolveTenantRequestContext();
    return createSuccessResponse(await deleteLead(context, id));
  } catch (error) {
    return createErrorResponse(error);
  }
}
