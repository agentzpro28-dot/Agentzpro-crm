import { z } from "zod";
import { assertSameOrigin } from "@/lib/server/auth/same-origin";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";
import { OlxHomeIntegrationService } from "@/lib/server/olx-home/olx-home-integration-service";

export const runtime = "nodejs";

// The company's OLX Home integration. GET: whether the URL was created (the /leads Source filter and the dashboard);
// with ?details=1 the owner also gets the webhook URL, the last lead time, the old URL's 7-day handover and the last 10
// failed requests (the Integrations card). POST: create the URL, or replace it (owner only). PATCH: pause or resume
// (below). DELETE: disconnect (below).
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

const pauseSchema = z.object({ paused: z.boolean() }).strict();

// PATCH { paused: true | false }: pause OLX Home leads (every request then gets 404, nothing is saved) or resume them
// (owner only).
export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await parseJsonBody(request, pauseSchema);
    return createSuccessResponse(await new OlxHomeIntegrationService().setPaused(body.paused));
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

// DELETE: disconnect OLX Home (owner only). Every request to the current URL and the old URL then gets 404 and nothing
// is saved; leads already received stay. A new URL can be generated later with POST.
export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    return createSuccessResponse(await new OlxHomeIntegrationService().disconnect());
  } catch (error) {
    return createErrorResponse(error, request);
  }
}
