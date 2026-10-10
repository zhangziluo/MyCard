// ============================================================================
// sync.js — 多端同步（v0.9.0，WebDAV；增量传输 + 预览对比 + 本机专用卡组）
//
// 同步什么：**全部卡组（词库）+ 卡面内容 + 每张卡的复习调度（学习进度）+
//           复习日志 revlog + 关卡通关记录 passedLevels + 「每关词数」设置**。
// 冲突策略（可复现，且保证「学习进度只进不退」）：
//   · 内容字段（front/back/例句/标签/关卡归属/卡组名·简介·标签·每关词数…）
//     → 按 `updatedAt` 新者胜（store 只在**内容编辑**时打这个时间戳）；
//   · 调度字段（state / repetitions / interval / easeFactor / due / lastReview）
//     → 按 `lastReview` 新者胜（谁学得更晚听谁的，不会被另一台设备「学回旧状态」）；
//   · revlog → 按日志 id 求并集（只增不减）；
//   · passedLevels → 并集（已通关不会被别的设备抹掉）；
//   · 删除 → **墓碑**（store 在 deleteCard/deleteDeck 时记录时间戳）：
//     只有「删除时间 > 对方副本的最后修改 / 复习时间」才真删，否则视为对方又改过 → 保留。
//
// 数据落地（v0.9.0 = 增量布局，只传变化的卡组）：
//   `mycard-sync.json`            索引：每个卡组的元信息 + 内容指纹 + 墓碑 + 设置（很小）
//   `mycard-decks/{deckId}.json`  各卡组的完整内容（卡面 + 调度 + 日志）
//   `mycard-sync.prev.json`       索引的写前备份；`…/{deckId}.prev.json` 卡组文件的写前备份
//   `mycard-sync.lock.json`       同步锁（TTL 10 分钟，可抢占）
//   兼容 v0.8.0 的单文件快照：读到老格式会正常合并，并按新布局重写。
//
// 三项增强：
//   · **预览差异** `previewSync()`：只 GET 不写，给出「本地/远端/合并后」规模、逐卡组明细、
//     冲突清单（内容按 updatedAt、进度按 lastReview 各自取谁）与本次会上下传哪些卡组；
//   · **只传增量** `readRemote()/writeRemote()`：指纹相同就跳过，网盘流量 ∝ 变化的卡组数；
//   · **本机专用卡组** `deck.syncLocal`：不上传、不被远端覆盖 / 删除、删除记录（墓碑）也不外传。
//
// 分工：`mergeSnapshots()` 是**纯函数内核**（不碰 DOM / 网络 / 存储，单测直接覆盖），
//       `planSync()` 只算（只读）→ `previewSync()` 展示 → `syncNow()` 抢锁 + 写回 + 落库。
// ============================================================================

import * as store from './store.js';
import * as webdav from './webdav.js';
import { WebdavError } from './webdav.js';

export { WebdavError };

/** 快照格式版本（v0.9.0 起 = 2：网盘上改为「manifest + 按卡组分文件」的增量布局） */
export const SNAPSHOT_VERSION = 2;
/** 索引文件（很小：只放每个卡组的元信息 + 内容指纹 + 墓碑 + 设置） */
export const SNAPSHOT_FILE = 'mycard-sync.json';
/** 索引文件的写前备份 */
export const BACKUP_FILE = 'mycard-sync.prev.json';
/** 同步锁 */
export const LOCK_FILE = 'mycard-sync.lock.json';
/** 分卡组文件目录（`mycard-decks/{deckId}.json`） */
export const DECK_DIR = 'mycard-decks';
/** 每个卡组文件的写前备份后缀 */
export const DECK_BACKUP_SUFFIX = '.prev.json';
/** 配置 + 上次同步结果的 localStorage key */
export const CONFIG_KEY = 'mycard-sync';
/** 缺省同步目录名 */
export const DEFAULT_DIR = 'mycard';
/** 锁的有效期（超过视为上一台设备异常退出，可抢占） */
export const LOCK_TTL = 10 * 60 * 1000;
/** 自动同步（变更后）的检查间隔 */
export const AUTO_INTERVAL = 5 * 60 * 1000;
/** 两次自动同步之间的最小间隔（防抖） */
export const AUTO_MIN_GAP = 60 * 1000;

/** 调度字段：合并时按 lastReview 判定归属 */
const SCHED_FIELDS = ['state', 'repetitions', 'interval', 'easeFactor', 'due', 'lastReview'];

/* ------------------------------ 配置 ------------------------------ */

/** 本次会话内的密码（未勾「记住密码」时只存在内存里，刷新即需重填） */
let sessionPass = '';

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
    console.warn('[sync] 配置写入失败:', e);
    return false;
  }
}

/** 读取同步配置（密码仅当「记住密码」时才从 localStorage 取回） */
export function loadConfig() {
  const raw = readJson(CONFIG_KEY) || {};
  const remember = !!raw.remember;
  return {
    url: String(raw.url || ''),
    user: String(raw.user || ''),
    pass: remember ? String(raw.pass || '') : sessionPass,
    remember,
    dir: String(raw.dir == null ? DEFAULT_DIR : raw.dir),
    autoOnLoad: raw.autoOnLoad !== false,
    autoOnChange: !!raw.autoOnChange,
    device: String(raw.device || ''),
    lastSyncAt: Number(raw.lastSyncAt) || 0,
    lastResult: raw.lastResult || null
  };
}

/** 保存配置（`pass` 只在勾选「记住密码」时落 localStorage） */
export function saveConfig(patch = {}) {
  const cur = loadConfig();
  const next = { ...cur, ...patch };
  if ('pass' in patch) sessionPass = String(patch.pass == null ? '' : patch.pass);
  if (!next.device) next.device = deviceName();
  // 地址统一规范化（补协议 / 去尾斜杠），后续 probe / sync 直接用
  let url = String(next.url || '').trim();
  if (url) {
    try {
      url = webdav.normalizeBase(url);
    } catch (e) {
      // 地址还没填完（如只输了几个字符）→ 原样保存，等用户改
    }
  }
  writeJson(CONFIG_KEY, {
    url,
    user: next.user,
    pass: next.remember ? String(next.pass || '') : '',
    remember: !!next.remember,
    dir: next.dir,
    autoOnLoad: next.autoOnLoad !== false,
    autoOnChange: !!next.autoOnChange,
    device: next.device,
    lastSyncAt: next.lastSyncAt || 0,
    lastResult: next.lastResult || null
  });
  return { ...next, url };
}

