import { z } from "zod";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";
import { MAX_BULK_DELETE_LEADS } from "@/features/leads/lead-options";
import { deleteLeads } from "@/lib/server/lead-query-service";
import { resolveTenantRequestContext } from "@/lib/server/tenant-context";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bodySchema = z.object({ ids: z.array(z.string().regex(UUID_PATTERN)).min(1).max(MAX_BULK_DELETE_LEADS) }).strict();

// Permanently deletes the checked leads in one request (one access check). The client only calls this after the user
// has explicitly confirmed the action, since a deleted lead can never be recovered. Same rights as deleting one lead.
export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request, bodySchema);
    const context = await resolveTenantRequestContext();
    return createSuccessResponse(await deleteLeads(context, body.ids));
  } catch (error) {
    return createErrorResponse(error, request);
  }
}
