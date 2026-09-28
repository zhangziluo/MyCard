// ============================================================================
// store.js — 数据层
//
// 存储策略（v0.4）：
//   1. 卡组正文 + 学习进度 → IndexedDB（js/idb.js）
//        库 mycard：decks（卡组元信息）/ cards（卡片+进度，索引 byDeck）/ meta
//   2. localStorage 只保留：设置 + 卡组清单摘要（key: mycard-meta）
//   3. 环境不支持 IndexedDB（Node 单测 / 极老浏览器）→ 回退到整库 localStorage
//        （key: mycard-v1，与旧版行为一致）
//
// 兼容性：对外 API 全部保持「同步内存读 + 异步落盘」，
// 因此 decks.js / review.js / test.js 无需感知存储介质；
// 启动时由 app.js 先 await store.init() 完成水合（hydration）。
// ============================================================================

import { DEFAULT_PER_LEVEL, clampPerLevel, splitCards, suggestLevelForNewCard, resplitLevels } from './levels.js';
import * as sched from './scheduler.js';
import * as idb from './idb.js';
import * as revlog from './revlog.js';
import * as wordbook from './wordbook.js';
import { arrangeCards } from './arrange.js';

/** 旧版整库 key（IndexedDB 不可用时的回退；迁移完成后会被删除以释放空间） */
export const STORAGE_KEY = 'mycard-v1';
/** 精简元数据 key（设置 + 卡组清单摘要） */
export const META_KEY = 'mycard-meta';
const MIGRATION_KEY = 'migrated';

export function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function defaultDb() {
  return { version: 1, seededDemo: false, settings: { cardsPerLevel: DEFAULT_PER_LEVEL }, decks: [] };
}

/* ------------------------------ 数据规范化 ------------------------------ */

/**
 * 提取并校验「复习进度」字段（缺省 / 非法 → 新卡）。
 * normalizeCard（落库）与导入路径（seedBuiltinDeck / addManyCards）共用，
 * 使 JSON 导出的复习状态在导入时得以保留。
 */
export function pickScheduling(src) {
  const s = src || {};
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const reps = num(s.repetitions);
  const interval = num(s.interval);
  const ease = num(s.easeFactor);
  const due = num(s.due);
  const last = num(s.lastReview);
  return {
    state: ['new', 'learning', 'review'].includes(s.state) ? s.state : 'new',
    repetitions: reps != null && reps > 0 ? Math.floor(reps) : 0,
    interval: interval != null && interval > 0 ? interval : 0,
    easeFactor: ease != null ? Math.max(1.3, Math.min(3.0, ease)) : 2.5,
    due: due != null && due > 0 ? due : 0,
    lastReview: last != null && last > 0 ? last : null
  };
}

function normalizeCard(c) {
  const now = Date.now();
  return {
    id: c.id || uid(),
    front: String(c.front ?? ''),
    back: String(c.back ?? ''),
    example: c.example ?? '',
    exampleZh: c.exampleZh ?? '',
    phonetic: String(c.phonetic ?? ''),
    tags: Array.isArray(c.tags) ? c.tags.map(String) : [],
    groups: Array.isArray(c.groups) ? c.groups.map(String) : [],
    extraBacks: Array.isArray(c.extraBacks) ? c.extraBacks.map(String) : [],
    createdAt: c.createdAt || now,
    level: Number.isInteger(c.level) && c.level >= 0 ? c.level : 0,
    ...pickScheduling(c),
    src: typeof c.src === 'string' && c.src ? c.src : null, // 来源（online_lookup / batch_import / …）
    addedAt: c.addedAt || null // 加入时间（查词/导入时间）
  };
}

function normalizeDeck(d) {
  return {
    id: d.id || uid(),
    name: String(d.name || '未命名卡组'),
    description: String(d.description || ''),
    tags: Array.isArray(d.tags) ? d.tags.map(String) : [],
    paused: !!d.paused,
    cardsPerLevel: d.cardsPerLevel == null ? null : clampPerLevel(d.cardsPerLevel),
    createdAt: d.createdAt || Date.now(),
    demo: !!d.demo,
    source: typeof d.source === 'string' && d.source ? d.source : null,
    passedLevels: d.passedLevels ? { ...d.passedLevels } : {},
    cards: Array.isArray(d.cards) ? d.cards.map(normalizeCard) : [],
    // 复习日志：IndexedDB 模式下独立存于 revlog 表；回退模式下随卡组整库保存
    revlogs: Array.isArray(d.revlogs) ? d.revlogs.filter(Boolean) : []
  };
}

function normalize(raw) {
  const d = defaultDb();
  if (raw && typeof raw === 'object') {
    d.seededDemo = !!raw.seededDemo;
    if (raw.settings && typeof raw.settings === 'object') {
      d.settings.cardsPerLevel = clampPerLevel(raw.settings.cardsPerLevel);
    }
    d.decks = Array.isArray(raw.decks) ? raw.decks.map(normalizeDeck) : [];
  }
  return d;
}

/** 卡组元信息（写入 IndexedDB decks / localStorage 摘要用，不含 cards） */
function deckMetaOf(deck) {
  return {
    id: deck.id,
    name: deck.name,
    description: deck.description,
    tags: [...(deck.tags || [])],
    paused: !!deck.paused,
    cardsPerLevel: deck.cardsPerLevel ?? null,
    createdAt: deck.createdAt,
    demo: !!deck.demo,
    source: deck.source ?? null,
    passedLevels: { ...(deck.passedLevels || {}) },
    cardCount: (deck.cards || []).length
  };
}

/* ------------------------------ 内存库 / 读取 ------------------------------ */

