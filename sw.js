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
const VERSION = 'movexe-v3.0.0';
const SHELL = [
  './',
  'index.html',
  'manifest.json',
  'css/desktop.css',
  'css/mobile.css',
  'css/reset.css',
  'css/style.css',
  'js/api560-ui.js',
  'js/api560.js',
  'js/app.js',
  'js/audio.js',
  'js/deesser-ui.js',
  'js/deesser.js',
  'js/detection.js',
  'js/dsp.js',
  'js/eq.js',
  'js/fir-worker.js',
  'js/fx-chain.js',
  'js/gestures.js',
  'js/graph.js',
  'js/mobile-ui.js',
  'js/presets.js',
  'js/proportionalq.js',
  'js/recorder.js',
  'js/spectrum.js',
  'js/touch.js',
  'js/ui.js',
  'js/worklets/deesser-worklet.js',
  'js/worklets/recorder-worklet.js',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-32.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'presets/air.json',
  'presets/bass-boost.json',
  'presets/de-mud.json',
  'presets/guitar-clarity.json',
  'presets/hum-removal.json',
  'presets/index.json',
  'presets/mid-side-wide.json',
  'presets/podcast-voice.json',
  'presets/telephone.json',
  'presets/vocal-presence.json',
  'presets/warm-tilt.json',
  'presets/deesser/allround-bus.json',
  'presets/deesser/index.json',
  'presets/deesser/podcast-gentle.json',
  'presets/deesser/podcast-voice.json',
  'presets/deesser/pop-polish.json',
  'presets/deesser/rap-aggressive.json',
  'presets/deesser/rock-vocal.json',
  'presets/deesser/vocal-bright.json',
  'presets/deesser/vocal-female.json',
  'presets/deesser/vocal-male.json',
  'presets/lite/bass-growl.json',
  'presets/lite/guitar-bright.json',
  'presets/lite/guitar-warm.json',
  'presets/lite/index.json',
  'presets/lite/kick-deep.json',
  'presets/lite/kick-punch.json',
  'presets/lite/room-tame.json',
  'presets/lite/snare-crack.json',
  'presets/lite/snare-fat.json',
  'presets/lite/vocal-air.json',
  'presets/lite/vocal-presence.json'
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
