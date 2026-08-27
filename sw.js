/*
 * Caches the whole app so it keeps working with no network at all.
 * Bump CACHE whenever one of the files below changes, otherwise installed
 * copies keep serving the old version.
 */
var CACHE = 'book-scan-splitter-v8';
var ASSETS = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './split-core.js',
  './deskew-core.js',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/pdf.min.js',
  './vendor/pdf.worker.min.js',
  './vendor/pdf-lib.min.js',
];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) {
    return cache.addAll(ASSETS);
  }).then(function () {
    return self.skipWaiting();
  }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.map(function (key) {
      return key === CACHE ? null : caches.delete(key);
    }));
  }).then(function () {
    return self.clients.claim();
  }));
});

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;
  event.respondWith(caches.match(event.request).then(function (hit) {
    return hit || fetch(event.request);
  }));
});
