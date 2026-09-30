// ============================================================================
// match.js — 明牌配对游戏（v0.5.11，路由 #/match/{deckId}）
//
// 解锁：卡组「已通关关卡」≥ UNLOCK_LEVELS（3）时，卡组详情页出现入口横幅。
// 玩法：取某一「已通关关卡」的全部卡片，展开成 2N 张明牌（N 张单词 + N 张释义，
//       位置随机打乱且**全程可见**）——先点单词、再点它的释义即配对成功：
//         · 配对成功 → 金色闪光 + 迸发，连击 +1（≥2 时弹出「连击 ×N」），两张牌变金收起；
//         · 配对失败 → 两张牌抖动后取消选中，连击清零、失误 +1。
//       全部配完 → 结算「用时 / 失误 / 最大连击」+ 再玩一次。
//
// 分工（见 memory-bank/systemPatterns.md 第 20 条）：
//   · 纯函数内核：解锁判定 / 建牌 / 洗牌 / 点击状态机 / 连击计分 / 统计
//     （随机源 rng 可注入 → 单测可复现，不依赖 DOM）
//   · 薄 UI：只负责把内核状态画成 DOM，并把点击喂回内核
//   · 点击后**不做整页重渲染**：只局部打补丁（否则每配一对就把棋盘重建，
//     已配对的牌会重复播金光、键盘焦点也会丢）
//
// 会话：sessionStorage（key mycard-match-session，关掉标签页即清空）；
//       路由切换时由 app.js 调 clearMatchSession() 清场。
// ============================================================================

import * as store from './store.js';
import * as lv from './levels.js';
import { esc, on, icon, navigate, announce } from './ui.js';

/** 解锁所需「已通关关卡」数（含） */
export const UNLOCK_LEVELS = 3;

/** 单局最多纳入的卡片数（关卡本身 ≤30 张，这里兜底防止异常数据把 DOM 撑爆） */
export const MAX_PAIRS = lv.MAX_PER_LEVEL;

export const SESSION_KEY = 'mycard-match-session';

/* ---------------------------- 解锁 / 可选关卡 ---------------------------- */

/** 已通关的关卡索引（升序）——配对游戏只开放「已通关」的关卡 */
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

/** 默认开局关卡：最高的一关已通关关卡（没有则 null） */
export function defaultLevel(deck) {
  const list = passedLevels(deck);
  return list.length ? list[list.length - 1] : null;
}

/** 该关卡是否可玩（必须已通关） */
export function isPlayableLevel(deck, level) {
  return passedLevels(deck).includes(Number(level));
}

/** 取某关的卡片（作为配对牌面用；最多 MAX_PAIRS 张） */
export function levelCardsFor(deck, level, limit = MAX_PAIRS) {
  return lv.cardsInLevel(deck, level).slice(0, clampLimit(limit));
}

