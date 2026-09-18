/* ============================================================
 * Mycard Service Worker
 * 策略：
 *   - 安装时预缓存 App Shell + data/ 内置词库（首次打开即离线可用）
 *   - 页面导航 / JS / CSS / JSON：**网络优先**（在线总是拿到最新版，并回写缓存；离线回退缓存）
 *   - 图片 / 图标：缓存优先（内容不常变）
 * 说明：发布新版本时递增 VERSION，新 SW 会 skipWaiting + claim 立即接管，
 *       配合 app.js 的 controllerchange 自动刷新，用户无需手动强刷即可看到新功能。
 * ============================================================ */
const VERSION = 'v1.8.1';
const CACHE = 'mycard-' + VERSION;

const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './favicon.svg',
  './css/style.css',
  './js/app.js',
  './js/store.js',
  './js/idb.js',
  './js/scheduler.js',
  './js/levels.js',
  './js/difficulty.js',
  './js/arrange.js',
  './js/theme.js',
  './js/engdefs.js',
  './js/add-words.js',
  './js/import-file.js',
  './js/import-history.js',
  './js/xlsx.js',
  './js/export.js',
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
  './data/frequency.json',
  './vendor/sql.js/sql-wasm.js',
  './vendor/sql.js/sql-wasm.wasm',
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

  // 1) 页面导航：网络优先（保证拿到最新版），离线时回退缓存的 index.html
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          putInCache('./index.html', response.clone());
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // 2) 图片 / 图标：缓存优先（内容不常变，优先本地、省流量）
  if (/\.(png|jpe?g|svg|ico|webp|gif)$/i.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetchAndCache(request))
    );
    return;
  }

  // 3) JS / CSS / HTML / JSON：网络优先（在线用最新代码并回写缓存；离线回退缓存）
  event.respondWith(
    fetchAndCache(request).catch(() => caches.match(request))
  );
});

function putInCache(key, response) {
  if (!response || response.status !== 200) return;
  caches
    .open(CACHE)
    .then((cache) => cache.put(key, response))
    .catch(() => {});
}

/** 取网络并顺带写入缓存 */
function fetchAndCache(request) {
  return fetch(request).then((response) => {
    if (response && response.status === 200 && response.type === 'basic') {
      putInCache(request, response.clone());
    }
    return response;
  });
}
