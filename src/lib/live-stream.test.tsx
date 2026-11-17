import { act, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskAlertsProvider } from "@/components/task-bell";
import { useDashboardStats } from "@/features/dashboard/use-dashboard-live";
import { useLeadTimeline } from "@/features/leads/use-lead-timeline";
import { useNewLeadsCount } from "@/features/leads/use-new-leads-count";
import { openLiveStream, type LiveStream } from "@/lib/live-stream";

class FakeEventSource {
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 1;
  onerror: ((event: Event) => void) | null = null;
  private listeners = new Map<string, Array<(event: { data: string }) => void>>();
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  addEventListener(type: string, callback: (event: { data: string }) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]); }
  emit(type: string, data: unknown = {}) { for (const callback of this.listeners.get(type) ?? []) callback({ data: JSON.stringify(data) }); }
  fail() { this.onerror?.(new Event("error")); }
  close() { this.readyState = FakeEventSource.CLOSED; }
}

const open: LiveStream[] = [];
/** Joins the shared stream and records what this handle receives. */
function join(...names: string[]) {
  const handle = openLiveStream();
  open.push(handle);
  const received: string[] = [];
  for (const name of names) handle.addEventListener(name, (event) => received.push(`${name}:${event.data}`));
  handle.onerror = () => received.push("error");
  return { handle, received };
}
const flushMicrotasks = () => act(async () => { await Promise.resolve(); });
const latest = () => FakeEventSource.instances[FakeEventSource.instances.length - 1];

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  // Close every handle a test left open, so the next test starts with no shared connection.
  for (const handle of open.splice(0)) handle.close();
  vi.unstubAllGlobals();
});

describe("openLiveStream", () => {
  it("opens one real connection to the stream route however many handles join", () => {
    join("change");
    join("change");
    join("activity");
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe("/api/dashboard/stream");
  });

  it("delivers each event to every handle listening for it, and errors to every handle", () => {
    const a = join("change");
    const b = join("change", "activity");
    latest().emit("change", { kind: "update" });
    latest().emit("activity", { leadId: "lead-1" });
    latest().fail();
    expect(a.received).toEqual(['change:{"kind":"update"}', "error"]);
    expect(b.received).toEqual(['change:{"kind":"update"}', 'activity:{"leadId":"lead-1"}', "error"]);
  });

  it("replays this connection's ready and latest status to a late joiner, in the order they arrived", async () => {
    join("change");
    latest().emit("status", { state: "degraded" });
    latest().emit("ready", { tenantId: "tenant-a" });
    latest().emit("status", { state: "live" });
    const late = join("ready", "status");
    expect(late.received).toEqual([]);
    await flushMicrotasks();
    expect(late.received).toEqual(['ready:{"tenantId":"tenant-a"}', 'status:{"state":"live"}']);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("replays nothing from before a connection error: the reconnect sends its own ready", async () => {
    join("change");
    latest().emit("ready", { tenantId: "tenant-a" });
    latest().fail();
    const late = join("ready");
    await flushMicrotasks();
    expect(late.received).toEqual([]);
    latest().emit("ready", { tenantId: "tenant-a" });
    expect(late.received).toEqual(['ready:{"tenantId":"tenant-a"}']);
  });

  it("keeps the connection while any handle is open and closes it with the last one", () => {
    const a = join("change");
    const b = join("change");
    a.handle.close();
    a.handle.close();
    expect(latest().readyState).toBe(1);
    latest().emit("change");
    expect(a.received).toEqual([]);
    expect(b.received).toEqual(["change:{}"]);
    b.handle.close();
    expect(latest().readyState).toBe(FakeEventSource.CLOSED);
    expect(b.handle.readyState).toBe(FakeEventSource.CLOSED);
  });

  it("opens a new connection once the browser gave up, and the handles still attached receive it", () => {
    const survivor = join("change");
    const first = latest();
    first.readyState = FakeEventSource.CLOSED;
    first.fail();
    expect(survivor.handle.readyState).toBe(FakeEventSource.CLOSED);
    join("change");
    expect(FakeEventSource.instances).toHaveLength(2);
    latest().emit("change");
    expect(survivor.received).toEqual(["error", "change:{}"]);
    first.emit("change");
    expect(survivor.received).toEqual(["error", "change:{}"]);
  });

  it("keeps delivering to the other handles when one listener throws", () => {
    const reported = vi.fn();
    vi.stubGlobal("reportError", reported);
    const broken = openLiveStream();
    open.push(broken);
    broken.addEventListener("change", () => { throw new Error("broken page handler"); });
    const healthy = join("change");
    latest().emit("change");
    expect(healthy.received).toEqual(["change:{}"]);
    expect(reported).toHaveBeenCalledTimes(1);
  });
});

describe("the shell and the dashboard together", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(
      url === "/api/notifications" ? { items: [], unread: 0 } : { tenantId: "tenant-a", timezone: "Asia/Kolkata" },
    ), { status: 200, headers: { "content-type": "application/json" } })));
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
  });

  it("hold one live connection between them, and both still get its events", async () => {
    const wrapper = ({ children }: { children: ReactNode }) => <TaskAlertsProvider>{children}</TaskAlertsProvider>;
    const { result, unmount } = renderHook(() => useDashboardStats({ platform: "facebook" }), { wrapper });
    expect(FakeEventSource.instances).toHaveLength(1);
    act(() => latest().emit("ready", { tenantId: "tenant-a" }));
    expect(result.current.liveState).toBe("live");
    unmount();
    expect(latest().readyState).toBe(FakeEventSource.CLOSED);
  });
});

