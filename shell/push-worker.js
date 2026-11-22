// Same-origin service worker: notification payloads contain no producer text or secrets.
self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let data;
    try { data = event.data?.json(); } catch { return; }
    if (data?.title !== "acon: 1 item needs you" || data?.link !== "/#/local/inbox" || typeof data?.tag !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(data.tag)) return;
    await self.registration.showNotification(data.title, { tag: data.tag, data: { link: data.link } });
  })());
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = new URL("/#/local/inbox", self.location.origin).href;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (open) { await open.navigate(target); await open.focus(); }
    else await self.clients.openWindow(target);
  })());
});
