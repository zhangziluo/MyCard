// ============================================================================
// test-engine.js — 整卡组测试引擎（纯逻辑，无 DOM）
//   抽题：N 题从卡组抽取；词数≥N 不重复；词数<N 循环（首轮每词一次、间隔≥floor(N/词数)）
//   题型：按权重分配数量，同词重复出现时优先换题型
//   优先池：错题优先占用 50% 配额（并保证可行时仍覆盖全部词）
//   进度：localStorage['test_progress_{deckId}']（中途退出可续做）
//   优先池存储：localStorage['mycard-test-priority']
// ============================================================================

import { QUESTION_TYPES, PASS_RATIO, enabledTypeIds } from './test-config.js';

const PRIORITY_KEY = 'mycard-test-priority';
const PROGRESS_PREFIX = 'test_progress_';

function storage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch (e) {
    return null;
  }
}

export function shuffle(arr, random = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ------------------------------ 题型分配 ------------------------------ */

/** 按权重分配 N 题的题型数量（返回打乱后的题型数组）
 *  typesList：参与分配的题型（默认基础 5 种；传入已启用集合可含可选题型） */
export function allocateTypes(n, weights, typesList = QUESTION_TYPES, random = Math.random) {
  const types = Array.isArray(typesList) && typesList.length ? typesList : QUESTION_TYPES;
  const total = types.reduce((s, t) => s + (Number(weights && weights[t]) || 0), 0);
  const list = [];
  if (total <= 0) {
    for (let i = 0; i < n; i++) list.push(types[i % types.length]);
    return shuffle(list, random);
  }
  let assigned = 0;
  types.forEach((t, i) => {
    const share =
      i === types.length - 1
        ? n - assigned
        : Math.round((n * (Number(weights[t]) || 0)) / total);
    for (let k = 0; k < Math.max(0, share); k++) list.push(t);
    assigned += Math.max(0, share);
  });
  while (list.length < n) list.push(types[0]);
  list.length = n;
  return shuffle(list, random);
}

/** 把题型分配给卡序列：同一张卡再次出现时优先使用未用过的题型 */
export function assignTypesByCard(seq, typeList, random = Math.random) {
  const remaining = [...typeList];
  const usedByCard = new Map();
  const out = [];
  for (const cardId of seq) {
    const used = usedByCard.get(cardId) || new Set();
    let cands = remaining.filter((t) => !used.has(t));
    if (!cands.length) cands = remaining;
    const pick = cands[Math.floor(random() * cands.length)];
    remaining.splice(remaining.indexOf(pick), 1);
    out.push(pick);
    used.add(pick);
    usedByCard.set(cardId, used);
  }
  return out;
}

/* ------------------------------ 抽卡序列 ------------------------------ */

/**
 * 生成 N 题的卡序列：
 *  - 词数 ≥ N：不重复；
 *  - 词数 < N：首轮覆盖全部词，其后「用量最少者优先 + 间隔 ≥ floor(N/词数)」；
 *  - 有优先池时，50% 槽位优先从错题池抽取（在能保证覆盖全部词的前提下）。
 */
export function buildCardSequence(cards, n, priorityIds = new Set(), random = Math.random) {
  const words = cards.length;
  if (!words || n <= 0) return [];
  const minGap = Math.max(1, Math.floor(n / words));
  // 仅在有优先池时才建 id→card 映射（常规路径省掉一次 O(词数) 遍历）
  const prioIds = priorityIds ? [...priorityIds] : [];
  let prio = [];
  if (prioIds.length) {
    const byId = new Map(cards.map((c) => [c.id, c]));
    prio = prioIds.map((id) => byId.get(id)).filter(Boolean);
  }

  // 快路径：词数 ≥ 题数 且无优先池 —— 此时「最少用量 + 冷却」退化为「取 n 个互不相同的词」，
  // 用部分 Fisher-Yates 直接取（分布等价，随机调用次数一致），复杂度 O(n)。
  // 万级卡组 + 150 题走此路径，避免 O(题数×词数) 的全量扫描。
  if (!prio.length && words >= n) {
    const idx = cards.map((_, i) => i);
    const fastSeq = [];
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(random() * (words - i));
      const tmp = idx[i];
      idx[i] = idx[j];
      idx[j] = tmp;
      fastSeq.push(cards[idx[i]].id);
    }
    return fastSeq;
  }

  // 优先槽位数量（能覆盖全部词时优先保证覆盖）
  const coverAll = words < n;
  const prioCap = prio.length
    ? Math.max(0, Math.min(Math.floor(n / 2), coverAll ? Math.max(0, n - words) : n))
    : 0;
  const wantPrio = new Array(n).fill(false);
  if (prioCap > 0) {
    const step = n / prioCap;
    for (let k = 0; k < prioCap; k++) wantPrio[Math.min(n - 1, Math.floor(k * step))] = true;
  }

  const lastUse = new Map();
  const used = new Map();
  const seq = [];
  // 单趟扫描：一次同时得到「冷却已过的最小用量候选」与「冷却中最久未用者」
  // （等价于原「filter → min → filter」三段，但只遍历 pool 一遍；cands 顺序与原实现一致）
  const pickLeastUsed = (pool) => {
    let minCount = Infinity;
    let cands = null;
    let earliest = null;
    let earliestLast = Infinity;
    for (const c of pool) {
      const last = lastUse.get(c.id);
      if (last === undefined || seq.length - last >= minGap) {
        const count = used.get(c.id) || 0; // 用量最少者优先 → 分布均匀
        if (count < minCount) {
          minCount = count;
          cands = [c];
        } else if (count === minCount) {
          cands.push(c);
        }
      } else if (last < earliestLast) {
        earliestLast = last;
        earliest = c;
      }
    }
    if (cands && cands.length) return cands[Math.floor(random() * cands.length)];
    // 全部处于冷却期（词数过少）：取最早使用过的
    return earliest || pool[0];
  };

  for (let i = 0; i < n; i++) {
    const pool = wantPrio[i] && prio.length ? prio : cards;
    const card = pickLeastUsed(pool);
    seq.push(card.id);
    lastUse.set(card.id, i);
    used.set(card.id, (used.get(card.id) || 0) + 1);
  }
  return seq;
}

