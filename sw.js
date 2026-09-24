/**
 * sw.js — Service Worker: офлайн-работа PWA.
 * sw.js — Service Worker: offline support for the PWA.
 *
 * Стратегии / Strategies:
 *   • оболочка приложения (HTML/CSS/JS/иконки/заводские пресеты) — precache, stale-while-revalidate;
 *     app shell — precache, stale-while-revalidate;
 *   • /api/* — только сеть (при офлайне клиент сам уходит в localStorage).
 *     /api/* — network only (the client falls back to localStorage when offline).
 */
const VERSION = 'proeq-v1.0.0';
const SHELL = [
  './',
  'index.html',
  'manifest.json',
  'css/reset.css', 'css/style.css', 'css/mobile.css', 'css/desktop.css',
  'js/app.js', 'js/audio.js', 'js/dsp.js', 'js/eq.js', 'js/fx-chain.js', 'js/fir-worker.js',
  'js/gestures.js', 'js/mobile-ui.js', 'js/presets.js', 'js/recorder.js', 'js/touch.js', 'js/ui.js',
  'js/worklets/recorder-worklet.js',
  'icons/icon-32.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
  'presets/index.json',
  'presets/air.json', 'presets/bass-boost.json', 'presets/de-mud.json', 'presets/guitar-clarity.json',
  'presets/hum-removal.json', 'presets/mid-side-wide.json', 'presets/podcast-voice.json',
  'presets/telephone.json', 'presets/vocal-presence.json', 'presets/warm-tilt.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      // cache: 'reload' — не брать устаревшее из HTTP-кеша / bypass stale HTTP cache
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.includes('/api/') || url.pathname.includes('/php/')) return; // сеть / network only

  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res.ok && res.type === 'basic') cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached) { e.waitUntil(network); return cached; }
      const res = await network;
      if (res) return res;
      // Навигация офлайн → оболочка / offline navigation → app shell
      if (req.mode === 'navigate') return cache.match('index.html');
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    })
  );
});
