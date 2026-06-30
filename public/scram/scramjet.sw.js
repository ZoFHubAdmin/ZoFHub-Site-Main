// Eduame · Scramjet service worker
// Wraps the packaged Scramjet worker factory.  Scope is /scram/service/
// (set by browser.js at registration time), which matches the controller
// prefix so only proxied navigations are intercepted.  Everything Scramjet
// fetches upstream flows over the shared bare-mux transport (epoxy → /wisp/).
importScripts('/scram/scramjet.all.js');

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  event.respondWith((async () => {
    await scramjet.loadConfig();
    if (scramjet.route(event)) return scramjet.fetch(event);
    return fetch(event.request);
  })());
});
