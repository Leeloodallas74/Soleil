/* Soleil du jour – service worker : garde l'appli disponible hors ligne.
   Changer VERSION à chaque mise en ligne, et le ?v= des fichiers (ici et dans index.html). */
var VERSION = 'sdj-v10';
var SHELL = ['./', 'index.html', 'css/app.css?v=10', 'js/config.js?v=10', 'js/model.js?v=10', 'js/app.js?v=10', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  /* Prévisions et adresses : jamais mises en cache ici (l'appli garde elle-même la dernière prévision). */
  if (/open-meteo\.com|geopf\.fr|data\.gouv\.fr/.test(url.hostname)) return;
  /* Fichiers de l'appli et police : réponse immédiate depuis le cache, mise à jour en arrière-plan. */
  e.respondWith(caches.open(VERSION).then(function (c) {
    return c.match(req, { ignoreSearch: url.origin === location.origin }).then(function (hit) {
      var net = fetch(req).then(function (r) { if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone()); return r; }).catch(function () { return hit; });
      return hit || net;
    });
  }));
});