/** 清除已保存的密码（URL / 用户名 / 目录保留） */
export function clearCredentials() {
  sessionPass = '';
  const cur = loadConfig();
  return saveConfig({ pass: '', remember: false, url: cur.url, user: cur.user, dir: cur.dir });
}

/** 是否「填齐了」同步所需信息 */
export function isConfigured(cfg = loadConfig()) {
  return !!(cfg && cfg.url && cfg.user && cfg.pass);
}

/** 本机标识（写进快照 / 锁，便于判断「是不是自己写的」；持久化） */
export function deviceName() {
  const cur = readJson(CONFIG_KEY);
  if (cur && cur.device) return String(cur.device);
  let kind = 'device';
  try {
    const ua = typeof navigator !== 'undefined' ? String(navigator.userAgent || '') : '';
    if (/iPhone|iPad|iPod/i.test(ua)) kind = 'ios';
    else if (/Android/i.test(ua)) kind = 'android';
    else if (/Macintosh|Mac OS X/i.test(ua)) kind = 'mac';
    else if (/Windows/i.test(ua)) kind = 'win';
    else if (/Linux/i.test(ua)) kind = 'linux';
  } catch (e) {}
  return `${kind}-${Math.random().toString(36).slice(2, 6)}`;
}

/* ------------------------------ 快照 ------------------------------ */

/** 空快照（远端还没有文件时用） */
export function emptySnapshot(now = Date.now()) {
  return {
    app: 'mycard',
    formatVersion: SNAPSHOT_VERSION,
    savedAt: now,
    device: '',
    settings: {},
    decks: [],
    tombstones: { decks: {}, cards: {} }
  };
}

/** 卡片 → 快照负载（显式列字段，避免把内部字段带出去） */
export function cardPayload(card) {
  const c = card || {};
  const out = {
    id: String(c.id || ''),
    front: String(c.front ?? ''),
    back: String(c.back ?? ''),
    example: c.example ?? '',
    exampleZh: c.exampleZh ?? '',
    phonetic: String(c.phonetic ?? ''),
    tags: Array.isArray(c.tags) ? c.tags.map(String) : [],
    groups: Array.isArray(c.groups) ? c.groups.map(String) : [],
    extraBacks: Array.isArray(c.extraBacks) ? c.extraBacks.map(String) : [],
    createdAt: Number(c.createdAt) || 0,
    updatedAt: Number(c.updatedAt) || Number(c.createdAt) || 0,
    level: Number.isInteger(c.level) && c.level >= 0 ? c.level : 0
  };
  out.state = ['new', 'learning', 'review'].includes(c.state) ? c.state : 'new';
  out.repetitions = Number(c.repetitions) || 0;
  out.interval = Number(c.interval) || 0;
  out.easeFactor = Number(c.easeFactor) || 2.5;
  out.due = Number(c.due) || 0;
  out.lastReview = Number(c.lastReview) > 0 ? Number(c.lastReview) : null;
  out.src = typeof c.src === 'string' && c.src ? c.src : null;
  out.addedAt = c.addedAt || null;
  return out;
}

/** 复习日志 → 快照负载（字段与 revlog 表一致） */
export function entryPayload(e) {
  const x = e || {};
  return {
    id: String(x.id || ''),
    cardId: String(x.cardId || ''),
    ts: Number(x.ts) || 0,
    ease: Number(x.ease) || 0,
    type: Number(x.type) || 0,
    ivl: Number(x.ivl) || 0,
    lastIvl: Number(x.lastIvl) || 0,
    factor: Number(x.factor) || 0,
    time: Number(x.time) || 0
  };
}

/** 「本机专用」卡组：不参与同步（buildSnapshot 会跳过；合并也不会删它们） */
export function isLocalOnlyDeck(deck) {
  return !!(deck && deck.syncLocal);
}

/** 本机专用卡组的 id 列表（同步落库时用 keepDeckIds 传给 store） */
export function localOnlyDeckIds() {
  return store
    .getDb()
    .decks.filter(isLocalOnlyDeck)
    .map((d) => String(d.id));
}

/** 把一个卡组对象变成「可传输负载」（显式列字段，避免把内部标记 / 本机专用标记带出去） */
export async function deckPayload(deck, now = Date.now()) {
  let logs = [];
  try {
    logs = await store.revlogsOfDeck(deck.id);
  } catch (e) {
    logs = (deck.revlogs || []).slice();
  }
  return {
    id: String(deck.id),
    name: deck.name,
    description: deck.description,
    tags: [...(deck.tags || [])],
    paused: !!deck.paused,
    cardsPerLevel: deck.cardsPerLevel ?? null,
    createdAt: Number(deck.createdAt) || now,
    updatedAt: Number(deck.updatedAt) || Number(deck.createdAt) || now,
    demo: !!deck.demo,
    source: deck.source ?? null,
    passedLevels: { ...(deck.passedLevels || {}) },
    cards: (deck.cards || []).map(cardPayload),
    revlog: logs.map(entryPayload)
  };
}

/** 由本地库构造快照（含每个卡组的复习日志；异步 —— 日志在 IndexedDB 里）
 *  v0.9.0：**跳过「本机专用」卡组**（它们永不参与同步） */
