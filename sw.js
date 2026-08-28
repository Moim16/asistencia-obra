// =============================================================================
//  Service worker minimo: cachea el "cascaron" (HTML, manifest, icono) para que
//  la app ABRA aunque en la obra no haya señal.
//
//  OJO: las llamadas a /api/ NUNCA se cachean. Sin conexion se puede abrir la app,
//  pero no cargar ni guardar la lista del dia (marcar sin conexion y sincronizar
//  despues es un paso pendiente, ver README).
// =============================================================================

const CACHE = "asistencia-v1";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) return;   // datos: siempre de la red

  // Network-first: si hay red se ve lo ultimo; si no, sale del cache.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("/index.html")))
  );
});
