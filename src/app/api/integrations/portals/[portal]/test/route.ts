import { assertSameOrigin } from "@/lib/server/auth/same-origin";
import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";
import { AppError } from "@/lib/server/app-error";
import { parsePortalId } from "@/lib/portal-leads/portals";
import { PortalIntegrationService } from "@/lib/server/portal-leads/portal-integration-service";

export const runtime = "nodejs";

// "Send test lead" on the Integrations card (owner only): a sample enquiry through the same intake as a real one.
export async function POST(request: Request, { params }: { params: Promise<{ portal: string }> }) {
  try {
    assertSameOrigin(request);
    const portal = parsePortalId((await params).portal);
    if (!portal) throw new AppError("Unknown portal.", { status: 404, code: "PORTAL_NOT_FOUND" });
    return createSuccessResponse(await new PortalIntegrationService().sendTestLead(portal));
  } catch (error) {
    return createErrorResponse(error, request);
  }
}