export async function buildSnapshot(now = Date.now()) {
  const decks = [];
  const localOnly = new Set(localOnlyDeckIds());
  const localOnlyCards = new Set();
  for (const deck of store.getDb().decks) {
    if (isLocalOnlyDeck(deck)) {
      for (const c of deck.cards || []) localOnlyCards.add(String(c.id));
      continue;
    }
    decks.push(await deckPayload(deck, now));
  }
  // 墓碑：本机专用卡组（及其卡片）的删除记录不外传
  const allTomb = store.syncTombstones();
  const tombstones = { decks: {}, cards: {} };
  for (const [id, at] of Object.entries(allTomb.decks || {})) {
    if (localOnly.has(String(id))) continue;
    tombstones.decks[id] = at;
  }
  for (const [id, at] of Object.entries(allTomb.cards || {})) {
    if (localOnlyCards.has(String(id))) continue;
    tombstones.cards[id] = at;
  }
  return {
    app: 'mycard',
    formatVersion: SNAPSHOT_VERSION,
    savedAt: now,
    device: deviceName(),
    settings: {
      cardsPerLevel: store.getDb().settings.cardsPerLevel,
      updatedAt: Number(store.getDb().settings.updatedAt) || 0 // 最后改动时间（多端比较用）
    },
    decks,
    tombstones
  };
}

/** 解析远端文本（JSON）；失败抛出可读错误 */
export function parseSnapshot(text) {
  if (!text || !String(text).trim()) return emptySnapshot();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new WebdavError('远端文件不是合法 JSON（可能被其它程序写过）');
  }
}

/** 宽松归一化快照（容忍手工编辑 / 老版本缺字段） */
export function normalizeSnapshot(raw, now = Date.now()) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    app: 'mycard',
    formatVersion: Number(s.formatVersion) || SNAPSHOT_VERSION,
    savedAt: Number(s.savedAt) || 0,
    device: String(s.device || ''),
    settings: s.settings && typeof s.settings === 'object' ? { ...s.settings } : {},
    decks: (Array.isArray(s.decks) ? s.decks : [])
      .filter((d) => d && d.id)
      .map((d) => ({
        ...d,
        id: String(d.id),
        cards: (Array.isArray(d.cards) ? d.cards : [])
          .filter((c) => c && c.id)
          .map((c) => cardPayload(c)),
        revlog: (Array.isArray(d.revlog) ? d.revlog : [])
          .filter((e) => e && (e.id || e.ts))
          .map((e) => entryPayload(e))
      })),
    tombstones: {
      decks: (s.tombstones && s.tombstones.decks) || {},
      cards: (s.tombstones && s.tombstones.cards) || {}
    }
  };
}



/* ------------------------------ 合并内核（纯函数，可单测） ------------------------------ */

function maxNum(...vals) {
  let m = 0;
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n) && n > m) m = n;
  }
  return m;
}

/** 取最早的「正数」时间（创建时间用它，避免合并出的 createdAt 越来越晚） */
function minPos(...vals) {
  let m = 0;
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0 && (m === 0 || n < m)) m = n;
  }
  return m;
}

/**
 * 合并两张卡：**内容按 updatedAt 新者胜，调度按 lastReview 新者胜**。
 * 于是「在 A 改了释义」与「在 B 背了两遍」互不吞掉。
 */
export function mergeCard(a, b) {
  if (!a) return b;
  if (!b) return a;
  const content = maxNum(a.updatedAt) >= maxNum(b.updatedAt) ? a : b;
  const progress = maxNum(a.lastReview) >= maxNum(b.lastReview) ? a : b;
  const out = { ...content };
  for (const k of SCHED_FIELDS) if (k !== 'lastReview') out[k] = progress[k];
  out.lastReview = maxNum(a.lastReview, b.lastReview) || null;
  out.updatedAt = maxNum(a.updatedAt, b.updatedAt) || 0;
  out.createdAt = minPos(a.createdAt, b.createdAt) || Number(content.createdAt) || 0;
  return out;
}

/** 复习日志并集（按 id 去重，同 id 取更新的 ts；输出按 ts 升序） */
export function mergeRevlog(a, b) {
  const map = new Map();
  for (const list of [a, b]) {
    for (const raw of Array.isArray(list) ? list : []) {
      const item = entryPayload(raw);
      const key = item.id || `${item.cardId}:${item.ts}:${item.ease}`;
      const prev = map.get(key);
      if (!prev || item.ts >= prev.ts) map.set(key, item);
    }
  }
  return [...map.values()].sort((x, y) => x.ts - y.ts || String(x.id).localeCompare(String(y.id)));
}

/** 墓碑并集（同一 id 取更晚的删除时间） */
export function mergeTombstones(a, b) {
  const out = { decks: {}, cards: {} };
  for (const kind of ['decks', 'cards']) {
    const x = (a && a[kind]) || {};
    const y = (b && b[kind]) || {};
    for (const id of new Set([...Object.keys(x), ...Object.keys(y)])) out[kind][id] = maxNum(x[id], y[id]);
  }
  return out;
}

/** 卡片删除是否生效：删除时间要晚于该副本的最后「修改 / 复习」时间 */
export function cardDeletedAt(card, at) {
  if (!at) return false;
  return at > maxNum(card && card.updatedAt, card && card.lastReview);
}

/** 卡组删除是否生效：删除时间要晚于卡组自身与组内所有卡片的最新时间 */
export function deckDeletedAt(deck, at) {
  if (!at) return false;
  let newest = maxNum(deck && deck.updatedAt);
  for (const c of (deck && deck.cards) || []) newest = Math.max(newest, maxNum(c.updatedAt, c.lastReview));
  return at > newest;
}

/** 过滤掉「删除已生效」的卡片，并按存活卡片裁剪日志 */
export function withTombstones(deck, tombs = { cards: {} }) {
  if (!deck) return deck;
  const cardTomb = tombs.cards || {};
  const cards = (deck.cards || []).filter((c) => !cardDeletedAt(c, Number(cardTomb[c.id]) || 0));
  const ids = new Set(cards.map((c) => c.id));
  return { ...deck, cards, revlog: mergeRevlog(deck.revlog, []).filter((e) => ids.has(e.cardId)) };
}

