// ============================================================================
// arrange.js — 关卡编排策略（纯逻辑，无 DOM / 无存储）
//
// 三条策略（按需求）：
//   1. 平缓进阶：按难度升序分层，前几关以高频/短词打基础，
//      后续关卡逐步混入低频/长难词（每一关仍横跨一段难度区间，天然混排）。
//   2. 错峰排列：形近词 / 同根词（易混组）强制间隔 ≥ minGapLevels 关再出现。
//   3. 动态调序：结合错题池 / 困难词，把反复错记的卡片提升到当前关卡，
//      使其尽快重现。
//
// 难度来源：difficulty.js（词频 / 词长 / 音节 / 熟悉度 / 语种特性 / 外部词表）。
// ============================================================================

import { computeLevelCount, clampPerLevel, DEFAULT_PER_LEVEL } from './levels.js';
import { scoreCards, difficultyBands, clearScoreCache } from './difficulty.js';

export const DEFAULT_MIN_GAP = 2; // 同易混组卡片至少间隔 2 关

/** 收集一张卡片所属的易混组 id（卡片自带 groups ∪ groupsMap[front]） */
export function groupIdsOf(card, groupsMap = {}) {
  const out = new Set();
  for (const g of card?.groups || []) if (g) out.add(String(g));
  const key = card?.front ?? card?.word ?? '';
  for (const g of groupsMap[key] || []) if (g) out.add(String(g));
  return out;
}

/** 生成「按难度升序」的下标序列（同分时用 createdAt / front 稳定排序） */
export function sortIndicesByDifficulty(cards, ctx = {}) {
  const scores = scoreCards(cards, ctx);
  return cards
    .map((_, i) => i)
    .sort((a, b) => {
      if (scores[a] !== scores[b]) return scores[a] - scores[b];
      const ca = cards[a]?.createdAt || 0;
      const cb = cards[b]?.createdAt || 0;
      if (ca !== cb) return ca - cb;
      return String(cards[a]?.front ?? '').localeCompare(String(cards[b]?.front ?? ''));
    });
}

/** 把已排序下标按关卡容量切成 K 段（每段大小尽量均衡，且符合 15–30 约束） */
export function sliceByDifficulty(sortedIdx, perLevel) {
  const n = sortedIdx.length;
  if (!n) return [];
  const k = computeLevelCount(n, perLevel);
  if (k <= 1) return [sortedIdx.slice()];
  const bands = difficultyBands(n, k);
  return bands.map((b) => sortedIdx.slice(b.start, b.end));
}

/** 每关的目标卡片数（均衡拆分，供交换时保持容量一致） */
export function levelSizes(n, perLevel) {
  const k = computeLevelCount(n, perLevel);
  if (k <= 0) return [];
  const base = Math.floor(n / k);
  const rem = n % k;
  return Array.from({ length: k }, (_, i) => base + (i < rem ? 1 : 0));
}

/* --------------------------- 策略 2：错峰排列 --------------------------- */

/** 统计每个易混组在各关的出现次数：Map<groupId, Map<level, count>> */
function buildOccupancy(groups) {
  const occ = new Map();
  groups.forEach((lv, li) => {
    lv.forEach((gs) => {
      gs.forEach((g) => {
        let byLevel = occ.get(g);
        if (!byLevel) {
          byLevel = new Map();
          occ.set(g, byLevel);
        }
        byLevel.set(li, (byLevel.get(li) || 0) + 1);
      });
    });
  });
  return occ;
}

function occAdd(occ, g, level) {
  let byLevel = occ.get(g);
  if (!byLevel) {
    byLevel = new Map();
    occ.set(g, byLevel);
  }
  byLevel.set(level, (byLevel.get(level) || 0) + 1);
}

function occDel(occ, g, level) {
  const byLevel = occ.get(g);
  if (!byLevel) return;
  const n = (byLevel.get(level) || 0) - 1;
  if (n > 0) byLevel.set(level, n);
  else byLevel.delete(level);
  if (!byLevel.size) occ.delete(g);
}

/** 把某组卡片放到 target 关后，是否与「同组其它卡片」保持 ≥ minGap 间隔 */
function fitsAt(occ, groupIds, fromLevel, target, minGap) {
  for (const g of groupIds) {
    const byLevel = occ.get(g);
    if (!byLevel) continue;
    for (const [level, count] of byLevel) {
      const others = level === fromLevel ? count - 1 : count; // 排除自身
      if (others > 0 && Math.abs(level - target) < minGap) return false;
    }
  }
  return true;
}

/**
 * 同易混组（形近 / 同根）卡片强制间隔 ≥ minGap 关。
 * 采用「占位计数 + 就近向后交换」策略：保持每关容量不变，尽量减少位置抖动。
 * @returns {number} 实际交换次数
 */
