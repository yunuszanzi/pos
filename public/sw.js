// Keeps the till openable without a connection (technical plan 5.5). It is deliberately small and careful:
//  - it never touches the API (/api): money and stock are only ever read from, and written to, the live server;
//  - a page (navigation) goes to the network first, and the copy kept from last time is used only when the network fails,
//    so while online nobody is ever shown an old page;
//  - files under /assets have a hash in their name, so a kept copy is always right for that name and is used first.
// Everything else is left to the browser.

const VERSION = "pos-shell-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name !== VERSION) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api")) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      try {
        const fresh = await fetch(request);
        // One copy of the app's page serves every route: the app does its own routing.
        if (fresh.ok) await cache.put("/index.html", fresh.clone());
        return fresh;
      } catch {
        const kept = await cache.match("/index.html");
        if (kept) return kept;
        throw new Error("The app is not available offline yet. Open it once with a connection first.");
      }
    })());
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const kept = await cache.match(request);
      if (kept) return kept;
      const fresh = await fetch(request);
      if (fresh.ok) await cache.put(request, fresh.clone());
      return fresh;
    })());
  }
});