/** 单局牌数上限：非法值一律回落到 MAX_PAIRS，至少 1 张卡 */
function clampLimit(limit) {
  const n = Number(limit);
  return Math.max(1, Number.isFinite(n) ? Math.floor(n) : MAX_PAIRS);
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

/** 两张牌是否互为配对（同一张卡的单词牌 + 释义牌） */
export function isMatch(a, b) {
  return !!(a && b) && a.cardId === b.cardId && a.kind !== b.kind;
}

/** 按 id 找牌（棋盘 ≤60 张，Map 构建一次 O(n)） */
export function tileMap(tiles) {
  const m = new Map();
  for (const t of tiles || []) m.set(t.id, t);
  return m;
}

/* ---------------------------- 点击状态机（纯函数） ---------------------------- */

/** 已配对的牌不再响应点击 */
function isMatchedTile(state, tileId) {
  return (state.matched || []).includes(tileId);
}

/**
 * 一次点击后的选中态：
 *   'ignore'  点到已配对的牌 / 未知牌
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
  if (!tile || isMatchedTile(state, tileId)) return { selectedId, event: 'ignore', pair: null };
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

/** 新会话（一副刚洗好的牌） */
export function newSession(deckId, level, cards, now = Date.now(), rng = Math.random) {
  return {
    deckId,
    level,
    tiles: buildTiles(cards, rng),
    selectedId: null,
    matched: [], // 已配对的牌 id
    combo: 0,
    maxCombo: 0,
    mistakes: 0,
    startedAt: now,
    endedAt: null,
    event: null
  };
}

/**
 * 把一次点击喂进状态机：返回 { state, event, pair }（不修改入参，便于单测）。
 * 配对成功 → 记下两张牌、连击 +1 并刷新最大连击；配对失败 → 连击清零、失误 +1；
 * 全部配完时写入 endedAt（用时定格）。
 */
export function applyPick(state, tileId, now = Date.now()) {
  const tiles = state.tiles || [];
  const out = nextSelection(state, tileId);
  const next = { ...state, matched: (state.matched || []).slice(), selectedId: out.selectedId, event: out.event };
  if (out.event === 'match') {
    next.matched = next.matched.concat(out.pair);
    next.combo = (state.combo || 0) + 1;
    next.maxCombo = Math.max(state.maxCombo || 0, next.combo);
  } else if (out.event === 'miss') {
    next.combo = 0;
    next.mistakes = (state.mistakes || 0) + 1;
  }
  if (tiles.length && next.matched.length >= tiles.length) next.endedAt = now;
  return { state: next, event: next.event, pair: out.pair };
}

/* ------------------------------- 统计 ------------------------------- */

/** 棋盘进度：{ tiles, matched, pairs, totalPairs, left, done } */
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

let S = null; // 当前会话
let clock = null; // 用时计时器
let missTimer = null; // 「配对失败」抖动的清除定时器

function saveSession() {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(S));
  } catch (e) {}
}

function loadSession(deckId) {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    const s = raw ? JSON.parse(raw) : null;
    return s && s.deckId === deckId && Array.isArray(s.tiles) ? s : null;
  } catch (e) {
    return null;
  }
}

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

