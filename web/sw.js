// sw.js — офлайн-кэш веб-сборки (PWA). Политика — «сеть вперёд, кэш как
// запас»: шейдеры, атласы и GI-объём при каждом запросе берутся с сервера,
// поэтому правка `shaders/glsl/*.frag` видна сразу, без жёсткой перезагрузки и
// без «сегодня рисуется вчерашний шейдер». В кэш кладётся то, что сервер
// отдал, — и именно это выдаётся, когда сети нет (телефон в метро, самолёт).
// Снять регистрацию: открыть страницу с ?nosw=1.
const CACHE = 'newwoorld-0.5.32-v1';
// Каркас приложения: без него офлайн нечему стартовать.
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/ui.css',
  'js/main.js',
  'js/gl.js',
  'js/gi.js',
  'js/world.js',
  'js/materials.js',
  'icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))),
  );
});
