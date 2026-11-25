import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NEW_LEAD_ALERT_POLL_MS, PRESENCE_CHANNEL, PRESENCE_WAIT_MS, newLeadAlertText, useNewLeadAlerts } from "@/features/leads/use-new-lead-alerts";
import { LEADS_CHANGED_EVENT } from "@/lib/live-events";

/** A shown pop-up as the service worker registration keeps it. */
interface Shown { title: string; tag: string; body?: string; data?: unknown; closed: boolean; close: () => void }

let shown: Shown[] = [];
const registration = {
  showNotification: vi.fn(async (title: string, options: NotificationOptions) => {
    const entry: Shown = { title, tag: options.tag ?? "", body: options.body, data: options.data, closed: false, close: () => { entry.closed = true; } };
    shown.push(entry);
  }),
  getNotifications: vi.fn(async () => shown.filter((entry) => !entry.closed)),
};
let workerListeners: Array<(event: MessageEvent) => void> = [];
const serviceWorker = {
  getRegistration: vi.fn(async () => registration as unknown as ServiceWorkerRegistration),
  addEventListener: vi.fn((_type: string, listener: (event: MessageEvent) => void) => { workerListeners.push(listener); }),
  removeEventListener: vi.fn((_type: string, listener: (event: MessageEvent) => void) => { workerListeners = workerListeners.filter((item) => item !== listener); }),
};

let replies: Array<() => Response> = [];
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => (replies.shift() ?? (() => json({ count: 0, newest: null })))());
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }
const lead = (id: string, name = "Ravi", source = "Facebook") => ({ id, name, source });

/** BroadcastChannel between "tabs": a message reaches every other open channel of the same name, never the sender. */
class FakeChannel {
  static open: FakeChannel[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(public name: string) { FakeChannel.open.push(this); }
  postMessage(data: unknown) {
    for (const other of FakeChannel.open) if (other !== this && other.name === this.name) queueMicrotask(() => other.onmessage?.({ data }));
  }
  close() { FakeChannel.open = FakeChannel.open.filter((item) => item !== this); }
}
/** Another CRM tab of this browser that is on screen: it answers every question. */
function otherTabOnScreen() {
  const other = new FakeChannel(PRESENCE_CHANNEL);
  other.onmessage = ({ data }) => { const { type, id } = data as { type: string; id: string }; if (type === "ask") other.postMessage({ type: "on-screen", id }); };
  return other;
}
/** From a lead signal to a shown pop-up: the pause, the check and the wait for another tab's answer. */
const CHECK_MS = 750 + PRESENCE_WAIT_MS;

let permission: NotificationPermission = "granted";
function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
}
const insertSignal = () => act(() => { window.dispatchEvent(new Event(LEADS_CHANGED_EVENT)); });
const updateSignal = () => act(() => { window.dispatchEvent(new CustomEvent(LEADS_CHANGED_EVENT, { detail: { newestSavedUs: 1_795_578_751_014_349 } })); });
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const visible = () => shown.filter((entry) => !entry.closed);
const sentBodies = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as { hiddenForMs: number });

function mount(streamUp = true) {
  return renderHook(() => useNewLeadAlerts(() => streamUp));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(Date.parse("2026-11-25T10:00:00.000Z"));
  shown = [];
  replies = [];
  workerListeners = [];
  permission = "granted";
  fetchMock.mockClear();
  registration.showNotification.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  FakeChannel.open = [];
  vi.stubGlobal("BroadcastChannel", FakeChannel);
  vi.stubGlobal("Notification", { get permission() { return permission; } });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: serviceWorker });
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("pop-up text", () => {
  it("names one lead and its source, or counts several and names the newest", () => {
    expect(newLeadAlertText(1, lead("a"))).toEqual({ title: "New lead: Ravi", body: "Facebook" });
    expect(newLeadAlertText(3, lead("a", "Priya", "Google Ads"))).toEqual({ title: "3 new leads arrived", body: "Latest: Priya (Google Ads)" });
    expect(newLeadAlertText(140, lead("a"))).toMatchObject({ title: "99+ new leads arrived" });
  });
});

