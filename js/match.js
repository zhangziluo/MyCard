// ============================================================================
// match.js — 明牌配对游戏（v0.6.1，路由 #/match/{deckId}）
//
// 解锁：卡组「已通关关卡」≥ UNLOCK_LEVELS（1）时，卡组详情页出现入口横幅。
// 词源（v0.7.1 起可切）：**整个卡组** 或 某一个「已通关关卡」——两者都按 ROUND_PAIRS（5）
//       对一轮切成多轮（多余的配对自动排到后面的轮次），所以「整卡组」就是一轮一轮一直
//       配到本卡组没有对为止（不再 20 张就结束）；整卡组模式单局最多纳入 MAX_DECK_PAIRS(300)
//       张卡（兜底），超出部分不纳入并在页头如实提示。
// 玩法：每轮把该轮卡片展开成 2N 张明牌（N 张单词 + N 张释义，位置随机打乱且**全程可见**）
//       ——先点单词、再点它的释义即配对成功：
//         · 配对成功 → 金色闪光 + 爆炸，这一对**从棋盘移除**（不再显示），连击 +1；
//           连击 ≥2 时在棋盘**右下角**弹出「combo✖️N」并抖一下（N = 当前连击；
//           提示落在棋盘底部留白条内，不遮挡牌面文字）；
//         · 配对失败 → 两张牌抖动后取消选中、combo 提示消失，连击清零、失误 +1；
//         · 本轮 5 对全消完 → 自动铺下一轮，直到所有对配完；
//       全部配完 → 结算「用时 / 失误 / 最大连击」+ 再玩一次。
//
// 分工（见 memory-bank/systemPatterns.md 第 20 条）：
//   · 纯函数内核：解锁判定 / 建牌（按轮切分 + 每轮独立洗牌）/ 洗牌 / 点击状态机 /
//     轮次推演 / 连击计分 / 统计（随机源 rng 可注入 → 单测可复现，不依赖 DOM）
//   · 薄 UI：只负责把内核状态画成 DOM，并把点击喂回内核
//   · 点击后**不做整页重渲染**：只局部打补丁（否则每配一对就把棋盘重建，已消除的牌
//     会复活、键盘焦点也会丢）；只有「本轮清空 → 铺下一轮」这种低频时刻才重写
//     `#match-board` 里的内容
//
// 会话：**只存在内存（页面会话级）**——`S` 是模块级变量，不写 sessionStorage；
//       **任何一次「进入配对页」都会重新洗牌开局**（首次加载 / 刷新 / 路由切换 / 点入口 /
//       点同一关 chip / 点「再玩一次」），因为刷新与路由切换都会让 `S` 归零；
//       只有**同一页内的重渲染**（切主题 / 切主色 / 跟随系统变色）会沿用当前棋局、不重排。
//       路由切换时由 app.js 调 clearMatchSession() 清场（清会话 + 计时器）。
// ============================================================================

import * as store from './store.js';
import * as lv from './levels.js';
import { esc, on, icon, navigate, announce } from './ui.js';

/** 解锁所需「已通关关卡」数（含）——通关 1 关即可玩 */
export const UNLOCK_LEVELS = 1;

/** 每轮铺设的对数（10 张牌 / 轮）；多余的配对自动排到后面的轮次 */
export const ROUND_PAIRS = 5;

/** 单局最多纳入的卡片数（关卡本身 ≤30 张，这里兜底防止异常数据把 DOM 撑爆） */
export const MAX_PAIRS = lv.MAX_PER_LEVEL;

/** 一次「配对成功」的爆炸动画时长（ms）：动画播完才把这对牌从棋盘移除 */
export const BOOM_MS = 420;

/** 「整卡组」模式单局最多纳入的卡片数（300 对 = 600 张牌 = 60 轮；再多的部分不纳入并给出提示） */
export const MAX_DECK_PAIRS = 300;

/* ---------------------------- 解锁 / 词源 ---------------------------- */

/** 已通关的关卡索引（升序）——配对游戏只开放「已通关」的关卡作为词源 */
export function passedLevels(deck, levels = lv.deckLevels(deck)) {
  const states = lv.levelStates(deck, levels);
  return levels.filter((l) => states[l.index] === 'passed').map((l) => l.index);
}

export function passedCount(deck, levels = lv.deckLevels(deck)) {
  return passedLevels(deck, levels).length;
}

/** 解锁状态：{ passed, need, unlocked, left } */
export function unlockInfo(deck) {
  const passed = passedCount(deck);
  return {
    passed,
    need: UNLOCK_LEVELS,
    unlocked: passed >= UNLOCK_LEVELS,
    left: Math.max(0, UNLOCK_LEVELS - passed)
  };
}

/**
 * 词源归一化：`{ kind:'deck' }` | `{ kind:'level', level:n }`。
 * 兼容旧写法：数字 / 数字字符串 / 只有 `level` 字段的对象都当作「关卡词源」。
 */