export function enforceGroupGap(levels, groupsMap = {}, minGap = DEFAULT_MIN_GAP, maxMoves = null) {
  if (!levels.length || minGap <= 0) return 0;
  const groups = levels.map((lv) => lv.map((card) => groupIdsOf(card, groupsMap)));
  const occ = buildOccupancy(groups);
  const total = groups.reduce((s, l) => s + l.length, 0);
  const cap = maxMoves == null ? total : maxMoves;
  let moves = 0;

  for (let li = 0; li < levels.length && moves < cap; li++) {
    for (let pi = 0; pi < levels[li].length && moves < cap; pi++) {
      const gs = groups[li][pi];
      if (!gs.size || fitsAt(occ, gs, li, li, minGap)) continue;
      // 向后找一个「放得下自己 + 换过来的卡片也放得下」的关卡
      let swapped = false;
      for (let t = li + 1; t < levels.length && !swapped; t++) {
        if (!fitsAt(occ, gs, li, t, minGap)) continue;
        for (let tj = 0; tj < levels[t].length; tj++) {
          const cgs = groups[t][tj];
          if (!fitsAt(occ, cgs, t, li, minGap)) continue;
          for (const g of gs) {
            occDel(occ, g, li);
            occAdd(occ, g, t);
          }
          for (const g of cgs) {
            occDel(occ, g, t);
            occAdd(occ, g, li);
          }
          const card = levels[li][pi];
          levels[li][pi] = levels[t][tj];
          levels[t][tj] = card;
          groups[li][pi] = cgs;
          groups[t][tj] = gs;
          moves += 1;
          swapped = true;
          break;
        }
      }
    }
  }
  return moves;
}

/* -------------------------- 策略 3：动态调序 -------------------------- */

/**
 * 把错题池 / 困难词卡片提升到 targetLevel（与目标关的非优先卡片交换）。
 * @returns {number} 实际提升的卡片数
 */
export function promoteByPriority(levels, priorityIds, targetLevel = 0) {
  const set = priorityIds instanceof Set ? priorityIds : new Set(priorityIds || []);
  if (!set.size || levels.length < 2) return 0;
  const t = Math.max(0, Math.min(levels.length - 1, Number(targetLevel) || 0));
  let moves = 0;
  for (let li = 0; li < levels.length; li++) {
    if (li === t) continue;
    for (let pi = 0; pi < levels[li].length; pi++) {
      const card = levels[li][pi];
      if (!card || !set.has(card.id)) continue;
      const tj = levels[t].findIndex((c) => c && !set.has(c.id));
      if (tj < 0) return moves; // 目标关已全是优先卡
      levels[li][pi] = levels[t][tj];
      levels[t][tj] = card;
      moves += 1;
    }
  }
  return moves;
}

/* ------------------------------ 编排入口 ------------------------------ */

/**
 * 编排卡片到各关卡。
 * @param {Array} cards 卡片数组（须含 id / front）
 * @param {object} opts
 *   perLevel     每关卡片数（15–30，默认 20）
 *   groupsMap    { front: [groupId] } 易混组（可选）
 *   lang         语种（'en' | 'ja' | 'zh-classic'）
 *   hardIds      困难词 id 集合（可选）
 *   errorIds     错题池 id 集合（可选）
 *   activeLevel  当前待学关卡（动态调序目标，默认 0）
 *   minGapLevels 错峰间隔（默认 2）
 *   ctx          传给 difficulty 的额外上下文
 * @returns {Array<Array>} 每关的卡片数组（下标即 level）
 */
export function arrangeCards(cards, opts = {}) {
  const list = (Array.isArray(cards) ? cards : []).filter(Boolean);
  const n = list.length;
  if (!n) return [];
  const per = clampPerLevel(opts.perLevel ?? DEFAULT_PER_LEVEL);
  const ctx = { lang: opts.lang || 'en', ...(opts.ctx || {}) };

  clearScoreCache(list);
  const sortedIdx = sortIndicesByDifficulty(list, ctx);
  const levels = sliceByDifficulty(sortedIdx, per).map((idxs) => idxs.map((i) => list[i]));

  const minGap = opts.minGapLevels == null ? DEFAULT_MIN_GAP : Math.max(0, Number(opts.minGapLevels) || 0);
  if (levels.length > 1 && minGap > 0) {
    enforceGroupGap(levels, opts.groupsMap || {}, minGap, opts.maxMoves);
  }
  const priority = new Set([...(opts.errorIds || []), ...(opts.hardIds || [])]);
  if (levels.length > 1 && priority.size) {
    promoteByPriority(levels, priority, opts.activeLevel || 0);
  }
  return levels;
}
