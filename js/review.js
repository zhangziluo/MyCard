// ============================================================================
// review.js — 翻转记忆模式
// 流程：正面 → 点击翻转 → 背面（含例句）→ 四档反馈「重来/困难/记住/轻松」
// 会话保存在 sessionStorage，刷新/中断后可从当前卡片继续。
// ============================================================================

import * as store from './store.js';
import * as sched from './scheduler.js';
import * as lv from './levels.js';
import * as hw from './hardwords.js';
import { esc, on, navigate, toast } from './ui.js';

const SESSION_KEY = 'mycard-review-session'; // 按关卡翻转
const ALL_SESSION_KEY = 'mycard-review-all-session'; // 整卡组循环翻转

let S = null; // { deckId, level, mode, queue:[id], pos, total, counts:{} }（mode='all' 另有 round）

/* ------------------------------ 会话 ------------------------------ */

/** 不同模式使用不同会话键（整卡组与按关卡互不干扰） */
function keyOf(mode) {
  return mode === 'all' ? ALL_SESSION_KEY : SESSION_KEY;
}

function saveSession() {
  try {
    sessionStorage.setItem(keyOf(S && S.mode), JSON.stringify(S));
  } catch (e) {}
}

function loadSession(mode) {
  try {
    const raw = sessionStorage.getItem(keyOf(mode));
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function clearSession() {
  S = null;
  try {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(ALL_SESSION_KEY);
  } catch (e) {}
}

/** Fisher-Yates 洗牌 */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 由路由参数构建会话（若已有同参数会话则沿用进度） */
function ensureSession(deckId, level, mode) {
  const deck = store.getDeck(deckId);
  if (!deck) return null;

  // 整卡组循环模式：洗牌全部卡片（突破关卡限制），困难词前置，循环不结束
  if (mode === 'all') {
    if (!deck.cards.length) return null;
    const hard = hw.hardSet(deckId);
    const shuffled = shuffle(deck.cards.map((c) => c.id));
    const queue = [...shuffled.filter((id) => hard.has(id)), ...shuffled.filter((id) => !hard.has(id))];
    return {
      deckId,
      level: null,
      mode: 'all',
      queue,
      pos: 0,
      round: 0, // 已完成的整轮数
      total: queue.length,
      counts: { again: 0, hard: 0, good: 0, easy: 0 }
    };
  }

  const now = Date.now();
  let cards = lv.cardsInLevel(deck, Number(level));
  if (mode === 'learn') {
    cards = cards.filter((c) => c.lastReview == null).sort((a, b) => a.createdAt - b.createdAt);
  } else {
    cards = cards.filter((c) => c.lastReview != null && c.due <= now).sort((a, b) => a.due - b.due);
  }
  if (!cards.length) return null;
  return {
    deckId,
    level: Number(level),
    mode,
    queue: cards.map((c) => c.id),
    pos: 0,
    total: cards.length,
    counts: { again: 0, hard: 0, good: 0, easy: 0 }
  };
}

/* ------------------------------ 键盘 / 手势映射（纯函数，便于测试） ------------------------------ */

export const SWIPE_THRESHOLD = 32;

let swipeGuard = 0; // 手势处理时间戳，用于抑制随后的 click 误触发翻转

/** 是否翻面键（空格） */
export function isFlipKey(evt) {
  return evt.key === ' ' || evt.key === 'Spacebar' || evt.code === 'Space';
}

/** 键盘按键 → 反馈 key（不做状态判断） */
export function keyToFeedback(evt) {
  switch (evt.key) {
    case 'ArrowRight': return 'easy';
    case 'ArrowUp': return 'good';
    case 'ArrowLeft': return 'hard';
    case 'ArrowDown': return 'again';
    case 'Enter': return evt.shiftKey ? 'good' : 'easy';
    case 'Backspace': return 'hard';
    default: return null;
  }
}

/**
 * 拖拽 / 滑动位移 → 反馈 key。三端方向统一：
 *   右 = 轻松 easy ｜ 上 = 记住 good ｜ 左 = 困难 hard ｜ 下 = 重来 again
 * 位移不足阈值时返回 null（视为点击 → 翻面）。
 */
export function directionToFeedback(dx, dy, threshold = SWIPE_THRESHOLD) {
  if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return null;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'easy' : 'hard';
  return dy > 0 ? 'again' : 'good';
}

function fbButtonsHtml() {
  const color = { again: 'fb-again', hard: 'fb-hard', good: 'fb-good', easy: 'fb-easy' };
  const key = { again: '↓', hard: '←', good: '↑', easy: '→' };
  return `
  <div class="fb-grid">
    ${sched.FEEDBACKS.map((f) => {
      return `<button class="fb-btn ${color[f.key]}" data-action="review-rate" data-fb="${f.key}">
        <kbd class="fb-key" aria-hidden="true">${key[f.key]}</kbd>
        <span class="fb-dot"></span><b>${f.label}</b><small>${f.hint}</small>
      </button>`;
    }).join('')}
  </div>`;
}
function currentCard() {
  const deck = store.getDeck(S.deckId);
  if (!deck) return null;
  const id = S.queue[S.pos];
  return deck.cards.find((c) => c.id === id) || null;
}

function exampleHtml(card) {
  if (!card.example && !card.exampleZh) return '';
  return `<div class="card-example">
    ${card.example ? `<p class="ex-en">${esc(card.example)}</p>` : ''}
    ${card.exampleZh ? `<p class="ex-zh">${esc(card.exampleZh)}</p>` : ''}
  </div>`;
}

function cardHtml(flipped) {
  const card = currentCard();
  if (!card) return '';
  return `
    <div class="flashcard3d-wrap">
      <div class="flashcard3d${flipped ? ' flipped' : ''}" data-action="review-flip" role="button" tabindex="0">
        <div class="face face-front">
          <span class="face-tag">正面 · 问题</span>
          <p class="face-main">${esc(card.front)}</p>
        </div>
        <div class="face face-back">
          <span class="face-tag">背面 · 答案</span>
          <p class="face-main back-main">${esc(card.back)}</p>
          ${exampleHtml(card)}
        </div>
      </div>
    </div>`;
}

/* ------------------------------ 指针手势（鼠标拖拽 / 触摸滑动） ------------------------------ */

function attachGestures(card) {
  if (!card || !card.addEventListener) return;
  const wrap = card.closest && card.closest('.flashcard3d-wrap') || card;
  const view = card.closest && card.closest('.review-view');
  let active = false;
  let mode = null; // 'scroll'（滚动内容） | 'gesture'（评分手势）
  let startX = 0;
  let startY = 0;
  let startScrollTop = 0;
  let scrollEl = null;
  let pointerId = null;

  const clearVisual = () => {
    wrap.style.transform = '';
    if (wrap.dataset) delete wrap.dataset.dir;
    card.classList.remove('dragging');
  };

  const reset = () => {
    active = false;
    mode = null;
    pointerId = null;
    if (wrap.classList) {
      wrap.classList.add('snap');
      setTimeout(() => wrap.classList.remove('snap'), 220);
    }
    clearVisual();
  };

  card.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    active = true;
    mode = null;
    startX = e.clientX;
    startY = e.clientY;
    pointerId = e.pointerId;
    if (card.classList) card.classList.add('dragging');
    // 触摸时若当前面内容超长，优先允许内部滚动（鼠标拖拽不滚动）
    scrollEl = null;
    if (e.pointerType !== 'mouse' && view) {
      const face = view.dataset.flipped === '1' ? card.querySelector('.face-back') : card.querySelector('.face-front');
      if (face && face.scrollHeight > face.clientHeight + 4) scrollEl = face;
    }
    startScrollTop = scrollEl ? scrollEl.scrollTop : 0;
    try {
      card.setPointerCapture(e.pointerId);
    } catch (err) {}
  });

  card.addEventListener('pointermove', (e) => {
    if (!active) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (!mode) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return; // 方向未明确
      if (scrollEl && Math.abs(dy) > Math.abs(dx)) {
        const canScrollUp = startScrollTop > 0;
        const canScrollDown = startScrollTop + scrollEl.clientHeight < scrollEl.scrollHeight - 1;
        // 内容还能在该方向滚动 → 滚动；已到边界 → 交给手势评分
        mode = (dy > 0 && canScrollUp) || (dy < 0 && canScrollDown) ? 'scroll' : 'gesture';
      } else {
        mode = 'gesture';
      }
    }

    if (mode === 'scroll') {
      scrollEl.scrollTop = startScrollTop - dy;
      return;
    }

    const dir = directionToFeedback(dx, dy);
    wrap.style.transform = `translate(${dx * 0.32}px, ${dy * 0.32}px) rotate(${dx * 0.02}deg)`;
    if (wrap.dataset) wrap.dataset.dir = dir || '';
  });

  const finish = (e) => {
    if (!active) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const wasScroll = mode === 'scroll';
    const fb = wasScroll ? null : directionToFeedback(dx, dy);
    if (pointerId != null) {
      try {
        card.releasePointerCapture(pointerId);
      } catch (err) {}
    }
    if (wasScroll) {
      reset();
      swipeGuard = Date.now(); // 滚动后抑制 click
      return;
    }
    reset();
    if (!fb) {
      // 轻触 → 翻面（抑制随后的 click 重复触发）
      swipeGuard = Date.now();
      flipCard(view);
      return;
    }
    swipeGuard = Date.now();
    if (!view || view.dataset.flipped !== '1') {
      flipCard(view); // 未翻面时先翻到答案
      return;
    }
    rate(fb);
  };

  card.addEventListener('pointerup', finish);
  card.addEventListener('pointercancel', finish);
}

