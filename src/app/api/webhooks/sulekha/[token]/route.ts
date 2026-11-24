import { NextResponse } from "next/server";
import { MAX_SULEKHA_WEBHOOK_BODY_BYTES, parseSulekhaForm } from "@/lib/server/sulekha/sulekha-lead-mapper";
import { SulekhaLeadIntakeService, type SulekhaIntakeResult } from "@/lib/server/sulekha/sulekha-lead-intake-service";

export const runtime = "nodejs";

// A company's Sulekha webhook: Sulekha pushes each customer enquiry here, server to server, as POST (JSON, form data,
// multipart, or JSON sent as text) or GET URL parameters. The [token] in the URL is the secret and picks the company.
// 200 {"success":true,"message":"Lead received"} = saved ("duplicate": true when it was already saved, or added as a
// note to the lead that has this phone); 200 {"success":true,"message":"Received"} = kept, but no lead could be read
// from it (listed under Failed requests in the card); 404 / 413 {"success":false} = wrong URL / too large; 429 = too
// many leads this minute (Retry-After); 500 = our failure, safe to retry.
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
  if (declaredLength > MAX_SULEKHA_WEBHOOK_BODY_BYTES) return respond({ status: 413, message: "Payload too large." });
  try {
    const { token } = await params;
    const rawBody = method === "POST" ? await request.text() : "";
    const result = await new SulekhaLeadIntakeService().ingestFromWebhook(token, {
      method,
      headers: request.headers,
      query: parseSulekhaForm(new URL(request.url).searchParams),
      rawBody,
    });
    return respond(result);
  } catch {
    console.error(JSON.stringify({ operation: "sulekha_lead_webhook", code: "INGESTION_FAILED" }));
    return respond({ status: 500, message: "Temporary failure, retry later." });
  }
}

function respond(result: SulekhaIntakeResult): Response {
  if (result.status === 200) {
    return NextResponse.json("duplicate" in result && result.duplicate ? { success: true, message: result.message, duplicate: true } : { success: true, message: result.message });
  }
  if (result.status === 429) {
    return NextResponse.json({ success: false, message: result.message }, { status: 429, headers: { "retry-after": String(result.retryAfterSeconds) } });
  }
  return NextResponse.json({ success: false, message: result.message }, { status: result.status });
}
