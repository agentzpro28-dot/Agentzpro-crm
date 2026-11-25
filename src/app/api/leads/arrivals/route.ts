import { z } from "zod";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";
import { countLeadsSavedSince } from "@/lib/server/lead-query-service";
import { resolveTenantRequestContext } from "@/lib/server/tenant-context";

/** A tab hidden longer than this asks about the last day only; the session's idle limit is shorter anyway. */
const MAX_HIDDEN_FOR_MS = 24 * 60 * 60 * 1000;
/**
 * Added to the hidden time so a lead saved while the tab was being left, or while this request was on its way, is
 * never missed. A lead saved a few seconds before the tab was hidden may be announced too; that is the safe side.
 */
const ARRIVALS_MARGIN_MS = 5_000;

/**
 * The background "New lead" pop-up. A CRM tab that is in the background sends how long it has been hidden (its own
 * clock, so a wrong PC clock does not matter); the server turns that into a time on its own clock and answers how
 * many of the company's leads were saved since then, plus the newest one's name and source for the pop-up text.
 * An ordinary request: it never renews the idle-logout clock.
 */
const requestSchema = z.object({ hiddenForMs: z.number().int().min(0).max(MAX_HIDDEN_FOR_MS) }).strict();

export async function POST(request: Request) {
  try {
    const context = await resolveTenantRequestContext();
    const { hiddenForMs } = await parseJsonBody(request, requestSchema);
    const since = new Date(Date.now() - hiddenForMs - ARRIVALS_MARGIN_MS).toISOString();
    return createSuccessResponse(await countLeadsSavedSince(context, since));
  } catch (error) { return createErrorResponse(error); }
}