let db = null;
let idbReady = false;

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.warn('[store] localStorage 写入失败:', e);
    return false;
  }
}

/**
 * 取内存库。首次调用按顺序水合：
 *   1) localStorage 精简元数据（mycard-meta，IndexedDB 模式）
 *   2) localStorage 旧版整库（mycard-v1，回退模式）
 *   3) 全新空库
 * IndexedDB 模式下的卡片正文由 init() 水合，故 app.js 必须先 await init()。
 */
export function getDb() {
  if (db) return db;
  const meta = readJson(META_KEY);
  if (meta) {
    db = normalize(meta);
    return db;
  }
  const legacy = readJson(STORAGE_KEY);
  if (legacy) {
    db = normalize(legacy);
    return db;
  }
  db = defaultDb();
  return db;
}

export function isIdbReady() {
  return idbReady;
}

/* ------------------------------ 持久化 ------------------------------ */

/** 精简元数据（localStorage）：设置 + 卡组清单摘要 */
function persistMeta() {
  const d = getDb();
  writeJson(META_KEY, {
    version: d.version,
    seededDemo: d.seededDemo,
    settings: { ...d.settings },
    idb: idbReady,
    decks: d.decks.map(deckMetaOf)
  });
}

/** 回退模式：整库写入 localStorage（与旧版一致） */
function legacyPersist() {
  writeJson(STORAGE_KEY, getDb());
}

/* ---- IndexedDB 增量落盘（写穿 + 合并防抖） ---- */

let pendingDecks = new Map(); // id -> deck meta
let pendingCards = new Map(); // cardId -> card record（含 deckId）
let pendingRevlogs = new Map(); // 日志 id -> 日志记录（含 deckId / cardId）
let deletedDeckIds = new Set();
let deletedCardIds = new Set();
let flushTimer = null;

function scheduleFlush() {
  if (!idbReady || flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushPending();
  }, 250);
}

/** 立即把待写数据落到 IndexedDB（返回写入条数，供测试/退出前调用） */
export async function flushPending() {
  const decks = [...pendingDecks.values()];
  const cards = [...pendingCards.values()];
  const logs = [...pendingRevlogs.values()];
  const delDecks = [...deletedDeckIds];
  const delCards = [...deletedCardIds];
  pendingDecks = new Map();
  pendingCards = new Map();
  pendingRevlogs = new Map();
  deletedDeckIds = new Set();
  deletedCardIds = new Set();
  if (!idbReady) return 0;
  let written = 0;
  try {
    if (delDecks.length) await idb.delAll(idb.STORE_DECKS, delDecks);
    if (delCards.length) await idb.delAll(idb.STORE_CARDS, delCards);
    if (decks.length) await idb.putAll(idb.STORE_DECKS, decks);
    if (cards.length) await idb.putAll(idb.STORE_CARDS, cards);
    if (logs.length) await idb.putAll(idb.STORE_REVLOG, logs);
    written = decks.length + cards.length + logs.length + delDecks.length + delCards.length;
    persistMeta();
  } catch (e) {
    console.warn('[store] IndexedDB 写入失败', e);
  }
  return written;
}

export function queueDeck(deck) {
  if (!idbReady || !deck) return;
  pendingDecks.set(deck.id, deckMetaOf(deck));
  scheduleFlush();
}

/** 单卡写穿（自动补 deckId） */
export function queueCard(deckId, card) {
  if (!idbReady || !card) return;
  pendingCards.set(card.id, { ...normalizeCard(card), deckId });
  scheduleFlush();
}

export function queueCards(deckId, cards) {
  for (const c of cards || []) queueCard(deckId, c);
}

export function queueDeleteCard(cardId) {
  if (!idbReady || !cardId) return;
  pendingCards.delete(cardId);
  deletedCardIds.add(cardId);
  purgeRevlogs({ cardId }); // 卡片没了，其复习日志一并清理
  scheduleFlush();
}

export function queueDeleteDeck(deckId) {
  if (!idbReady || !deckId) return;
  pendingDecks.delete(deckId);
  deletedDeckIds.add(deckId);
  purgeRevlogs({ deckId }); // 卡组没了，其复习日志一并清理
  scheduleFlush();
}

/**
 * 清理复习日志（异步、不阻塞调用方；失败仅告警）。
 * @param {{deckId?:string, cardId?:string}} where 给出 deckId 走 byDeck，给出 cardId 走 byCard
 */
function purgeRevlogs(where = {}) {
  const { deckId, cardId } = where;
  if (!deckId && !cardId) return;
  const hit = (r) => (deckId ? r.deckId === deckId : false) || (cardId ? r.cardId === cardId : false);
  for (const [id, r] of pendingRevlogs) if (hit(r)) pendingRevlogs.delete(id);
  if (!idbReady) {
    // 回退模式：日志随卡组存在内存里，直接过滤（必要时整库回写）
    let changed = false;
    for (const deck of getDb().decks) {
      if (!Array.isArray(deck.revlogs) || !deck.revlogs.length) continue;
      if (deckId && deck.id !== deckId) continue;
      const kept = deck.revlogs.filter((r) => !hit(r));
      if (kept.length !== deck.revlogs.length) {
        deck.revlogs = kept;
        changed = true;
      }
    }
    if (changed) legacyPersist();
    return;
  }
  const index = deckId ? 'byDeck' : 'byCard';
  idb
    .getAllByIndex(idb.STORE_REVLOG, index, deckId || cardId)
    .then((list) => (list && list.length ? idb.delAll(idb.STORE_REVLOG, list.map((r) => r.id)) : 0))
    .catch(() => {});
}

