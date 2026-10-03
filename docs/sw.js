// Network-first for the app's own files, cache only as an offline fallback.
//
// Cache-first was wrong: with a fixed cache name, a published update never
// reaches anyone who already has the app open or installed — they keep running
// the old shell forever and there is no obvious symptom, just stale behaviour.
// Network-first costs one request per file on load and makes "push a fix" mean
// what it says.
//
// API responses are NEVER cached either way. Cache Storage is persistent and
// invisible, and private queue content does not belong in it; an operator tool
// showing stale state is worse than one that says it is offline.
const CACHE = 'autoposter-v2';
const SHELL = ['./', 'index.html', 'app.js', 'github.js', 'logic.js', 'llm.js',
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
  // Anything not our own origin — the API, the image CDN, the LLM providers —
  // goes straight to the network and is never stored.
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // Refresh the offline copy as a side effect of a successful load.
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit
        || new Response('Offline, and this file is not cached.',
          { status: 503, headers: { 'Content-Type': 'text/plain' } })))
  );
});
