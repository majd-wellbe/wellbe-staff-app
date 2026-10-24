/* Wellbe service worker: one file for the staff app (/), the client app and the game (/client/).
   Pages: network first (you always get the newest version when online), cached copy when offline.
   Pages and our own .js files: network first too. Images, 3D models, fonts, three.js: served from the cache, refreshed in the background.
   Server calls (POST to Apps Script) are never touched.
   To change what is cached, bump VERSION. To switch the worker off for everyone: set OFF = true and push. */
var VERSION = 'wb-1';
var OFF = false;
var PAGES = VERSION + '-pages', FILES = VERSION + '-files';
var CDN = /^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;

self.addEventListener('install', function (e) { self.skipWaiting(); });
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return OFF || (k.indexOf(VERSION + '-') !== 0); }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function isPage(req) { return req.mode === 'navigate' || (req.headers.get('accept') || '').indexOf('text/html') > -1; }

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (OFF || req.method !== 'GET') return;
  var url = new URL(req.url), same = url.origin === self.location.origin;
  if (!same && !CDN.test(req.url)) return;            // Apps Script, analytics, wa.me: straight to the network
  // pages and our own scripts (core/wb-core.js): always the newest when online, so a new page never runs with old shared code
  if (same && (isPage(req) || /\.js$/.test(url.pathname))) {
    e.respondWith(fetch(req).then(function (res) {
      if (res && res.ok) { var copy = res.clone(); caches.open(PAGES).then(function (c) { c.put(req, copy); }); }
      return res;
    }).catch(function () { return caches.match(req, { ignoreSearch: true }); }));
    return;
  }
  // files: cache first, refresh in the background
  e.respondWith(caches.open(FILES).then(function (c) {
    return c.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) { if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone()); return res; });
      if (hit) { net.catch(function () {}); return hit; }
      return net;
    });
  }));
});
