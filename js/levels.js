// ============================================================================
// levels.js — 关卡系统（纯逻辑，无 DOM）
//
// 规则：
//  1. 每关卡片数可在 15–30 之间由用户在设置中调整（默认 20）
//  2. 卡片数 ≤ 30 的小卡组不拆分，直接作为单关卡
//  3. 卡片按"关卡序号 card.level"分组，关卡顺序解锁：
//     第 0 关默认解锁；第 N 关需第 N-1 关"通关"后才解锁
//  4. 通关条件（两点同时满足）：
//     a. 该关卡全部卡片都完成过翻转记忆（lastReview != null）
//     b. 测试题正确率达到 80%（通过测试时写入 deck.passedLevels[index]）
//  5. 通过后的关卡若被加入新卡，会回到"已解锁"状态，需重新通关
// ============================================================================

export const MIN_PER_LEVEL = 15;
export const MAX_PER_LEVEL = 30;
export const DEFAULT_PER_LEVEL = 20;

export const PASS_RATIO = 0.8; // 测试题通过线：80%

export function clampPerLevel(n) {
  if (typeof n !== 'number' || !isFinite(n)) return DEFAULT_PER_LEVEL;
  return Math.min(MAX_PER_LEVEL, Math.max(MIN_PER_LEVEL, Math.round(n)));
}

/** 卡组实际生效的每关卡片数（deck.cardsPerLevel 优先，其次全局设置） */
export function effectivePerLevel(deck, settings) {
  return clampPerLevel(
    deck.cardsPerLevel != null ? deck.cardsPerLevel : (settings && settings.cardsPerLevel) ?? DEFAULT_PER_LEVEL
  );
}

/* ------------------------------- 关卡划分 ------------------------------- */

/** 依据"小卡组单关卡"与"15-30/关"约束计算拆分目标关卡数 */
export function computeLevelCount(total, per) {
  if (total <= 0) return 0;
  if (total <= MAX_PER_LEVEL) return 1; // 小卡组（≤30）不拆分
  const minLevels = Math.ceil(total / MAX_PER_LEVEL); // 每关最多 30 → 最少关卡数
  const maxLevels = Math.floor(total / MIN_PER_LEVEL); // 每关至少 15 → 最多关卡数
  const byPer = Math.round(total / per);
  return Math.max(minLevels, Math.min(maxLevels, byPer));
}

/**
 * 将一张卡片列表按关卡约束拆分（尽量贴近 per，余量均衡，保证每关 15–30 张）。
 * 返回二维数组（关卡内保持原有顺序）。
 */
export function splitCards(cards, per) {
  const n = cards.length;
  if (n <= 0) return [];
  const k = computeLevelCount(n, per);
  if (k <= 1) return [[...cards]];
  const base = Math.floor(n / k);
  const rem = n % k;
  const out = [];
  let i = 0;
  for (let l = 0; l < k; l++) {
    const size = base + (l < rem ? 1 : 0);
    out.push(cards.slice(i, i + size));
    i += size;
  }
  return out;
}

/**
 * 新卡加入时的关卡归属：
 *  - 卡组总卡片数仍 < 30（小卡组）→ 全部留在单关卡（第 0 关）
 *  - 达到 30 张后：填满“前沿关卡”，满了则开辟新关卡（通关上一关后解锁）
 */
export function suggestLevelForNewCard(deck) {
  if (!deck.cards || !deck.cards.length) return 0;
  if (deck.cards.length < MAX_PER_LEVEL) return 0; // 小卡组（<30 张）不拆分
  const per = clampPerLevel(deck.cardsPerLevel ?? DEFAULT_PER_LEVEL);
  const levels = deckLevels(deck);
  const last = levels[levels.length - 1];
  if (!last) return 0;
  if (last.cards.length < per) return last.index;
  return last.index + 1;
}

/**
 * 按「每关卡片数」重新划分关卡：保持卡片原有顺序，仅重写 card.level。
 * 用于用户修改每关词数（卡组级 / 全局设置）后即时刷新各组词汇数。
 * @returns {Array<Array>} 新的关卡分组
 */
export function resplitLevels(cards, per) {
  const list = Array.isArray(cards) ? cards : [];
  if (!list.length) return [];
  const groups = splitCards(list, clampPerLevel(per));
  groups.forEach((g, gi) => {
    for (const c of g) if (c && typeof c === 'object') c.level = gi;
  });
  return groups;
}

/** 依据 card.level 分组（升序、连续），返回 [{ index, cards }] */
export function deckLevels(deck) {
  const groups = new Map();
  for (const card of deck.cards || []) {
    const idx = Number.isInteger(card.level) && card.level >= 0 ? card.level : 0;
    if (!groups.has(idx)) groups.set(idx, []);
    groups.get(idx).push(card);
  }
  const indices = [...groups.keys()].sort((a, b) => a - b);
  return indices.map((index) => ({ index, cards: groups.get(index) }));
}

