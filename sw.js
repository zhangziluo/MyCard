/* ============================================================
 * Mycard Service Worker
 * 策略：预缓存 App Shell + data/ 内置词库（首次打开即离线可用）；
 * 运行时同源静态资源 cache-first；导航请求 network-first 回退缓存页。
 * 发布新版本时递增 VERSION 即可触发缓存更新与旧缓存清理。
 * ============================================================ */
const VERSION = 'v1.6.3';
const CACHE = 'mycard-' + VERSION;

const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './favicon.svg',
  './css/style.css',
  './js/app.js',
  './js/store.js',
  './js/scheduler.js',
  './js/levels.js',
  './js/levelstats.js',
  './js/hardwords.js',
  './js/test-config.js',
  './js/test-engine.js',
  './js/ui.js',
  './js/decks.js',
  './js/review.js',
  './js/test.js',
  './data/words.json',
  './data/confusables.json',
  './data/kaoyan.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

/* 安装：预缓存全部资源 */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

/* 激活：清理旧版本缓存并立即接管页面 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* 请求拦截 */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // 页面导航：优先网络（保证拿到最新版），离线时回退缓存的 index.html
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches
            .open(CACHE)
            .then((cache) => cache.put('./index.html', copy))
            .catch(() => {});
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // 静态资源：cache-first，缓存未命中时回源并顺带写入缓存
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const copy = response.clone();
          caches
            .open(CACHE)
            .then((cache) => cache.put(request, copy))
            .catch(() => {});
        }
        return response;
      });
    })
  );
});
