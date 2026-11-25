// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** public/sw.js run as the browser runs it: a script with `self`, its event listeners and `self.clients`. */
const SOURCE = readFileSync(join(process.cwd(), "public", "sw.js"), "utf8");

interface FakeClient { url: string; focus: ReturnType<typeof vi.fn>; navigate: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> }
function client(url: string, overrides: Partial<FakeClient> = {}): FakeClient {
  const self: FakeClient = {
    url,
    focus: vi.fn(async () => self),
    navigate: vi.fn(async () => self),
    postMessage: vi.fn(),
    ...overrides,
  };
  return self;
}

let listeners: Record<string, (event: unknown) => void>;
let windows: FakeClient[];
const openWindow = vi.fn(async () => null);

function loadWorker() {
  listeners = {};
  const self = {
    addEventListener: (name: string, listener: (event: unknown) => void) => { listeners[name] = listener; },
    clients: { matchAll: vi.fn(async () => windows), openWindow },
    registration: { showNotification: vi.fn() },
  };
  new Function("self", SOURCE)(self);
  return self;
}

/** Clicks a notification and waits for everything the worker hands to waitUntil. */
async function click(tag: string, url: string) {
  const pending: Array<Promise<unknown>> = [];
  const close = vi.fn();
  listeners.notificationclick({ notification: { tag, data: { url }, close }, waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } });
  await Promise.all(pending);
  return { close };
}

beforeEach(() => {
  openWindow.mockClear();
  windows = [];
  loadWorker();
});

describe("sw.js: a click on a New lead pop-up", () => {
  it("brings an open /leads tab forward and tells it to reload its table, never reloading the page", async () => {
    const tasks = client("https://crm.agentzpro.com/tasks");
    const leads = client("https://crm.agentzpro.com/leads?lead=x");
    windows = [tasks, leads];
    const { close } = await click("new-lead:lead-1", "/leads");
    expect(close).toHaveBeenCalled();
    expect(leads.focus).toHaveBeenCalledTimes(1);
    expect(leads.postMessage).toHaveBeenCalledWith({ type: "agentz:show-new-leads" });
    expect(leads.navigate).not.toHaveBeenCalled();
    // The /tasks tab, where the member may be typing, is left alone.
    expect(tasks.focus).not.toHaveBeenCalled();
    expect(tasks.navigate).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("opens /leads in a new tab when no /leads tab is open, leaving the other CRM tabs alone", async () => {
    const tasks = client("https://crm.agentzpro.com/tasks");
    const dashboard = client("https://crm.agentzpro.com/dashboard");
    windows = [tasks, dashboard];
    await click("new-lead:lead-1", "/leads");
    expect(openWindow).toHaveBeenCalledWith("/leads");
    for (const other of [tasks, dashboard]) {
      expect(other.navigate).not.toHaveBeenCalled();
      expect(other.focus).not.toHaveBeenCalled();
    }
  });

  it("opens /leads in a new tab when the /leads tab cannot be brought forward", async () => {
    const leads = client("https://crm.agentzpro.com/leads", { focus: vi.fn(async () => { throw new Error("not allowed"); }) });
    windows = [leads];
    await click("new-lead:lead-1", "/leads");
    expect(openWindow).toHaveBeenCalledWith("/leads");
    expect(leads.navigate).not.toHaveBeenCalled();
  });

  it("opens /leads in a new tab when no CRM tab is open at all", async () => {
    await click("new-lead:lead-1", "/leads");
    expect(openWindow).toHaveBeenCalledWith("/leads");
  });
});

describe("sw.js: a click on a task reminder (unchanged)", () => {
  it("brings the first CRM tab forward and opens the reminder's page in it", async () => {
    const tasks = client("https://crm.agentzpro.com/tasks");
    windows = [tasks];
    await click("notification-1", "/tasks");
    expect(tasks.focus).toHaveBeenCalled();
    expect(tasks.navigate).toHaveBeenCalledWith("/tasks");
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("asks a tab the worker does not control to open the page itself", async () => {
    const tasks = client("https://crm.agentzpro.com/tasks", { navigate: vi.fn(async () => { throw new TypeError("not controlled"); }) });
    windows = [tasks];
    await click("notification-1", "/tasks");
    expect(tasks.postMessage).toHaveBeenCalledWith({ type: "agentz:open", url: "/tasks" });
  });

  it("opens the page in a new tab when no CRM tab is open", async () => {
    await click("notification-1", "/tasks");
    expect(openWindow).toHaveBeenCalledWith("/tasks");
  });
});