describe("new lead pop-up while the CRM tab is in the background", () => {
  it("shows one pop-up for a new lead, with its name, a tag per lead and a click to /leads", async () => {
    mount();
    setHidden(true);
    await wait(90_000);
    replies.push(() => json({ count: 1, newest: lead("lead-1") }));
    insertSignal();
    await wait(CHECK_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/leads/arrivals");
    // How long the tab has been in the background, by the tab's own clock.
    expect(sentBodies()[0].hiddenForMs).toBe(90_750);
    expect(visible()).toEqual([expect.objectContaining({ title: "New lead: Ravi", body: "Facebook", tag: "new-lead:lead-1", data: { url: "/leads" } })]);
  });

  it("sends nothing while the tab is in view: the /leads bar handles that", async () => {
    mount();
    insertSignal();
    await wait(5_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(shown).toHaveLength(0);
  });

  it("sends nothing when this browser does not allow notifications", async () => {
    permission = "default";
    mount();
    setHidden(true);
    insertSignal();
    await wait(5_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends nothing for an update (status, label, assignee): it can never add a lead", async () => {
    mount();
    setHidden(true);
    updateSignal();
    await wait(5_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turns a burst of signals into one check", async () => {
    mount();
    setHidden(true);
    replies.push(() => json({ count: 2, newest: lead("lead-2") }));
    insertSignal();
    await wait(300);
    insertSignal();
    await wait(300);
    insertSignal();
    await wait(CHECK_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(visible()).toEqual([expect.objectContaining({ title: "2 new leads arrived", tag: "new-lead:lead-2" })]);
  });

  it("shows nothing new when the count did not go up (a delete, a repeated signal)", async () => {
    mount();
    setHidden(true);
    replies.push(() => json({ count: 1, newest: lead("lead-1") }), () => json({ count: 1, newest: lead("lead-1") }));
    insertSignal();
    await wait(CHECK_MS);
    insertSignal();
    await wait(CHECK_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(registration.showNotification).toHaveBeenCalledTimes(1);
  });

  it("replaces the first pop-up with the count when a second lead arrives", async () => {
    mount();
    setHidden(true);
    replies.push(() => json({ count: 1, newest: lead("lead-1") }), () => json({ count: 2, newest: lead("lead-2", "Priya") }));
    insertSignal();
    await wait(CHECK_MS);
    insertSignal();
    await wait(CHECK_MS);
    expect(visible()).toEqual([expect.objectContaining({ title: "2 new leads arrived", body: "Latest: Priya (Facebook)", tag: "new-lead:lead-2" })]);
  });

  it("closes its pop-ups and starts over when the tab comes back into view", async () => {
    mount();
    setHidden(true);
    replies.push(() => json({ count: 1, newest: lead("lead-1") }));
    insertSignal();
    await wait(CHECK_MS);
    expect(visible()).toHaveLength(1);
    setHidden(false);
    await wait(0);
    expect(visible()).toHaveLength(0);
    // A new background spell counts from its own start: the same single lead is not announced again...
    setHidden(true);
    await wait(10_000);
    insertSignal();
    await wait(CHECK_MS);
    expect(sentBodies()[1].hiddenForMs).toBe(10_750);
    // ...unless the server says it is new for this spell (the default reply here is 0).
    expect(registration.showNotification).toHaveBeenCalledTimes(1);
  });

  it("never shows a reply that lands after the tab came back into view", async () => {
    mount();
    setHidden(true);
    let release: (() => void) | undefined;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = () => resolve(json({ count: 1, newest: lead("lead-1") })); }));
    insertSignal();
    await wait(CHECK_MS);
    setHidden(false);
    release?.();
    await wait(0);
    expect(shown).toHaveLength(0);
  });

  it("stops checking after a 401 (signed out)", async () => {
    mount();
    setHidden(true);
    replies.push(() => json({ error: "Sign in again." }, 401));
    insertSignal();
    await wait(CHECK_MS);
    insertSignal();
    await wait(CHECK_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows nothing for a failed check or an unreadable reply", async () => {
    mount();
    setHidden(true);
    replies.push(() => json({ error: "x" }, 500), () => json({ count: "1", newest: lead("lead-1") }), () => json({ count: 1, newest: { id: 1 } }));
    for (let index = 0; index < 3; index += 1) { insertSignal(); await wait(CHECK_MS); }
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(shown).toHaveLength(0);
  });

  it("checks once a minute while the live signal is down, and never while it is up", async () => {
    mount(true);
    setHidden(true);
    await wait(NEW_LEAD_ALERT_POLL_MS * 3);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to a check every minute when the live signal is down", async () => {
    mount(false);
    setHidden(true);
    replies.push(() => json({ count: 1, newest: lead("lead-1") }));
    await wait(NEW_LEAD_ALERT_POLL_MS + PRESENCE_WAIT_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(visible()).toHaveLength(1);
    await wait(NEW_LEAD_ALERT_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("works in a tab that started in the background", async () => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    mount();
    replies.push(() => json({ count: 1, newest: lead("lead-1") }));
    insertSignal();
    await wait(CHECK_MS);
    expect(visible()).toHaveLength(1);
  });

  it("uses a plain page notification when no service worker is registered, opening /leads on click", async () => {
    serviceWorker.getRegistration.mockResolvedValue(undefined as unknown as ServiceWorkerRegistration);
    const created: Array<{ title: string; options: NotificationOptions; onclick: (() => void) | null; close: () => void }> = [];
    class PageNotification {
      static get permission() { return permission; }
      onclick: (() => void) | null = null;
      close = vi.fn();
      constructor(public title: string, public options: NotificationOptions) { created.push(this); }
    }
    vi.stubGlobal("Notification", PageNotification);
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, assign } as Location);
    const focus = vi.spyOn(window, "focus").mockImplementation(() => undefined);
    mount();
    setHidden(true);
    replies.push(() => json({ count: 1, newest: lead("lead-1") }));
    insertSignal();
    await wait(CHECK_MS);
    expect(created).toEqual([expect.objectContaining({ title: "New lead: Ravi", options: expect.objectContaining({ tag: "new-lead:lead-1", body: "Facebook" }) })]);
    created[0].onclick?.();
    expect(assign).toHaveBeenCalledWith("/leads");
    expect(focus).toHaveBeenCalled();
    expect(created[0].close).toHaveBeenCalled();
    serviceWorker.getRegistration.mockResolvedValue(registration as unknown as ServiceWorkerRegistration);
  });

  it("opens the page the service worker asks for (a tab it does not control), and only a same-site path", async () => {
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, assign } as Location);
    mount();
    const send = (data: unknown) => act(() => { for (const listener of workerListeners) listener(new MessageEvent("message", { data })); });
    send({ type: "agentz:open", url: "//evil.example" });
    send({ type: "agentz:open", url: "https://evil.example" });
    send({ type: "other", url: "/leads" });
    expect(assign).not.toHaveBeenCalled();
    send({ type: "agentz:open", url: "/leads" });
    expect(assign).toHaveBeenCalledWith("/leads");
  });

  it("shows no pop-up while another CRM tab of this browser is on screen, and never announces that lead later", async () => {
    const other = otherTabOnScreen();
    mount();
    setHidden(true);
    replies.push(() => json({ count: 1, newest: lead("lead-1") }), () => json({ count: 1, newest: lead("lead-1") }));
    insertSignal();
    await wait(CHECK_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(shown).toHaveLength(0);
    // The member leaves that tab too: the lead already seen is not announced, a newer one would be.
    other.close();
    insertSignal();
    await wait(CHECK_MS);
    expect(shown).toHaveLength(0);
  });

  it("still shows the pop-up when the other open CRM tabs are in the background too", async () => {
    // A second background tab running the same hook answers nothing.
    const second = renderHook(() => useNewLeadAlerts(() => true));
    mount();
    setHidden(true);
    replies.push(() => json({ count: 1, newest: lead("lead-1") }));
    insertSignal();
    await wait(CHECK_MS);
    expect(registration.showNotification).toHaveBeenCalled();
    second.unmount();
  });

  it("answers for itself when it is on screen, so a background tab stays quiet", async () => {
    mount();
    const asker = new FakeChannel(PRESENCE_CHANNEL);
    const answers: unknown[] = [];
    asker.onmessage = ({ data }) => { answers.push(data); };
    asker.postMessage({ type: "ask", id: "q-1" });
    await wait(0);
    expect(answers).toEqual([{ type: "on-screen", id: "q-1" }]);
    setHidden(true);
    asker.postMessage({ type: "ask", id: "q-2" });
    await wait(0);
    expect(answers).toHaveLength(1);
  });

  it("removes every listener and timer on unmount", async () => {
    const view = mount(false);
    view.unmount();
    setHidden(true);
    insertSignal();
    await wait(NEW_LEAD_ALERT_POLL_MS * 2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(workerListeners).toHaveLength(0);
    expect(FakeChannel.open).toHaveLength(0);
  });
});
