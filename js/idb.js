// ============================================================================
// idb.js — 极简 IndexedDB 封装（Promise 化，无第三方依赖）
//
// 设计目标：让 store.js 把「卡组正文 + 学习进度」放大到 IndexedDB 存储，
// 从而突破 localStorage 约 5MB 的配额（全部内置词库约 7 万词）。
//
// 库名 mycard，版本 1：
//   decks  (keyPath: id)              — 卡组元信息（不含 cards）
//   cards  (keyPath: id, 索引 byDeck) — 卡片正文 + 学习进度（带 deckId）
//   meta   (keyPath: key)             — 迁移标记等少量元数据
//
// 环境无 indexedDB（Node 单测 / 极老浏览器）时 isAvailable() 返回 false，
// 调用方需回退到 localStorage 方案。
// ============================================================================

export const DB_NAME = 'mycard';
export const DB_VERSION = 2;
export const STORE_DECKS = 'decks';
export const STORE_CARDS = 'cards';
export const STORE_META = 'meta';
/** 在线查词缓存（v0.6）：key = `${lang}_${word}`，value = 卡片对象 */
export const STORE_LOOKUP = 'lookup';

/** 当前环境是否支持 IndexedDB */
export function isAvailable() {
  try {
    return typeof indexedDB !== 'undefined' && !!indexedDB;
  } catch (e) {
    return false;
  }
}

let dbPromise = null;

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** 打开（并按需升级）数据库；重复调用复用同一连接 */
export function openDb() {
  if (!isAvailable()) return Promise.reject(new Error('IndexedDB 不可用'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_DECKS)) {
        db.createObjectStore(STORE_DECKS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_CARDS)) {
        const cards = db.createObjectStore(STORE_CARDS, { keyPath: 'id' });
        cards.createIndex('byDeck', 'deckId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_LOOKUP)) {
        db.createObjectStore(STORE_LOOKUP, { keyPath: 'key' }); // v2：在线查词缓存
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB 被其它标签页阻塞'));
  });
  dbPromise.catch(() => {
    dbPromise = null; // 失败后允许重试
  });
  return dbPromise;
}

async function withStore(names, mode, fn) {
  const db = await openDb();
  const list = Array.isArray(names) ? names : [names];
  return new Promise((resolve, reject) => {
    const tx = db.transaction(list, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('事务中止'));
    try {
      result = fn(list.length === 1 ? tx.objectStore(list[0]) : tx.objectStore.bind(tx));
    } catch (e) {
      try {
        tx.abort();
      } catch (e2) {}
      reject(e);
    }
  });
}

/* ------------------------------- 单条读写 ------------------------------- */

export async function get(store, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function put(store, value) {
  return withStore(store, 'readwrite', (os) => os.put(value));
}

/** 批量写入（单一事务，适合整本词库导入） */
export async function putAll(store, values) {
  if (!values || !values.length) return 0;
  return withStore(store, 'readwrite', (os) => {
    for (const v of values) os.put(v);
    return values.length;
  });
}

export async function del(store, key) {
  return withStore(store, 'readwrite', (os) => os.delete(key));
}

/** 批量删除（单一事务） */
export async function delAll(store, keys) {
  if (!keys || !keys.length) return 0;
  return withStore(store, 'readwrite', (os) => {
    for (const k of keys) os.delete(k);
    return keys.length;
  });
}

/** 读取整个 store */
export async function getAll(store) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/** 按索引读取（如 cards.byDeck） */
export async function getAllByIndex(store, indexName, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db
      .transaction(store, 'readonly')
      .objectStore(store)
      .index(indexName)
      .getAll(value);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/* ------------------------------- 维护操作 ------------------------------- */

/** 清空所有业务数据（保留库结构） */
export async function clearAll() {
  return withStore([STORE_DECKS, STORE_CARDS, STORE_META, STORE_LOOKUP], 'readwrite', (get) => {
    get(STORE_DECKS).clear();
    get(STORE_CARDS).clear();
    get(STORE_META).clear();
    get(STORE_LOOKUP).clear();
  });
}

/** 估算占用（字节）；浏览器不支持 estimate 时返回 0 */
export async function estimateUsage() {
  try {
    if (navigator?.storage?.estimate) {
      const { usage = 0 } = await navigator.storage.estimate();
      return usage;
    }
  } catch (e) {}
  return 0;
}