function completionHtml() {
  const counts = S.counts || {};
  const deck = store.getDeck(S.deckId);
  const lvCards = lv.cardsInLevel(deck, S.level);
  const allReviewed = lvCards.length > 0 && lvCards.every((c) => c.lastReview != null);
  const passed = lv.isLevelPassed(deck, S.level);
  const showTest = S.mode === 'learn' && allReviewed && !passed;

  return `
  <div class="review-done">
    <div class="done-icon">${iconCheck()}</div>
    <h2>${S.mode === 'learn' ? '本关卡片已全部学完' : '本轮复习完成'}</h2>
    <p class="done-sub">共 ${S.total} 张${
      showTest
        ? ' · 现在进入测试，正确率 ≥80% 即可通关并解锁下一关！'
        : ' · 卡片将按艾宾浩斯遗忘曲线安排下次复习。'
    }</p>
    <div class="done-stats">
      ${Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `<span class="stat fb-${k}">${sched.FEEDBACK_BY_KEY[k].label} ${n}</span>`)
        .join('') || '<span class="stat">全部完成</span>'}
    </div>
    ${showTest ? `<button class="btn btn-primary btn-lg" data-action="review-go-test" data-id="${esc(S.deckId)}" data-level="${S.level}">进入测试 · 冲刺通关</button>` : ''}
    <button class="btn btn-ghost btn-lg" data-action="review-back" data-id="${S.deckId}">返回卡组</button>
  </div>`;
}

