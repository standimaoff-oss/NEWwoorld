/* 京华里 · Новый Китай — offline service worker.
   The whole preview is one HTML file; caching it once is enough to run without
   a network. Network-first so a rebuilt HTML is picked up on the next visit. */
const CACHE = 'china-preview-v1';
const CORE = [
  './', './index.html', './China_Preview.html', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(CORE.map(async url => {
      try {
        const response = await fetch(url, { cache: 'no-store' });
        if (response && response.ok) await cache.put(url, response.clone());
      } catch (_) { /* a file may not exist on this origin — that is fine */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    let network = null;
    try {
      network = await fetch(request);
      if (network && network.ok) cache.put(request, network.clone());
    } catch (_) { /* offline */ }
    if (network) return network;
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const fallback = await cache.match('./index.html') || await cache.match('./China_Preview.html') || await cache.match('./');
      if (fallback) return fallback;
    }
    return Response.error();
  })());
});
