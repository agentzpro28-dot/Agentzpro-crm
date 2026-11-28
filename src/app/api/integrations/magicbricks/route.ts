import { z } from "zod";
import { assertSameOrigin } from "@/lib/server/auth/same-origin";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";
import { MagicbricksIntegrationService } from "@/lib/server/magicbricks/magicbricks-integration-service";

export const runtime = "nodejs";

// The company's MagicBricks integration. GET: whether the URL was created (the /leads Source filter and the dashboard);
// with ?details=1 the owner also gets the webhook URL, the last lead time and the last 10 failed requests (the
// Integrations card). POST: create the URL, or replace it (owner only). PATCH: pause or resume (below).
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    return createSuccessResponse(await new MagicbricksIntegrationService().getOverview(url.origin, { details: url.searchParams.get("details") === "1" }));
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    return createSuccessResponse(await new MagicbricksIntegrationService().createOrReplace(new URL(request.url).origin));
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

const pauseSchema = z.object({ paused: z.boolean() }).strict();

// PATCH { paused: true | false }: pause MagicBricks leads (every request then gets 404, nothing is saved) or resume
// them (owner only).
export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await parseJsonBody(request, pauseSchema);
    return createSuccessResponse(await new MagicbricksIntegrationService().setPaused(body.paused));
  } catch (error) {
    return createErrorResponse(error, request);
  }
}
