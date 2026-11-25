"use client";

import { useEffect } from "react";
import { timestampToMicros } from "@/lib/lead-change-signal";
import { LEADS_CHANGED_EVENT, SHOW_NEW_LEADS_EVENT } from "@/lib/live-events";

/** Same pause as the /leads bar: several lead writes in a burst become one check. */
const CHANGE_DEBOUNCE_MS = 750;
/** Fallback while the tab is in the background and the live signal is down. */
export const NEW_LEAD_ALERT_POLL_MS = 60_000;
/** The route accepts at most one day (its own limit); a longer hidden time is sent as one day. */
const MAX_HIDDEN_FOR_MS = 24 * 60 * 60 * 1000;
/** Every pop-up this hook shows has a tag starting with this, so they can be found and closed again. */
export const NEW_LEAD_TAG_PREFIX = "new-lead:";
/** Where a click on the pop-up goes: /leads, where the new lead is on top. */
const NEW_LEAD_URL = "/leads";
/** The message sw.js sends when it cannot open the page itself (a tab it does not control). */
export const SW_OPEN_MESSAGE = "agentz:open";
/** The message sw.js sends to the /leads tab it brought forward for a click on a "New lead" pop-up. */
export const SW_SHOW_NEW_LEADS_MESSAGE = "agentz:show-new-leads";
/** Only a /leads tab on screen keeps the pop-up away: it shows the new-leads bar. Other CRM pages show no new lead. */
const LEADS_PATH = "/leads";
/** CRM tabs of this browser ask each other here whether one of them is on screen. */
export const PRESENCE_CHANNEL = "agentz:crm-presence";
/** How long a background tab waits for another CRM tab to say it is on screen (a hidden tab's timers run late anyway). */
export const PRESENCE_WAIT_MS = 400;

interface Arrivals { count: number; newest: { id: string; name: string; source: string; savedUs: number } | null }

/** The pop-up's text: "New lead: Ravi" / "Facebook" for one lead, "3 new leads arrived" / "Latest: Ravi (Facebook)". */
export function newLeadAlertText(count: number, newest: { name: string; source: string }): { title: string; body: string } {
  return count === 1
    ? { title: `New lead: ${newest.name}`, body: newest.source }
    : { title: `${count > 99 ? "99+" : count} new leads arrived`, body: `Latest: ${newest.name} (${newest.source})` };
}

function readArrivals(value: unknown): Arrivals | null {
  const { count, newest } = (value && typeof value === "object" ? value : {}) as { count?: unknown; newest?: unknown };
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return null;
  if (newest === null) return { count, newest: null };
  const { id, name, source, savedAt } = (newest && typeof newest === "object" ? newest : {}) as { id?: unknown; name?: unknown; source?: unknown; savedAt?: unknown };
  const savedUs = typeof savedAt === "string" ? timestampToMicros(savedAt) : null;
  return typeof id === "string" && typeof name === "string" && typeof source === "string" && savedUs !== null ? { count, newest: { id, name, source, savedUs } } : null;
}