function iconCheck() {
  return '<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m8 12.5 2.5 2.5L16 9"/></svg>';
}
export function renderReview(root, deckId, level, mode) {
  const wanted = { deckId, level: mode === 'all' ? null : Number(level), mode };
  const existing = loadSession(mode);
  if (
    existing &&
    existing.deckId === wanted.deckId &&
    existing.mode === wanted.mode &&
    (mode === 'all' || existing.level === wanted.level) &&
    existing.queue.length
  ) {
    S = existing;
  } else {
    S = ensureSession(wanted.deckId, wanted.level, wanted.mode);
    if (S) saveSession();
  }

  if (!S) {
    const deck = store.getDeck(deckId);
    root.innerHTML = `<div class="view"><div class="empty glass">
      <h3>${deck ? '没有可学习的卡片' : '卡组不存在'}</h3>
      <p>${deck ? (mode === 'all' ? '这个卡组还没有卡片。' : '本关暂无待学习 / 待复习的卡片。') : ''}</p>
      <a class="btn btn-primary" href="#/deck/${esc(deckId)}">返回卡组</a>
    </div></div>`;
    return;
  }

  // 按关卡模式：队列走完即出完成页；整卡组模式：循环，永不结束
  if (S.mode !== 'all' && S.pos >= S.queue.length) {
    root.innerHTML = `<div class="view">${completionHtml()}</div>`;
    return;
  }

  const flipped = root.dataset.flipped === '1';
  const pct = Math.round((S.pos / S.total) * 100);
  const isAll = S.mode === 'all';
  const roundDone = (S.round || 0) >= 1; // 已至少完成 1 整轮
  const hardN = isAll ? hw.hardCount(S.deckId) : 0;
  const label = isAll
    ? `第 ${(S.round || 0) + 1} 轮 · 困难词 ${hardN} 个`
    : S.mode === 'learn'
      ? '第 ' + (S.level + 1) + ' 关 · 学习'
      : '第 ' + (S.level + 1) + ' 关 · 复习';
  root.dataset.flipped = flipped ? '1' : '0';
  root.innerHTML = `
    <div class="review-view" data-flipped="${flipped ? '1' : '0'}">
      <div class="review-progress">
        <span class="rp-label">${label}</span>
        <div class="progress-track"><i class="progress-fill" style="width:${pct}%"></i></div>
        <span class="rp-count">${Math.min(S.pos + 1, S.total)} / ${S.total}</span>
      </div>
      ${cardHtml(flipped)}
      <p class="swipe-hint">
        <span class="hint-kb">空格 翻面 · ← 困难 · ↑ 记住 · → 轻松 · ↓ 重来</span>
        <span class="hint-touch">点按翻面 · 左滑困难 · 上滑记住 · 右滑轻松 · 下滑重来</span>
      </p>
      ${
        isAll
          ? `<div class="review-test-cta"><button class="btn btn-block ${roundDone ? 'btn-test glow' : 'btn-disabled'}" data-action="review-start-test" ${
              roundDone ? '' : 'disabled'
            }>${roundDone ? '开始测试 · 挑战关卡' : '完成 1 整轮后解锁测试'}</button></div>`
          : S.mode === 'learn'
            ? '<p class="review-skip"><button class="btn-link" data-action="review-direct-test">跳过翻面 · 直接测试 →</button></p>'
            : ''
      }
      <div class="review-controls">
        <button class="btn btn-ghost btn-lg flip-cta" data-action="review-flip">点击翻面看答案</button>
        ${fbButtonsHtml()}
      </div>
    </div>`;

  attachGestures(root.querySelector('.flashcard3d'));
}

