// Minimal service worker: makes the app installable. Network-first; no offline
// caching of API data (everything sits behind Cloudflare Access). Web Push is added in M4.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
