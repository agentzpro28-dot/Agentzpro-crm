// Service worker for task alerts and new-lead pop-ups. It only shows push notifications and handles clicks on them;
// it caches nothing and handles no fetches.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  event.waitUntil(self.registration.showNotification(data.title || "Task reminder", {
    body: data.body || "",
    icon: "/logo-icon.png",
    tag: data.tag || "task-reminder",
    // Stays on screen until the member clicks or closes it, where the browser supports that (desktop Chrome, Edge).
    requireInteraction: true,
    data: { url: typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/tasks" },
  }));
});

/** Tags of the "New lead" pop-ups (use-new-lead-alerts.ts). */
const NEW_LEAD_TAG_PREFIX = "new-lead:";

/**
 * A click on a "New lead" pop-up never reloads a tab the member may be typing in: an open /leads tab is brought
 * forward and told to reload its table (like the bar's Show); with no /leads tab, /leads opens in a new tab.
 */
function openNewLeads(url) {
  return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    const leadsTab = clients.find((client) => {
      try { return new URL(client.url).pathname === "/leads"; } catch { return false; }
    });
    if (leadsTab && "focus" in leadsTab) {
      return leadsTab.focus()
        .then(() => leadsTab.postMessage({ type: "agentz:show-new-leads" }))
        .catch(() => self.clients.openWindow(url));
    }
    return self.clients.openWindow(url);
  });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/tasks";
  if (typeof event.notification.tag === "string" && event.notification.tag.startsWith(NEW_LEAD_TAG_PREFIX)) {
    event.waitUntil(openNewLeads(url));
    return;
  }
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    for (const client of clients) {
      if ("focus" in client) {
        // navigate() fails for a tab this worker does not control (opened before it was registered); that tab is
        // then asked to open the page itself (use-new-lead-alerts.ts listens for this message).
        return client.focus().then(() => client.navigate(url)).catch(() => client.postMessage({ type: "agentz:open", url }));
      }
    }
    return self.clients.openWindow(url);
  }));
});