/** 统一持久化入口：IndexedDB 模式写精简元数据，回退模式写整库 */
export function persist() {
  if (idbReady) {
    persistMeta();
    scheduleFlush();
  } else {
    legacyPersist();
  }
}

/* ------------------------------ 启动水合 / 迁移 ------------------------------ */

/**
 * 初始化存储：打开 IndexedDB → 迁移旧版 localStorage 整库 → 水合到内存。
 * 必须在首次渲染前 await。IndexedDB 不可用时返回 { idb:false }。
 */
export async function init() {
  if (!idb.isAvailable()) {
    console.warn('[store] 当前环境不支持 IndexedDB，回退到 localStorage 整库模式');
    getDb();
    return { idb: false, decks: getDb().decks.length, cards: 0 };
  }

  try {
    await idb.openDb();
  } catch (e) {
    console.warn('[store] 打开 IndexedDB 失败，回退到 localStorage 整库模式', e);
    getDb();
    return { idb: false, decks: getDb().decks.length, cards: 0 };
  }

  // 1) 迁移：旧版 mycard-v1（整库）→ IndexedDB
  const migrated = await idb.get(idb.STORE_META, MIGRATION_KEY).catch(() => null);
  if (!migrated) {
    const legacy = readJson(STORAGE_KEY);
    const existing = await idb.getAll(idb.STORE_DECKS).catch(() => []);
    if (legacy && Array.isArray(legacy.decks) && legacy.decks.length && !existing.length) {
      const decks = legacy.decks.map((x) => {
        const deck = normalizeDeck(x);
        if (!deck.source && deck.demo) deck.source = 'demo'; // 旧版示范卡组补 source
        return deck;
      });
      await idb.putAll(idb.STORE_DECKS, decks.map(deckMetaOf));
      const cards = [];
      for (const deck of decks) {
        for (const card of deck.cards) cards.push({ ...card, deckId: deck.id });
      }
      await idb.putAll(idb.STORE_CARDS, cards);
      db = { ...defaultDb(), ...normalize(legacy), decks };
      idbReady = true;
      persistMeta();
      try {
        localStorage.removeItem(STORAGE_KEY); // 迁移完成，释放 localStorage 空间
      } catch (e) {}
      console.log(`[store] 已从 localStorage 迁移到 IndexedDB：${decks.length} 个卡组 / ${cards.length} 张卡片`);
      return { idb: true, decks: decks.length, cards: cards.length, migrated: true };
    }
    await idb.put(idb.STORE_META, { key: MIGRATION_KEY, at: Date.now() });
  }

  // 2) 水合：decks（元信息）+ cards（正文与进度）
  const metaDecks = await idb.getAll(idb.STORE_DECKS).catch(() => []);
  const allCards = await idb.getAll(idb.STORE_CARDS).catch(() => []);
  const byDeck = new Map();
  for (const rec of allCards) {
    const list = byDeck.get(rec.deckId);
    if (list) list.push(rec);
    else byDeck.set(rec.deckId, [rec]);
  }
  const meta = readJson(META_KEY);
  const settings = meta && meta.settings ? { cardsPerLevel: clampPerLevel(meta.settings.cardsPerLevel) } : null;
  idbReady = true;
  db = {
    version: 1,
    seededDemo: !!(meta && meta.seededDemo),
    settings: settings || { cardsPerLevel: DEFAULT_PER_LEVEL },
    decks: metaDecks.map((m) => ({
      ...normalizeDeck({ ...m, cards: [] }),
      // 旧版示范卡组没有 source → 回填 'demo'，避免首页把它当成未导入而重复导入
      source: m.source || (m.demo ? 'demo' : null),
      cards: (byDeck.get(m.id) || []).map((rec) => normalizeCard(rec))
    }))
  };
  persistMeta();
  return { idb: true, decks: db.decks.length, cards: allCards.length };
}

/* ------------------------------ 设置 / 重置 ------------------------------ */

export function setSetting(key, value) {
  const d = getDb();
  if (key === 'cardsPerLevel') {
    const next = clampPerLevel(value);
    const changed = d.settings.cardsPerLevel !== next;
    d.settings.cardsPerLevel = next;
    persist();
    // 跟随全局设置的卡组（cardsPerLevel == null）需要按新词数重新分组
    if (changed) {
      for (const deck of d.decks) {
        if (deck.cardsPerLevel == null && deck.cards && deck.cards.length) resplitDeck(deck.id);
      }
    }
    return;
  }
  d.settings[key] = value;
  persist();
}

/**
 * 按新的「每关卡片数」重新划分某个卡组的关卡（保持卡片顺序与学习进度，仅重写 level）。
 * @param {string} deckId
 * @param {number|null} per 省略时用卡组设置 / 全局设置
 * @returns {number} 关卡数
 */
export function resplitDeck(deckId, per = null) {
  const deck = getDeck(deckId);
  if (!deck || !deck.cards.length) return 0;
  const use = clampPerLevel(
    per == null ? deck.cardsPerLevel ?? getDb().settings.cardsPerLevel ?? DEFAULT_PER_LEVEL : per
  );
  const before = deck.cards.map((c) => (Number.isInteger(c.level) ? c.level : 0));
  const groups = resplitLevels(deck.cards, use);
  const changed = deck.cards.filter((c, i) => c.level !== before[i]);
  persist();
  queueDeck(deck);
  if (changed.length) queueCards(deckId, changed); // 只写回关卡发生变化的卡片
  return groups.length;
}

