import { NextResponse } from "next/server";
import { MAX_HOUSING_WEBHOOK_BODY_BYTES, parseHousingForm } from "@/lib/server/housing/housing-lead-mapper";
import { HousingLeadIntakeService, type HousingIntakeResult } from "@/lib/server/housing/housing-lead-intake-service";

export const runtime = "nodejs";

// A company's Housing.com webhook: Housing.com pushes each enquiry here, server to server, as POST (JSON, form data,
// multipart, or JSON sent as text) or GET URL parameters. The [token] in the URL is the secret and picks the company.
// Every answer says how many leads were accepted ("accepted": 1 or 0; one lead per request).
// 200 {"success":true,"accepted":1,"message":"Lead received"} = saved ("duplicate": true when it was already saved, or
// added as a note to the lead that has this phone); 200 {"success":true,"accepted":0,"message":"Received","reason":...}
// = kept, but no lead could be read from it, and why (listed under Failed requests in the card); 404 / 413
// {"success":false,"accepted":0} = wrong URL / too large; 429 = too many leads this minute (Retry-After); 500 = our
// failure, safe to retry.
type Params = { params: Promise<{ token: string }> };

export async function POST(request: Request, { params }: Params): Promise<Response> {
  return handle(request, "POST", params);
}

export async function GET(request: Request, { params }: Params): Promise<Response> {
  return handle(request, "GET", params);
}

/** A HEAD check never saves anything (Next.js would otherwise answer it with the GET handler, which can save a lead). */
export async function HEAD(): Promise<Response> {
  return new Response(null, { status: 200 });
}

async function handle(request: Request, method: "GET" | "POST", params: Params["params"]): Promise<Response> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_HOUSING_WEBHOOK_BODY_BYTES) return respond({ status: 413, message: "Payload too large." });
  try {
    const { token } = await params;
    const rawBody = method === "POST" ? await request.text() : "";
    const result = await new HousingLeadIntakeService().ingestFromWebhook(token, {
      method,
      headers: request.headers,
      query: parseHousingForm(new URL(request.url).searchParams),
      rawBody,
    });
    return respond(result);
  } catch {
    console.error(JSON.stringify({ operation: "housing_lead_webhook", code: "INGESTION_FAILED" }));
    return respond({ status: 500, message: "Temporary failure, retry later." });
  }
}

function respond(result: HousingIntakeResult): Response {
  if (result.status === 200) {
    // Kept but not readable as a lead: still 200 (see HousingIntakeResult), with the reason.
    if ("reason" in result) return NextResponse.json({ success: true, accepted: 0, message: result.message, reason: result.reason });
    // "Webhook ready" (an empty URL check) saves nothing.
    if (!("duplicate" in result)) return NextResponse.json({ success: true, accepted: 0, message: result.message });
    return NextResponse.json(result.duplicate ? { success: true, accepted: 1, message: result.message, duplicate: true } : { success: true, accepted: 1, message: result.message });
  }
  if (result.status === 429) {
    return NextResponse.json({ success: false, accepted: 0, message: result.message }, { status: 429, headers: { "retry-after": String(result.retryAfterSeconds) } });
  }
  return NextResponse.json({ success: false, accepted: 0, message: result.message }, { status: result.status });
}
