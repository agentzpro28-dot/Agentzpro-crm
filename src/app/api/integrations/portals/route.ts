import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";
import { PortalIntegrationService } from "@/lib/server/portal-leads/portal-integration-service";

export const runtime = "nodejs";

// Which real-estate portals (99acres, ...) this company has set up: the /leads Source filter and the dashboard's
// platform switch. One call for every portal; never returns a URL.
export async function GET(request: Request) {
  try {
    return createSuccessResponse(await new PortalIntegrationService().listStatuses());
  } catch (error) {
    return createErrorResponse(error, request);
  }
}