export function resetAll() {
  db = defaultDb();
  idbReady = false; // 先停落盘，避免清库后又被写回
  pendingDecks = new Map();
  pendingCards = new Map();
  pendingRevlogs = new Map();
  deletedDeckIds = new Set();
  deletedCardIds = new Set();
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(META_KEY);
  } catch (e) {}
  if (idb.isAvailable()) {
    idb
      .clearAll()
      .then(() => idb.put(idb.STORE_META, { key: MIGRATION_KEY, at: Date.now() }))
      .catch((e) => console.warn('[store] 清空 IndexedDB 失败', e));
  }
}

/** 存储概览（设置页展示） */
export function storageInfo() {
  const d = getDb();
  const cards = d.decks.reduce((n, x) => n + x.cards.length, 0);
  let localBytes = 0;
  try {
    const raw = localStorage.getItem(META_KEY) || localStorage.getItem(STORAGE_KEY) || '';
    localBytes = raw.length * 2;
  } catch (e) {}
  return { mode: idbReady ? 'indexeddb' : 'localstorage', decks: d.decks.length, cards, localBytes };
}

/* ------------------------------ 卡组 CRUD ------------------------------ */

export function createDeck(fields = {}) {
  const d = getDb();
  const deck = {
    id: uid(),
    name: String(fields.name || '新卡组'),
    description: String(fields.description || ''),
    tags: Array.isArray(fields.tags) ? fields.tags.map(String) : [],
    paused: false,
    cardsPerLevel:
      fields.cardsPerLevel == null || fields.cardsPerLevel === '' ? null : clampPerLevel(fields.cardsPerLevel),
    createdAt: Date.now(),
    demo: false,
    source: fields.source ? String(fields.source) : null,
    passedLevels: {},
    cards: []
  };
  d.decks.push(deck);
  persist();
  queueDeck(deck);
  return deck;
}

export function getDeck(id) {
  return getDb().decks.find((x) => x.id === id) || null;
}

export function getDeckBySource(source) {
  return getDb().decks.find((x) => x.source === source) || null;
}

export function updateDeck(id, patch) {
  const deck = getDeck(id);
  if (!deck) return null;
  let perChanged = false;
  if ('name' in patch) deck.name = String(patch.name);
  if ('description' in patch) deck.description = String(patch.description);
  if ('tags' in patch) deck.tags = (patch.tags || []).map(String);
  if ('paused' in patch) deck.paused = !!patch.paused;
  if ('cardsPerLevel' in patch) {
    const next =
      patch.cardsPerLevel == null || patch.cardsPerLevel === '' ? null : clampPerLevel(patch.cardsPerLevel);
    if (deck.cardsPerLevel !== next) perChanged = true;
    deck.cardsPerLevel = next;
  }
  persist();
  queueDeck(deck);
  // 每关词数变化 → 立即按新词数重新划分该卡组的关卡（保持卡片顺序与学习进度）
  if (perChanged) resplitDeck(deck.id, deck.cardsPerLevel);
  return deck;
}

export function deleteDeck(id) {
  const d = getDb();
  const deck = d.decks.find((x) => x.id === id);
  d.decks = d.decks.filter((x) => x.id !== id);
  if (deck && idbReady) {
    for (const c of deck.cards) queueDeleteCard(c.id);
    queueDeleteDeck(id);
  }
  persist();
}

export function togglePause(id) {
  const deck = getDeck(id);
  if (!deck) return null;
  deck.paused = !deck.paused;
  persist();
  queueDeck(deck);
  return deck;
}

/* --------------------------- 用户生词卡组（查词/词表加入） --------------------------- */

export const USER_DECK_NAME = '我的生词';

/** 「我的生词」卡组（不存在返回 null） */
export function getUserDeck() {
  return getDb().decks.find((x) => x.source === 'custom') || null;
}

/** 取「我的生词」卡组，不存在则创建（source='custom' 便于与内置词库区分） */
export function ensureUserDeck() {
  return getUserDeck() || createDeck({ name: USER_DECK_NAME, description: '通过在线查词/词表加入的生词', tags: ['生词'], source: 'custom' });
}

/**
 * 把查词/导入结果追加到「我的生词」卡组（按 word 去重）。
 * v0.5.9：`merge: true` 时，已存在的词不直接跳过，而是把新释义/例句/标签**合并**进原卡片
 *        （原 back 始终是第一义，新释义追加为 extraBacks；复习进度不动）。
 * @param {Array} items [{ word, ipa, phonetic, back, extraBacks, example, exampleZh, tags }]
 * @param {object} opts  { src: 'online_lookup' | 'batch_import', merge: boolean }
 * @returns {{ deck:object, added:number, merged:number, skipped:number, words:string[], mergedWords:string[] }}
 */
export function addWords(items, { src = 'online_lookup', merge = false } = {}) {
  const deck = ensureUserDeck();
  const index = new Map(); // normKey(front) → 卡片（同一个词只认第一张）
  for (const c of deck.cards) {
    const key = wordbook.normKey(c.front);
    if (key && !index.has(key)) index.set(key, c);
  }
  const fresh = [];
  const skippedWords = [];
  const mergedWords = [];
  const mergedCards = [];
  for (const it of items || []) {
    const front = String((it && (it.word ?? it.front)) || '').trim();
    if (!front) continue;
    const key = wordbook.normKey(front);
    const hit = index.get(key);
    if (hit) {
      const res = merge ? wordbook.mergeInto(hit, it) : { changed: false };
      if (res.changed) {
        applyCardFields(hit, res.patch);
        if (!mergedCards.includes(hit)) mergedCards.push(hit);
        mergedWords.push(front);
      } else {
        skippedWords.push(front);
      }
      continue;
    }
    const card = {
      front,
      back: String(it.back ?? ''),
      example: it.example ?? '',
      exampleZh: it.exampleZh ?? '',
      phonetic: String(it.phonetic ?? it.ipa ?? ''),
      tags: Array.isArray(it.tags) ? it.tags.map(String) : [],
      groups: [],
      extraBacks: Array.isArray(it.extraBacks) ? it.extraBacks.map(String) : [],
      src,
      addedAt: Date.now()
    };
    index.set(key, card);
    fresh.push(card);
  }
  if (fresh.length) addManyCards(deck.id, fresh);
  if (mergedCards.length) {
    persist();
    queueCards(deck.id, mergedCards);
  }
  return {
    deck: getDeck(deck.id),
    added: fresh.length,
    merged: mergedWords.length,
    skipped: skippedWords.length,
    words: fresh.map((f) => f.front),
    mergedWords
  };
}