/** 合并两个卡组（元信息按 updatedAt / 通关记录取并集 / 卡片逐张合并 / 日志并集） */
export function mergeDeckEntry(a, b, tombs = { cards: {} }) {
  if (!a) return withTombstones(b, tombs);
  if (!b) return withTombstones(a, tombs);
  const meta = maxNum(a.updatedAt) >= maxNum(b.updatedAt) ? a : b;
  const out = { ...meta };
  out.createdAt = minPos(a.createdAt, b.createdAt) || Number(meta.createdAt) || 0;
  out.updatedAt = maxNum(a.updatedAt, b.updatedAt) || Number(meta.updatedAt) || 0;
  out.passedLevels = { ...(a.passedLevels || {}), ...(b.passedLevels || {}) };
  const cards = new Map();
  for (const c of a.cards || []) cards.set(c.id, c);
  for (const c of b.cards || []) {
    const prev = cards.get(c.id);
    cards.set(c.id, prev ? mergeCard(prev, c) : c);
  }
  return withTombstones({ ...out, cards: [...cards.values()], revlog: mergeRevlog(a.revlog, b.revlog) }, tombs);
}

/* ------------------------------ 合并快照 + 变更统计 ------------------------------ */

/**
 * 合并两份快照（**纯函数**）。
 * @param {object} local 本地快照
 * @param {object} remote 远端快照（不存在时传 emptySnapshot()）
 * @param {{ now?: number, device?: string, report?: boolean }} [opts]
 * @returns {{ snapshot: object, stats: object, report: object|null }} snapshot = 合并后的完整快照；
 *          `report`（默认开启，`report:false` 可关掉）是给「预览差异」用的逐卡组明细
 */
export function mergeSnapshots(local, remote, { now = Date.now(), device = '', report = true } = {}) {
  const a = normalizeSnapshot(local, now);
  const b = normalizeSnapshot(remote, now);
  const tombs = mergeTombstones(a.tombstones, b.tombstones);

  const deckMap = new Map();
  for (const d of a.decks) deckMap.set(d.id, d);
  for (const d of b.decks) {
    const prev = deckMap.get(d.id);
    deckMap.set(d.id, prev ? mergeDeckEntry(prev, d, tombs) : mergeDeckEntry(null, d, tombs));
  }
  for (const [id, deck] of [...deckMap]) {
    if (deckDeletedAt(deck, Number(tombs.decks[id]) || 0)) deckMap.delete(id);
  }

  // 设置：优先比「最后改动时间」（v0.9.0 起 store 会给 settings.updatedAt 打时间戳），
  // 老数据没有这个字段时退回「快照 savedAt」——避免出现「永远本地赢」的伪双向。
  const aT = Number(a.settings && a.settings.updatedAt) || 0;
  const bT = Number(b.settings && b.settings.updatedAt) || 0;
  const remoteSettingsWin = aT || bT ? bT > aT : b.savedAt > a.savedAt;
  const settings = { ...(a.settings || {}), ...(remoteSettingsWin ? b.settings || {} : {}) };

  const snapshot = {
    app: 'mycard',
    formatVersion: SNAPSHOT_VERSION,
    savedAt: now,
    device: device || b.device || a.device || '',
    settings,
    decks: [...deckMap.values()].sort((x, y) => String(x.id).localeCompare(String(y.id))),
    tombstones: tombs
  };
  return {
    snapshot,
    stats: diffSnapshots(a.decks, snapshot.decks),
    report: report ? buildReport(a.decks, b.decks, snapshot.decks) : null
  };
}

/** 统计「相对 before，after 发生了哪些变化」（= 本次同步会给本地带来什么） */
export function diffSnapshots(before, after) {
  const prev = new Map((before || []).map((d) => [d.id, d]));
  const stats = { decksAdded: 0, decksUpdated: 0, decksRemoved: 0, cardsAdded: 0, cardsUpdated: 0, cardsRemoved: 0, revlogs: 0 };
  const seen = new Set();
  for (const d of after || []) {
    seen.add(d.id);
    const p = prev.get(d.id);
    if (!p) {
      stats.decksAdded += 1;
      stats.cardsAdded += (d.cards || []).length;
      stats.revlogs += (d.revlog || []).length;
      continue;
    }
    if (JSON.stringify(p) !== JSON.stringify(d)) stats.decksUpdated += 1;
    const pm = new Map((p.cards || []).map((c) => [c.id, c]));
    for (const c of d.cards || []) {
      const pc = pm.get(c.id);
      if (!pc) stats.cardsAdded += 1;
      else {
        if (JSON.stringify(pc) !== JSON.stringify(c)) stats.cardsUpdated += 1;
        pm.delete(c.id);
      }
    }
    stats.cardsRemoved += pm.size;
    const pIds = new Set((p.revlog || []).map((e) => e.id));
    stats.revlogs += (d.revlog || []).filter((e) => !pIds.has(e.id)).length;
  }
  for (const id of prev.keys()) if (!seen.has(id)) stats.decksRemoved += 1;
  return stats;
}

/** 变更摘要文案（设置页展示） */
export function statsText(stats) {
  const s = stats || {};
  const parts = [];
  if (s.decksAdded) parts.push(`新增卡组 ${s.decksAdded}`);
  if (s.decksUpdated) parts.push(`更新卡组 ${s.decksUpdated}`);
  if (s.decksRemoved) parts.push(`移除卡组 ${s.decksRemoved}`);
  if (s.cardsAdded) parts.push(`新增卡片 ${s.cardsAdded}`);
  if (s.cardsUpdated) parts.push(`更新卡片 ${s.cardsUpdated}`);
  if (s.cardsRemoved) parts.push(`移除卡片 ${s.cardsRemoved}`);
  if (s.revlogs) parts.push(`日志 +${s.revlogs}`);
  return parts.length ? parts.join(' · ') : '已是最新';
}

/** 上次同步结果文案 */
export function lastResultText(result) {
  if (!result) return '尚未同步';
  if (!result.ok) return `上次失败：${result.error || '未知错误'}`;
  const extra = result.uploaded ? `（上传 ${result.uploaded} 个卡组文件）` : '';
  return `上次成功：${statsText(result.stats)}${extra}`;
}

/* ------------------- 传输层：manifest + 按卡组分文件（v0.9.0 增量） ------------------- */

