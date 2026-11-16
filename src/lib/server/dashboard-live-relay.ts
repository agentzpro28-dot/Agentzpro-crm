import "server-only";

import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import { readNewestSavedUs } from "@/lib/lead-change-signal";
import { getSupabaseEnv } from "@/lib/server/env";

/**
 * Server-side bridge from Supabase Realtime to dashboard SSE streams.
 *
 * A Postgres trigger on lead_data broadcasts a PII-free ping on the private topic
 * `dashboard:<tenant_id>` (see migration 20260929120000). Browsers cannot join that topic (no policy
 * on realtime.messages for anon/authenticated); only this module, using the service role, can.
 *
 * One Realtime channel is held per tenant per server instance and shared by every SSE stream of
 * that tenant on the instance, so open dashboards cost one channel per tenant, not one each.
 * A stream can only ever attach to the tenant id it was authenticated for.
 *
 * Supabase Realtime accepts at most 100 channels on one connection, on every plan (a join beyond that is refused
 * with "too_many_channels"). The tenant channels are therefore spread over as many Realtime connections as they
 * need, at most MAX_CHANNELS_PER_CONNECTION on each. These connections belong to this module, not to the shared
 * service-role client the rest of the server uses for database calls. A connection whose last channel has left
 * closes its socket by itself (supabase-js) and takes new channels again later.
 */

export type RelayEvent = "change" | "degraded" | "live" | "activity" | "reminder";
/**
 * "activity": the lead whose timeline gained a row. "reminder": a task alert and the one member it is for
 * (the stream route forwards it only to that member). Both are UUIDs, no PII.
 * "change" from an update: when the newest lead it changed was saved (microseconds since 1970, a digit string; see
 * migration 20261105150000), so /leads can skip its check for changes to older leads. Any other "change" has none.
 */
export interface RelayPayload { leadId?: string; notificationId?: string; userId?: string; newestSavedUs?: string }
export type RelayListener = (event: RelayEvent, payload?: RelayPayload) => void;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RelayConnection {
  client: SupabaseClient;
  /**
   * This connection's channels by topic, including one that is still leaving: until supabase-js drops it, the server
   * may still count it, and supabase-js would hand that same leaving channel back for a new join of its topic.
   */
  channels: Map<string, RealtimeChannel>;
}

interface TenantChannel {
  topic: string;
  connection: RelayConnection;
  channel: RealtimeChannel;
  listeners: Set<RelayListener>;
  state: "connecting" | "live" | "degraded";
  degradedTimer: ReturnType<typeof setTimeout> | undefined;
  lingerTimer: ReturnType<typeof setTimeout> | undefined;
  hasBeenLive: boolean;
  /** Set once this module starts removing the channel. Its own leave then reports CLOSED, which means nothing. */
  closing: boolean;
  /** The last join failure supabase-js reported, for the log line if the channel turns degraded. */
  lastFailure: { status: string; reason: string | null } | undefined;
}

// Below Supabase's 100 so that a channel the server has not finished removing (a leave that timed out) never pushes
// a connection over the limit.
const MAX_CHANNELS_PER_CONNECTION = 90;
// A first join can fail once with "MissingPartition" and then succeed on Realtime's own retry, so a
// channel only counts as degraded after it has failed to (re)join for this long.
const DEGRADED_AFTER_MS = 10_000;
// A tenant's channel stays open this long after its last stream ends. Every stream ends after a few minutes and the
// browser reconnects a few seconds later (stream route), so a reconnect to this instance reuses the open channel
// instead of leaving and joining again.
const LINGER_AFTER_LAST_STREAM_MS = 30_000;

const connections: RelayConnection[] = [];
const tenantChannels = new Map<string, TenantChannel>();

function warn(code: string, details: Record<string, unknown>): void {
  console.warn(JSON.stringify({ operation: "dashboard_live_relay", code, ...details }));
}

function emit(entry: TenantChannel, event: RelayEvent, payload?: RelayPayload): void {
  for (const listener of entry.listeners) {
    try {
      if (payload) listener(event, payload);
      else listener(event);
    } catch {
      // One broken stream must not stop the others receiving the event.
    }
  }
}

/** The first connection with room that does not still hold this topic, or a new connection when there is none. */
function connectionFor(topic: string): RelayConnection {
  const free = connections.find((connection) => connection.channels.size < MAX_CHANNELS_PER_CONNECTION && !connection.channels.has(topic));
  if (free) return free;
  const environment = getSupabaseEnv();
  // The same options as the shared service-role client (supabase-admin.ts).
  const connection: RelayConnection = {
    client: createClient(environment.SUPABASE_URL, environment.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } }),
    channels: new Map(),
  };
  connections.push(connection);
  return connection;
}

