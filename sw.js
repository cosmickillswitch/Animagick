// Bump VERSION whenever you change any file so phones pick up the new copy.
const VERSION = 'animath-4';
// Fonts (KaTeX's Computer Modern, IBM Plex) live in a cache that survives version bumps.
const RUNTIME = 'animath-runtime';
const CORE = ['./', './index.html', './fonts.css', './fonts/lm-regular.woff', './fonts/lm-italic.woff', './fonts/lm-bold.woff', './fonts/lm-bolditalic.woff', './fonts/lm-math.woff', './app.css', './core.js', './export.js', './editor.js', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png', './maskable-512.png', './apple-touch-icon.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== RUNTIME).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const runtime = url.host === 'cdn.jsdelivr.net' || url.host.endsWith('fonts.googleapis.com') || url.host.endsWith('fonts.gstatic.com');
  if (url.origin !== location.origin && !runtime) return;
  e.respondWith(
    caches.match(e.request, {ignoreSearch: url.origin === location.origin}).then(hit => hit || fetch(e.request).then(res => {
      if (res.ok || res.type === 'opaque') {
        const copy = res.clone();
        caches.open(url.origin === location.origin ? VERSION : RUNTIME).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => e.request.mode === 'navigate' ? caches.match('./index.html') : Response.error()))
  );
});