/** Sends a raw string, as a broken or unexpected server reply would arrive. */
function emitRaw(connection: FakeEventSource, type: string, data: string) {
  const listeners = (connection as unknown as { listeners: Map<string, Array<(event: { data: string }) => void>> }).listeners;
  for (const callback of listeners.get(type) ?? []) callback({ data });
}

describe("handover when the server says rollover", () => {
  const CLOSED = FakeEventSource.CLOSED;
  const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  /** A connection that said ready and then live, as the stream route does. */
  function goLive(connection: FakeEventSource, tenantId = "tenant-a") {
    connection.emit("ready", { tenantId });
    connection.emit("status", { state: "live" });
  }
  /** One handle on a live connection, with what it received so far cleared. */
  function liveHandle() {
    const watcher = join("ready", "status", "change");
    goLive(latest());
    watcher.received.length = 0;
    return watcher;
  }

  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }); });
  afterEach(() => { vi.useRealTimers(); });

  it("switches to the next connection once it is live: its ready and status arrive, no error, no lost signal", async () => {
    const watcher = liveHandle();
    const first = latest();
    first.emit("rollover");
    expect(FakeEventSource.instances).toHaveLength(2);
    const second = latest();
    expect(second.url).toBe("/api/dashboard/stream");
    // Until the next one is live the old one still carries everything; the next one's own events wait.
    first.emit("change", { n: 1 });
    second.emit("ready", { tenantId: "tenant-a" });
    expect(watcher.received).toEqual(['change:{"n":1}']);
    second.emit("status", { state: "live" });
    expect(watcher.received).toEqual(['change:{"n":1}', 'ready:{"tenantId":"tenant-a"}', 'status:{"state":"live"}']);
    // For a moment the old one still delivers signals (a duplicate is fine), never its connection state.
    first.emit("change", { n: 2 });
    first.emit("status", { state: "degraded" });
    second.emit("change", { n: 3 });
    expect(watcher.received.slice(3)).toEqual(['change:{"n":2}', 'change:{"n":3}']);
    expect(first.readyState).toBe(1);
    await wait(2_000);
    expect(first.readyState).toBe(CLOSED);
    first.emit("change", { n: 4 });
    second.emit("change", { n: 5 });
    expect(watcher.received.slice(5)).toEqual(['change:{"n":5}']);
    expect(watcher.received).not.toContain("error");
    expect(watcher.handle.readyState).toBe(1);
  });

  it("replays the new connection's ready and status to a handle that joins after the switch", async () => {
    liveHandle();
    latest().emit("rollover");
    goLive(latest(), "tenant-a");
    const late = join("ready", "status");
    await flushMicrotasks();
    expect(late.received).toEqual(['ready:{"tenantId":"tenant-a"}', 'status:{"state":"live"}']);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("keeps the old path when the connection is not live: no next connection opens", () => {
    const watcher = join("change");
    latest().emit("ready", { tenantId: "tenant-a" });
    latest().emit("rollover");
    latest().emit("status", { state: "degraded" });
    latest().emit("rollover");
    expect(FakeEventSource.instances).toHaveLength(1);
    latest().fail();
    expect(watcher.received).toEqual(["error"]);
  });

  it.each([
    { name: "an error", happen: (next: FakeEventSource) => next.fail() },
    { name: "a refusal (401/429) the browser gives up on", happen: (next: FakeEventSource) => { next.readyState = CLOSED; next.fail(); } },
    { name: "degraded", happen: (next: FakeEventSource) => { next.emit("ready", { tenantId: "tenant-a" }); next.emit("status", { state: "degraded" }); } },
    { name: "live without ready", happen: (next: FakeEventSource) => next.emit("status", { state: "live" }) },
    { name: "an unreadable status", happen: (next: FakeEventSource) => { next.emit("ready", { tenantId: "tenant-a" }); emitRaw(next, "status", "not json"); } },
  ])("drops the next connection without telling any handle on $name, and the old one goes on as before", ({ happen }) => {
    const watcher = liveHandle();
    const first = latest();
    first.emit("rollover");
    const second = latest();
    happen(second);
    expect(second.readyState).toBe(CLOSED);
    expect(watcher.received).toEqual([]);
    first.emit("change");
    second.emit("change");
    expect(watcher.received).toEqual(["change:{}"]);
    // The old one then ends as it always did: the handles hear about it and reconnect their own way.
    first.fail();
    expect(watcher.received).toEqual(["change:{}", "error"]);
  });

  it("drops the next connection when the current one stops being live before the switch, so the old path catches up", () => {
    const watcher = liveHandle();
    const first = latest();
    first.emit("rollover");
    const second = latest();
    // The current connection's live link breaks while the next one is still connecting: a signal may be missed now.
    first.emit("status", { state: "degraded" });
    goLive(second);
    expect(second.readyState).toBe(CLOSED);
    expect(watcher.received).toEqual(['status:{"state":"degraded"}']);
    // The old one then ends as always, and the pages get the error that makes them catch up.
    first.fail();
    expect(watcher.received).toEqual(['status:{"state":"degraded"}', "error"]);
  });

  it("drops the next connection when the old one ends first, and the handles hear the old one's error once", () => {
    const watcher = liveHandle();
    const first = latest();
    first.emit("rollover");
    const second = latest();
    first.fail();
    expect(second.readyState).toBe(CLOSED);
    goLive(second);
    expect(watcher.received).toEqual(["error"]);
    // The browser reconnected the old one by itself: its own ready and status arrive as before.
    goLive(first);
    expect(watcher.received).toEqual(["error", 'ready:{"tenantId":"tenant-a"}', 'status:{"state":"live"}']);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("drops a next connection that is not live within 15 s", async () => {
    const watcher = liveHandle();
    latest().emit("rollover");
    const second = latest();
    second.emit("ready", { tenantId: "tenant-a" });
    await wait(14_999);
    expect(second.readyState).toBe(1);
    await wait(1);
    expect(second.readyState).toBe(CLOSED);
    second.emit("status", { state: "live" });
    expect(watcher.received).toEqual([]);
  });

  it("opens one next connection however often rollover repeats", () => {
    liveHandle();
    latest().emit("rollover");
    FakeEventSource.instances[0].emit("rollover");
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("closes the old connection at once if it ends during the overlap, before the browser reconnects it", () => {
    const watcher = liveHandle();
    const first = latest();
    first.emit("rollover");
    goLive(latest());
    watcher.received.length = 0;
    first.fail();
    expect(first.readyState).toBe(CLOSED);
    expect(watcher.received).toEqual([]);
  });

  it("closes every connection when the last handle closes during a handover or its overlap", () => {
    const watcher = liveHandle();
    const first = latest();
    first.emit("rollover");
    const second = latest();
    watcher.handle.close();
    expect([first.readyState, second.readyState]).toEqual([CLOSED, CLOSED]);

    const again = liveHandle();
    const third = latest();
    third.emit("rollover");
    const fourth = latest();
    goLive(fourth);
    again.handle.close();
    expect([third.readyState, fourth.readyState]).toEqual([CLOSED, CLOSED]);
  });

  it("hands over again at the next rollover, from the connection that took over", async () => {
    const watcher = liveHandle();
    latest().emit("rollover");
    goLive(latest());
    await wait(2_000);
    latest().emit("rollover");
    expect(FakeEventSource.instances).toHaveLength(3);
    goLive(latest());
    await wait(2_000);
    expect(FakeEventSource.instances.map((connection) => connection.readyState)).toEqual([CLOSED, CLOSED, 1]);
    expect(watcher.received.filter((entry) => entry === "error")).toEqual([]);
  });
});

describe("a stream restart on a full page (shell, dashboard, new-leads bar, open lead timeline)", () => {
  const CLOSED = FakeEventSource.CLOSED;
  const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  let notifications: unknown[] = [];
  let fetchMock: ReturnType<typeof vi.fn>;
  const calls = (prefix: string) => fetchMock.mock.calls.filter((call) => String(call[0]).startsWith(prefix)).length;
  const snapshot = { body: { quickFilter: "all", pageSize: 100 }, cursor: "2026-11-16T05:00:00.000000+00:00" };
  function goLive(connection: FakeEventSource) {
    act(() => { connection.emit("ready", { tenantId: "tenant-a" }); connection.emit("status", { state: "live" }); });
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    // Mid-day in Asia/Kolkata, so the dashboard's midnight refresh is hours away.
    vi.setSystemTime(new Date("2026-11-16T06:00:00.000Z"));
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    notifications = [];
    fetchMock = vi.fn(async (url: string) => {
      const body = url === "/api/notifications" ? { items: notifications, unread: notifications.length }
        : url === "/api/leads/new-count" ? { count: 0 }
          : url.startsWith("/api/leads/") ? { items: [], nextCursor: null }
            : { tenantId: "tenant-a", timezone: "Asia/Kolkata" };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.useRealTimers(); });

  async function openPage() {
    const wrapper = ({ children }: { children: ReactNode }) => <TaskAlertsProvider>{children}</TaskAlertsProvider>;
    const page = renderHook(() => ({
      dashboard: useDashboardStats({ platform: "facebook" }),
      newLeads: useNewLeadsCount(snapshot),
      timeline: useLeadTimeline("lead-1", "all"),
    }), { wrapper });
    await wait(0);
    expect(FakeEventSource.instances).toHaveLength(1);
    goLive(latest());
    await wait(1_000);
    fetchMock.mockClear();
    return page;
  }

  it("makes no catch-up request and reports no drop when the server hands over", async () => {
    const page = await openPage();
    const first = latest();
    act(() => first.emit("rollover"));
    goLive(latest());
    await wait(2_000);
    expect(first.readyState).toBe(CLOSED);
    // A minute later: no catch-up, and no "stream down" fallback check from the new-leads bar either.
    await wait(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(page.result.current.dashboard.liveState).toBe("live");
    // Lead signals keep arriving on the connection that took over.
    act(() => latest().emit("change", {}));
    act(() => latest().emit("activity", { leadId: "lead-1" }));
    await wait(1_000);
    expect([calls("/api/dashboard/stats"), calls("/api/leads/new-count"), calls("/api/leads/lead-1/activities")]).toEqual([1, 1, 1]);
    page.unmount();
  });

  it("catches up as before when the live link breaks during a handover", async () => {
    const page = await openPage();
    const first = latest();
    act(() => first.emit("rollover"));
    const second = latest();
    act(() => first.emit("status", { state: "degraded" }));
    goLive(second);
    expect(second.readyState).toBe(CLOSED);
    act(() => first.fail());
    goLive(first);
    await wait(1_000);
    expect([calls("/api/dashboard/stats"), calls("/api/leads/new-count"), calls("/api/leads/lead-1/activities")]).toEqual([1, 1, 1]);
    page.unmount();
  });

  it("still catches up after a restart without the hint (an older server), exactly as before", async () => {
    const page = await openPage();
    const first = latest();
    act(() => first.fail());
    goLive(first);
    await wait(1_000);
    expect([calls("/api/dashboard/stats"), calls("/api/leads/new-count"), calls("/api/leads/lead-1/activities")]).toEqual([1, 1, 1]);
    expect(FakeEventSource.instances).toHaveLength(1);
    page.unmount();
  });

  it("shows a reminder card that arrives on the connection that took over", async () => {
    const view = render(<TaskAlertsProvider><div /></TaskAlertsProvider>);
    await wait(0);
    goLive(latest());
    act(() => latest().emit("rollover"));
    goLive(latest());
    await wait(2_000);
    notifications = [{ id: "n-1", kind: "due_soon", dueAt: "2026-11-16T06:15:00.000Z", createdAt: "2026-11-16T06:00:00.000Z", read: false, leadId: "lead-1", taskTitle: "Call Back", leadName: "Ravi" }];
    act(() => latest().emit("task_reminder", { notificationId: "n-1" }));
    await wait(0);
    expect(screen.getAllByRole("group", { name: "Task reminder" })).toHaveLength(1);
    expect(screen.getByText("Follow up with Ravi in 15 min")).toBeTruthy();
    view.unmount();
  });
});