/* --------------------------- 通关与解锁状态 --------------------------- */

export function reviewedAll(cards) {
  return cards.length > 0 && cards.every((c) => c.lastReview != null);
}

/**
 * 计算卡组全部关卡的状态。状态机（按关卡顺序推导）：
 *   passed   已通关（通关标记 && 全卡完成翻转记忆）
 *   unlocked 已解锁（首关，或上一关已通关）
 *   locked   未解锁
 */
export function levelStates(deck, levels = deckLevels(deck)) {
  const passedMap = deck.passedLevels || {};
  const states = {};
  let prevPassed = false;
  levels.forEach((lv, i) => {
    const allReviewed = reviewedAll(lv.cards);
    const flagged = !!passedMap[lv.index];
    const passed = flagged && allReviewed;
    let state;
    if (passed) state = 'passed';
    else if (i === 0 || prevPassed) state = 'unlocked';
    else state = 'locked';
    states[lv.index] = state;
    prevPassed = passed;
  });
  return states;
}

export function levelState(deck, levelIndex) {
  return levelStates(deck)[levelIndex] || 'locked';
}

export function isLevelPassed(deck, levelIndex) {
  return levelState(deck, levelIndex) === 'passed';
}

export function isLevelUnlocked(deck, levelIndex) {
  const s = levelState(deck, levelIndex);
  return s === 'unlocked' || s === 'passed';
}

/* ------------------------------- 关卡内统计 ------------------------------- */

export function cardsInLevel(deck, levelIndex) {
  return (deck.cards || []).filter((c) => (Number.isInteger(c.level) ? c.level : 0) === levelIndex);
}

export function unreviewedInLevel(deck, levelIndex) {
  return cardsInLevel(deck, levelIndex).filter((c) => c.lastReview == null);
}

export function dueCardsInLevel(deck, levelIndex, now = Date.now()) {
  return cardsInLevel(deck, levelIndex).filter((c) => c.lastReview != null && c.due <= now);
}

export function learnedInLevel(deck, levelIndex) {
  return cardsInLevel(deck, levelIndex).filter((c) => c.lastReview != null).length;
}

/* ------------------------------- 卡组级统计 ------------------------------- */

/** 卡组统计（单次遍历，万级卡组也只是一趟 O(n)） */
export function deckStats(deck, now = Date.now()) {
  let total = 0;
  let learned = 0;
  let due = 0;
  for (const c of (deck && deck.cards) || []) {
    total++;
    if (c.lastReview != null) {
      learned++;
      if (c.due <= now) due++;
    }
  }
  return { total, learned, due, newCount: total - learned };
}

/* ------------------------------- 关卡分页 ------------------------------- */

/**
 * 关卡超过 LEVELS_PER_PAGE 时，卡组详情按页展示（每页 15 关）。
 * 例如 45 关 → 第 2/3 页。
 */
export const LEVELS_PER_PAGE = 15;

/** 总页数（至少 1 页） */
export function levelPageCount(totalLevels, perPage = LEVELS_PER_PAGE) {
  const n = Math.max(0, Math.floor(Number(totalLevels) || 0));
  const p = Math.max(1, Math.floor(Number(perPage) || LEVELS_PER_PAGE));
  return Math.max(1, Math.ceil(n / p));
}

/** 某关卡所在页（0 基） */
export function levelPageOf(levelIndex, perPage = LEVELS_PER_PAGE) {
  const p = Math.max(1, Math.floor(Number(perPage) || LEVELS_PER_PAGE));
  const idx = Math.max(0, Math.floor(Number(levelIndex) || 0));
  return Math.floor(idx / p);
}

/** 页号夹取到合法范围 */
export function clampLevelPage(page, totalLevels, perPage = LEVELS_PER_PAGE) {
  const last = levelPageCount(totalLevels, perPage) - 1;
  const p = Math.floor(Number(page) || 0);
  return Math.max(0, Math.min(last, p));
}

/** 取某一页的关卡（levels 为 deckLevels 的结果） */
export function sliceLevelsPage(levels, page, perPage = LEVELS_PER_PAGE) {
  const list = Array.isArray(levels) ? levels : [];
  const p = clampLevelPage(page, list.length, perPage);
  const size = Math.max(1, Math.floor(Number(perPage) || LEVELS_PER_PAGE));
  return list.slice(p * size, p * size + size);
}

/** 分页文案：如「第 2/3 页」 */
export function levelPageLabel(page, totalLevels, perPage = LEVELS_PER_PAGE) {
  const total = levelPageCount(totalLevels, perPage);
  const p = clampLevelPage(page, totalLevels, perPage);
  return `第 ${p + 1}/${total} 页`;
}

