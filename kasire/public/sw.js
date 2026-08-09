const CACHE_NAME = "kasir-cloud-shell-v23"; // dinaikkan: brand assets muidsoft ditambahkan ke APP_SHELL

const APP_SHELL = [
  "login.html",
  "index.html",
  "admin.html",
  "styles.css",
  "manifest.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/mark-white.svg",
  "favicon.ico",
  "favicon.svg",
  "apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Strategi:
// - /kasir/api/*   → selalu network tidak pernah dicache. Kegagalan network
//                    dibiarkan lempar error, ditangkap oleh logic offline-queue
//                    di halaman (fallback ke IndexedDB), BUKAN oleh SW ini.
// - Aset lain (HTML/CSS/JS/font/CDN) → cache-first, lalu update cache di
//                    background ("stale-while-revalidate") supaya app shell
//                    tetap bisa dibuka instan walau offline, tapi tetap
//                    ter-update
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== "GET") return; // POST/PUT/DELETE (mis. /api/transaksi) tidak disentuh SW
  if (url.pathname.startsWith("/kasir/api/")) return; // biarkan lewat langsung ke network

  event.respondWith(
    caches.match(req).then((cached) => {
      // Jaga-jaga: entri cache lama/rusak yang ternyata hasil redirect tidak
      // pernah dipakai untuk menjawab request navigasi (Chrome akan menolaknya
      // dengan error "a redirected response was used..."). Anggap sebagai
      // cache-miss saja, biar jatuh ke fetch() normal di bawah.
      if (cached && cached.redirected && req.mode === "navigate") {
        cached = undefined;
      }

      const network = fetch(req)
        .then((res) => {
          // Hanya cache response yang valid & BUKAN hasil redirect(hindari
          // menyimpan Response yang tidak boleh dipakai menjawab navigasi).
          if (res && res.status === 200 && !res.redirected) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => cached); // offline sungguhan & tidak ada di cache → biarkan gagal

      return cached || network;
    })
  );
});