export function normalizeSource(source) {
  if (source && typeof source === 'object') {
    if (source.kind === 'deck') return { kind: 'deck', level: null };
    if (source.kind === 'level' || source.level != null) {
      return { kind: 'level', level: Number(source.level) || 0 };
    }
    return { kind: 'deck', level: null };
  }
  if (source != null && source !== 'deck') return { kind: 'level', level: Number(source) || 0 };
  return { kind: 'deck', level: null };
}

/** 会话的词源（老会话只有 `level` 字段 → 当作关卡词源） */
export function stateSource(state) {
  if (state && state.source) return normalizeSource(state.source);
  return normalizeSource(state ? state.level : null);
}

/** 默认词源：最高的一关已通关关卡（没有已通关关卡时退回「整卡组」） */
export function defaultSource(deck) {
  const list = passedLevels(deck);
  if (list.length) return { kind: 'level', level: list[list.length - 1] };
  return { kind: 'deck', level: null };
}

/** 默认开局关卡（词源为关卡时返回其关卡号，否则 null） */
export function defaultLevel(deck) {
  const src = defaultSource(deck);
  return src.kind === 'level' ? src.level : null;
}

/** 该关卡是否可玩（必须已通关） */
export function isPlayableLevel(deck, level) {
  return passedLevels(deck).includes(Number(level));
}

/** 词源是否仍然有效（「整卡组」永远有效；关卡词源必须仍已通关） */
export function isValidSource(deck, source) {
  const src = normalizeSource(source);
  if (src.kind !== 'level') return true;
  return isPlayableLevel(deck, src.level);
}

/** 词源文案：`整卡组` / `第 3 关` */
export function sourceLabel(source) {
  const src = normalizeSource(source);
  return src.kind === 'level' ? `第 ${Number(src.level) + 1} 关` : '整卡组';
}

/** 页面标题：`明牌配对 · 整卡组` / `明牌配对 · 第 3 关` */
export function matchTitle(source) {
  return `明牌配对 · ${sourceLabel(source)}`;
}

/** 词源的取卡上限：「整卡组」比单关大得多 */
export function sourceLimit(source) {
  return normalizeSource(source).kind === 'level' ? MAX_PAIRS : MAX_DECK_PAIRS;
}

/** 词源可用卡片总数（未截断） */
export function sourceTotal(deck, source) {
  const src = normalizeSource(source);
  if (src.kind === 'level') return lv.cardsInLevel(deck, Number(src.level) || 0).length;
  return ((deck && deck.cards) || []).length;
}

/** 取词源的卡片（作为配对牌面用；「整卡组」最多 MAX_DECK_PAIRS 张、单关最多 MAX_PAIRS 张） */
export function sourceCards(deck, source, limit = sourceLimit(source)) {
  return sourceTotalCards(deck, source).slice(0, clampLimit(limit));
}

function sourceTotalCards(deck, source) {
  const src = normalizeSource(source);
  if (src.kind === 'level') return lv.cardsInLevel(deck, Number(src.level) || 0);
  return ((deck && deck.cards) || []).slice();
}

/** 取某关的卡片（保留的旧入口 → 等价于关卡词源的 sourceCards） */
export function levelCardsFor(deck, level, limit = MAX_PAIRS) {
  return sourceCards(deck, { kind: 'level', level }, limit);
}

/** 单局牌数上限：非法值一律回落到 MAX_PAIRS，至少 1 张卡 */
function clampLimit(limit) {
  const n = Number(limit);
  return Math.max(1, Number.isFinite(n) ? Math.floor(n) : MAX_PAIRS);
}

/** 正整数兜底（每轮对数等入参） */
function posInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/* ------------------------------- 牌面 ------------------------------- */

/** 单词牌文字（卡面正面） */
export function wordText(card) {
  const front = String((card && card.front) || '').trim();
  return front || '（无正面）';
}

/** 释义牌文字：背面 → 第一条其它释义 → 兜底文案 */
export function defText(card) {
  const c = card || {};
  const back = String(c.back || '').trim();
  if (back) return back;
  const extra = Array.isArray(c.extraBacks) ? String(c.extraBacks[0] || '').trim() : '';
  return extra || '（无释义）';
}

