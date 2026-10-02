// Shell only. API responses are NEVER cached: Cache Storage is persistent and
// invisible, and private queue content does not belong in it. An operator tool
// showing stale state is worse than one that says it is offline.
const CACHE = 'autoposter-v1';
const SHELL = ['./', 'index.html', 'app.js', 'github.js', 'logic.js',
               'style.css', 'manifest.webmanifest', 'vendor/js-yaml.min.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Anything not our own origin — the API, the image CDN — goes straight to
  // the network and is never stored.
  if (url.origin !== self.location.origin) return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
