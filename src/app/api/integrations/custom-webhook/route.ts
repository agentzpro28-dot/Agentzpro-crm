import { z } from "zod";
import { assertSameOrigin } from "@/lib/server/auth/same-origin";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";
import { CustomWebhookConnectionService } from "@/lib/server/custom-webhook/custom-webhook-connection-service";

export const runtime = "nodejs";

const pauseSchema = z.object({ paused: z.boolean() }).strict();

// The company's custom webhook. GET: whether it is on or stopped (the /leads and dashboard source check); with
// ?details=1, sent only by the Connection card, the owner also gets the URL. POST: create it, or replace the URL.
// DELETE: stop webhook leads. PATCH {"paused": true | false}: pause or resume webhook leads. POST, DELETE and PATCH are
// owner only.
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    return createSuccessResponse(await new CustomWebhookConnectionService().getOverview(url.origin, { includeUrl: url.searchParams.get("details") === "1" }));
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    return createSuccessResponse(await new CustomWebhookConnectionService().createOrReplace(new URL(request.url).origin));
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    await new CustomWebhookConnectionService().stop();
    return createSuccessResponse({ stopped: true });
  } catch (error) {
    return createErrorResponse(error, request);
  }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await parseJsonBody(request, pauseSchema);
    return createSuccessResponse(await new CustomWebhookConnectionService().setPaused(body.paused));
  } catch (error) {
    return createErrorResponse(error, request);
  }
}