function notificationsAllowed(): boolean {
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

async function serviceWorkerRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  try {
    return typeof navigator !== "undefined" && "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The "New lead" pop-up for a CRM tab that is open but in the background (another tab, Chrome minimised or covered).
 * Mounted once in the shell, so it works on every CRM page; the /leads bar stays as it is for a tab in view.
 *
 * - Acts only while the tab is hidden and this browser allows notifications. A lead signal (new lead, delete, the
 *   stream live again) is followed after a short pause by one check: how many of the company's leads were saved since
 *   the tab went into the background, and the newest one. An update (status, label, assignee) can never add a lead and
 *   sends nothing. While the live signal is down, a check runs once a minute instead.
 * - A pop-up appears only for a lead saved after the last lead announced in this background spell (exact database
 *   save times, not counts): a repeated signal or a delete shows nothing, and a delete never hides the next new lead. Its tag is the newest lead's id, so several background CRM tabs show one pop-up, not one each. A click opens
 *   /leads (sw.js); for a tab the worker does not control, sw.js asks the tab to open it (the message below).
 * - Not while the member is looking at /leads: if a /leads tab of this browser is on screen (it answers on a
 *   BroadcastChannel), no pop-up is shown, since its bar already says so. A member on /tasks, /dashboard or any other
 *   page gets the pop-up, because those pages show no new lead.
 * - A click never reloads a tab the member may be typing in: an open /leads tab is brought forward and its table
 *   reloads with the new leads on top (like the bar's Show); with no /leads tab, /leads opens in a new tab (sw.js).
 * - When the tab comes back into view, the count starts over and this tab's lead pop-ups close: the bar takes over.
 * - Best effort: a failed check shows nothing; a signed-out session (401) stops checking until the next page load.
 *   Background checks never renew the idle-logout clock.
 */
export function useNewLeadAlerts(isStreamUp: () => boolean): void {
  useEffect(() => {
    let hiddenAt: number | null = document.hidden ? Date.now() : null;
    // Changes every time the tab is hidden or shown, so a reply for an earlier background spell is never shown.
    let spell = 0;
    // Save time (µs) of the newest lead announced since the tab went into the background; 0 = none yet.
    let lastAnnouncedUs = 0;
    let stopped = false;
    let disposed = false;
    let inFlight = false;
    let queued = false;
    let controller: AbortController | null = null;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    // Pop-ups shown without the service worker (it was never registered here); closed on return like the others.
    let pageNotifications: Notification[] = [];
    // Presence between this browser's CRM tabs: a tab on screen answers a background tab's question.
    const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(PRESENCE_CHANNEL) : null;
    const waiting = new Map<string, () => void>();
    if (channel) {
      channel.onmessage = (event: MessageEvent<unknown>) => {
        const { type, id } = (event.data && typeof event.data === "object" ? event.data : {}) as { type?: unknown; id?: unknown };
        if (typeof id !== "string") return;
        if (type === "ask" && !document.hidden && window.location.pathname === LEADS_PATH) channel.postMessage({ type: "on-screen", id });
        if (type === "on-screen") waiting.get(id)?.();
      };
    }
    const anotherTabOnScreen = (): Promise<boolean> => {
      if (!channel) return Promise.resolve(false);
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => { waiting.delete(id); resolve(false); }, PRESENCE_WAIT_MS);
        waiting.set(id, () => { clearTimeout(timer); waiting.delete(id); resolve(true); });
        channel.postMessage({ type: "ask", id });
      });
    };

    const canAlert = () => !disposed && !stopped && hiddenAt !== null && document.hidden && notificationsAllowed();

    const closeLeadNotifications = async () => {
      for (const notification of pageNotifications) notification.close();
      pageNotifications = [];
      const registration = await serviceWorkerRegistration();
      if (!registration) return;
      try {
        for (const notification of await registration.getNotifications()) {
          if (notification.tag.startsWith(NEW_LEAD_TAG_PREFIX)) notification.close();
        }
      } catch {
        // Nothing to close.
      }
    };

    const show = async (count: number, newest: NonNullable<Arrivals["newest"]>) => {
      const { title, body } = newLeadAlertText(count, newest);
      const tag = `${NEW_LEAD_TAG_PREFIX}${newest.id}`;
      // The earlier pop-up of this spell ("New lead: Ravi") gives way to the newer one ("2 new leads arrived").
      await closeLeadNotifications();
      const registration = await serviceWorkerRegistration();
      if (registration) {
        await registration.showNotification(title, { body, tag, icon: "/logo-icon.png", requireInteraction: true, data: { url: NEW_LEAD_URL } });
        return;
      }
      const notification = new Notification(title, { body, tag, icon: "/logo-icon.png", requireInteraction: true });
      // Same rule as sw.js: never reload a page the member may be typing in.
      notification.onclick = () => {
        notification.close();
        if (window.location.pathname === LEADS_PATH) {
          window.focus();
          window.dispatchEvent(new Event(SHOW_NEW_LEADS_EVENT));
          return;
        }
        window.open(NEW_LEAD_URL, "_blank");
      };
      pageNotifications.push(notification);
    };

    const check = async (): Promise<void> => {
      if (!canAlert() || hiddenAt === null) return;
      if (inFlight) { queued = true; return; }
      inFlight = true;
      const mySpell = spell;
      controller = new AbortController();
      try {
        const hiddenForMs = Math.min(MAX_HIDDEN_FOR_MS, Math.max(0, Date.now() - hiddenAt));
        const response = await fetch("/api/leads/arrivals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hiddenForMs }), signal: controller.signal });
        if (response.status === 401) { stopped = true; return; }
        if (!response.ok) return;
        const arrivals = readArrivals(await response.json());
        if (!arrivals || !arrivals.newest || mySpell !== spell || !canAlert() || arrivals.newest.savedUs <= lastAnnouncedUs) return;
        // Marked either way, so a lead seen in another CRM tab is never announced later.
        lastAnnouncedUs = arrivals.newest.savedUs;
        if (await anotherTabOnScreen()) return;
        if (mySpell !== spell || !canAlert()) return;
        await show(arrivals.count, arrivals.newest);
      } catch {
        // Best effort: a failed or aborted check shows nothing.
      } finally {
        inFlight = false;
        controller = null;
        if (queued && !disposed) { queued = false; void check(); }
      }
    };

    const schedule = () => { clearTimeout(debounce); debounce = setTimeout(() => void check(), CHANGE_DEBOUNCE_MS); };
    const onLeadsChanged = (event: Event) => {
      if (!canAlert()) return;
      // An update carries when its newest changed lead was saved; it never adds a lead, so it needs no check.
      const detail = (event as CustomEvent<unknown>).detail as { newestSavedUs?: unknown } | null | undefined;
      if (detail && typeof detail.newestSavedUs === "number") return;
      schedule();
    };
    const onVisibility = () => {
      spell += 1;
      lastAnnouncedUs = 0;
      clearTimeout(debounce);
      controller?.abort();
      queued = false;
      if (document.hidden) { hiddenAt = Date.now(); return; }
      hiddenAt = null;
      void closeLeadNotifications();
    };
    // sw.js brought this /leads tab forward for a "New lead" click: the page reloads its table (SHOW_NEW_LEADS_EVENT).
    // Or, for a task reminder, it could not open the page in a tab it does not control: the tab opens it itself.
    const onWorkerMessage = (event: MessageEvent<unknown>) => {
      const { type, url } = (event.data && typeof event.data === "object" ? event.data : {}) as { type?: unknown; url?: unknown };
      if (type === SW_SHOW_NEW_LEADS_MESSAGE) { window.dispatchEvent(new Event(SHOW_NEW_LEADS_EVENT)); return; }
      if (type !== SW_OPEN_MESSAGE || typeof url !== "string" || !url.startsWith("/") || url.startsWith("//")) return;
      // A full load on purpose, as for the click above: the page must load fresh to show the new lead.
      window.location.assign(url);
    };

    window.addEventListener(LEADS_CHANGED_EVENT, onLeadsChanged);
    document.addEventListener("visibilitychange", onVisibility);
    // Only where the browser really offers service-worker messages; anything less must never break the shell.
    const container = typeof navigator !== "undefined" && "serviceWorker" in navigator ? navigator.serviceWorker : null;
    const worker = container && typeof container.addEventListener === "function" && typeof container.removeEventListener === "function" ? container : null;
    worker?.addEventListener("message", onWorkerMessage);
    // Asked at each tick, so the fallback starts and stops with the stream.
    const poll = setInterval(() => { if (canAlert() && !isStreamUp()) void check(); }, NEW_LEAD_ALERT_POLL_MS);
    return () => {
      disposed = true;
      window.removeEventListener(LEADS_CHANGED_EVENT, onLeadsChanged);
      document.removeEventListener("visibilitychange", onVisibility);
      worker?.removeEventListener("message", onWorkerMessage);
      clearInterval(poll);
      clearTimeout(debounce);
      controller?.abort();
      channel?.close();
    };
  }, [isStreamUp]);
}
