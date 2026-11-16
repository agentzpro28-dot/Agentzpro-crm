import { createErrorResponse } from "@/app/api/meta/_lib/route-utils";
import { AppError } from "@/lib/server/app-error";
import { subscribeToTenantChanges } from "@/lib/server/dashboard-live-relay";
import { resolveTenantRequestContext } from "@/lib/server/tenant-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Each stream closes itself well inside maxDuration and the browser's EventSource reconnects. Every
 * reconnect goes back through the proxy (idle-session check) and requireCrmAccess (session,
 * membership, tenant status, subscription), so a signed-out, idle, removed or expired user loses the
 * feed within one lifetime without any cookie handling after the response has started.
 *
 * Each stream picks its lifetime and the browser's reconnect delay at random within the bounds below. Streams that
 * started together (a server instance that stops drops all of its streams at once, and every browser reconnects)
 * then end and reconnect at different moments, instead of together every few minutes from then on.
 * The bounds are tied to other timers:
 * - the longest lifetime stays 20 s inside maxDuration;
 * - the longest delay plus the reconnect itself stays inside the dashboard's 10 s wait before it starts polling
 *   (STREAM_GRACE_MS, use-dashboard-live.ts);
 * - the longest lifetime plus the longest delay stays well inside the 330 s after which the shell stops trusting a
 *   quiet stream (LIVE_STREAM_QUIET_MS, task-bell.tsx).
 */
const STREAM_LIFETIME_MIN_MS = 250_000;
const STREAM_LIFETIME_MAX_MS = 280_000;
/**
 * This long before its end a stream sends "rollover": the browser opens the next stream beside it and switches once
 * that one is live (live-stream.ts), so no lead signal falls into the gap and no page reloads to catch up. A browser
 * that ignores the hint reconnects after the end, as before.
 */
const ROLLOVER_NOTICE_MS = 10_000;
const HEARTBEAT_MS = 20_000;
const RECONNECT_DELAY_MIN_MS = 1_000;
const RECONNECT_DELAY_MAX_MS = 5_000;
const MAX_STREAMS_PER_USER_PER_INSTANCE = 6;

const openStreamsByUser = new Map<string, number>();

/** A whole number of milliseconds from min to max, both included. */
function randomMs(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

export async function GET(request: Request): Promise<Response> {
  let context;
  try {
    context = await resolveTenantRequestContext();
    if ((openStreamsByUser.get(context.userId) ?? 0) >= MAX_STREAMS_PER_USER_PER_INSTANCE) {
      throw new AppError("Too many live dashboards are open for this account.", { status: 429, code: "TOO_MANY_STREAMS", retryable: true });
    }
  } catch (error) {
    return createErrorResponse(error, request);
  }

  const { tenantId, userId } = context;
  openStreamsByUser.set(userId, (openStreamsByUser.get(userId) ?? 0) + 1);
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe = () => {};
      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          close();
        }
      };
      const sendEvent = (event: string, data: unknown) => send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
      const lifetimeMs = randomMs(STREAM_LIFETIME_MIN_MS, STREAM_LIFETIME_MAX_MS);
      const lifetime = setTimeout(close, lifetimeMs);
      const rollover = setTimeout(() => sendEvent("rollover", {}), lifetimeMs - ROLLOVER_NOTICE_MS);

      function close() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(lifetime);
        clearTimeout(rollover);
        unsubscribe();
        const remaining = (openStreamsByUser.get(userId) ?? 1) - 1;
        if (remaining <= 0) openStreamsByUser.delete(userId);
        else openStreamsByUser.set(userId, remaining);
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      }
      cleanup = close;
      request.signal.addEventListener("abort", close);

      // "ready" goes out before subscribing: the relay tells a late joiner the channel's current state at once (it
      // may already be "degraded"), and the dashboard and the lead timeline treat "ready" as "connected, stop the
      // backup refresh". Sent the other way round, "ready" cancelled the "degraded" it followed.
      send(`retry: ${randomMs(RECONNECT_DELAY_MIN_MS, RECONNECT_DELAY_MAX_MS)}\n\n`);
      sendEvent("ready", { tenantId });
      if (closed) return;

      unsubscribe = subscribeToTenantChanges(tenantId, (event, payload) => {
        // An update says when the newest lead it changed was saved (a number, no lead data), so /leads can skip its
        // check for older leads; every other change stays {}.
        if (event === "change") sendEvent("change", payload?.newestSavedUs ? { kind: "update", newestSavedUs: payload.newestSavedUs } : {});
        else if (event === "activity") { if (payload?.leadId) sendEvent("activity", { leadId: payload.leadId }); }
        // A reminder belongs to one member; the other streams of the tenant never see it.
        else if (event === "reminder") { if (payload?.userId === userId && payload.notificationId) sendEvent("task_reminder", { notificationId: payload.notificationId }); }
        else sendEvent("status", { state: event });
      });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "private, no-cache, no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