/* ------------------------------ 卡片 CRUD ------------------------------ */

export function addCard(deckId, fields = {}) {
  const deck = getDeck(deckId);
  if (!deck) return null;
  const level = suggestLevelForNewCard(deck);
  const card = {
    id: uid(),
    front: String(fields.front ?? ''),
    back: String(fields.back ?? ''),
    example: fields.example ?? '',
    exampleZh: fields.exampleZh ?? '',
    phonetic: String(fields.phonetic ?? ''),
    tags: Array.isArray(fields.tags) ? fields.tags.map(String) : [],
    groups: Array.isArray(fields.groups) ? fields.groups.map(String) : [],
    extraBacks: Array.isArray(fields.extraBacks) ? fields.extraBacks.map(String) : [],
    createdAt: Date.now(),
    level,
    state: 'new',
    repetitions: 0,
    interval: 0,
    easeFactor: 2.5,
    due: 0,
    lastReview: null,
    src: typeof fields.src === 'string' && fields.src ? fields.src : null,
    addedAt: fields.addedAt || null
  };
  deck.cards.push(card);
  persist();
  queueCard(deck.id, card);
  queueDeck(deck);
  return card;
}

/** 批量导入卡片（与现有卡片一起按关卡规则重新拆分并分配 level） */
export function addManyCards(deckId, items) {
  const deck = getDeck(deckId);
  if (!deck || !Array.isArray(items) || !items.length) return 0;
  const per = clampPerLevel(deck.cardsPerLevel ?? getDb().settings.cardsPerLevel ?? DEFAULT_PER_LEVEL);
  const newCards = items.map((f) => ({
    id: uid(),
    front: String(f.front ?? ''),
    back: String(f.back ?? ''),
    example: f.example ?? '',
    exampleZh: f.exampleZh ?? '',
    phonetic: String(f.phonetic ?? ''),
    tags: Array.isArray(f.tags) ? f.tags.map(String) : [],
    groups: Array.isArray(f.groups) ? f.groups.map(String) : [],
    extraBacks: Array.isArray(f.extraBacks) ? f.extraBacks.map(String) : [],
    createdAt: Date.now(),
    ...pickScheduling(f), // 复习进度随导入保留（缺省 = 新卡）
    src: typeof f.src === 'string' && f.src ? f.src : null,
    addedAt: f.addedAt || null
  }));
  const groups = splitCards([...deck.cards, ...newCards], per);
  groups.forEach((g, gi) => g.forEach((c) => (c.level = gi)));
  deck.cards = groups.flat();
  persist();
  queueCards(deck.id, deck.cards);
  queueDeck(deck);
  return newCards.length;
}

export function updateCard(deckId, cardId, patch) {
  const deck = getDeck(deckId);
  if (!deck) return null;
  const card = deck.cards.find((c) => c.id === cardId);
  if (!card) return null;
  applyCardFields(card, patch || {});
  persist();
  queueCard(deckId, card);
  return card;
}

/**
 * 把卡片字段补丁写进卡片对象（不改内存库以外的东西）。
 * updateCard / updateCards / mergeCards 三个入口共用，保证字段语义一致。
 */
function applyCardFields(card, patch = {}) {
  if ('front' in patch) card.front = String(patch.front);
  if ('back' in patch) card.back = String(patch.back);
  if ('example' in patch) card.example = patch.example ?? '';
  if ('exampleZh' in patch) card.exampleZh = patch.exampleZh ?? '';
  if ('phonetic' in patch) card.phonetic = String(patch.phonetic ?? '');
  if ('tags' in patch) card.tags = (patch.tags || []).map(String);
  if ('groups' in patch) card.groups = (patch.groups || []).map(String);
  if ('extraBacks' in patch) card.extraBacks = (patch.extraBacks || []).map(String);
  if ('level' in patch && Number.isInteger(patch.level) && patch.level >= 0) card.level = patch.level;
  // 复习流程写入调度结果
  if ('state' in patch) card.state = patch.state;
  if ('repetitions' in patch) card.repetitions = patch.repetitions;
  if ('interval' in patch) card.interval = patch.interval;
  if ('easeFactor' in patch) card.easeFactor = patch.easeFactor;
  if ('due' in patch) card.due = patch.due;
  if ('lastReview' in patch) card.lastReview = patch.lastReview;
  if ('src' in patch) card.src = typeof patch.src === 'string' && patch.src ? patch.src : null;
  if ('addedAt' in patch) card.addedAt = patch.addedAt || null;
  return card;
}

/**
 * 批量更新卡片（v0.5.9「我的生词」批量标签等）：单次 persist + 批量排队。
 * @param {string} deckId
 * @param {Array<{id:string, patch:object}>} entries
 * @returns {{ updated:number }}
 */