/** 清空会话与所有定时器（路由切换 / 重置数据 / 离开棋局调用） */
export function clearMatchSession() {
  stopClock();
  stopMissTimer();
  S = null;
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch (e) {}
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

/** 只改 class，不整页重渲染（避免已配对的牌重复播金光 / 丢焦点） */
function setClass(el, cls, want) {
  if (!el || !el.classList) return;
  if (el.classList.toggle) el.classList.toggle(cls, !!want);
  else if (want) el.classList.add(cls);
  else el.classList.remove(cls);
}

function setText(el, text) {
  if (el) el.textContent = text;
}

function tileHtml(tile, matched, selected) {
  const cls = ['match-tile', `match-tile-${tile.kind}`, selected ? 'is-selected' : '', matched ? 'is-matched' : '']
    .filter(Boolean)
    .join(' ');
  const kindLabel = tile.kind === 'word' ? '单词' : '释义';
  return `
    <button type="button" class="${cls}" data-action="match-pick" data-tile="${esc(tile.id)}"
      aria-pressed="${matched || selected ? 'true' : 'false'}"
      aria-label="${kindLabel}「${esc(tile.text)}」${matched ? '，已配对' : ''}"${matched ? ' disabled' : ''}>
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

/** 关卡选择 chips（只列已通关关卡；单关时不显示） */
function levelPickerHtml(deck, current) {
  const list = passedLevels(deck);
  if (list.length <= 1) return '';
  return `<div class="match-levels" role="group" aria-label="选择关卡">
    ${list
      .map(
        (i) =>
          `<button type="button" class="match-lv${i === current ? ' is-active' : ''}" data-action="match-level" data-level="${i}" aria-pressed="${
            i === current ? 'true' : 'false'
          }">第 ${i + 1} 关</button>`
      )
      .join('')}
  </div>`;
}

/** 棋盘页整页 HTML（仅在开局 / 换关 / 重开 / 重渲染等低频时刻生成） */
export function boardHtml(deck, state) {
  const b = boardStats(state);
  const pct = b.tiles ? Math.round((b.matched / b.tiles) * 100) : 0;
  const st = playStats(state);
  const tilesHtml = b.tiles
    ? state.tiles.map((t) => tileHtml(t, state.matched.includes(t.id), state.selectedId === t.id)).join('')
    : `<div class="empty glass"><h3>这一关还没有卡片</h3><p>先给关卡添加卡片，再来玩配对。</p></div>`;

  return `
    <div class="view view-match">
      <div class="match-head glass">
        <div class="match-title-row">
          <h2 class="screen-title">明牌配对 · 第 ${state.level + 1} 关</h2>
          <span class="sub-note">${b.totalPairs} 对 · 点单词再点它的释义</span>
        </div>
        <div class="match-stats">
          ${statCellHtml('time', '用时', formatDuration(st.elapsedMs))}
          ${statCellHtml('pairs', '已配对', `${b.pairs}/${b.totalPairs}`)}
          ${statCellHtml('misses', '失误', String(st.mistakes))}
          ${statCellHtml('combo', '最大连击', String(st.maxCombo))}
        </div>
        <div class="progress-track" id="match-progress" role="progressbar" aria-label="配对进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i class="progress-fill" style="width:${pct}%"></i></div>
        ${levelPickerHtml(deck, state.level)}
      </div>
      <div class="match-board" id="match-board" role="group" aria-label="配对棋盘">${tilesHtml}</div>
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
        <p>通关 ${info.need} 关后解锁「明牌配对」——把本卡组的单词与释义两两配对，考验记忆也考验眼力。</p>
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

/** 结算：填入完成面板、播报成绩并把焦点交给「再玩一次」 */
function finishGame() {
  const panel = byId('match-result');
  stopClock();
  const st = playStats(S);
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

/** 点击后的局部打补丁：选中态 / 金光 / 抖动 / 统计 / 焦点 */
function paintPick(event, pair) {
  const pairSet = new Set(pair || []);
  const matchedSet = new Set(S.matched);
  for (const el of all('.match-tile')) {
    const id = el.dataset && el.dataset.tile;
    if (!id) continue;
    const matched = matchedSet.has(id);
    setClass(el, 'is-selected', id === S.selectedId);
    setClass(el, 'is-matched', matched);
    if (el.setAttribute) el.setAttribute('aria-pressed', matched || id === S.selectedId ? 'true' : 'false');
    if (matched && 'disabled' in el) el.disabled = true;
    if (pairSet.has(id) && event === 'miss') {
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
    // 连击 ≥2 才播报「连击 ×N」并让「最大连击」格子弹一下，避免一直打扰
    if (S.combo >= 2) {
      announce(`配对成功，连击 ×${S.combo}`);
      popComboCell();
    } else {
      announce('配对成功');
    }
    if (isDone(S)) finishGame();
    else focusNextPlayable(pair && pair[pair.length - 1]);
  } else if (event === 'miss') {
    announce('配对失败，连击清零');
  }
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

/* ------------------------------- 开局 / 路由 ------------------------------- */

/** 开一局（可注入 rng 便于单测复现洗牌） */
function startGame(deck, level, rng = Math.random) {
  S = newSession(deck.id, level, levelCardsFor(deck, level), Date.now(), rng);
  saveSession();
  startClock();
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

  // 沿用未完成的会话（重渲染不重新洗牌）；关卡已不可玩则重新开局
  let s = S && S.deckId === deckId ? S : loadSession(deckId);
  if (!s || !isPlayableLevel(deck, s.level)) s = startGame(deck, defaultLevel(deck));
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
  saveSession();
  paintPick(out.event, out.pair);
});

/* 换一关：重新洗牌开局 */
on('match-level', (el) => {
  if (!S || !el || !el.dataset) return;
  const deck = store.getDeck(S.deckId);
  const level = Number(el.dataset.level);
  if (!deck || !isPlayableLevel(deck, level)) return;
  clearMatchSession();
  startGame(deck, level);
  renderMatch(rootView(), deck.id);
});

/* 再玩一次：同一关重新洗牌 */
on('match-replay', () => {
  if (!S) return;
  const deck = store.getDeck(S.deckId);
  if (!deck) return;
  const level = S.level;
  clearMatchSession();
  startGame(deck, level);
  renderMatch(rootView(), deck.id);
});

/* 返回卡组：跳回详情页（路由变化会清空会话） */
on('match-back', () => {
  const deckId = (S && S.deckId) || '';
  clearMatchSession();
  if (deckId) navigate(`#/deck/${deckId}`);
});
