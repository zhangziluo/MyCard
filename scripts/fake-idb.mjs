// ============================================================================
// fake-idb.mjs — Node 测试用的最小 IndexedDB 桩（覆盖 js/idb.js 用到的能力）
//   安装: installFakeIndexedDB() → globalThis.indexedDB
//   数据保存在闭包内，同一进程内多个 store.js 实例共享（用于验证「重载后仍在」）
// ============================================================================

function okReq(result) {
  const r = { result, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
  setTimeout(() => {
    if (r.onsuccess) r.onsuccess();
  }, 0);
  return r;
}

class FakeStore {
  constructor(def) {
    this.def = def;
  }
  put(value) {
    this.def.records.set(value[this.def.keyPath], value);
    this.def.dirty = true;
    return okReq(value[this.def.keyPath]);
  }
  get(key) {
    return okReq(this.def.records.get(key));
  }
  delete(key) {
    this.def.records.delete(key);
    return okReq(undefined);
  }
  clear() {
    this.def.records.clear();
    return okReq(undefined);
  }
  getAll() {
    return okReq([...this.def.records.values()]);
  }
  index(name) {
    const idx = this.def.indexes.get(name);
    const records = this.def.records;
    return {
      getAll: (value) => okReq([...records.values()].filter((r) => r[idx.keyPath] === value))
    };
  }
}

class FakeTx {
  constructor(db, names) {
    this.db = db;
    this.names = names;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    setTimeout(() => {
      if (this.oncomplete) this.oncomplete();
    }, 0);
  }
  objectStore(name) {
    const def = this.db.stores.get(name);
    if (!def) throw new Error('No objectStore: ' + name);
    return new FakeStore(def);
  }
  abort() {
    if (this.onabort) this.onabort();
  }
}

class FakeDb {
  constructor(name, version) {
    this.name = name;
    this.version = version;
    this.stores = new Map();
    const self = this;
    this.objectStoreNames = {
      contains: (n) => self.stores.has(n)
    };
  }
  createObjectStore(name, opts = {}) {
    const def = { keyPath: opts.keyPath || 'id', indexes: new Map(), records: new Map() };
    this.stores.set(name, def);
    return {
      createIndex: (indexName, keyPath) => def.indexes.set(indexName, { keyPath })
    };
  }
  transaction(names, _mode) {
    const list = Array.isArray(names) ? names : [names];
    return new FakeTx(this, list);
  }
}

/** 安装 fake IndexedDB，返回内部 DB 注册表（便于断言） */
export function installFakeIndexedDB() {
  const dbs = new Map();
  globalThis.indexedDB = {
    open(name, version) {
      const r = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      setTimeout(() => {
        let db = dbs.get(name);
        const isNew = !db;
        if (isNew) {
          db = new FakeDb(name, version);
          dbs.set(name, db);
        }
        // 版本升级（v2 → v3 等）也要触发 upgradeneeded：idb.js 用 contains 增量补建 store
        const upgrading = isNew || Number(version) > db.version;
        if (Number(version) > db.version) db.version = version;
        r.result = db;
        if (upgrading && r.onupgradeneeded) r.onupgradeneeded();
        if (r.onsuccess) r.onsuccess();
      }, 0);
      return r;
    }
  };
  return dbs;
}

/** 读取某个 fake store 的全部记录（测试断言用） */
export function dumpStore(dbs, dbName, storeName) {
  const db = dbs.get(dbName);
  if (!db) return [];
  const def = db.stores.get(storeName);
  return def ? [...def.records.values()] : [];
}
