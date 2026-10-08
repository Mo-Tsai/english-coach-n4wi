/* sw.js：英文口說 Live 教練的離線快取（由 build_pwa.py 填入版本號）
 * - 頁面本體（index.html、store.js、speech.js、圖示）：先連網拿最新，連不上就用快取。版本號一變，舊快取自動清掉。
 * - 發音檔（audio/*.mp3）：快取優先，存過就不再下載；iPhone 的音訊會用 Range 請求，這裡有處理。
 * - Google 字型：用過一次就存起來（離線時還在）。
 * - Azure 語音的請求（microsoft.com）完全不經過這裡，也不會被快取。
 */
var VERSION = '20261008-07e556';
var SHELL = 'elc-shell-' + VERSION, AUDIO = 'elc-audio-v1', FONTS = 'elc-fonts-v1';
var SHELL_FILES = ['./', 'index.html', 'store.js?v=20261008-07e556', 'speech.js?v=20261008-07e556', 'manifest.json', 'icons/icon-192.png', 'icons/icon-512.png', 'apple-touch-icon.png'];

function rangeResponse(res, header) {
  return res.arrayBuffer().then(function (buf) {
    var size = buf.byteLength, m = /^bytes=(\d*)-(\d*)$/.exec(header || ''), start = 0, end = size - 1;
    if (!m || (m[1] === '' && m[2] === '')) return new Response(buf, { status: 200, headers: { 'Content-Type': res.headers.get('Content-Type') || 'audio/mpeg', 'Content-Length': String(size) } });
    if (m[1] === '') { var n = parseInt(m[2], 10); start = Math.max(0, size - n); }
    else { start = parseInt(m[1], 10); if (m[2] !== '') end = Math.min(size - 1, parseInt(m[2], 10)); }
    if (isNaN(start) || start >= size || end < start) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
    return new Response(buf.slice(start, end + 1), { status: 206, headers: { 'Content-Type': res.headers.get('Content-Type') || 'audio/mpeg', 'Content-Range': 'bytes ' + start + '-' + end + '/' + size, 'Content-Length': String(end - start + 1) } });
  });
}

function audioFetch(req) {
  return caches.open(AUDIO).then(function (cache) {
    return cache.match(req.url).then(function (hit) {
      if (hit) return hit;
      return fetch(req.url).then(function (net) {
        if (!net.ok) return net;
        return cache.put(req.url, net.clone()).catch(function () {}).then(function () { return net; });
      });
    }).then(function (res) {
      var range = req.headers.get('range');
      return (range && res.ok) ? rangeResponse(res, range) : res;
    });
  });
}

function fontFetch(req) {
  return caches.open(FONTS).then(function (c) {
    return c.match(req).then(function (hit) {
      var net = fetch(req).then(function (r) {
        if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone()).catch(function () {});
        return r;
      }).catch(function () { return null; });
      return hit || net.then(function (r) { return r || Response.error(); });
    });
  });
}

function shellFetch(req) {
  return fetch(req, { cache: 'no-cache' }).then(function (res) {
    if (res && res.ok) { var copy = res.clone(); caches.open(SHELL).then(function (c) { c.put(req, copy); }).catch(function () {}); }
    return res;
  }).catch(function () {
    return caches.open(SHELL).then(function (c) {
      return c.match(req).then(function (hit) {
        if (hit) return hit;
        if (req.mode === 'navigate') return c.match('index.html').then(function (h2) { return h2 || c.match('./'); });
        return Response.error();
      });
    });
  });
}

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(SHELL).then(function (c) {
    return c.addAll(SHELL_FILES.map(function (u) { return new Request(u, { cache: 'reload' }); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('elc-') === 0 && k !== SHELL && k !== AUDIO && k !== FONTS; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') event.respondWith(fontFetch(req));
    return;
  }
  if (/\/audio\/[^\/]+\.mp3$/.test(url.pathname)) { event.respondWith(audioFetch(req)); return; }
  event.respondWith(shellFetch(req));
});

// 頁面載入後會送來發音檔清單：沒存過的在背景慢慢存（一次 4 個），之後離線也能聽
self.addEventListener('message', function (event) {
  var d = event.data || {};
  if (d.type !== 'precache-audio' || !Array.isArray(d.urls)) return;
  var scope = self.registration.scope;
  var urls = d.urls.filter(function (u) { return typeof u === 'string' && /^audio\/[A-Za-z0-9_.-]+\.mp3$/.test(u); }).map(function (u) { return new URL(u, scope).href; });
  event.waitUntil(caches.open(AUDIO).then(function (cache) {
    var i = 0;
    function worker() {
      if (i >= urls.length) return Promise.resolve();
      var u = urls[i++];
      return cache.match(u).then(function (hit) {
        if (hit) return;
        return fetch(u).then(function (r) { if (r.ok) return cache.put(u, r); }).catch(function () {});
      }).then(worker);
    }
    return Promise.all([worker(), worker(), worker(), worker()]);
  }));
});