/* ------------------------------ 核心动作 ------------------------------ */

/** 翻面（切换正/反面） */
function flipCard(view) {
  if (!view || !view.dataset) return;
  const card = view.querySelector('.flashcard3d');
  const flipped = view.dataset.flipped === '1';
  view.dataset.flipped = flipped ? '0' : '1';
  if (card && card.classList) card.classList.toggle('flipped', !flipped);
}

/** 记录一档反馈并推进到下一张（按钮 / 键盘 / 手势共用） */
function rate(fb) {
  if (!S || !sched.FEEDBACK_BY_KEY[fb]) return false;
  const card = currentCard();
  const deck = store.getDeck(S.deckId);
  if (!deck || !card) return false;
  const updated = sched.applyFeedback(card, fb);
  store.updateCard(S.deckId, card.id, updated);
  S.counts[fb] = (S.counts[fb] || 0) + 1;
  // 困难词标记：「重来 / 不认识」标记为困难词，「轻松」取消标记
  if (fb === 'again') hw.markHard(S.deckId, card.id);
  else if (fb === 'easy') hw.clearHard(S.deckId, card.id);
  S.pos += 1;
  const container = document.getElementById('view');
  if (!container) return true;

  // 整卡组循环：走完一轮回到第一张，round +1，永不自动结束
  if (S.mode === 'all') {
    if (S.pos >= S.queue.length) {
      S.pos = 0;
      S.round = (S.round || 0) + 1;
    }
    saveSession();
    renderReview(container, S.deckId, null, 'all');
    return true;
  }

  if (S.pos >= S.queue.length) {
    const html = completionHtml(); // 需在清除会话前生成
    clearSession();
    container.innerHTML = `<div class="view">${html}</div>`;
  } else {
    saveSession();
    renderReview(container, S.deckId, S.level, S.mode);
  }
  return true;
}

