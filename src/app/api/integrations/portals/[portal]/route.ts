import { assertSameOrigin } from "@/lib/server/auth/same-origin";
import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";
import { AppError } from "@/lib/server/app-error";
import { parsePortalId, type PortalId } from "@/lib/portal-leads/portals";
import { PortalIntegrationService } from "@/lib/server/portal-leads/portal-integration-service";

export const runtime = "nodejs";

type Params = { params: Promise<{ portal: string }> };

// One portal's integration (99acres, ...). GET: the Integrations card; with ?details=1 the owner also gets the webhook
// URL, the last lead time and the last 10 failed requests. POST: create the URL, or replace it (owner only).
export async function GET(request: Request, { params }: Params) {
  try {
    const url = new URL(request.url);
    return createSuccessResponse(await new PortalIntegrationService().getOverview(await portalFrom(params), url.origin, { details: url.searchParams.get("details") === "1" }));
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    assertSameOrigin(request);
    return createSuccessResponse(await new PortalIntegrationService().createOrReplace(await portalFrom(params), new URL(request.url).origin));
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

async function portalFrom(params: Params["params"]): Promise<PortalId> {
  const portal = parsePortalId((await params).portal);
  if (!portal) throw new AppError("Unknown portal.", { status: 404, code: "PORTAL_NOT_FOUND" });
  return portal;
}