export function updateCards(deckId, entries) {
  const deck = getDeck(deckId);
  if (!deck || !Array.isArray(entries) || !entries.length) return { updated: 0 };
  const byId = new Map(deck.cards.map((c) => [String(c.id), c]));
  const changed = [];
  for (const e of entries) {
    const card = e ? byId.get(String(e.id)) : null;
    if (!card || !e.patch || !Object.keys(e.patch).length) continue;
    changed.push(applyCardFields(card, e.patch));
  }
  if (!changed.length) return { updated: 0 };
  persist();
  queueCards(deckId, changed);
  return { updated: changed.length };
}

/**
 * 应用「重复词合并」方案（v0.5.9）：保留主卡（复习进度与复习日志都在它身上），
 * 把合并后的字段写入主卡，再删掉多余的重复卡片（其日志级联清理）。
 * @param {string} deckId
 * @param {Array<{keepId:string, patch:object, removeIds:string[]}>} plans
 * @returns {{ kept:number, removed:number, groups:number }}
 */
export function mergeCards(deckId, plans) {
  const deck = getDeck(deckId);
  if (!deck || !Array.isArray(plans) || !plans.length) return { kept: 0, removed: 0, groups: 0 };
  const byId = new Map(deck.cards.map((c) => [String(c.id), c]));
  const dead = new Set();
  const kept = [];
  const removed = [];
  let groups = 0;
  for (const p of plans) {
    if (!p) continue;
    const keep = byId.get(String(p.keepId));
    if (!keep || dead.has(String(keep.id))) continue;
    const targets = (p.removeIds || [])
      .map((id) => byId.get(String(id)))
      .filter((c) => c && c !== keep && !dead.has(String(c.id)));
    if (!targets.length) continue;
    if (p.patch && Object.keys(p.patch).length) kept.push(applyCardFields(keep, p.patch));
    for (const t of targets) {
      dead.add(String(t.id));
      removed.push(t);
    }
    groups++;
  }
  if (!removed.length) return { kept: 0, removed: 0, groups: 0 };
  deck.cards = deck.cards.filter((c) => !dead.has(String(c.id)));
  persist();
  if (kept.length) queueCards(deckId, kept);
  if (idbReady) for (const c of removed) queueDeleteCard(c.id); // 副卡日志一并清理
  queueDeck(deck);
  return { kept: kept.length, removed: removed.length, groups };
}

/**
 * 批量删除卡片（单次 persist + 单次排队；用于「导入回滚」）。
 * @param {string} deckId
 * @param {string[]} cardIds
 */
export function deleteCards(deckId, cardIds) {
  const deck = getDeck(deckId);
  if (!deck || !Array.isArray(cardIds) || !cardIds.length) return deck || null;
  const dead = new Set(cardIds.map(String));
  const removed = deck.cards.filter((c) => dead.has(String(c.id)));
  if (!removed.length) return deck;
  deck.cards = deck.cards.filter((c) => !dead.has(String(c.id)));
  persist();
  if (idbReady) for (const c of removed) queueDeleteCard(c.id);
  queueDeck(deck);
  return deck;
}

export function deleteCard(deckId, cardId) {
  const deck = getDeck(deckId);
  if (!deck) return null;
  deck.cards = deck.cards.filter((c) => c.id !== cardId);
  persist();
  queueDeleteCard(cardId);
  queueDeck(deck);
  return deck;
}

/* ------------------------------ 通关 / 学完 ------------------------------ */

/** 通关写入：记录该关卡已通过测试（正确率 ≥ 80% 时调用） */
export function markLevelPassed(deckId, levelIndex) {
  const deck = getDeck(deckId);
  if (!deck) return null;
  if (!deck.passedLevels) deck.passedLevels = {};
  deck.passedLevels[levelIndex] = true;
  persist();
  queueDeck(deck);
  return deck;
}

/** 清除某关卡通关记录 */
export function unmarkLevelPassed(deckId, levelIndex) {
  const deck = getDeck(deckId);
  if (!deck) return null;
  if (deck.passedLevels) {
    delete deck.passedLevels[levelIndex];
    persist();
    queueDeck(deck);
  }
  return deck;
}

/**
 * 通关即学完：把该关「尚未复习过」的卡片按「记住(good)」推进为已学。
 * 用于「跳过翻面、直接测试通过」时补齐学习状态，使关卡满足通关条件；
 * 已有复习进度的卡片不受影响（不会重置）。
 */
export function markLevelLearned(deckId, levelIndex, now = Date.now()) {
  const deck = getDeck(deckId);
  if (!deck) return null;
  const idx = Number(levelIndex);
  let changed = false;
  for (const c of deck.cards) {
    const lvIdx = Number.isInteger(c.level) ? c.level : 0;
    if (lvIdx !== idx || c.lastReview != null) continue;
    Object.assign(c, sched.applyFeedback(c, 'good', now));
    queueCard(deckId, c);
    changed = true;
  }
  if (changed) {
    persist();
    queueDeck(deck);
  }
  return deck;
}

/* ------------------------------ 复习日志（revlog，v0.5.8） ------------------------------ */

/**
 * 写入一条复习日志（评分瞬间调用；同步、不阻塞 UI）。
 * 存储位置：IndexedDB revlog 表（不支持 IDB 时随卡组存于整库 localStorage）。
 * @param {string} deckId
 * @param {object} before 评分前的卡片
 * @param {string} feedback 'again' | 'hard' | 'good' | 'easy'
 * @param {object} after  评分后的调度结果（sched.applyFeedback 返回值）
 * @param {{ now?:number, timeMs?:number }} [opts] timeMs = 该卡停留毫秒
 * @returns {object|null} 写入的日志条目（参数不合法时为 null）
 */
