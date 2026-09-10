// ============================================================================
// store.js — 数据层（localStorage，key: "mycard-v1"）
// 单例模块：db 常驻内存，所有变更立即持久化。
// ============================================================================

import { DEFAULT_PER_LEVEL, clampPerLevel, splitCards, suggestLevelForNewCard } from './levels.js';
import * as sched from './scheduler.js';

export const STORAGE_KEY = 'mycard-v1';

export function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function defaultDb() {
  return { version: 1, seededDemo: false, settings: { cardsPerLevel: DEFAULT_PER_LEVEL }, decks: [] };
}

/* ------------------------------ 数据规范化 ------------------------------ */

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
    state: ['new', 'learning', 'review'].includes(c.state) ? c.state : 'new',
    repetitions: c.repetitions || 0,
    interval: c.interval || 0,
    easeFactor: typeof c.easeFactor === 'number' && isFinite(c.easeFactor) ? c.easeFactor : 2.5,
    due: c.due || 0,
    lastReview: c.lastReview ?? null
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
    cards: Array.isArray(d.cards) ? d.cards.map(normalizeCard) : []
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
/* ------------------------------ 存取 API ------------------------------ */

let db = null;

export function getDb() {
  if (db) return db;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) db = normalize(JSON.parse(raw));
  } catch (e) {
    console.warn('[store] 读取本地数据失败，已重置:', e);
  }
  if (!db) {
    db = defaultDb();
    persist();
  }
  return db;
}

export function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch (e) {
    console.error('[store] 保存失败:', e);
  }
}

export function setSetting(key, value) {
  const d = getDb();
  if (key === 'cardsPerLevel') value = clampPerLevel(value);
  d.settings[key] = value;
  persist();
}

export function resetAll() {
  db = defaultDb();
  persist();
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
    passedLevels: {},
    cards: []
  };
  d.decks.push(deck);
  persist();
  return deck;
}

export function getDeck(id) {
  return getDb().decks.find((x) => x.id === id) || null;
}

export function updateDeck(id, patch) {
  const deck = getDeck(id);
  if (!deck) return null;
  if ('name' in patch) deck.name = String(patch.name);
  if ('description' in patch) deck.description = String(patch.description);
  if ('tags' in patch) deck.tags = (patch.tags || []).map(String);
  if ('paused' in patch) deck.paused = !!patch.paused;
  if ('cardsPerLevel' in patch) {
    deck.cardsPerLevel =
      patch.cardsPerLevel == null || patch.cardsPerLevel === '' ? null : clampPerLevel(patch.cardsPerLevel);
  }
  persist();
  return deck;
}

export function deleteDeck(id) {
  const d = getDb();
  d.decks = d.decks.filter((x) => x.id !== id);
  persist();
}

export function togglePause(id) {
  const deck = getDeck(id);
  if (!deck) return null;
  deck.paused = !deck.paused;
  persist();
  return deck;
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
    groups: [],
    extraBacks: [],
    createdAt: Date.now(),
    level,
    state: 'new',
    repetitions: 0,
    interval: 0,
    easeFactor: 2.5,
    due: 0,
    lastReview: null
  };
  deck.cards.push(card);
  persist();
  return card;
}

/** 批量导入卡片（与现有卡片一起按关卡规则重新拆分并分配 level） */
export function addManyCards(deckId, items) {
  const deck = getDeck(deckId);
  if (!deck || !Array.isArray(items) || !items.length) return 0;
  const per = clampPerLevel(deck.cardsPerLevel ?? db.settings.cardsPerLevel ?? DEFAULT_PER_LEVEL);
  const newCards = items.map((f) => ({
    id: uid(),
    front: String(f.front ?? ''),
    back: String(f.back ?? ''),
    example: f.example ?? '',
    exampleZh: f.exampleZh ?? '',
    phonetic: String(f.phonetic ?? ''),
    tags: Array.isArray(f.tags) ? f.tags.map(String) : [],
    groups: [],
    extraBacks: [],
    createdAt: Date.now(),
    state: 'new',
    repetitions: 0,
    interval: 0,
    easeFactor: 2.5,
    due: 0,
    lastReview: null
  }));
  const groups = splitCards([...deck.cards, ...newCards], per);
  groups.forEach((g, gi) => g.forEach((c) => (c.level = gi)));
  deck.cards = groups.flat();
  persist();
  return newCards.length;
}

export function updateCard(deckId, cardId, patch) {
  const deck = getDeck(deckId);
  if (!deck) return null;
  const card = deck.cards.find((c) => c.id === cardId);
  if (!card) return null;
  if ('front' in patch) card.front = String(patch.front);
  if ('back' in patch) card.back = String(patch.back);
  if ('example' in patch) card.example = patch.example ?? '';
  if ('exampleZh' in patch) card.exampleZh = patch.exampleZh ?? '';
  if ('phonetic' in patch) card.phonetic = String(patch.phonetic ?? '');
  if ('tags' in patch) card.tags = (patch.tags || []).map(String);
  if ('level' in patch && Number.isInteger(patch.level) && patch.level >= 0) card.level = patch.level;
  // 复习流程写入调度结果
  if ('state' in patch) card.state = patch.state;
  if ('repetitions' in patch) card.repetitions = patch.repetitions;
  if ('interval' in patch) card.interval = patch.interval;
  if ('easeFactor' in patch) card.easeFactor = patch.easeFactor;
  if ('due' in patch) card.due = patch.due;
  if ('lastReview' in patch) card.lastReview = patch.lastReview;
  persist();
  return card;
}

