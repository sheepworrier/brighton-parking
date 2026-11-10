// Minimal service worker: app shell is network-first (offline fallback), data and libraries are stale-while-revalidate.
// Bump VERSION when the shell changes so old caches are dropped.
const VERSION = 'v2';
const SHELL = `bhpf-shell-${VERSION}`;
const RUNTIME = `bhpf-runtime-${VERSION}`;
const SHELL_FILES = ['./', 'index.html', 'ui.css', 'app.js', 'engine.js', 'geo.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => ![SHELL, RUNTIME].includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const sameOrigin = url.origin === location.origin;
  const isLib = url.hostname === 'unpkg.com';
  const isMapTile = /openfreemap\.org$/.test(url.hostname);
  if (!sameOrigin && !isLib && !isMapTile) return; // geocoders etc: always network
  if (isMapTile) return; // let the browser's HTTP cache handle tiles
  const isData = sameOrigin && url.pathname.includes('/data/');
  e.respondWith((async () => {
    if (sameOrigin && !isData) {
      // app shell: network first (always fresh when online), cache as the offline fallback
      const cache = await caches.open(SHELL);
      try {
        const res = await fetch(e.request);
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      } catch {
        return (await cache.match(e.request, { ignoreSearch: true })) || new Response('Offline', { status: 503 });
      }
    }
    // data + libraries: stale-while-revalidate
    const cache = await caches.open(RUNTIME);
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const network = fetch(e.request).then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; }).catch(() => null);
    return cached || (await network) || new Response('Offline', { status: 503 });
  })());
});