export function recordReview(deckId, before, feedback, after, { now = Date.now(), timeMs = 0 } = {}) {
  if (!before || !before.id) return null;
  const entry = revlog.makeEntry({ cardId: before.id, ts: now, feedback, before, after: after || before, timeMs });
  if (!entry || !getDeck(deckId)) return null;
  queueRevlog({ ...entry, deckId });
  return entry;
}

/** 写入 / 覆盖一条日志（自动补 deckId；回退模式下写进卡组对象） */
function queueRevlog(entry) {
  if (!entry || !entry.id || !entry.deckId) return;
  if (!idbReady) {
    const deck = getDb().decks.find((x) => x.id === entry.deckId);
    if (!deck) return;
    if (!Array.isArray(deck.revlogs)) deck.revlogs = [];
    const i = deck.revlogs.findIndex((r) => r.id === entry.id);
    if (i >= 0) deck.revlogs[i] = entry;
    else deck.revlogs.push(entry);
    legacyPersist();
    return;
  }
  pendingRevlogs.set(entry.id, entry);
  scheduleFlush();
}

/**
 * 导入外部日志（JSON 回导 / 测试）：只接受属于本卡组已有卡片的条目，返回写入条数。
 * @param {string} deckId
 * @param {Array} entries [{ cardId, ts, ease, type, ivl, lastIvl, factor, time }]
 */
export function importRevlogs(deckId, entries) {
  const deck = getDeck(deckId);
  const list = Array.isArray(entries) ? entries : [];
  if (!deck || !list.length) return 0;
  const known = new Set(deck.cards.map((c) => c.id));
  let n = 0;
  for (const raw of list) {
    const e = revlog.sanitizeEntry(raw);
    if (!e || !known.has(e.cardId)) continue;
    queueRevlog({ ...e, deckId: deck.id });
    n++;
  }
  return n;
}

/** 某卡组的全部复习日志（时间升序；含尚未落盘的最新一批） */
export async function revlogsOfDeck(deckId) {
  const id = String(deckId || '');
  if (!id) return [];
  const map = new Map();
  const deck = getDeck(id);
  for (const r of (deck && deck.revlogs) || []) map.set(r.id, r); // 回退模式 / 内存兜底
  if (idbReady) {
    try {
      const stored = await idb.getAllByIndex(idb.STORE_REVLOG, 'byDeck', id);
      for (const r of stored) map.set(r.id, r);
    } catch (e) {}
  }
  for (const r of pendingRevlogs.values()) if (r.deckId === id) map.set(r.id, r); // 未落盘的优先
  return revlog.sortEntries([...map.values()]);
}

/** 某张卡的复习日志（时间升序） */
export async function revlogsOfCard(deckId, cardId) {
  const list = await revlogsOfDeck(deckId);
  const key = String(cardId || '');
  return list.filter((r) => r.cardId === key);
}

/** 卡组复习日志汇总 { total, lapses, timeMs, first, last, ease } */
export async function revlogStats(deckId) {
  return revlog.summarize(await revlogsOfDeck(deckId));
}

/* ------------------------------ 其它查询 ------------------------------ */

/** 全部标签（去重排序） */
export function allTags() {
  const set = new Set();
  for (const d of getDb().decks) d.tags.forEach((t) => set.add(t));
  return [...set].sort((a, b) => a.localeCompare(b, 'zh'));
}

/* ------------------------------ 内置词库导入 ------------------------------ */

/**
 * 内置词库通用导入。
 *  - demo=true            → 卡组打「示范」标记；已存在任一示范卡组则不重复导入
 *  - source=null（普通卡组）→ 不记录来源
 *  - meta={name,tags,description,lang} → 用清单里的正确元数据覆盖 payload 自带的
 * 自动完成「难度分层 + 错峰排列 + 动态调序」的关卡编排。
 */
export function seedBuiltinDeck(payload, { demo = true, source = null, meta = null, groupsMap = {}, arrange = true } = {}) {
  const d = getDb();
  // 去重：示范词库按 demo 标记，其余按 source（旧版数据可能没有 source，故 demo 单独判）
  const already = demo
    ? d.decks.some((x) => x.demo)
    : source
      ? d.decks.some((x) => x.source === source)
      : false;
  if (already) return null;
  const words = Array.isArray(payload && payload.words) ? payload.words : [];
  if (!words.length) return null;

  const gm = payload.groupsMap && typeof payload.groupsMap === 'object' ? payload.groupsMap : groupsMap || {};
  const extraDefs = payload.extraDefs && typeof payload.extraDefs === 'object' ? payload.extraDefs : {};

  const per = clampPerLevel(meta?.levelSize ?? payload.levelSize ?? d.settings.cardsPerLevel ?? DEFAULT_PER_LEVEL);
  const deck = {
    id: uid(),
    name: String(meta?.name || payload.name || '内置词库'),
    description: String(meta?.description || payload.description || ''),
    tags: Array.isArray(meta?.tags) ? meta.tags.map(String) : Array.isArray(payload.tags) ? payload.tags.map(String) : demo ? ['示范'] : ['内置'],
    paused: false,
    cardsPerLevel: null, // 跟随全局设置
    createdAt: Date.now(),
    demo,
    source: source ? String(source) : null,
    passedLevels: {},
    cards: []
  };
  const lang = meta?.lang || 'en';

  const items = words.map((w) => {
    const wordKey = String(w.front ?? w.word ?? '');
    // 词条自带的分组 / 多释义优先（JSON 完整导出会带上），否则回退到易混词表
    const groupsFromDefs = Array.isArray(gm[wordKey]) ? gm[wordKey].map(String) : [];
    const extraFromDefs = Array.isArray(extraDefs[wordKey]) ? extraDefs[wordKey].map(String) : [];
    return {
      id: uid(),
      front: wordKey,
      back: String(w.back ?? w.meaningZh ?? ''),
      example: w.example ?? '',
      exampleZh: w.exampleZh ?? '',
      phonetic: String(w.phonetic ?? ''),
      tags: Array.isArray(w.tags) ? w.tags.map(String) : [],
      groups: Array.isArray(w.groups) && w.groups.length ? w.groups.map(String) : groupsFromDefs,
      extraBacks: Array.isArray(w.extraBacks) && w.extraBacks.length ? w.extraBacks.map(String) : extraFromDefs,
      createdAt: Date.now(),
      ...pickScheduling(w) // 复习进度随导入保留（缺省 = 新卡）
    };
  });

  const levels = arrange
    ? arrangeCards(items, { perLevel: per, groupsMap: gm, lang })
    : splitCards(items, per);
  levels.forEach((g, gi) => g.forEach((c) => (c.level = gi)));
  deck.cards = levels.flat();

  d.decks.unshift(deck);
  if (demo) d.seededDemo = true;
  persist();
  queueDeck(deck);
  queueCards(deck.id, deck.cards);
  return deck;
}

