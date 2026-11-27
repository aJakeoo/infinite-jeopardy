// Service worker: makes the phone and TV installable and opens them instantly from the home screen.
// Pages and code are network-first (a deploy shows up on the next open); icons and the QR library are
// cache-first. The game itself (/api and the WebSockets) is always live and never cached.
const VERSION = 'ij-v2';
const SHELL = ['/', '/play', '/css/base.css', '/css/tv.css', '/css/phone.css', '/js/tv.js', '/js/phone.js', '/js/net.js',
  '/js/sfx.js', '/js/topics.js', '/js/tuning.js', '/js/scan.js', '/js/vendor/qrcode.js', '/favicon.svg', '/icons/icon-192.png', '/icons/icon-180.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  const cacheFirst = url.pathname.startsWith('/icons/') || url.pathname.startsWith('/js/vendor/');
  if (cacheFirst) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); } return res; })));
    return;
  }
  e.respondWith(fetch(req).then((res) => {
    if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true })));
});