/** Fisher-Yates 洗牌（随机源可注入 → 单测用 LCG 完全复现） */
export function shuffle(list, rng = Math.random) {
  const a = [...(list || [])];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 由卡片列表生成明牌：每张卡 → 单词牌（w-{id}）+ 释义牌（d-{id}），再整体打乱。
 * 牌 id 与卡 id 一一对应，配对判定因此只需比较 cardId。
 */
export function buildTiles(cards, rng = Math.random, limit = MAX_PAIRS) {
  const max = clampLimit(limit);
  const tiles = [];
  for (const c of (Array.isArray(cards) ? cards : []).slice(0, max)) {
    if (!c || !c.id) continue;
    tiles.push({ id: `w-${c.id}`, cardId: c.id, kind: 'word', text: wordText(c) });
    tiles.push({ id: `d-${c.id}`, cardId: c.id, kind: 'def', text: defText(c) });
  }
  return shuffle(tiles, rng);
}

/** 按每轮 ROUND_PAIRS 对把卡片切分（多余的配对自动排到后面的轮次） */
export function splitRounds(cards, per = ROUND_PAIRS) {
  const size = posInt(per, ROUND_PAIRS);
  const list = (Array.isArray(cards) ? cards : []).filter((c) => c && c.id);
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** 整副牌：每轮**独立洗牌**（保证每轮都是词义混排，不会出现整轮全是词牌的死局） */
export function buildBoard(cards, rng = Math.random, per = ROUND_PAIRS) {
  return splitRounds(cards, per).flatMap((group) => buildTiles(group, rng, per));
}

/* ------------------------------- 轮次 ------------------------------- */

/** 每轮牌数（2N 张） */
export function roundSize(state) {
  return posInt(state && state.roundPairs, ROUND_PAIRS) * 2;
}

/** 当前轮次索引（0 基） */
export function roundIndex(state) {
  const i = Number(state && state.round);
  return Number.isFinite(i) && i > 0 ? Math.floor(i) : 0;
}

/** 老会话 / 手写状态没有轮次信息 → 整盘当作一轮（与单轮版行为一致） */
function singleRound(state) {
  return !state || (state.roundPairs == null && state.round == null);
}

/** 当前轮的牌（整轮，含已消掉的牌） */
export function roundTiles(state) {
  const tiles = (state && state.tiles) || [];
  if (singleRound(state)) return tiles.slice();
  const size = roundSize(state);
  const start = roundIndex(state) * size;
  return tiles.slice(start, start + size);
}

/** 轮次总数（0 张牌时 0） */
export function roundCount(state) {
  const tiles = (state && state.tiles) || [];
  if (!tiles.length) return 0;
  if (singleRound(state)) return 1;
  return Math.ceil(tiles.length / roundSize(state));
}

/** 本轮还剩几对没消掉 */
export function roundLeft(state) {
  const matched = new Set((state && state.matched) || []);
  return roundTiles(state).filter((t) => !matched.has(t.id)).length / 2;
}

/** 当前轮还未消掉的牌（= 棋盘上真正显示的牌） */
export function liveTiles(state) {
  const matched = new Set((state && state.matched) || []);
  return roundTiles(state).filter((t) => !matched.has(t.id));
}

/** 轮次进度：{ round, rounds, pairs, left, done, allDone }（round 为 1 基，便于展示） */
export function roundStats(state) {
  const rounds = roundCount(state);
  const left = roundLeft(state);
  return {
    round: rounds ? Math.min(roundIndex(state), rounds - 1) + 1 : 0,
    rounds,
    pairs: roundTiles(state).length / 2,
    left,
    done: rounds > 0 && left === 0,
    allDone: boardStats(state).done
  };
}

/* ---------------------------- 配对判定 / 状态机 ---------------------------- */

/** 两张牌是否互为配对（同一张卡的单词牌 + 释义牌） */
export function isMatch(a, b) {
  return !!(a && b) && a.cardId === b.cardId && a.kind !== b.kind;
}

/** 按 id 找牌（棋盘 ≤10 张，Map 构建一次 O(n)） */
export function tileMap(tiles) {
  const m = new Map();
  for (const t of tiles || []) m.set(t.id, t);
  return m;
}

/** 已消除的牌不再响应点击 */
function isMatchedTile(state, tileId) {
  return (state.matched || []).includes(tileId);
}

/** 只有当前轮的牌可点（越界的牌 id 一律忽略，避免脏数据把轮次搅乱） */
function inRound(state, tileId) {
  return roundTiles(state).some((t) => t.id === tileId);
}

/**
 * 一次点击后的选中态：
 *   'ignore'  点到已消除 / 不在本轮 / 未知的牌
 *   'select'  首次选中
 *   'cancel'  再点同一张 → 取消选中
 *   'replace' 同类（词→词 / 义→义）→ 改用新选中的那张
 *   'match'   词 + 义且同一张卡 → 配对成功（pair = 两张牌的 id）
 *   'miss'    词 + 义但不同卡 → 配对失败（pair = 两张牌的 id）
 * @returns {{ selectedId: string|null, event: string, pair: string[]|null }}
 */
export function nextSelection(state, tileId, map = tileMap(state.tiles)) {
  const selectedId = state.selectedId;
  const tile = map.get(tileId);
  if (!tile || isMatchedTile(state, tileId) || !inRound(state, tileId)) return { selectedId, event: 'ignore', pair: null };
  if (selectedId == null) return { selectedId: tileId, event: 'select', pair: null };
  if (selectedId === tileId) return { selectedId: null, event: 'cancel', pair: null };
  const prev = map.get(selectedId);
  if (!prev) return { selectedId: tileId, event: 'select', pair: null };
  if (prev.kind === tile.kind) return { selectedId: tileId, event: 'replace', pair: null };
  return {
    selectedId: null,
    event: isMatch(prev, tile) ? 'match' : 'miss',
    pair: [prev.id, tile.id]
  };
}

/**
 * 新会话：整关卡片按每轮 ROUND_PAIRS 对切分，每轮各自洗牌铺开。
 * roundPairs 写进会话 → 刷新 / 重渲染后轮次划分完全不变。
 */
/**
 * 新会话：把词源的卡片按每轮 ROUND_PAIRS 对切分，每轮各自洗牌铺开。
 * `source` 支持 `{ kind:'deck' }` / `{ kind:'level', level:n }`（也兼容旧写法：直接传关卡号）。
 * roundPairs 写进会话 → 刷新 / 重渲染后轮次划分完全不变。
 */
export function newSession(deckId, source, cards, now = Date.now(), rng = Math.random, per = ROUND_PAIRS) {
  const src = normalizeSource(source);
  const roundPairs = posInt(per, ROUND_PAIRS);
  const list = Array.isArray(cards) ? cards : [];
  return {
    deckId,
    source: src,
    level: src.kind === 'level' ? src.level : null, // 兼容旧字段（关卡词源才有）
    roundPairs,
    tiles: buildBoard(list, rng, roundPairs),
    round: 0, // 当前轮次（0 基）
    selectedId: null,
    matched: [], // 已消除的牌 id（跨轮累计）
    combo: 0,
    maxCombo: 0,
    mistakes: 0,
    startedAt: now,
    endedAt: null,
    event: null
  };
}

/**
 * 把一次点击喂进状态机：返回 { state, event, pair, roundCleared }（不修改入参，便于单测）。
 * 配对成功 → 记下两张牌、连击 +1 并刷新最大连击；本轮消完且还有下一轮 → round +1 且
 * roundCleared = true（UI 据此铺下一轮）；配对失败 → 连击清零、失误 +1；
 * 全部配完时写入 endedAt（用时定格）。
 */
export function applyPick(state, tileId, now = Date.now()) {
  const tiles = state.tiles || [];
  const out = nextSelection(state, tileId);
  const next = { ...state, matched: (state.matched || []).slice(), selectedId: out.selectedId, event: out.event };
  let roundCleared = false;
  if (out.event === 'match') {
    next.matched = next.matched.concat(out.pair);
    next.combo = (state.combo || 0) + 1;
    next.maxCombo = Math.max(state.maxCombo || 0, next.combo);
    roundCleared = roundLeft(next) === 0;
    if (roundCleared && next.matched.length < tiles.length) next.round = roundIndex(state) + 1;
  } else if (out.event === 'miss') {
    next.combo = 0;
    next.mistakes = (state.mistakes || 0) + 1;
  }
  if (tiles.length && next.matched.length >= tiles.length) {
    next.endedAt = now;
    roundCleared = false; // 最后一对消掉 → 直接结算，没有「下一轮」
  }
  return { state: next, event: next.event, pair: out.pair, roundCleared };
}

/* ------------------------------- 统计 ------------------------------- */

/** 整局进度：{ tiles, matched, pairs, totalPairs, left, done } */
export function boardStats(state) {
  const tiles = (state && state.tiles) || [];
  const matched = (state && state.matched) || [];
  return {
    tiles: tiles.length,
    matched: matched.length,
    pairs: matched.length / 2,
    totalPairs: tiles.length / 2,
    left: tiles.length - matched.length,
    done: tiles.length > 0 && matched.length >= tiles.length
  };
}

export function isDone(state) {
  return boardStats(state).done;
}

/** 对局统计：{ elapsedMs, mistakes, combo, maxCombo, pairs, totalPairs } */
export function playStats(state, now = Date.now()) {
  const b = boardStats(state);
  const start = (state && state.startedAt) || now;
  const end = (state && state.endedAt) || now;
  return {
    elapsedMs: Math.max(0, end - start),
    mistakes: (state && state.mistakes) || 0,
    combo: (state && state.combo) || 0,
    maxCombo: (state && state.maxCombo) || 0,
    pairs: b.pairs,
    totalPairs: b.totalPairs
  };
}

/** 用时文案：`45秒` / `1分05秒` / `2分30秒` */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return mm ? `${mm}分${String(ss).padStart(2, '0')}秒` : `${ss}秒`;
}

/* ------------------------------- 会话存取 ------------------------------- */

let S = null; // 当前会话（**只存内存**：进入配对页 = 新的一局，见文件头注释）
let clock = null; // 用时计时器
let missTimer = null; // 「配对失败」抖动的清除定时器
let boomTimer = null; // 「爆炸消除 → 铺下一轮 / 结算」的定时器

function stopClock() {
  if (clock) {
    clearInterval(clock);
    clock = null;
  }
}

function stopMissTimer() {
  if (missTimer) {
    clearTimeout(missTimer);
    missTimer = null;
  }
}

function stopBoomTimer() {
  if (boomTimer) {
    clearTimeout(boomTimer);
    boomTimer = null;
  }
}

/** 清空会话与所有定时器（路由切换 / 重置数据 / 离开棋局调用） */
export function clearMatchSession() {
  stopClock();
  stopMissTimer();
  stopBoomTimer();
  S = null;
}

/** 读取当前会话（供测试 / 页面自查，页面本身不依赖它） */
export function getMatchSession() {
  return S;
}

/* ------------------------------- 渲染 ------------------------------- */

function byId(id) {
  return typeof document !== 'undefined' && document.getElementById ? document.getElementById(id) : null;
}

function rootView() {
  return byId('view');
}

function all(sel) {
  const root = rootView();
  return root && root.querySelectorAll ? Array.from(root.querySelectorAll(sel)) : [];
}

/** 只改 class，不整页重渲染（避免已消除的牌复活 / 丢焦点） */
function setClass(el, cls, want) {
  if (!el || !el.classList) return;
  if (el.classList.toggle) el.classList.toggle(cls, !!want);
  else if (want) el.classList.add(cls);
  else el.classList.remove(cls);
}

function setText(el, text) {
  if (el) el.textContent = text;
}

/** 一张牌（配对成功的牌会离开棋盘，所以这里没有「已配对」态） */
function tileHtml(tile, selected) {
  const cls = ['match-tile', `match-tile-${tile.kind}`, selected ? 'is-selected' : ''].filter(Boolean).join(' ');
  const kindLabel = tile.kind === 'word' ? '单词' : '释义';
  return `
    <button type="button" class="${cls}" data-action="match-pick" data-tile="${esc(tile.id)}"
      aria-pressed="${selected ? 'true' : 'false'}"
      aria-label="${kindLabel}「${esc(tile.text)}」">
      <span class="match-tile-text">${esc(tile.text)}</span>
    </button>`;
}

function statCellHtml(key, label, value) {
  return `<div class="match-stat"><b data-match="${key}">${esc(value)}</b><span>${esc(label)}</span></div>`;
}

/** 结算面板（未完成时由外层加 hidden） */
function resultHtml(state) {
  const st = playStats(state);
  return `
    <div class="match-done">
      <div class="match-done-icon" aria-hidden="true">${icon('check', 30)}</div>
      <h3>全部配对完成</h3>
      <div class="match-final">
        <div><b>${formatDuration(st.elapsedMs)}</b><span>用时</span></div>
        <div><b>${st.mistakes}</b><span>失误</span></div>
        <div><b>${st.maxCombo}</b><span>最大连击</span></div>
      </div>
      <div class="match-done-actions">
        <button class="btn btn-primary" data-action="match-replay">${icon('refresh', 16)} 再玩一次</button>
        <button class="btn btn-ghost" data-action="match-back">返回卡组</button>
      </div>
    </div>`;
}

/** 词源选择 chips：整卡组 + 每个已通关关卡 */
function levelPickerHtml(deck, source) {
  const cur = normalizeSource(source);
  const levels = passedLevels(deck);
  const deckActive = cur.kind !== 'level';
  const chip = (active, attrs, label) =>
    `<button type="button" class="match-lv${active ? ' is-active' : ''}" ${attrs} aria-pressed="${active ? 'true' : 'false'}">${label}</button>`;
  return `<div class="match-levels" role="group" aria-label="选择词源">
    ${chip(deckActive, 'data-action="match-source" data-kind="deck"', `整卡组（${((deck && deck.cards) || []).length} 张）`)}
    ${levels
      .map((i) =>
        chip(
          !deckActive && cur.level === i,
          `data-action="match-source" data-kind="level" data-level="${i}"`,
          `第 ${i + 1} 关`
        )
      )
      .join('')}
  </div>`;
}

/** 词源摘要：整卡组可能被兜底上限截断，这里如实说明 */
function sourceNoteHtml(deck, state) {
  const src = stateSource(state);
  if (src.kind !== 'level') {
    const total = sourceTotal(deck, src);
    const used = boardStats(state).totalPairs;
    if (used && used < total) return `<span class="hint">已纳入 ${used}/${total} 张卡（整卡组最多 ${MAX_DECK_PAIRS} 张，其余不纳入本局）</span>`;
    return `<span class="hint">整卡组 ${total} 张卡全都在本局里（每轮 ${state.roundPairs || ROUND_PAIRS} 对，一轮一轮配完为止）</span>`;
  }
  return '';
}

/** 轮次文案：`第 2/6 轮 · 本轮还剩 3 对` */
function roundText(state) {
  const r = roundStats(state);
  if (!r.rounds) return '';
  if (r.allDone) return `全部完成 · 共 ${r.rounds} 轮`;
  return `第 ${r.round}/${r.rounds} 轮 · 本轮还剩 ${r.left} 对`;
}

/** 连击提示：combo✖️N（贴棋盘右下角、落在底部留白条内；连续配对 ≥2 才显示；配对失败即隐藏） */
function comboHtml(state) {
  const combo = Number(state && state.combo) || 0;
  const show = combo >= 2;
  return `<span class="match-combo" id="match-combo" aria-hidden="true"${show ? '' : ' hidden'}>combo✖️${show ? combo : 2}</span>`;
}

/** 棋盘区域 HTML（本轮清空 → 铺下一轮时只重写这一块） */
function boardTilesHtml(state) {
  const list = liveTiles(state);
  if (list.length) return list.map((t) => tileHtml(t, state.selectedId === t.id)).join('');
  if (isDone(state)) return '<div class="empty glass"><h3>全部配对完成</h3><p>成绩见下方结算面板。</p></div>';
  return '<div class="empty glass"><h3>这一轮清空啦</h3><p>正在铺下一轮…</p></div>';
}

/** 棋盘页整页 HTML（仅在开局 / 换关 / 重开 / 重渲染等低频时刻生成） */
export function boardHtml(deck, state) {
  const b = boardStats(state);
  const pct = b.tiles ? Math.round((b.matched / b.tiles) * 100) : 0;
  const st = playStats(state);
  const perRound = state.roundPairs || ROUND_PAIRS;
  const src = stateSource(state);
  const tilesHtml = b.tiles
    ? boardTilesHtml(state)
    : `<div class="empty glass"><h3>${src.kind === 'level' ? '这一关还没有卡片' : '这个卡组还没有卡片'}</h3><p>${
        src.kind === 'level' ? '先给关卡添加卡片，再来玩配对。' : '先给卡组添加卡片，再来玩配对。'
      }</p></div>`;

  return `
    <div class="view view-match">
      <div class="match-head glass">
        <div class="match-title-row">
          <h2 class="screen-title">${esc(matchTitle(src))}</h2>
          <span class="sub-note">每轮 ${perRound} 对 · 点单词再点它的释义</span>
        </div>
        <div class="match-round" data-match="round">${esc(roundText(state))}</div>
        <div class="match-stats">
          ${statCellHtml('time', '用时', formatDuration(st.elapsedMs))}
          ${statCellHtml('pairs', '已配对', `${b.pairs}/${b.totalPairs}`)}
          ${statCellHtml('misses', '失误', String(st.mistakes))}
          ${statCellHtml('combo', '最大连击', String(st.maxCombo))}
        </div>
        <div class="progress-track" id="match-progress" role="progressbar" aria-label="配对进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i class="progress-fill" style="width:${pct}%"></i></div>
        ${sourceNoteHtml(deck, state)}
        ${levelPickerHtml(deck, src)}
      </div>
      <div class="match-board-wrap">
        <div class="match-board" id="match-board" role="group" aria-label="配对棋盘">${tilesHtml}</div>
        ${comboHtml(state)}
      </div>
      <div class="match-result glass" id="match-result"${b.done ? '' : ' hidden'}>${b.done ? resultHtml(state) : ''}</div>
    </div>`;
}

/** 未解锁时的引导页（正常流程下入口横幅只在解锁后出现，这里是兜底） */
function lockedHtml(deck, info) {
  return `
    <div class="view view-match">
      <div class="empty glass">
        <div class="empty-icon">${icon('lock', 26)}</div>
        <h3>明牌配对尚未解锁</h3>
        <p>通关 ${info.need} 关后解锁「明牌配对」——每轮 ${ROUND_PAIRS} 对明牌，点单词再点它的释义；配对正确的这一对会<b>爆炸消除</b>，连续配对成功还有「combo✖️N」连击提示。</p>
        <p class="hint">「${esc(deck.name)}」已通关 ${info.passed} 关，还差 ${info.left} 关。</p>
        <a class="btn btn-primary" href="#/deck/${esc(deck.id)}">返回卡组闯关</a>
      </div>
    </div>`;
}

/* ------------------------------- 计时与统计 ------------------------------- */

/** 用时计时器：每秒刷新「用时」（完成 / 会话清空后自动停） */
function startClock() {
  stopClock();
  if (typeof setInterval !== 'function') return;
  clock = setInterval(() => {
    if (!S || isDone(S)) {
      stopClock();
      return;
    }
    updateStats();
  }, 1000);
  if (clock && typeof clock.unref === 'function') clock.unref(); // Node 单测不阻塞退出
}

/** 只刷新统计区（不整页重渲染） */
function updateStats() {
  if (!S) return;
  const b = boardStats(S);
  const st = playStats(S);
  for (const el of all('[data-match]')) {
    const key = el.dataset && el.dataset.match;
    if (key === 'time') setText(el, formatDuration(st.elapsedMs));
    else if (key === 'pairs') setText(el, `${b.pairs}/${b.totalPairs}`);
    else if (key === 'misses') setText(el, String(st.mistakes));
    else if (key === 'combo') setText(el, String(st.maxCombo));
    else if (key === 'round') setText(el, roundText(S));
  }
  const bar = byId('match-progress');
  if (bar && b.tiles) {
    const pct = Math.round((b.matched / b.tiles) * 100);
    if (bar.setAttribute) bar.setAttribute('aria-valuenow', String(pct));
    setBarWidth(bar, pct);
  }
}

/** 进度条填充宽度（进度条是既有组件，这里只改宽度） */
function setBarWidth(bar, pct) {
  const fill = bar && bar.querySelector ? bar.querySelector('.progress-fill') : null;
  if (fill && fill.style) fill.style.width = `${pct}%`;
}

/** 铺下一轮：只重写棋盘区域（不整页重渲染），焦点交给新铺的第一张牌 */
function renderBoard() {
  const board = byId('match-board');
  if (board && board.innerHTML !== undefined) board.innerHTML = boardTilesHtml(S);
  updateStats();
  const first = all('.match-tile')[0];
  if (first && first.focus) {
    try {
      first.focus();
    } catch (e) {}
  }
  const r = roundStats(S);
  announce(`第 ${r.round} 轮开始，本轮 ${r.pairs} 对`);
}

/** 配对成功后把焦点交给下一张还能点的牌（纯键盘也能连玩，焦点不丢） */
function focusNextPlayable(afterId) {
  const list = all('.match-tile').filter((el) => el && !el.disabled);
  if (!list.length) return;
  const idx = list.findIndex((el) => el.dataset && el.dataset.tile === afterId);
  const next = list[(idx + 1 + list.length) % list.length] || list[0];
  if (next && next.focus) {
    try {
      next.focus();
    } catch (e) {}
  }
}

/** 结算：棋盘收尾、填入完成面板、播报成绩并把焦点交给「再玩一次」 */
function finishGame() {
  const panel = byId('match-result');
  stopClock();
  const st = playStats(S);
  // 最后一对爆炸消除后，棋盘区域换成「全部配对完成」提示（与最后一屏一致）
  const board = byId('match-board');
  if (board && board.innerHTML !== undefined) board.innerHTML = boardTilesHtml(S);
  if (panel) {
    if (panel.innerHTML !== undefined) panel.innerHTML = resultHtml(S);
    panel.hidden = false;
    setClass(panel, 'show', true);
    const btn = panel.querySelector ? panel.querySelector('[data-action="match-replay"]') : null;
    if (btn && btn.focus) {
      try {
        btn.focus();
      } catch (e) {}
    }
  }
  announce(`全部配对完成，用时 ${formatDuration(st.elapsedMs)}，失误 ${st.mistakes} 次，最大连击 ${st.maxCombo}`);
}

/* --------------------------- 点击后的局部打补丁 --------------------------- */

/** 爆炸动画时长（用户偏好「减少动效」→ 立即移除，不空等 420ms） */
function boomMs() {
  try {
    const mq =
      typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    if (mq && mq.matches) return 0;
  } catch (e) {}
  return BOOM_MS;
}

/** 把一对已消除的牌从棋盘上拿掉（DOM 上真的不再显示） */
function removePair(pair) {
  const set = new Set(pair || []);
  for (const el of all('.match-tile')) {
    const id = el.dataset && el.dataset.tile;
    if (!id || !set.has(id)) continue;
    if (el.remove) el.remove();
    else if ('hidden' in el) el.hidden = true;
  }
}

/** 爆炸播完 → 拿掉这对牌 → 铺下一轮 / 结算 / 交还焦点 */
function scheduleBoom(pair, roundCleared) {
  stopBoomTimer();
  boomTimer = setTimeout(() => {
    boomTimer = null;
    removePair(pair);
    if (!S) return;
    if (isDone(S)) {
      finishGame();
      return;
    }
    if (roundCleared) {
      renderBoard();
      return;
    }
    focusNextPlayable(pair && pair[pair.length - 1]);
  }, boomMs());
  if (boomTimer && typeof boomTimer.unref === 'function') boomTimer.unref();
}

/** 连击提示：combo✖️N（同一节点改文字 + 重放抖动动画，不重建棋盘） */
function showCombo(n) {
  const el = byId('match-combo');
  if (!el) return;
  if (el.textContent !== undefined) el.textContent = `combo✖️${n}`;
  el.hidden = false;
  setClass(el, 'is-pop', false);
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 0);
  raf(() => setClass(el, 'is-pop', true));
}