/** 稳定序列化（键名排序、递归处理数组 / 对象）—— 让指纹与字段顺序无关 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * 内容指纹（FNV-1a 32 位，十六进制）。
 * 只用于「这一份卡组要不要重传 / 要不要下载」，**不参与合并正确性** —— 指纹不同最多多传一次，不会丢数据。
 * 用稳定序列化：两台设备即使字段顺序不同，只要内容一致指纹就一致。
 */
export function deckHash(payload) {
  const text = stableStringify(payload == null ? null : payload);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 由卡组负载生成 manifest 条目（含判定「卡组是否被删」所需的元信息，避免为它多拉一次文件） */
export function manifestEntry(payload) {
  let maxUpdated = Number(payload.updatedAt) || 0;
  let maxReview = 0;
  for (const c of payload.cards || []) {
    maxUpdated = Math.max(maxUpdated, Number(c.updatedAt) || 0);
    maxReview = Math.max(maxReview, Number(c.lastReview) || 0);
  }
  return {
    id: String(payload.id),
    name: payload.name,
    cardCount: (payload.cards || []).length,
    updatedAt: Number(payload.updatedAt) || 0,
    maxCardUpdated: maxUpdated,
    maxLastReview: maxReview,
    hash: deckHash(payload)
  };
}

/** 由快照生成 manifest（索引文件内容） */
export function manifestOf(snapshot, { now = Date.now(), device = '' } = {}) {
  const s = snapshot || {};
  return {
    app: 'mycard',
    formatVersion: SNAPSHOT_VERSION,
    savedAt: Number(s.savedAt) || now,
    device: device || s.device || '',
    settings: { ...(s.settings || {}) },
    decks: (s.decks || []).map(manifestEntry),
    tombstones: s.tombstones || { decks: {}, cards: {} }
  };
}

/** 老版本（v1 单文件）检测：manifest 里的 decks 直接带着 cards */
export function isLegacyManifest(raw) {
  const list = raw && Array.isArray(raw.decks) ? raw.decks : [];
  return list.some((d) => d && Array.isArray(d.cards));
}

/** 分卡组文件名（id 多为 UUID；含路径/URL 不友好字符时退化为「安全名 + 指纹」，保证跨端一致且不冲突） */
export function deckFileName(deckId) {
  const id = String(deckId == null ? '' : deckId).trim();
  const safe = id.replace(/[\u0000-\u001f\u007f/\\:*?"<>|%]/g, '-').replace(/^\.+/, '-');
  if (!safe) return `deck-${deckHash(id)}`;
  return safe === id ? id : `${safe}-${deckHash(id)}`;
}

/** 分卡组文件路径（相对同步目录；webdav.buildUrl 会逐段编码，这里不能预先 encode） */
export function deckFileOf(deckId) {
  return `${DECK_DIR}/${deckFileName(deckId)}.json`;
}

/** 分卡组文件的写前备份路径 */
export function deckBackupFileOf(deckId) {
  return `${DECK_DIR}/${deckFileName(deckId)}${DECK_BACKUP_SUFFIX}`;
}

/** 空 manifest */
export function emptyManifest(now = Date.now()) {
  return { app: 'mycard', formatVersion: SNAPSHOT_VERSION, savedAt: 0, device: '', settings: {}, decks: [], tombstones: { decks: {}, cards: {} } };
}

/**
 * 合并明细报告（给「预览差异」用）：每个卡组新增 / 更新 / 移除的卡片数 + 冲突明细。
 * 冲突 = 同一张卡在两端都存在且**两边都动过**（内容按 updatedAt、进度按 lastReview 各自择一）。
 */
export function buildReport(localDecks, remoteDecks, mergedDecks) {
  const localById = new Map((localDecks || []).map((d) => [String(d.id), d]));
  const remoteById = new Map((remoteDecks || []).map((d) => [String(d.id), d]));
  const out = { decks: [], conflicts: 0, cardsAdded: 0, cardsUpdated: 0, cardsRemoved: 0, revlogs: 0 };
  for (const m of mergedDecks || []) {
    const l = localById.get(String(m.id));
    const r = remoteById.get(String(m.id));
    const entry = {
      id: String(m.id),
      name: m.name,
      status: 'unchanged',
      cardsAdded: 0,
      cardsUpdated: 0,
      cardsRemoved: 0,
      revlogs: 0,
      conflicts: []
    };
    if (!l) {
      entry.status = 'added';
      entry.cardsAdded = (m.cards || []).length;
      entry.revlogs = (m.revlog || []).length;
    } else {
      const lm = new Map((l.cards || []).map((c) => [String(c.id), c]));
      const rm = new Map(((r && r.cards) || []).map((c) => [String(c.id), c]));
      for (const c of m.cards || []) {
        const lc = lm.get(String(c.id));
        if (!lc) entry.cardsAdded += 1;
        else if (JSON.stringify(lc) !== JSON.stringify(c)) entry.cardsUpdated += 1;
        if (lc && rm.has(String(c.id))) {
          const rc = rm.get(String(c.id));
          const contentDiff = (Number(lc.updatedAt) || 0) !== (Number(rc.updatedAt) || 0);
          const progressDiff = (Number(lc.lastReview) || 0) !== (Number(rc.lastReview) || 0);
          if (contentDiff || progressDiff) {
            entry.conflicts.push({
              cardId: String(c.id),
              front: c.front,
              contentFrom: contentDiff ? ((Number(lc.updatedAt) || 0) >= (Number(rc.updatedAt) || 0) ? 'local' : 'remote') : null,
              progressFrom: progressDiff
                ? (Number(lc.lastReview) || 0) >= (Number(rc.lastReview) || 0)
                  ? 'local'
                  : 'remote'
                : null
            });
            out.conflicts += 1;
          }
        }
      }
      for (const id of lm.keys()) if (!(m.cards || []).some((c) => String(c.id) === id)) entry.cardsRemoved += 1;
      const lIds = new Set((l.revlog || []).map((e) => e.id));
      entry.revlogs = (m.revlog || []).filter((e) => !lIds.has(e.id)).length;
    }
    if (!entry.cardsAdded && !entry.cardsUpdated && !entry.cardsRemoved && !entry.revlogs && !entry.conflicts.length) {
      entry.status = 'unchanged';
    } else {
      entry.status = entry.cardsRemoved && !entry.cardsAdded && !entry.cardsUpdated ? 'removed' : 'updated';
    }
    out.cardsAdded += entry.cardsAdded;
    out.cardsUpdated += entry.cardsUpdated;
    out.cardsRemoved += entry.cardsRemoved;
    out.revlogs += entry.revlogs;
    out.decks.push(entry);
  }
  for (const l of localDecks || []) {
    if ((mergedDecks || []).some((d) => String(d.id) === String(l.id))) continue;
    out.decks.push({
      id: String(l.id),
      name: l.name,
      status: 'removed',
      cardsAdded: 0,
      cardsUpdated: 0,
      cardsRemoved: (l.cards || []).length,
      revlogs: 0,
      conflicts: []
    });
    out.cardsRemoved += (l.cards || []).length;
  }
  return out;
}




/* ---------------- 远端读写：索引（manifest）+ 按卡组分文件（v0.9.0 增量） ---------------- */

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

/**
 * 读远端：
 *  1. GET 索引文件（很小：只有每个卡组的元信息 + 指纹）；
 *  2. **只**拉真正需要的卡组文件（本地没有的 / 指纹不同的 / 本地记了墓碑的）；
 *  3. 组装成一份「远端快照」交给 mergeSnapshots。
 * 兼容 v1 单文件快照（老版本写的 `mycard-sync.json` 里直接带 cards）。
 */
export async function readRemote(cfg, auth, { now = Date.now(), local = null, onStep = null } = {}) {
  const step = (s) => {
    if (onStep) {
      try {
        onStep(s);
      } catch (e) {}
    }
  };
  step('拉取远端索引');
  const got = await webdav.getText(cfg.url, SNAPSHOT_FILE, { auth, dir: cfg.dir });
  const text = got.exists ? String(got.text || '') : '';
  if (!text.trim()) {
    return { exists: false, legacy: false, text: '', manifest: emptyManifest(now), snapshot: emptySnapshot(now), known: new Map(), fetched: [], missing: [] };
  }
  const parsed = safeJson(text);
  if (!parsed || typeof parsed !== 'object') throw new WebdavError('远端同步文件不是合法 JSON（可先备份再删除它重试）', { status: 0 });
  if (isLegacyManifest(parsed)) {
    const snapshot = normalizeSnapshot(parsed, now);
    return {
      exists: true,
      legacy: true,
      text,
      manifest: manifestOf(snapshot, { now }),
      snapshot,
      known: new Map(),
      fetched: [],
      missing: []
    };
  }
  const manifest = {
    ...emptyManifest(now),
    ...parsed,
    decks: (Array.isArray(parsed.decks) ? parsed.decks : []).filter((d) => d && d.id),
    settings: parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {},
    tombstones: parsed.tombstones && typeof parsed.tombstones === 'object' ? parsed.tombstones : { decks: {}, cards: {} }
  };
  const lost = new Set(Object.keys(manifest.tombstones.decks || {})); // 本地记了墓碑的卡组必须拉下来才能正确判断
  const mine = new Map(manifestOf(local || emptySnapshot(now), { now }).decks.map((e) => [e.id, e]));
  const decks = [];
  const known = new Map();
  const fetched = [];
  const missing = [];
  for (const entry of manifest.decks) {
    const id = String(entry.id);
    const my = mine.get(id);
    if (my && my.hash === entry.hash && !lost.has(id)) {
      const same = ((local && local.decks) || []).find((d) => String(d.id) === id);
      if (same) {
        decks.push(same); // 内容与本地一致 → 不下载，直接用本地这份当远端
        continue;
      }
    }
    step(`拉取卡组：${entry.name || id}`);
    const f = await webdav.getText(cfg.url, deckFileOf(id), { auth, dir: cfg.dir });
    const payload = f.exists ? safeJson(String(f.text || '')) : null;
    if (!payload || typeof payload !== 'object') {
      missing.push(id); // 索引里有、文件不在（或损坏）：按「远端没有」处理，稍后会重传
      continue;
    }
    const p = { ...payload, id };
    known.set(id, p);
    fetched.push(id);
    decks.push(p);
  }
  return {
    exists: true,
    legacy: false,
    text,
    manifest,
    snapshot: {
      app: 'mycard',
      formatVersion: SNAPSHOT_VERSION,
      savedAt: Number(manifest.savedAt) || 0,
      device: manifest.device || '',
      settings: manifest.settings || {},
      decks,
      tombstones: manifest.tombstones
    },
    known,
    fetched,
    missing
  };
}

/** 计算「哪些卡组要重传 / 哪些远端文件要删」 */
export function uploadPlan(mergedDecks, remoteManifest, { force = [] } = {}) {
  const forceSet = new Set((force || []).map(String));
  const remoteHashes = new Map(((remoteManifest && remoteManifest.decks) || []).map((e) => [String(e.id), String(e.hash || '')]));
  const payloads = mergedDecks || [];
  const toUpload = payloads.filter((p) => forceSet.has(String(p.id)) || remoteHashes.get(String(p.id)) !== deckHash(p)).map((p) => String(p.id));
  const toRemove = [...remoteHashes.keys()].filter((id) => !payloads.some((p) => String(p.id) === id));
  return { toUpload, toRemove };
}

/**
 * 把合并结果写回远端（**增量**：只写有变化的卡组文件 + 索引；覆盖前先备份一份旧的）。
 * @returns {{ manifest:object, uploaded:string[], removed:string[] }}
 */
export async function writeRemote(cfg, auth, { merged, remoteManifest = null, known = new Map(), force = [], remoteText = '', now = Date.now(), device = '', onStep = null } = {}) {
  const step = (s) => {
    if (onStep) {
      try {
        onStep(s);
      } catch (e) {}
    }
  };
  const { toUpload, toRemove } = uploadPlan(merged.decks, remoteManifest, { force });
  const payloadById = new Map((merged.decks || []).map((p) => [String(p.id), p]));
  if (toUpload.length) {
    step(`上传 ${toUpload.length} 个卡组`);
    await webdav.ensureCollection(cfg.url, `${cfg.dir ? cfg.dir + '/' : ''}${DECK_DIR}`, { auth });
    for (const id of toUpload) {
      const payload = payloadById.get(id);
      const old = known.get(id);
      if (old) await webdav.putText(cfg.url, deckBackupFileOf(id), JSON.stringify(old, null, 2), { auth, dir: cfg.dir }).catch(() => {});
      await webdav.putText(cfg.url, deckFileOf(id), JSON.stringify(payload, null, 2), { auth, dir: cfg.dir });
    }
  }
  for (const id of toRemove) await webdav.remove(cfg.url, deckFileOf(id), { auth, dir: cfg.dir }).catch(() => {});
  if (remoteText) {
    step('备份远端索引');
    await webdav.putText(cfg.url, BACKUP_FILE, remoteText, { auth, dir: cfg.dir }).catch(() => {});
  }
  step('写回远端索引');
  const manifest = manifestOf(merged, { now, device });
  await webdav.putText(cfg.url, SNAPSHOT_FILE, JSON.stringify(manifest, null, 2), { auth, dir: cfg.dir });
  return { manifest, uploaded: toUpload, removed: toRemove };
}

/* ------------------------------ 执行同步 ------------------------------ */

/** 抢锁：拿到（自己写的 / 过期 / 没有锁）→ true；别人正在同步 → false */
export async function acquireLock(cfg, auth, now = Date.now()) {
  const mine = { device: cfg.device || deviceName(), at: now };
  const cur = await webdav.getText(cfg.url, LOCK_FILE, { auth, dir: cfg.dir });
  if (cur.exists) {
    let info = null;
    try {
      info = JSON.parse(cur.text || '{}');
    } catch (e) {
      info = null;
    }
    const at = Number(info && info.at) || 0;
    const owner = String((info && info.device) || '');
    if (at && now - at < LOCK_TTL && owner && owner !== mine.device) return false;
  }
  await webdav.putText(cfg.url, LOCK_FILE, JSON.stringify(mine), { auth, dir: cfg.dir });
  return true;
}

export async function releaseLock(cfg, auth) {
  return webdav.remove(cfg.url, LOCK_FILE, { auth, dir: cfg.dir });
}

/** 校验同步配置，返回 { conf, auth, device } */
function requireConfig(cfg) {
  const conf = cfg || loadConfig();
  if (!conf.url || !conf.user) throw new WebdavError('请先填写服务器地址与用户名');
  if (!conf.pass) throw new WebdavError('请填写密码（勾选「记住密码」后无需重复输入）');
  return { conf, auth: { user: conf.user, pass: conf.pass }, device: conf.device || deviceName() };
}

/** 快照规模（预览表用） */
export function countsOf(snapshot) {
  const decks = (snapshot && snapshot.decks) || [];
  return {
    decks: decks.length,
    cards: decks.reduce((n, d) => n + (d.cards || []).length, 0),
    revlogs: decks.reduce((n, d) => n + (d.revlog || []).length, 0)
  };
}

/**
 * 计算这次同步要做的事 —— **只读**：只 GET（索引 + 有变化的卡组），不写任何文件、不抢锁。
 * 「预览差异」与正式同步共用同一套计算，所以预览看到的 = 真正会发生的。
 */
export async function planSync({ cfg = null, now = Date.now(), onStep = null } = {}) {
  const { conf, auth, device } = requireConfig(cfg);
  const local = await buildSnapshot(now);
  const remote = await readRemote(conf, auth, { now, local, onStep });
  const { snapshot: merged, stats, report } = mergeSnapshots(local, remote.snapshot, { now, device });
  const force = remote.missing.slice();
  if (remote.legacy) force.push(...merged.decks.map((d) => String(d.id))); // v1 → v2 迁移：所有卡组都落成分文件
  const { toUpload, toRemove } = uploadPlan(merged.decks, remote.manifest, { force });
  const localOnly = localOnlyDeckIds();
  return {
    at: now,
    conf,
    auth,
    device,
    local,
    remote,
    merged,
    stats,
    report,
    remoteExists: remote.exists,
    legacy: remote.legacy,
    remoteSavedAt: Number(remote.manifest.savedAt) || 0,
    remoteDevice: remote.manifest.device || '',
    fetched: remote.fetched,
    missing: remote.missing,
    toUpload,
    toRemove,
    localOnly,
    keepDeckIds: localOnly
  };
}

/**
 * 同步前预览：**不发任何写请求**，返回「本地 / 远端 / 合并后」的规模、逐卡组明细、冲突列表，
 * 以及本次会下载 / 上传哪些卡组。用户确认后再调 `syncNow()`。
 * 出错（配置不全 / 网络 / 权限）会抛出 `WebdavError`，用 `webdav.explainError(err)` 取中文原因。
 */
export async function previewSync({ cfg = null, now = Date.now(), onStep = null } = {}) {
  const plan = await planSync({ cfg, now, onStep });
  return {
    ok: true,
    at: now,
    device: plan.device,
    remoteExists: plan.remoteExists,
    remoteSavedAt: plan.remoteSavedAt,
    remoteDevice: plan.remoteDevice,
    legacy: plan.legacy,
    stats: plan.stats,
    report: plan.report,
    fetched: plan.fetched,
    missing: plan.missing,
    toUpload: plan.toUpload,
    toRemove: plan.toRemove,
    localOnly: plan.localOnly,
    counts: {
      local: countsOf(plan.local),
      remote: countsOf(plan.remote.snapshot),
      merged: countsOf(plan.merged)
    }
  };
}

/** 预览结论一句话（设置页 / 弹窗标题用） */
export function previewText(pv) {
  if (!pv) return '';
  const parts = [];
  parts.push(`合并后 ${pv.counts.merged.decks} 个卡组 / ${pv.counts.merged.cards} 张卡`);
  const delta = (pv.stats && (pv.stats.cardsAdded + pv.stats.cardsUpdated + pv.stats.cardsRemoved + pv.stats.decksAdded + pv.stats.decksRemoved)) || 0;
  parts.push(delta ? `本地将变化：${statsText(pv.stats)}` : '本地无需变化（已是最新）');
  if (pv.localOnly && pv.localOnly.length) parts.push(`${pv.localOnly.length} 个卡组为本机专用，不参与`);
  return parts.join('；');
}

/**
 * 立即同步一次（v0.9.0 增量）：
 * 建目录 → 抢锁 → 拉索引 → **只**拉有变化的卡组 → 合并 → **只**写有变化的卡组 + 索引 → 应用到本地 → 存墓碑。
 * 失败会抛出 `WebdavError`（用 `webdav.explainError(err)` 取中文原因），并把结果写进配置。
 * @returns {Promise<{ ok:true, at:number, stats:object, applied:object, deckCount:number, uploaded:number }>}
 */
export async function syncNow({ cfg = null, now = Date.now(), onStep = null } = {}) {
  const { conf, auth, device } = requireConfig(cfg);
  const step = (s) => {
    if (onStep) {
      try {
        onStep(s);
      } catch (e) {}
    }
  };
  const result = { ok: false, at: now, stats: null, applied: null, deckCount: 0, uploaded: 0, removed: 0, localOnly: 0, error: '' };

  try {
    step('检查目录');
    await webdav.ensureCollection(conf.url, conf.dir, { auth });
    step('获取同步锁');
    const got = await acquireLock({ ...conf, device }, auth, now);
    if (!got) throw new WebdavError('另一台设备正在同步，请稍后再试', { status: 423 });
    try {
      const plan = await planSync({ cfg: { ...conf, device }, now, onStep: step });
      const written = await writeRemote(conf, auth, {
        merged: plan.merged,
        remoteManifest: plan.remote.manifest,
        known: plan.remote.known,
        force: [...plan.missing, ...(plan.legacy ? plan.merged.decks.map((d) => String(d.id)) : [])],
        remoteText: plan.remote.text,
        now,
        device,
        onStep: step
      });
      step('应用到本地');
      result.applied = store.applySyncDecks(plan.merged.decks, { settings: plan.merged.settings, keepDeckIds: plan.keepDeckIds });
      store.setTombstones(plan.merged.tombstones, now);
      result.ok = true;
      result.stats = plan.stats;
      result.deckCount = plan.merged.decks.length;
      result.savedAt = plan.merged.savedAt;
      result.uploaded = written.uploaded.length;
      result.removed = written.removed.length;
      result.localOnly = plan.localOnly.length;
      result.downloaded = plan.fetched.length;
      lastSig = signature();
    } finally {
      try {
        await releaseLock(conf, auth);
      } catch (e) {}
    }
  } catch (e) {
    result.error = webdav.explainError(e);
    saveConfig({ lastSyncAt: now, lastResult: result });
    throw e;
  }
  saveConfig({ lastSyncAt: now, lastResult: result });
  return result;
}

/* ------------------------------ 自动同步 ------------------------------ */

let autoTimer = null;
let syncing = false;
let lastSig = '';

/** 本机数据的轻量指纹（卡组数 : 卡片数 : 最新修改 : 最新复习）——判断「有没有变」
 *  v0.9.0：**忽略「本机专用」卡组**（改它们不该触发同步） */
export function signature() {
  const db = store.getDb();
  let cards = 0;
  let decks = 0;
  let maxUpdated = 0;
  let maxReview = 0;
  for (const deck of db.decks) {
    if (isLocalOnlyDeck(deck)) continue;
    decks += 1;
    cards += (deck.cards || []).length;
    maxUpdated = Math.max(maxUpdated, Number(deck.updatedAt) || 0);
    for (const c of deck.cards || []) {
      maxUpdated = Math.max(maxUpdated, Number(c.updatedAt) || 0);
      maxReview = Math.max(maxReview, Number(c.lastReview) || 0);
    }
  }
  return `${decks}:${cards}:${maxUpdated}:${maxReview}`;
}

async function autoRun() {
  if (syncing) return null;
  syncing = true;
  try {
    return await syncNow();
  } catch (e) {
    return null; // 自动同步失败静默（结果已记进配置，设置页可看）
  } finally {
    syncing = false;
  }
}

/**
 * 数据变更后调用（由 app.js 在关键动作 / 离开页面时触发）：
 * 仅在「变更后自动同步」开启、填齐了信息、距上次同步超过最小间隔、且指纹确实变了时才真跑。
 */
export async function notifyDataChanged(now = Date.now()) {
  const cfg = loadConfig();
  if (!cfg.autoOnChange || !isConfigured(cfg)) return null;
  if (now - (cfg.lastSyncAt || 0) < AUTO_MIN_GAP) return null;
  if (signature() === lastSig) return null;
  return autoRun();
}

/** 启动自动同步：进入 App 时同步一次（可关）+ 定期检查「数据变了就同步」（可开） */
export function initAutoSync({ interval = AUTO_INTERVAL, delay = 3000, runNow = true } = {}) {
  stopAutoSync();
  lastSig = signature();
  const cfg = loadConfig();
  if (!isConfigured(cfg)) return false;
  if (runNow && cfg.autoOnLoad) {
    const t = setTimeout(() => {
      autoRun();
    }, delay);
    if (t && typeof t.unref === 'function') t.unref();
  }
  if (cfg.autoOnChange) {
    autoTimer = setInterval(() => {
      notifyDataChanged();
    }, interval);
    if (autoTimer && typeof autoTimer.unref === 'function') autoTimer.unref();
  }
  return true;
}

export function stopAutoSync() {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
}

export function isSyncing() {
  return syncing;
}

/** 同步状态快照（设置页 / 测试用） */
export function syncStatus() {
  const cfg = loadConfig();
  return {
    configured: isConfigured(cfg),
    lastSyncAt: cfg.lastSyncAt,
    lastResult: cfg.lastResult,
    autoOnLoad: cfg.autoOnLoad,
    autoOnChange: cfg.autoOnChange
  };
}
