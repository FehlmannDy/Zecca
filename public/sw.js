// Minimal service worker: makes the app installable. Network-only on purpose (balances/payments must be live).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