/** 配对失败 / 连击中断 → 收起连击提示 */
function hideCombo() {
  const el = byId('match-combo');
  if (!el) return;
  el.hidden = true;
  setClass(el, 'is-pop', false);
}

/** 连击 ≥2 时让「最大连击」格子弹一下（先摘 class 再下一帧加回 → 动画可重复播放） */
function popComboCell() {
  const cell = all('[data-match="combo"]')[0];
  if (!cell) return;
  const target = cell.parentElement || cell;
  setClass(target, 'combo-pop', false);
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 0);
  raf(() => setClass(target, 'combo-pop', true));
  const t = setTimeout(() => setClass(target, 'combo-pop', false), 700);
  if (t && typeof t.unref === 'function') t.unref();
}

/** 点击后的局部打补丁：选中态 / 金光 · 爆炸消除 / 连击提示 / 统计 / 焦点 */
function paintPick(event, pair, roundCleared) {
  const pairSet = new Set(pair || []);
  for (const el of all('.match-tile')) {
    const id = el.dataset && el.dataset.tile;
    if (!id) continue;
    const chosen = id === S.selectedId;
    setClass(el, 'is-selected', chosen);
    if (el.setAttribute) el.setAttribute('aria-pressed', chosen ? 'true' : 'false');
    if (event === 'match' && pairSet.has(id)) {
      setClass(el, 'is-matched', true);
      setClass(el, 'is-boom', true);
      if ('disabled' in el) el.disabled = true;
      if (el.setAttribute) el.setAttribute('aria-pressed', 'true');
    }
    if (event === 'miss' && pairSet.has(id)) {
      setClass(el, 'is-wrong', true);
      stopMissTimer();
      missTimer = setTimeout(() => {
        for (const e2 of all('.match-tile.is-wrong')) setClass(e2, 'is-wrong', false);
        missTimer = null;
      }, 460);
      if (missTimer && typeof missTimer.unref === 'function') missTimer.unref();
    }
  }
  updateStats();
  if (event === 'match') {
    // 连击 ≥2：在棋盘右下角浮出「combo✖️N」并抖一下，同时播报 + 让「最大连击」格弹一下
    if (S.combo >= 2) {
      showCombo(S.combo);
      announce(`配对成功，连击 ×${S.combo}`);
      popComboCell();
    } else {
      announce('配对成功');
    }
    scheduleBoom(pair, roundCleared);
  } else if (event === 'miss') {
    hideCombo();
    announce('配对失败，连击清零');
  }
}

