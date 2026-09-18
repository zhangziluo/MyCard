#!/usr/bin/env node
// ============================================================================
// test-perf.mjs — 大卡组（1 万词 / 500 关）规模下的正确性与耗时
//   运行: node scripts/test-perf.mjs
// 覆盖：deckStats 单遍统计 / deckLevels 分组 / levelStates 复用 levels /
//       buildCardSequence 抽题（覆盖率、间隔）/ samplePlan（含优先池）
// 说明：仅设「宽松上限 2s」作为「切勿回归成 O(n²)」的金丝雀（并打印实测量级），
//       避免不同机器上的抖动导致 CI 误报。
// ============================================================================

const mem = {};
globalThis.localStorage = {
  getItem(k) { return k in mem ? mem[k] : null; },
  setItem(k, v) { mem[k] = String(v); },
  removeItem(k) { delete mem[k]; }
};
globalThis.sessionStorage = globalThis.localStorage;

const lv = await import('../js/levels.js');
const engine = await import('../js/test-engine.js');

let pass = 0;
let fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

/** 可复现随机（LCG），保证抽题结果稳定 */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 计时：返回 { out, dt(ms) } */
function ms(fn) {
  const t0 = process.hrtime.bigint();
  const out = fn();
  const dt = Number(process.hrtime.bigint() - t0) / 1e6;
  return { out, dt };
}

const N = 10000;
const NOW = 1700000000000;
const DAY = 86400000;

function makeDeck(total) {
  const cards = Array.from({ length: total }, (_, i) => ({
    id: 'c' + i,
    front: 'w' + i,
    back: 'd' + i,
    level: Math.floor(i / 20),
    state: 'new',
    repetitions: 0,
    interval: 0,
    easeFactor: 2.5,
    due: 0,
    lastReview: null
  }));
  // 前 4000 张标记为「已学」，其中前 1000 张已到期
  for (let i = 0; i < Math.min(4000, total); i++) {
    cards[i].state = 'review';
    cards[i].lastReview = NOW - DAY;
    cards[i].due = i < 1000 ? NOW - 1000 : NOW + 7 * DAY;
  }
  return { id: 'perf-deck', name: '万词卡组', cards, passedLevels: {} };
}

console.log('\n[构造 1 万词卡组]');
const deck = makeDeck(N);
ok(deck.cards.length === N, '10000 张卡片', deck.cards.length);

console.log('\n[卡组统计（单遍遍历）]');
{
  const { out: stats, dt } = ms(() => lv.deckStats(deck, NOW));
  ok(stats.total === N, 'total = 10000', stats.total);
  ok(stats.learned === 4000, 'learned = 4000', stats.learned);
  ok(stats.due === 1000, 'due = 1000', stats.due);
  ok(stats.newCount === 6000, 'newCount = 6000', stats.newCount);
  console.log(`    deckStats 1 万词：${dt.toFixed(2)} ms`);
  ok(dt < 2000, 'deckStats < 2000ms（宽松金丝雀）', dt.toFixed(2));
}

console.log('\n[关卡分组 / 状态（复用 levels 避免重复遍历）]');
let LEVELS = null;
{
  const { out: levels, dt } = ms(() => lv.deckLevels(deck));
  LEVELS = levels;
  ok(levels.length === 500, '10000 / 20 → 500 关', levels.length);
  ok(levels.every((l) => l.cards.length === 20), '每关 20 张');
  ok(levels[0].index === 0 && levels[499].index === 499, '关卡 index 升序连续');
  console.log(`    deckLevels 1 万词：${dt.toFixed(2)} ms`);

  const a = ms(() => lv.levelStates(deck));
  const b = ms(() => lv.levelStates(deck, LEVELS));
  ok(JSON.stringify(a.out) === JSON.stringify(b.out), 'levelStates(deck, levels) 与旧调用结果完全一致');
  ok(Object.keys(a.out).length === 500, '500 个关卡状态', Object.keys(a.out).length);
  ok(Object.values(a.out).every((s) => s === 'unlocked' || s === 'locked' || s === 'passed'), '状态取值合法');
  console.log(`    levelStates（内部再分组）：${a.dt.toFixed(2)} ms ／ 复用 levels：${b.dt.toFixed(2)} ms`);
  ok(a.dt < 2000 && b.dt < 2000, 'levelStates < 2000ms（宽松金丝雀）');
}

console.log('\n[整卡组抽题 · 1 万词抽 150 题]');
{
  const { out: plan, dt } = ms(() => engine.samplePlan(deck, { count: 150, random: rng(11) }));
  ok(plan.length === 150, '生成 150 题', plan.length);
  ok(new Set(plan.map((q) => q.cardId)).size === 150, '词数 10000 ≥ 150 → 题目不重复');
  ok(plan.every((q) => q.cardId && q.type), '每题都含 cardId 与题型');
  console.log(`    samplePlan 1 万词 / 150 题：${dt.toFixed(2)} ms`);
  ok(dt < 2000, 'samplePlan < 2000ms（宽松金丝雀）', dt.toFixed(2));
  // 词数 ≥ 题数 且无优先池 → 走 O(n) 快路径（未优化前为 O(题数×词数)，约 400ms）
  ok(dt < 250, '无优先池走 O(n) 快路径（实测约 10ms；退回全量扫描会 ≫250ms）', dt.toFixed(2));

  // 边界：词数 === 题数（恰好取完）
  const exact = engine.buildCardSequence(makeDeck(150).cards, 150, new Set(), rng(14));
  ok(exact.length === 150 && new Set(exact).size === 150, '词数 === 题数 → 恰好取完且不重复', new Set(exact).size);
}

console.log('\n[整卡组抽题 · 带优先池（错题提前）]');
{
  const prio = new Set(Array.from({ length: 40 }, (_, i) => 'c' + i * 7));
  const { out: plan, dt } = ms(() => engine.samplePlan(deck, { count: 150, priorityIds: prio, random: rng(12) }));
  const fromPrio = plan.filter((q) => prio.has(q.cardId)).length;
  ok(plan.length === 150, '带优先池仍生成 150 题', plan.length);
  ok(fromPrio > 0 && fromPrio <= 75, '错题占用一部分槽位（≤ 50%）', fromPrio);
  console.log(`    带 40 题优先池：${dt.toFixed(2)} ms，其中错题 ${fromPrio} 道`);
  ok(dt < 2000, '带优先池 < 2000ms（宽松金丝雀）', dt.toFixed(2));
}

console.log('\n[少词多题（20 词 × 150 题）覆盖率与间隔]');
{
  const small = makeDeck(20);
  const { out: seq, dt } = ms(() => engine.buildCardSequence(small.cards, 150, new Set(), rng(13)));
  ok(seq.length === 150, '生成 150 题', seq.length);
  ok(new Set(seq).size === 20, '覆盖全部 20 个词', new Set(seq).size);
  const first = new Map();
  let minGap = Infinity;
  seq.forEach((id, i) => {
    if (first.has(id)) minGap = Math.min(minGap, i - first.get(id));
    first.set(id, i);
  });
  const minExpected = Math.floor(150 / 20); // 7
  ok(minGap >= minExpected, `同词相邻出现间隔 ≥ floor(150/20) = ${minExpected}`, minGap);
  ok(dt < 2000, '少词多题 < 2000ms', dt.toFixed(2));
}

console.log(`\n性能结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