/** 生成抽题计划：[{ cardId, type }] */
export function samplePlan(deck, { count = 50, weights = null, priorityIds = new Set(), random = Math.random, enabled = null } = {}) {
  const cards = (deck && deck.cards ? deck.cards : []).filter((c) => c.front);
  const n = Math.max(1, Math.floor(Number(count) || 0));
  if (!cards.length) return [];
  const seq = buildCardSequence(cards, n, priorityIds, random);
  const typesList = enabled ? enabledTypeIds(enabled) : QUESTION_TYPES;
  const typeList = allocateTypes(seq.length, weights, typesList, random);
  const types = assignTypesByCard(seq, typeList, random);
  return seq.map((cardId, i) => ({ cardId, type: types[i] }));
}

/* ------------------------------ 判分 ------------------------------ */

export function passThreshold() {
  return Math.round(PASS_RATIO * 100);
}

export function isPassed(pct) {
  return Math.round(Number(pct) || 0) >= passThreshold();
}

/** 依据题目列表统计成绩 */
export function summarize(questions) {
  const total = questions.length;
  const correct = questions.filter((q) => q.correct).length;
  const pct = total ? Math.round((correct / total) * 100) : 0;
  const wrongIds = questions.filter((q) => q.answered && !q.correct).map((q) => q.cardId);
  return { total, correct, wrong: total - correct, pct, passed: isPassed(pct), wrongIds };
}

/* ------------------------------ 优先池（错题） ------------------------------ */

function readPriority() {
  const s = storage();
  if (!s) return {};
  try {
    const raw = s.getItem(PRIORITY_KEY);
    const d = raw ? JSON.parse(raw) : null;
    return d && typeof d === 'object' ? d : {};
  } catch (e) {
    return {};
  }
}

function writePriority(d) {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(PRIORITY_KEY, JSON.stringify(d));
  } catch (e) {}
}

/** 记录错题（次数 +1） */
export function recordWrong(deckId, cardIds) {
  const data = readPriority();
  const dk = String(deckId);
  if (!data[dk] || typeof data[dk] !== 'object') data[dk] = {};
  for (const id of cardIds || []) {
    const k = String(id);
    data[dk][k] = (Number(data[dk][k]) || 0) + 1;
  }
  writePriority(data);
  return data[dk];
}

/** 优先池 id 集合 */
export function getPriorityIds(deckId) {
  const d = readPriority()[String(deckId)];
  return new Set(d && typeof d === 'object' ? Object.keys(d) : []);
}

/** 优先池题数 */
export function priorityCount(deckId) {
  return getPriorityIds(deckId).size;
}

/** 清空某卡组优先池 */
export function clearPriority(deckId) {
  const data = readPriority();
  delete data[String(deckId)];
  writePriority(data);
}

/* ------------------------------ 进度（中途退出续做） ------------------------------ */

export function progressKey(deckId, kind = 'deck') {
  return PROGRESS_PREFIX + String(deckId) + (kind === 'wrong' ? '__wrong' : '');
}

export function saveProgress(deckId, data, kind = 'deck') {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(progressKey(deckId, kind), JSON.stringify(data));
  } catch (e) {}
}

export function loadProgress(deckId, kind = 'deck') {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(progressKey(deckId, kind));
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

export function clearProgress(deckId, kind = 'deck') {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(progressKey(deckId, kind));
  } catch (e) {}
}

