/* ShopSim service worker: офлайн-кэш для установки на Windows и Android (PWA).
   Стратегия: оболочка (HTML/JS/CSS/three) — cache-first, остальное — network-first с фолбэком в кэш. */
const VERSION = 'shopsim-v9-0';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './vendor/three.module.js',
  './vendor/three.core.js',
  './src/main.js',
  './src/core/settings.js',
  './src/core/input.js',
  './src/core/ui.js',
  './src/core/audio.js',
  './src/util/logger.js',
  './src/util/geo.js',
  './src/gfx/renderer.js',
  './src/gfx/post.js',
  './src/gfx/textures.js',
  './src/gfx/grass.js',
  './src/gfx/water.js',
  './src/gfx/sky.js',
  './src/gfx/effects.js',
  './src/world/gen.js',
  './src/world/weather.js',
  './src/world/city.js',
  './src/world/traffic.js',
  './src/player/player.js',
  './src/game/shops.js',
  './src/game/gameplay.js',
  './src/test/selftest.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // ставим по одному: один отсутствующий файл не должен ломать всю установку
    await Promise.all(SHELL.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const isNav = req.mode === 'navigate';
  const isShell = isNav || /\.(?:js|css|webmanifest|html|png|jpg|json)$/.test(url.pathname) || url.pathname.endsWith('/');
  if (isShell) {
    e.respondWith((async () => {
      const cache = await caches.open(VERSION);
      let hit = await cache.match(req, { ignoreSearch: true });
      if (!hit && isNav) hit = await cache.match('./index.html', { ignoreSearch: true });
      if (hit) {
        // в фоне обновляем
        fetch(req).then((r) => { if (r && r.ok) cache.put(req, r.clone()); }).catch(() => {});
        return hit;
      }
      try {
        const r = await fetch(req);
        if (r && r.ok) cache.put(req, r.clone());
        return r;
      } catch (err) {
        return (await cache.match('./index.html')) || Response.error();
      }
    })());
  } else {
    e.respondWith(fetch(req).catch(() => caches.match(req)));
  }
});
