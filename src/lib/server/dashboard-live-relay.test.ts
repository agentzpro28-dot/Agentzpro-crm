// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

type StatusCallback = (status: string, error?: Error) => void;
type LeaveResult = "ok" | "timed out" | "error";

interface FakeChannel {
  topic: string;
  config: unknown;
  client: FakeClient;
  handlers: Record<string, (message?: unknown) => void>;
  status: StatusCallback;
  joined: boolean;
  on: Mock;
  subscribe: Mock;
  teardown: Mock;
}

interface FakeClient {
  url: string;
  key: string;
  options: unknown;
  channels: FakeChannel[];
  channel: Mock;
  getChannels: Mock;
  removeChannel: Mock;
}

/**
 * A stand-in for supabase-js built from what @supabase/realtime-js 2.112 does:
 * - client.channel(topic) hands back the channel it still lists for that topic instead of creating another;
 * - a channel joins once (phoenix throws "tried to join multiple times");
 * - removeChannel(): an acknowledged or timed-out leave closes the channel (CLOSED to its subscribe callback) and
 *   drops it from the client's list; a refused leave leaves it listed; only an acknowledged leave tears it down.
 */
const fake = vi.hoisted(() => {
  const state = {
    clients: [] as FakeClient[],
    /** Every channel created, oldest first. */
    created: [] as FakeChannel[],
    /** How the next leaves end. "hold" keeps each one pending until the test settles it. */
    leave: "ok" as LeaveResult | "hold",
    heldLeaves: [] as Array<(result: LeaveResult) => void>,
  };
  const createClient = vi.fn((url: string, key: string, options: unknown) => {
    const client = { url, key, options, channels: [] as FakeChannel[] } as FakeClient;
    client.channel = vi.fn((topic: string, config: unknown) => {
      const listed = client.channels.find((candidate) => candidate.topic === topic);
      if (listed) return listed;
      const channel = { topic, config, client, handlers: {}, status: () => {}, joined: false } as unknown as FakeChannel;
      channel.on = vi.fn((_type: string, filter: { event: string }, callback: (message?: unknown) => void) => {
        channel.handlers[filter.event] = callback;
        return channel;
      });
      channel.subscribe = vi.fn((callback: StatusCallback) => {
        if (channel.joined) throw new Error("tried to join multiple times");
        channel.joined = true;
        channel.status = callback;
        return channel;
      });
      channel.teardown = vi.fn();
      client.channels.push(channel);
      state.created.push(channel);
      return channel;
    });
    client.getChannels = vi.fn(() => client.channels);
    client.removeChannel = vi.fn((channel: FakeChannel) => new Promise<LeaveResult>((resolve) => {
      const settle = (result: LeaveResult) => {
        if (result !== "error") {
          client.channels = client.channels.filter((candidate) => candidate !== channel);
          channel.status("CLOSED");
        }
        if (result === "ok") channel.teardown();
        resolve(result);
      };
      if (state.leave === "hold") state.heldLeaves.push(settle);
      else settle(state.leave);
    }));
    state.clients.push(client);
    return client;
  });
  return { state, createClient };
});

vi.mock("@supabase/supabase-js", () => ({ createClient: fake.createClient }));
vi.mock("@/lib/server/env", () => ({
  getSupabaseEnv: () => ({ SUPABASE_URL: "https://project.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-key" }),
}));

const LINGER_MS = 30_000;

let subscribeToTenantChanges: typeof import("@/lib/server/dashboard-live-relay").subscribeToTenantChanges;
let warn: ReturnType<typeof vi.spyOn>;

/** The newest channel opened for a tenant. */
function channelOf(tenantId: string): FakeChannel {
  const channel = [...fake.state.created].reverse().find((candidate) => candidate.topic === `dashboard:${tenantId}`);
  if (!channel) throw new Error(`no channel for ${tenantId}`);
  return channel;
}

const channelsPerConnection = () => fake.state.clients.map((client) => client.channels.length);
const warnings = () => warn.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);

beforeEach(async () => {
  vi.useFakeTimers();
  fake.state.clients.length = 0;
  fake.state.created.length = 0;
  fake.state.heldLeaves.length = 0;
  fake.state.leave = "ok";
  fake.createClient.mockClear();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  // Every test starts with no channels and no connections.
  vi.resetModules();
  ({ subscribeToTenantChanges } = await import("@/lib/server/dashboard-live-relay"));
});
afterEach(() => {
  vi.useRealTimers();
  warn.mockRestore();
});

