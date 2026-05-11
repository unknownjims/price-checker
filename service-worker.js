const CACHE = 'price-checker-v1';
const FILES = [
  '/',
  '/price-checker-standalone.html',
  '/manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => {
      return cache.addAll(FILES);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(cached => {
      return cached || fetch(e.request).then(response => {
        return caches.open(CACHE).then(cache => {
          if (e.request.url.match(/\.(html|js|css|png|svg|json)$/)) {
            cache.put(e.request, response.clone());
          }
          return response;
        });
      });
    })
  );
});
