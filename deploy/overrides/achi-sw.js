/* ACHI Scaffolding - network-first shell service worker.
 *
 * Upstream precaches index.html before Caddy injects ACHI's theme/navigation
 * assets. That can pin browsers to an obsolete injected script indefinitely.
 * ACHI is an online ERP, so keep the worker registration valid while allowing
 * the browser to fetch the application shell from Caddy on every navigation.
 *
 * OFFLINE, added without giving that up: our own pages and their assets are
 * cached, but ALWAYS network-first — the network answer wins and refreshes the
 * cache, and the cache is only read when the network fails. So a reachable
 * server still cannot serve a stale injected script (the bug above), while a
 * van with no signal still opens Call Log and Site Survey.
 *
 * WHAT THIS DOES NOT DO: make the app work offline. It caches the SHELL — the
 * HTML, the sidebar, the drawing tool, the logo. Log rows are fetched per
 * request against a bearer token and are not cached, and writes are not queued:
 * offline, the pages open but load no rows, and saving fails. Making edits
 * survive offline needs a write queue and conflict handling, which is a
 * different piece of work. Do not read "works offline" into this.
 */
const ACHI_SW_VERSION = 'achi-shell-v2';
const ACHI_CACHE = 'achi-offline-v2';

/* Our own shell. Same-origin paths only — never the API data routes. */
const ACHI_ASSETS = [
  '/api/v1/achi/ui',
  '/api/v1/achi/survey/ui',
  '/api/v1/achi/ui/chrome.js',
  '/api/v1/achi/ui/drawing.js',
  '/api/v1/branding/',
  '/logo.svg'
];

function isOurs(url) {
  if (url.origin !== self.location.origin) return false;
  const p = url.pathname;
  // The UI routes and their assets, plus branding and the logo the sidebar draws
  // with. NOT /logs/, /surveys/ or any other data route: those are per-user,
  // token-scoped, and a cached copy would be both stale and a leak between
  // accounts on a shared machine.
  return p === '/logo.svg'
    || p === '/api/v1/branding/'
    || p.startsWith('/api/v1/achi/ui')
    || p.startsWith('/api/v1/achi/survey/ui');
}

self.addEventListener('install', function (event) {
  // Warm the cache so the FIRST offline open works even if the user never
  // visited that page online. Failure here must not block activation — a
  // missing asset is a degraded offline mode, not a broken worker.
  event.waitUntil(
    caches.open(ACHI_CACHE)
      .then(function (cache) { return cache.addAll(ACHI_ASSETS); })
      .catch(function () {})
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        // Still clear upstream's precache (the original point of this worker),
        // but keep OUR cache — deleting it on every activate would mean the
        // first load after any update is the one time you cannot work offline.
        return Promise.all(keys
          .filter(function (key) { return key !== ACHI_CACHE; })
          .map(function (key) { return caches.delete(key); }));
      })
      .then(function () { return self.clients.claim(); })
      .then(function () { return self.clients.matchAll({ type: 'window' }); })
      .then(function (clients) {
        return Promise.all(clients.map(function (client) {
          return client.navigate(client.url);
        }));
      })
  );
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;                 // never cache writes
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (!isOurs(url)) return;                          // everything else: untouched

  event.respondWith(
    fetch(req)
      .then(function (res) {
        // Only cache a real success. An opaque or error response cached here
        // would be replayed offline as if it were the page.
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(ACHI_CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        }
        return res;
      })
      .catch(function () {
        return caches.match(req).then(function (hit) {
          if (hit) return hit;
          throw new Error('offline and not cached: ' + url.pathname);
        });
      })
  );
});

self.addEventListener('message', function (event) {
  if (event.data === 'achi-sw-version' && event.source) {
    event.source.postMessage({ type: 'achi-sw-version', version: ACHI_SW_VERSION });
  }
});