/** 当前复习视图是否已翻面 */
function isFlipped(view) {
  return !!view && !!view.dataset && view.dataset.flipped === '1';
}

/* ------------------------------ Actions ------------------------------ */

on('review-flip', (el) => {
  // 卡片上的翻面已由手势处理：刚发生手势时跳过随后的 click，避免重复翻转
  if (el.classList && el.classList.contains('flashcard3d') && Date.now() - swipeGuard < 400) return;
  flipCard(el.closest ? el.closest('.review-view') : null);
});

on('review-rate', (el) => {
  rate(el.dataset.fb);
});

/* 键盘快捷键（桌面）：空格翻面；→/Enter 轻松、↑/Shift+Enter 记住、←/Backspace 困难、↓ 重来 */
function onKeydown(e) {
  if (e.repeat) return; // 忽略长按自动重复，避免快速刷过卡片
  if (!S || S.pos >= S.queue.length) return; // 无会话 / 已完成
  const body = document.body;
  if (body && body.classList && body.classList.contains('modal-open')) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  // 焦点在按钮上时，空格/回车交还给浏览器（保留按钮的无障碍激活）
  const onButton = t && (t.tagName === 'BUTTON' || (t.dataset && t.dataset.action));
  if (onButton && (isFlipKey(e) || e.key === 'Enter')) return;
  const view = document.querySelector('.review-view');
  if (!view) return;

  if (isFlipKey(e)) {
    e.preventDefault();
    flipCard(view);
    return;
  }
  const fb = keyToFeedback(e);
  if (!fb) return;
  e.preventDefault();
  if (!isFlipped(view)) return; // 未翻面时评分键无效
  rate(fb);
}
document.addEventListener('keydown', onKeydown);

on('review-back', (el) => {
  const deckId = (S && S.deckId) || (el.dataset && el.dataset.id) || '';
  clearSession();
  if (deckId) navigate(`#/deck/${deckId}`);
});

/**
 * 进入本关测试冲刺通关。
 * 注意：学完最后一张卡时完成页是在 clearSession() 之后渲染的（S 已为 null），
 * 因此必须支持从按钮的 data-id / data-level 兜底取参，否则点击无反应。
 */
on('review-go-test', (el) => {
  const ds = (el && el.dataset) || {};
  const deckId = (S && S.deckId) || ds.id || '';
  const levelRaw = S && S.level != null ? S.level : ds.level;
  const level = levelRaw == null || levelRaw === '' ? null : Number(levelRaw);
  clearSession();
  if (deckId && level != null && Number.isFinite(level)) navigate(`#/test/${deckId}/${level}`);
});

/* 跳过翻面：直接进入本关测试（测试 ≥80% 即通关，未翻面卡片自动记为已学） */
on('review-direct-test', () => {
  if (!S) return;
  const { deckId, level } = S;
  clearSession();
  navigate(`#/test/${deckId}/${level}`);
});

/** 下一个需要通关的关卡（第一个未通关的关卡索引） */
export function nextLevelToTest(deck) {
  const levels = lv.deckLevels(deck);
  const states = lv.levelStates(deck);
  const target = levels.find((l) => states[l.index] !== 'passed');
  return target ? target.index : null;
}

/* 整卡组翻转完成后「开始测试」：进入第一个未通关关卡（需至少完成 1 整轮） */
on('review-start-test', () => {
  if (!S) return;
  if ((S.round || 0) < 1) return; // 未完成 1 整轮
  const deckId = S.deckId;
  const deck = store.getDeck(deckId);
  if (!deck) return;
  const level = nextLevelToTest(deck);
  clearSession();
  if (level == null) {
    toast('本卡组已全部通关 🎉', 'good');
    navigate(`#/deck/${deckId}`);
    return;
  }
  navigate(`#/test/${deckId}/${level}`);
});

export function clearReviewSession() {
  clearSession();
}