/* ------------------------------- 开局 / 路由 ------------------------------- */

/**
 * 开一局（可注入 rng 便于单测复现洗牌）。
 * 只写内存会话，不落 sessionStorage —— 「重新进入同一关」必须拿到新洗的牌面。
 * 词源：`{ kind:'deck' }`（整个卡组，一轮一轮配完）/ `{ kind:'level', level:n }`（某个已通关关卡）。
 */
function startGame(deck, source, rng = Math.random) {
  const src = isValidSource(deck, source) ? normalizeSource(source) : defaultSource(deck);
  S = newSession(deck.id, src, sourceCards(deck, src), Date.now(), rng);
  return S;
}

/** 页面入口（由 app.js 的 render() 调用：#/match/{deckId}） */
export function renderMatch(root, deckId) {
  const deck = store.getDeck(deckId);
  if (!deck) {
    root.innerHTML = `<div class="view"><div class="empty glass"><h3>卡组不存在</h3><a class="btn btn-primary" href="#/home">返回首页</a></div></div>`;
    return;
  }
  const info = unlockInfo(deck);
  if (!info.unlocked) {
    clearMatchSession();
    root.innerHTML = lockedHtml(deck, info);
    return;
  }

  // 内存里已有本卡组的棋局 → 属于「同一页内的重渲染」（切主题 / 切主色），沿用不动；
  // 其余情况（首次加载 / 刷新 / 路由切换 / 点入口）一律**重新洗牌开局**。
  let s = S && S.deckId === deckId ? S : null;
  if (!s || !isValidSource(deck, stateSource(s))) s = startGame(deck, defaultSource(deck));
  S = s;

  root.innerHTML = boardHtml(deck, S);
  if (isDone(S)) stopClock();
  else startClock();
}