describe("dashboard live relay", () => {
  it("opens one private channel per tenant on its own service-role connection and shares it across streams", () => {
    const a1 = vi.fn(); const a2 = vi.fn(); const b = vi.fn();
    const stops = [subscribeToTenantChanges("tenant-a", a1), subscribeToTenantChanges("tenant-a", a2), subscribeToTenantChanges("tenant-b", b)];
    expect(fake.createClient).toHaveBeenCalledTimes(1);
    expect(fake.createClient).toHaveBeenCalledWith("https://project.supabase.co", "service-role-key", { auth: { autoRefreshToken: false, persistSession: false } });
    const [client] = fake.state.clients;
    expect(client.channel).toHaveBeenCalledTimes(2);
    expect(client.channel).toHaveBeenCalledWith("dashboard:tenant-a", { config: { private: true } });
    expect(client.channel).toHaveBeenCalledWith("dashboard:tenant-b", { config: { private: true } });

    channelOf("tenant-a").handlers.lead_change();
    expect(a1).toHaveBeenCalledWith("change");
    expect(a2).toHaveBeenCalledWith("change");
    expect(b).not.toHaveBeenCalled(); // a tenant only ever hears its own topic

    for (const stop of stops) stop();
  });

  it("passes on an update's newest saved time only when it is a valid digit string; any other change stays plain", () => {
    const a = vi.fn();
    const stop = subscribeToTenantChanges("tenant-u", a);
    const leadChange = channelOf("tenant-u").handlers.lead_change;
    leadChange({ payload: { t: "2026-11-05T14:04:58.436425+00:00", kind: "update", newest_saved_us: "1793859911562817" } });
    expect(a).toHaveBeenLastCalledWith("change", { newestSavedUs: "1793859911562817" });
    a.mockClear();
    // A new lead or delete (no kind), the old database function, a bad value or a missing message: a plain change.
    for (const message of [{ payload: { t: "x" } }, { payload: { kind: "insert", newest_saved_us: "1" } }, { payload: { kind: "update" } },
      { payload: { kind: "update", newest_saved_us: 1793859911562817 } }, { payload: { kind: "update", newest_saved_us: "1.5" } },
      { payload: { kind: "update", newest_saved_us: "99999999999999999" } }, {}, undefined]) {
      leadChange(message);
      expect(a).toHaveBeenLastCalledWith("change");
    }
    expect(a).toHaveBeenCalledTimes(8);
    stop();
  });

  it("leaves the channel only once the last stream of that tenant has been gone for the linger time", async () => {
    const stop1 = subscribeToTenantChanges("tenant-c", vi.fn());
    const stop2 = subscribeToTenantChanges("tenant-c", vi.fn());
    const [client] = fake.state.clients;
    const first = channelOf("tenant-c");
    stop1();
    stop2();
    stop2(); // detaching twice changes nothing
    await vi.advanceTimersByTimeAsync(LINGER_MS - 1);
    expect(client.removeChannel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(client.removeChannel).toHaveBeenCalledTimes(1);
    expect(client.removeChannel).toHaveBeenCalledWith(first);
    expect(channelsPerConnection()).toEqual([0]);

    // A new stream after the leave gets a fresh channel on the same connection.
    const stop3 = subscribeToTenantChanges("tenant-c", vi.fn());
    expect(channelOf("tenant-c")).not.toBe(first);
    expect(channelOf("tenant-c").client).toBe(client);
    expect(fake.createClient).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    stop3();
  });

  it("keeps the channel for a stream that comes back within the linger time and tells it the channel is live", async () => {
    const stop1 = subscribeToTenantChanges("tenant-k", vi.fn());
    channelOf("tenant-k").status("SUBSCRIBED");
    stop1();
    await vi.advanceTimersByTimeAsync(5_000); // the browser reconnects a few seconds after a stream ends
    const back = vi.fn();
    const stop2 = subscribeToTenantChanges("tenant-k", back);
    expect(back).toHaveBeenCalledWith("live");
    await vi.advanceTimersByTimeAsync(LINGER_MS * 2);
    const [client] = fake.state.clients;
    expect(client.removeChannel).not.toHaveBeenCalled();
    expect(client.channel).toHaveBeenCalledTimes(1);
    stop2();
  });

  it("does not call a transient join error 'degraded', but does after sustained failure, and logs why once", () => {
    const listener = vi.fn();
    const stop = subscribeToTenantChanges("tenant-d", listener);
    const { status } = channelOf("tenant-d");
    status("CHANNEL_ERROR", new Error("MissingPartition")); // e.g. on the very first join
    vi.advanceTimersByTime(3_000);
    status("SUBSCRIBED");
    vi.advanceTimersByTime(20_000);
    expect(listener).not.toHaveBeenCalledWith("degraded");
    expect(listener).toHaveBeenCalledWith("live");
    expect(warn).not.toHaveBeenCalled();

    listener.mockClear();
    status("CHANNEL_ERROR", new Error("too_many_channels"));
    status("CHANNEL_ERROR", new Error("too_many_channels")); // supabase-js retries the join by itself
    vi.advanceTimersByTime(10_001);
    expect(listener).toHaveBeenCalledWith("degraded");
    expect(warnings()).toEqual([{
      operation: "dashboard_live_relay", code: "CHANNEL_DEGRADED", tenantId: "tenant-d", status: "CHANNEL_ERROR", reason: "too_many_channels",
      connections: 1, channelsOnConnection: 1,
    }]);
    stop();
  });

  it("tells streams to refetch after a gap, because leads may have arrived while it was down", () => {
    const listener = vi.fn();
    const stop = subscribeToTenantChanges("tenant-e", listener);
    const { status } = channelOf("tenant-e");
    status("SUBSCRIBED");
    listener.mockClear();
    status("CHANNEL_ERROR");
    vi.advanceTimersByTime(10_001);
    status("SUBSCRIBED");
    expect(listener.mock.calls.map(([event]) => event)).toEqual(["degraded", "live", "change"]);
    stop();
  });

  it("relays a task reminder only with well-formed ids", () => {
    const a = vi.fn();
    const stop = subscribeToTenantChanges("tenant-r", a);
    const reminder = channelOf("tenant-r").handlers.task_reminder;
    const ids = { notification_id: "11111111-1111-4111-8111-111111111111", user_id: "22222222-2222-4222-8222-222222222222" };
    reminder({ payload: ids });
    expect(a).toHaveBeenCalledWith("reminder", { notificationId: ids.notification_id, userId: ids.user_id });
    a.mockClear();
    reminder({ payload: { ...ids, user_id: "nope" } });
    reminder({ payload: { notification_id: 7 } });
    reminder(undefined);
    expect(a).not.toHaveBeenCalled();
    stop();
  });

  it("relays a timeline activity with only a well-formed lead id, to that tenant only", () => {
    const a = vi.fn(); const b = vi.fn();
    const stopA = subscribeToTenantChanges("tenant-g", a);
    const stopB = subscribeToTenantChanges("tenant-h", b);
    const activity = channelOf("tenant-g").handlers.lead_activity;
    activity({ payload: { lead_id: "11111111-1111-4111-8111-111111111111" } });
    expect(a).toHaveBeenCalledWith("activity", { leadId: "11111111-1111-4111-8111-111111111111" });
    expect(b).not.toHaveBeenCalled();
    a.mockClear();
    activity({ payload: { lead_id: "not-a-uuid" } });
    activity({ payload: { lead_id: 42 } });
    activity(undefined);
    expect(a).not.toHaveBeenCalled();
    stopA(); stopB();
  });

  it("gives a late joiner the current state and survives a throwing listener", () => {
    const first = vi.fn(() => { throw new Error("boom"); });
    const stopFirst = subscribeToTenantChanges("tenant-f", first);
    channelOf("tenant-f").status("SUBSCRIBED");
    const late = vi.fn();
    const stopLate = subscribeToTenantChanges("tenant-f", late);
    expect(late).toHaveBeenCalledWith("live");
    channelOf("tenant-f").handlers.lead_change();
    expect(late).toHaveBeenCalledWith("change");
    stopFirst(); stopLate();
  });

  it("spreads tenants over several Realtime connections, never more than 90 channels on one", async () => {
    const listeners = Array.from({ length: 200 }, () => vi.fn());
    const stops = listeners.map((listener, index) => subscribeToTenantChanges(`tenant-${index}`, listener));
    expect(fake.createClient).toHaveBeenCalledTimes(3);
    expect(channelsPerConnection()).toEqual([90, 90, 20]);
    for (let index = 0; index < 200; index += 1) {
      const holders = fake.state.clients.filter((client) => client.channels.some((channel) => channel.topic === `dashboard:tenant-${index}`));
      expect(holders).toHaveLength(1);
    }

    // Tenant 150 is on the second connection; its event reaches its own stream and nobody else's.
    expect(channelOf("tenant-150").client).toBe(fake.state.clients[1]);
    channelOf("tenant-150").status("SUBSCRIBED");
    channelOf("tenant-150").handlers.lead_change();
    expect(listeners[150]).toHaveBeenCalledWith("change");
    expect(listeners.filter((listener) => listener.mock.calls.length > 0)).toEqual([listeners[150]]);

    for (const stop of stops) stop();
    await vi.advanceTimersByTimeAsync(LINGER_MS);
    expect(channelsPerConnection()).toEqual([0, 0, 0]);
    // Each channel left through the connection it was opened on.
    for (const client of fake.state.clients) {
      for (const [channel] of client.removeChannel.mock.calls as Array<[FakeChannel]>) expect(channel.client).toBe(client);
    }
  });

  it("fills a freed slot before it opens another connection", async () => {
    const stops = Array.from({ length: 91 }, (_, index) => subscribeToTenantChanges(`tenant-${index}`, vi.fn()));
    expect(channelsPerConnection()).toEqual([90, 1]);
    stops[5]();
    await vi.advanceTimersByTimeAsync(LINGER_MS);
    expect(channelsPerConnection()).toEqual([89, 1]);
    const stopNew = subscribeToTenantChanges("tenant-new", vi.fn());
    expect(channelOf("tenant-new").client).toBe(fake.state.clients[0]);
    expect(channelsPerConnection()).toEqual([90, 1]);
    expect(fake.createClient).toHaveBeenCalledTimes(2);
    for (const stop of [...stops, stopNew]) stop();
  });

  it("never hands a tenant that comes back during the leave the channel that is still leaving", async () => {
    fake.state.leave = "hold";
    const stop1 = subscribeToTenantChanges("tenant-x", vi.fn());
    const leaving = channelOf("tenant-x");
    const [first] = fake.state.clients;
    stop1();
    await vi.advanceTimersByTimeAsync(LINGER_MS); // the leave is sent; the server has not answered yet
    expect(first.removeChannel).toHaveBeenCalledWith(leaving);

    // On the first connection supabase-js would hand back the leaving channel, which can never join again.
    const back = vi.fn();
    const stop2 = subscribeToTenantChanges("tenant-x", back);
    const fresh = channelOf("tenant-x");
    expect(fresh).not.toBe(leaving);
    expect(fresh.client).not.toBe(first);
    expect(fresh.subscribe).toHaveBeenCalledTimes(1);
    fresh.status("SUBSCRIBED");
    expect(back).toHaveBeenCalledWith("live");

    // The leave is answered: its CLOSED means nothing to anyone, and the first connection's slot is free again.
    for (const settle of fake.state.heldLeaves.splice(0)) settle("ok");
    await vi.advanceTimersByTimeAsync(10_001);
    expect(back).not.toHaveBeenCalledWith("degraded");
    expect(warn).not.toHaveBeenCalled();
    fake.state.leave = "ok";
    const stop3 = subscribeToTenantChanges("tenant-y", vi.fn());
    expect(channelOf("tenant-y").client).toBe(first);
    stop2(); stop3();
  });

  it("frees the slot of a leave that timed out, as supabase-js drops that channel, and stops the channel", async () => {
    fake.state.leave = "timed out";
    const stop1 = subscribeToTenantChanges("tenant-t", vi.fn());
    const timedOut = channelOf("tenant-t");
    stop1();
    await vi.advanceTimersByTimeAsync(LINGER_MS);
    expect(timedOut.teardown).toHaveBeenCalledTimes(1);
    expect(warnings()).toEqual([{ operation: "dashboard_live_relay", code: "CHANNEL_LEAVE_FAILED", status: "timed out" }]);
    expect(channelsPerConnection()).toEqual([0]);
    const stop2 = subscribeToTenantChanges("tenant-t", vi.fn());
    expect(channelOf("tenant-t").client).toBe(fake.state.clients[0]);
    stop2();
  });

  it("keeps the slot of a refused leave taken, since supabase-js still lists that channel, and stops the channel", async () => {
    fake.state.leave = "error";
    const stop1 = subscribeToTenantChanges("tenant-z", vi.fn());
    const refused = channelOf("tenant-z");
    stop1();
    await vi.advanceTimersByTimeAsync(LINGER_MS);
    expect(refused.teardown).toHaveBeenCalledTimes(1);
    expect(warnings()).toEqual([{ operation: "dashboard_live_relay", code: "CHANNEL_LEAVE_FAILED", status: "error" }]);
    expect(channelsPerConnection()).toEqual([1]);
    fake.state.leave = "ok";
    const stop2 = subscribeToTenantChanges("tenant-z", vi.fn());
    expect(channelOf("tenant-z")).not.toBe(refused);
    expect(channelOf("tenant-z").client).not.toBe(refused.client);
    stop2();
  });
});
