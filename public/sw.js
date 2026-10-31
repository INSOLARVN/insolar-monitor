// MỚI (31/10/2026): service worker tối thiểu để cài app (PWA). Chỉ đệm ảnh tĩnh; giao diện và API luôn lấy mới từ mạng.
const CACHE = "insolar-static-v1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== "GET" || u.origin !== location.origin || !(u.pathname.startsWith("/img/") || u.pathname.startsWith("/icons/"))) return;
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(r);
    if (hit) return hit;
    const res = await fetch(r);
    if (res.ok) c.put(r, res.clone());
    return res;
  }));
});
