import { assertSameOrigin } from "@/lib/server/auth/same-origin";
import { createErrorResponse, createSuccessResponse } from "@/app/api/meta/_lib/route-utils";
import { OlxHomeIntegrationService } from "@/lib/server/olx-home/olx-home-integration-service";

export const runtime = "nodejs";

// The company's OLX Home integration. GET: whether the URL was created (the /leads Source filter and the dashboard);
// with ?details=1 the owner also gets the webhook URL, the last lead time, the old URL's 7-day handover and the last 10
// failed requests (the Integrations card). POST: create the URL, or replace it (owner only).
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    return createSuccessResponse(await new OlxHomeIntegrationService().getOverview(url.origin, { details: url.searchParams.get("details") === "1" }));
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    return createSuccessResponse(await new OlxHomeIntegrationService().createOrReplace(new URL(request.url).origin));
  } catch (error) {
    return createErrorResponse(error, request);
  }
}