export function deleteCard(deckId, cardId) {
  const deck = getDeck(deckId);
  if (!deck) return null;
  deck.cards = deck.cards.filter((c) => c.id !== cardId);
  persist();
  return deck;
}

/** 通关写入：记录该关卡已通过测试（正确率 ≥ 80% 时调用） */
export function markLevelPassed(deckId, levelIndex) {
  const deck = getDeck(deckId);
  if (!deck) return null;
  if (!deck.passedLevels) deck.passedLevels = {};
  deck.passedLevels[levelIndex] = true;
  persist();
  return deck;
}

/** 清除某关卡通关记录 */
export function unmarkLevelPassed(deckId, levelIndex) {
  const deck = getDeck(deckId);
  if (!deck) return null;
  if (deck.passedLevels) {
    delete deck.passedLevels[levelIndex];
    persist();
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
    changed = true;
  }
  if (changed) persist();
  return deck;
}
/* ------------------------------ 内置词库 ------------------------------ */

/**
 * 内置词库通用导入：data/words.json（示范词库）与 data/kaoyan.json（考研词汇）共用。
 *  - demo=true         → 卡组打上「示范」标记，已存在任一示范卡组则不重复导入；
 *  - source='kaoyan'   → 卡组记录来源，同来源只导入一次（删掉后可再次手动导入）。
 * 自动按关卡拆分，并为卡片写入易混组（groups）与多释义（extraBacks）。
 * 首次打开（无任何本地数据）时由 app 自动调用，也可在首页手动触发。
 */
function seedBuiltinDeck(payload, { demo = true, source = null } = {}) {
  const d = getDb();
  const already = source
    ? d.decks.some((x) => x.source === source)
    : d.decks.some((x) => x.demo);
  if (already) return null;
  const words = Array.isArray(payload.words) ? payload.words : [];
  if (!words.length) return null;

  const groupsMap =
    payload.groupsMap && typeof payload.groupsMap === 'object' ? payload.groupsMap : {};
  const extraDefs =
    payload.extraDefs && typeof payload.extraDefs === 'object' ? payload.extraDefs : {};

  const per = clampPerLevel(payload.levelSize ?? d.settings.cardsPerLevel ?? DEFAULT_PER_LEVEL);
  const deck = {
    id: uid(),
    name: String(payload.name || '内置词库'),
    description: String(payload.description || ''),
    tags: Array.isArray(payload.tags) ? payload.tags.map(String) : demo ? ['示范'] : ['内置'],
    paused: false,
    cardsPerLevel: null, // 跟随全局设置
    createdAt: Date.now(),
    demo,
    source: source ? String(source) : null,
    passedLevels: {},
    cards: []
  };

  const items = words.map((w) => {
    const wordKey = String(w.front ?? w.word ?? '');
    return {
      id: uid(),
      front: wordKey,
      back: String(w.back ?? w.meaningZh ?? ''),
      example: w.example ?? '',
      exampleZh: w.exampleZh ?? '',
      phonetic: String(w.phonetic ?? ''),
      tags: Array.isArray(w.tags) ? w.tags.map(String) : [],
      groups: Array.isArray(groupsMap[wordKey]) ? groupsMap[wordKey].map(String) : [],
      extraBacks: Array.isArray(extraDefs[wordKey]) ? extraDefs[wordKey].map(String) : [],
      createdAt: Date.now(),
      state: 'new',
      repetitions: 0,
      interval: 0,
      easeFactor: 2.5,
      due: 0,
      lastReview: null
    };
  });

  const groups = splitCards(items, per);
  groups.forEach((g, gi) => g.forEach((c) => (c.level = gi)));
  deck.cards = groups.flat();

  d.decks.unshift(deck);
  if (demo) d.seededDemo = true;
  persist();
  return deck;
}

/** 导入示范词库（data/words.json + data/confusables.json 已在 payload 中合并），已存在则跳过 */
export function seedDemoDeck(payload) {
  return seedBuiltinDeck(payload, { demo: true, source: null });
}

/** 导入考研词汇卡组（data/kaoyan.json，已按内置格式重构），同来源只导入一次 */
export function seedKaoyanDeck(payload) {
  return seedBuiltinDeck(payload, { demo: false, source: 'kaoyan' });
}

/** 是否已有示范卡组 */
export function hasDemoDeck() {
  return getDb().decks.some((x) => x.demo);
}

/** 是否已导入考研词汇卡组 */
export function hasKaoyanDeck() {
  return getDb().decks.some((x) => x.source === 'kaoyan');
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
  }
  if (changed) persist();
  return changed;
}

/* ------------------------------ 其它 ------------------------------ */

/** 全部标签（去重排序） */
export function allTags() {
  const set = new Set();
  for (const d of getDb().decks) d.tags.forEach((t) => set.add(t));
  return [...set].sort((a, b) => a.localeCompare(b, 'zh'));
}