/* 点一张牌：喂进状态机 → 局部打补丁 */
on('match-pick', (el) => {
  if (!S || !el || !el.dataset) return;
  const out = applyPick(S, el.dataset.tile);
  if (out.event === 'ignore') return;
  S = out.state;
  paintPick(out.event, out.pair, out.roundCleared);
});

/* 换词源：整卡组（一直配到本卡组没有对为止）/ 某个已通关关卡 */
on('match-source', (el) => {
  if (!S || !el || !el.dataset) return;
  const deck = store.getDeck(S.deckId);
  if (!deck) return;
  const kind = el.dataset.kind === 'level' ? 'level' : 'deck';
  const source = kind === 'level' ? { kind, level: Number(el.dataset.level) } : { kind: 'deck', level: null };
  if (!isValidSource(deck, source)) return; // 未通关的关卡不可切换
  const cur = stateSource(S);
  if (cur.kind === source.kind && cur.level === source.level) return; // 点同一个词源不重开
  clearMatchSession();
  startGame(deck, source);
  renderMatch(rootView(), deck.id);
});

/* 再玩一次：同一词源重新洗牌 */
on('match-replay', () => {
  if (!S) return;
  const deck = store.getDeck(S.deckId);
  if (!deck) return;
  const source = stateSource(S);
  clearMatchSession();
  startGame(deck, source);
  renderMatch(rootView(), deck.id);
});

/* 返回卡组：跳回详情页（路由变化会清空会话） */
on('match-back', () => {
  const deckId = (S && S.deckId) || '';
  clearMatchSession();
  if (deckId) navigate(`#/deck/${deckId}`);
});
