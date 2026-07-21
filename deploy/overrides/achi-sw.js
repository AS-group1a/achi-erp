/* ACHI Scaffolding - network-first shell service worker.
 *
 * Upstream precaches index.html before Caddy injects ACHI's theme/navigation
 * assets. That can pin browsers to an obsolete injected script indefinitely.
 * ACHI is an online ERP, so keep the worker registration valid while allowing
 * the browser to fetch the application shell from Caddy on every navigation.
 */
const ACHI_SW_VERSION = 'achi-shell-v1';

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (key) { return caches.delete(key); }));
      })
      .then(function () { return self.clients.claim(); })
      .then(function () {
        return self.clients.matchAll({ type: 'window' });
      })
      .then(function (clients) {
        return Promise.all(clients.map(function (client) {
          return client.navigate(client.url);
        }));
      })
  );
});

self.addEventListener('message', function (event) {
  if (event.data === 'achi-sw-version' && event.source) {
    event.source.postMessage({ type: 'achi-sw-version', version: ACHI_SW_VERSION });
  }
});
