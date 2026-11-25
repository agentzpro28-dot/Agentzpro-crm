// Service worker for task alerts. It only shows push notifications and opens the Tasks page on click;
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

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/tasks";
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
