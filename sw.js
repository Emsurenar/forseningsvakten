// Förseningsvakten — service worker (offline-skal + notisklick)
const CACHE = "fv-v4";
const SHELL = ["./", "index.html", "styles.css", "app.js", "sl.js", "engine.js", "manifest.webmanifest",
  "icons/icon.svg", "icons/icon-192.png", "icons/apple-touch-icon-180.png"];

self.addEventListener("install", (e) => {
  // allSettled: en enskild saknad fil ska inte stjälpa hela installationen
  e.waitUntil(caches.open(CACHE)
    .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Cache-first (stale-while-revalidate) för appskalet: CSS/JS/HTML laddas alltid, även på
// en flakig mobiluppkoppling, och uppdateras i bakgrunden. Serverar ALDRIG HTML som svar på
// en CSS/JS-begäran (det gav en osylad sida). SL:s API:er (annan origin) går direkt mot nätet.
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(req);
    const fresh = fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    if (cached) { e.waitUntil(fresh); return cached; } // servera direkt, uppdatera i bakgrunden
    const res = await fresh;
    if (res) return res;
    if (req.mode === "navigate") return cache.match("index.html");
    return Response.error();
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) if ("focus" in c) return c.focus();
    return clients.openWindow("./");
  }));
});
