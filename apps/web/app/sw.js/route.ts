// Display and navigation only. Notification policy and formatting live in regular modules.
const script = `
self.addEventListener("install", event => { event.waitUntil(self.skipWaiting()); });
self.addEventListener("activate", event => { event.waitUntil(self.clients.claim()); });
function destination(value) {
  try {
    const url = new URL(typeof value === "string" ? value : "/notifications", self.location.origin);
    if (url.origin === self.location.origin && !url.username && !url.password &&
        ["/", "/notifications", "/notifications/target", "/catalog", "/discs"].includes(url.pathname)) return url.href;
  } catch {}
  return new URL("/notifications", self.location.origin).href;
}
self.addEventListener("push", event => {
  event.waitUntil((async () => {
    let payload;
    try { payload = event.data.json(); } catch {}
    const valid = payload && payload.version === 1 && typeof payload.body === "string" && payload.body.length <= 1000;
    const label = valid && typeof payload.label === "string" && payload.label.trim() ? payload.label.slice(0, 100) : "Unlabelled disc";
    await self.registration.showNotification(valid && typeof payload.title === "string" && payload.title.trim() ? payload.title.slice(0, 120) : label, {
      body: valid ? payload.body : "Open Rip DVD to inspect notifications.",
      tag: valid && typeof payload.tag === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(payload.tag) ? payload.tag : "rip-dvd-notification",
      icon: "/app-icon/192", badge: "/app-icon/192",
      data: { destination: destination(valid ? payload.destination : null) }
    });
  })());
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = destination(event.notification.data && event.notification.data.destination);
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const suitable = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (suitable) {
      try { const navigated = await suitable.navigate(target); if (navigated) { await navigated.focus().catch(() => undefined); return; } } catch {}
    }
    await self.clients.openWindow(target);
  })());
});
`;

export function GET(): Response {
  return new Response(script, { headers: { "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "no-cache, max-age=0, must-revalidate", "Service-Worker-Allowed": "/" } });
}
