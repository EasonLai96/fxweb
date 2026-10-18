// 槓桿交易練習場 service worker（保守版）
// · 只處理「同網域的 GET」靜態檔；API 在另一個網域（workers.dev），完全不經過這裡，永遠走網路。
// · 一律「網路優先」：有網路就拿最新版並順手更新快取，沒網路才用快取 —— 玩家不會卡在舊版前端。
// · 換版時改 VERSION，舊快取會在 activate 時清掉。
const VERSION = "fxweb-20261018song1";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./assets/icon-192.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith("fxweb-") && k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith("/fxweb/")) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const res = await fetch(req);
      if (res.ok && res.type === "basic") cache.put(req, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      const hit = await cache.match(req) || (req.mode === "navigate" ? await cache.match("./index.html") : null);
      if (hit) return hit;
      throw err;
    }
  })());
});
