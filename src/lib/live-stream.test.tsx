import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskAlertsProvider } from "@/components/task-bell";
import { useDashboardStats } from "@/features/dashboard/use-dashboard-live";
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
