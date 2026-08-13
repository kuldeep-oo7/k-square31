// K² requires current online prices. Retire all previous offline shell workers
// so a phone, tablet and desktop always load the same deployed application.
self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("k2-")).map((key) => caches.delete(key)));
    await self.clients.claim();
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    await Promise.all(clients.map((client) => {
      const url = new URL(client.url);
      url.searchParams.set("k2v", "23");
      return client.navigate(url.href);
    }));
  })());
});