/** 导入示范词库（data/words.json + data/confusables.json 已在 payload 中合并），已存在则跳过 */
export function seedDemoDeck(payload) {
  return seedBuiltinDeck(payload, { demo: true, source: 'demo' });
}

/** 是否已有示范卡组 */
export function hasDemoDeck() {
  return getDb().decks.some((x) => x.demo);
}

/** 是否已存在某来源的卡组（demo / custom 等） */
export function hasSource(source) {
  return getDb().decks.some((x) => x.source === source);
}

/**
 * 已下线的内置词库来源：旧版本曾「自动导入考研词库 / 首页按需导入」这些考试词库，
 * 现已全部从应用中移除。这里按 source 精确匹配清理浏览器里遗留的历史数据。
 */
export const REMOVED_BUILTIN_SOURCES = [
  'kaoyan',
  'chuzhong',
  'gaozhong',
  'cet4',
  'cet6',
  'sat',
  'toefl',
  'ielts',
  'tem4',
  'tem8'
];

/**
 * 清理旧版本内置词库（启动时调用一次；幂等）。只删除 source 命中的内置卡组，
 * 用户自建卡组（source=null）、示范卡组（demo）与「我的生词」（custom）不受影响。
 * @returns {{ count:number, names:string[] }}
 */
export function purgeRemovedBuiltins() {
  const targets = getDb().decks.filter((x) => x.source && REMOVED_BUILTIN_SOURCES.includes(x.source));
  const names = [];
  for (const deck of targets) {
    names.push(deck.name);
    deleteDeck(deck.id); // 同步移出内存 + 排队删除 IndexedDB 中的卡组与卡片 + 落盘
  }
  return { count: targets.length, names };
}

/**
 * 为已存在的示范卡组补标易混组/多释义（v0.2 升级用，保留学习进度）。
 * 只对尚缺该字段的卡片写入，不改动其复习状态。
 */
export function attachConfusables(deckId, { groupsMap = {}, extraDefs = {} } = {}) {
  const deck = getDeck(deckId);
  if (!deck || !deck.demo) return false;
  let changed = false;
  for (const c of deck.cards) {
    const key = c.front;
    const gs = Array.isArray(groupsMap[key]) ? groupsMap[key].map(String) : [];
    const es = Array.isArray(extraDefs[key]) ? extraDefs[key].map(String) : [];
    if (!Array.isArray(c.groups) || !c.groups.length) {
      c.groups = gs;
      if (gs.length) changed = true;
    }
    if (!Array.isArray(c.extraBacks) || !c.extraBacks.length) {
      c.extraBacks = es;
      if (es.length) changed = true;
    }
    if (changed) queueCard(deckId, c);
  }
  if (changed) {
    persist();
    queueDeck(deck);
  }
  return changed;
}

/* --------------------------- 动态调序（重排关卡） --------------------------- */

/**
 * 按难度重新编排某卡组的关卡（保留每张卡的学习进度，只改 card.level）。
 * 结合错题池（test-engine priority）与困难词（hardwords），把反复错记的卡片
 * 提升到 activeLevel（默认「第一个未通关关卡」）尽快重现。
 *
 * @returns {{ levels:number, moved:number }} 关卡数与发生关卡变动的卡片数
 */
export function rearrangeDeck(deckId, opts = {}) {
  const deck = getDeck(deckId);
  if (!deck || !deck.cards.length) return { levels: 0, moved: 0 };

  const groupsMap = opts.groupsMap || {};
  const per = clampPerLevel(deck.cardsPerLevel ?? getDb().settings.cardsPerLevel ?? DEFAULT_PER_LEVEL);
  const before = new Map(deck.cards.map((c) => [c.id, Number.isInteger(c.level) ? c.level : 0]));

  const levels = arrangeCards(deck.cards, {
    perLevel: per,
    groupsMap,
    lang: opts.lang || 'en',
    hardIds: opts.hardIds || null,
    errorIds: opts.errorIds || null,
    activeLevel: opts.activeLevel || 0,
    minGapLevels: opts.minGapLevels,
    ctx: opts.ctx || {}
  });
  levels.forEach((g, gi) => g.forEach((c) => (c.level = gi)));
  deck.cards = levels.flat();

  let moved = 0;
  for (const c of deck.cards) if (before.get(c.id) !== c.level) moved += 1;
  persist();
  queueDeck(deck);
  queueCards(deckId, deck.cards);
  return { levels: levels.length, moved };
}