function openTenantChannel(tenantId: string): TenantChannel {
  const topic = `dashboard:${tenantId}`;
  const connection = connectionFor(topic);
  const channel = connection.client.channel(topic, { config: { private: true } });
  connection.channels.set(topic, channel);
  const entry: TenantChannel = {
    topic, connection, channel, listeners: new Set(), state: "connecting", degradedTimer: undefined, lingerTimer: undefined,
    hasBeenLive: false, closing: false, lastFailure: undefined,
  };

  // Only a well-formed update value is passed on; a new lead, a delete or anything unreadable is a plain "change".
  channel.on("broadcast", { event: "lead_change" }, (message?: { payload?: { kind?: unknown; newest_saved_us?: unknown } }) => {
    const newestSavedUs = message?.payload?.kind === "update" ? readNewestSavedUs(message.payload.newest_saved_us) : undefined;
    if (newestSavedUs) emit(entry, "change", { newestSavedUs });
    else emit(entry, "change");
  });
  // A Lead Timeline row was written (migration 20261005120000). Only a well-formed lead id is passed on.
  channel.on("broadcast", { event: "lead_activity" }, (message?: { payload?: { lead_id?: unknown } }) => {
    const leadId = message?.payload?.lead_id;
    if (typeof leadId === "string" && UUID_PATTERN.test(leadId)) emit(entry, "activity", { leadId });
  });
  // A task is due soon / now (migration 20261007130000). The stream route delivers it to the named member only.
  channel.on("broadcast", { event: "task_reminder" }, (message?: { payload?: { notification_id?: unknown; user_id?: unknown } }) => {
    const notificationId = message?.payload?.notification_id;
    const userId = message?.payload?.user_id;
    if (typeof notificationId === "string" && UUID_PATTERN.test(notificationId) && typeof userId === "string" && UUID_PATTERN.test(userId)) {
      emit(entry, "reminder", { notificationId, userId });
    }
  });
  channel.subscribe((status, error) => {
    if (entry.closing) return;
    if (status === "SUBSCRIBED") {
      clearTimeout(entry.degradedTimer);
      entry.degradedTimer = undefined;
      entry.lastFailure = undefined;
      const recovered = entry.state === "degraded" || (entry.hasBeenLive && entry.state === "connecting");
      entry.state = "live";
      entry.hasBeenLive = true;
      emit(entry, "live");
      // Leads can arrive while the channel is down; tell streams to refetch once it is back.
      if (recovered) emit(entry, "change");
    } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
      entry.lastFailure = { status, reason: error?.message ? error.message.slice(0, 200) : null };
      if (entry.state === "live") entry.state = "connecting";
      if (!entry.degradedTimer && entry.state !== "degraded") {
        entry.degradedTimer = setTimeout(() => {
          entry.degradedTimer = undefined;
          entry.state = "degraded";
          // Once per outage. A reason of too_many_channels, too_many_connections or too_many_joins is a Realtime limit.
          warn("CHANNEL_DEGRADED", { tenantId, ...entry.lastFailure, connections: connections.length, channelsOnConnection: connection.channels.size });
          emit(entry, "degraded");
        }, DEGRADED_AFTER_MS);
      }
    }
  });
  return entry;
}

/** Leaves the channel and frees its slot on the connection once supabase-js no longer holds it. */
async function releaseChannel({ topic, connection, channel }: TenantChannel): Promise<void> {
  let status: string;
  try {
    status = await connection.client.removeChannel(channel);
  } catch {
    status = "error";
  }
  if (status !== "ok") {
    // supabase-js stops a channel's timers only after an acknowledged leave.
    warn("CHANNEL_LEAVE_FAILED", { status });
    try {
      channel.teardown();
    } catch {
      // Nothing left to stop.
    }
  }
  if (!connection.client.getChannels().includes(channel)) connection.channels.delete(topic);
}

function closeTenantChannel(tenantId: string, entry: TenantChannel): void {
  entry.lingerTimer = undefined;
  if (entry.listeners.size > 0) return;
  entry.closing = true;
  clearTimeout(entry.degradedTimer);
  entry.degradedTimer = undefined;
  if (tenantChannels.get(tenantId) === entry) tenantChannels.delete(tenantId);
  void releaseChannel(entry);
}

/**
 * Attaches a listener to one tenant's change feed and returns its detach function. When the last listener detaches,
 * the Realtime channel is torn down after LINGER_AFTER_LAST_STREAM_MS, unless a new listener arrives first.
 */
export function subscribeToTenantChanges(tenantId: string, listener: RelayListener): () => void {
  let entry = tenantChannels.get(tenantId);
  // A held channel is reused only while supabase-js still lists it. One the server closed is dropped by supabase-js
  // and never rejoined, so it is replaced, as a new stream did before channels were held. A listed channel that is
  // failing is still being retried by supabase-js and is kept: a second one would only add a connection.
  if (entry && entry.listeners.size === 0 && !entry.connection.client.getChannels().includes(entry.channel)) {
    clearTimeout(entry.lingerTimer);
    closeTenantChannel(tenantId, entry);
    entry = undefined;
  }
  if (!entry) {
    entry = openTenantChannel(tenantId);
    tenantChannels.set(tenantId, entry);
  }
  clearTimeout(entry.lingerTimer);
  entry.lingerTimer = undefined;
  entry.listeners.add(listener);
  // A late joiner needs the current state, not just future transitions.
  if (entry.state === "live") listener("live");
  if (entry.state === "degraded") listener("degraded");

  const attached = entry;
  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    attached.listeners.delete(listener);
    if (attached.listeners.size === 0) {
      clearTimeout(attached.lingerTimer);
      attached.lingerTimer = setTimeout(() => closeTenantChannel(tenantId, attached), LINGER_AFTER_LAST_STREAM_MS);
    }
  };
}
