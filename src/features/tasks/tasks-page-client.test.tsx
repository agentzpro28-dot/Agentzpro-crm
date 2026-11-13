import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TASKS_CHANGED_EVENT } from "@/components/task-bell";
import { TasksPageClient } from "@/features/tasks/tasks-page-client";

// Only the list's refresh timing is under test here: the bell and the drawer are separate components.
vi.mock("@/components/task-bell", async (importOriginal) => ({ ...await importOriginal<typeof import("@/components/task-bell")>(), TaskBell: () => null }));
vi.mock("@/features/leads/lead-drawer", () => ({ LeadDrawer: () => null }));

const overview = () => new Response(JSON.stringify({
  items: [], counts: { overdue: 0, today: 0, upcoming: 0, done: 0, doneOnTime: 0 },
  timezone: "Asia/Kolkata", isOwner: true, members: [], page: 1, pageSize: 50,
}), { status: 200, headers: { "content-type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
const taskLoads = () => fetchMock.mock.calls.filter((call) => String(call[0]).startsWith("/api/tasks?")).length;
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const tasksChanged = () => act(() => { window.dispatchEvent(new Event(TASKS_CHANGED_EVENT)); });
const setHidden = (hidden: boolean) => act(() => {
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
  document.dispatchEvent(new Event("visibilitychange"));
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  fetchMock = vi.fn(async () => overview());
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});

describe("TasksPageClient refresh", () => {
  it("loads once on open, then again 30 s after that load while the tab is visible", async () => {
    render(<TasksPageClient />);
    await wait(0);
    expect(taskLoads()).toBe(1);
    await wait(29_000);
    expect(taskLoads()).toBe(1);
    await wait(1_000);
    expect(taskLoads()).toBe(2);
  });

  it("never polls while the tab is hidden", async () => {
    render(<TasksPageClient />);
    await wait(0);
    setHidden(true);
    await wait(120_000);
    expect(taskLoads()).toBe(1);
  });

  it("loads exactly once when the tab comes back (on the shell's signal), then resumes the 30 s refresh", async () => {
    render(<TasksPageClient />);
    await wait(0);
    setHidden(true);
    await wait(60_000);
    // The shell's live-stream provider sends TASKS_CHANGED_EVENT right after the tab becomes visible again.
    setHidden(false);
    tasksChanged();
    await wait(0);
    expect(taskLoads()).toBe(2);
    await wait(29_000);
    expect(taskLoads()).toBe(2);
    await wait(1_000);
    expect(taskLoads()).toBe(3);
  });

  it("still resumes polling after the tab comes back even if no signal arrives", async () => {
    render(<TasksPageClient />);
    await wait(0);
    setHidden(true);
    await wait(60_000);
    setHidden(false);
    await wait(30_000);
    expect(taskLoads()).toBe(2);
  });

  it("refetches at once on a live signal, and counts the next refresh from that load", async () => {
    render(<TasksPageClient />);
    await wait(0);
    await wait(20_000);
    tasksChanged();
    await wait(0);
    expect(taskLoads()).toBe(2);
    // 30 s after the first load would be now; the signal's load moved the refresh to 30 s after it instead.
    await wait(10_000);
    expect(taskLoads()).toBe(2);
    await wait(20_000);
    expect(taskLoads()).toBe(3);
  });

  it("answers a burst of signals with one load at once and one more at the end of the cooldown", async () => {
    render(<TasksPageClient />);
    await wait(0);
    tasksChanged(); tasksChanged(); tasksChanged();
    await wait(0);
    expect(taskLoads()).toBe(2);
    await wait(750);
    expect(taskLoads()).toBe(3);
    await wait(5_000);
    expect(taskLoads()).toBe(3);
  });

  it("stops every timer and listener once the page is closed", async () => {
    const { unmount } = render(<TasksPageClient />);
    await wait(0);
    unmount();
    tasksChanged();
    await wait(120_000);
    expect(taskLoads()).toBe(1);
  });
});

describe("TasksPageClient member list", () => {
  const owner = (members: unknown) => new Response(JSON.stringify({
    items: [], counts: { overdue: 0, today: 0, upcoming: 0, done: 0, doneOnTime: 0 },
    timezone: "Asia/Kolkata", isOwner: true, members, page: 1, pageSize: 50,
  }), { status: 200, headers: { "content-type": "application/json" } });
  const taskUrls = () => fetchMock.mock.calls.map((call) => String(call[0])).filter((url) => url.startsWith("/api/tasks?"));

  it("reads it on open and when the tab comes back, skips it on refreshes, and keeps showing it", async () => {
    fetchMock.mockImplementation(async (url: string) => owner(url.includes("members=0") ? null : [{ userId: "emp-1", fullName: "Asha" }]));
    const { getByRole } = render(<TasksPageClient />);
    await wait(0);
    expect(taskUrls()[0]).not.toContain("members=0");
    await wait(30_000);
    expect(taskUrls()[1]).toContain("members=0");
    tasksChanged();
    await wait(0);
    expect(taskUrls()[2]).toContain("members=0");
    expect(getByRole("option", { name: "Asha" })).toBeInTheDocument();
    await wait(1_000);
    setHidden(true);
    setHidden(false);
    tasksChanged();
    await wait(0);
    expect(taskUrls()[3]).not.toContain("members=0");
  });
});
