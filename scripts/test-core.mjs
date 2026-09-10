#!/usr/bin/env node
// ============================================================================
// test-core.mjs — 核心纯逻辑单元测试（无需浏览器）
//   运行: node scripts/test-core.mjs
// 覆盖: 艾宾浩斯调度 + 关卡拆分/解锁/通关
// ============================================================================

import * as lv from '../js/levels.js';
import * as sched from '../js/scheduler.js';

let passed = 0;
let failed = 0;

function ok(cond, name, extra) {
  if (cond) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    console.error('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra) : ''));
  }
}

/* ----------------------------- levels 拆分 ----------------------------- */
console.log('\n[levels] 关卡拆分');
{
  const g = lv.splitCards(Array.from({ length: 60 }, (_, i) => i), 20);
  ok(g.length === 3, '60 张 / 20 → 3 关', g.map((x) => x.length));
  ok(g.every((x) => x.length === 20), '每关 20 张');
  ok(lv.computeLevelCount(60, 20) === 3, 'computeLevelCount(60,20)=3');
}
{
  const n = 31;
  const g = lv.splitCards(Array.from({ length: n }), 20);
  ok(g.length === 2, '31 张 → 2 关');
  ok(g.every((x) => x.length >= 15 && x.length <= 30), '每关都在 15–30', g.map((x) => x.length));
  ok(g[0].length + g[1].length === n, '卡片总数保持一致');
}
{
  const g = lv.splitCards(Array.from({ length: 25 }), 20);
  ok(g.length === 1 && g[0].length === 25, '25 张小卡组不拆分（单关 25 张）');
}
{
  const g = lv.splitCards(Array.from({ length: 45 }), 20);
  ok(g.length === 2, '45 张 → 2 关', g.map((x) => x.length));
  ok(g.every((x) => x.length >= 15 && x.length <= 30), '45 张拆分成 15–30 的关卡');
}
{
  const g = lv.splitCards([], 20);
  ok(g.length === 0, '空卡片列表 → 无关卡');
}

console.log('\n[levels] clamp 与 effectivePerLevel');
ok(lv.clampPerLevel(5) === 15, 'clamp(5)=15');
ok(lv.clampPerLevel(99) === 30, 'clamp(99)=30');
ok(lv.clampPerLevel('x') === 20, '非法值回退 20');
{
  const deck = { cardsPerLevel: null };
  ok(lv.effectivePerLevel(deck, { cardsPerLevel: 17 }) === 17, '全局设置生效');
  deck.cardsPerLevel = 33;
  ok(lv.effectivePerLevel(deck, { cardsPerLevel: 17 }) === 30, '卡组覆盖全局并夹紧到 30');
}

console.log('\n[levels] 解锁与通关状态机');
function mkCard(reviewed, level = 0) {
  return { id: Math.random().toString(36), front: 'q', back: 'a', level, lastReview: reviewed ? 123 : null };
}
{
  // 关卡 0 两张都未学 → unlocked；关卡 1 locked
  const deck = { passedLevels: {}, cards: [mkCard(false, 0), mkCard(false, 0), mkCard(false, 1)] };
  ok(lv.levelState(deck, 0) === 'unlocked', '第 1 关默认解锁');
  ok(lv.levelState(deck, 1) === 'locked', '第 2 关默认锁定');
}
{
  // 学完第 1 关全部卡片 + 通关标记 → passed；第 2 关随之 unlocked
  const deck = { passedLevels: {}, cards: [mkCard(true, 0), mkCard(true, 0), mkCard(false, 1)] };
  ok(lv.levelState(deck, 0) === 'unlocked', '只学完未测试 → 第 1 关 unlocked（待测试）');
  deck.passedLevels[0] = true;
  ok(lv.levelState(deck, 0) === 'passed', '学完 + 测试通过 → 第 1 关 passed');
  ok(lv.levelState(deck, 1) === 'unlocked', '第 1 关通过后第 2 关解锁');
}
{
  // 已通关的关卡被加入新卡后重新变回 unlocked
  const deck = { passedLevels: { 0: true }, cards: [mkCard(true, 0), mkCard(true, 0)] };
  ok(lv.levelState(deck, 0) === 'passed', '通关保持 passed');
  deck.cards.push(mkCard(false, 0));
  ok(lv.levelState(deck, 0) === 'unlocked', '加入新卡后需要重新通关');
}

console.log('\n[scheduler] 四档反馈');
const NOW = 1000000;
const DAY = 86400000;
{
  const card = { state: 'new', repetitions: 0, interval: 0, easeFactor: 2.5, due: 0, lastReview: null };
  const after = sched.applyFeedback(card, 'again', NOW);
  ok(after.state === 'learning', '重来 → learning');
  ok(after.repetitions === 0, '重来 → repetitions=0');
  ok(after.interval === 10 / 1440, '重来 → 10 分钟', after.interval);
  ok(after.due === NOW + Math.round((10 / 1440) * DAY), '重来 due = now + 10min');
  ok(after.easeFactor === 2.3, '重来 → easeFactor -0.2');
  ok(after.lastReview === NOW, '记录 lastReview');
}
{
  const card = { state: 'new', repetitions: 0, interval: 0, easeFactor: 2.5, due: 0, lastReview: null };
  const good = sched.applyFeedback(card, 'good', NOW);
  ok(good.repetitions === 1, '记住(新卡) → reps=1');
  ok(Math.abs(good.interval - (1 / 24) * 2.5) < 1e-9, '记住 → 1h×ease', good.interval);
  ok(good.state === 'review', '记住 → review');
  ok(good.easeFactor === 2.5, '记住 → easeFactor 不变');
}
{
  const card = { state: 'new', repetitions: 0, interval: 0, easeFactor: 2.5, due: 0, lastReview: null };
  const easy = sched.applyFeedback(card, 'easy', NOW);
  ok(easy.repetitions === 2, '轻松 → reps 跳档到 2', easy.repetitions);
  ok(Math.abs(easy.interval - 0.5 * 2.55) < 1e-9, '轻松 → 12h×ease(+0.05)', easy.interval);
  ok(easy.easeFactor === 2.55, '轻松 → easeFactor +0.05');
}
{
  const card = { state: 'new', repetitions: 0, interval: 0, easeFactor: 2.5, due: 0, lastReview: null };
  const hard = sched.applyFeedback(card, 'hard', NOW);
  ok(hard.repetitions === 1, '困难 → reps=1');
  ok(Math.abs(hard.interval - (1 / 24) * 0.8 * 2.4) < 1e-9, '困难 → 间隔×0.8 且 ease-0.1', hard.interval);
}
{
  // 间隔随重复次数单调递增（连续 good）
  const card = { state: 'new', repetitions: 0, interval: 0, easeFactor: 2.5, due: 0, lastReview: null };
  const seq = [];
  let cur = card;
  for (let i = 0; i < 6; i++) {
    cur = sched.applyFeedback(cur, 'good', NOW);
    seq.push(cur.interval);
  }
  ok(seq.every((v, i) => i === 0 || v > seq[i - 1]), '连续 good 复习间隔单调增长', seq);
  ok(cur.due > NOW, 'due 在未来');
}
{
  // easeFactor 下限
  const card = { state: 'learning', repetitions: 0, interval: 0, easeFactor: 1.3, due: 0, lastReview: 1 };
  const after = sched.applyFeedback(card, 'again', NOW);
  ok(after.easeFactor === 1.3, 'easeFactor 不低于 1.3');
}
{
  const newCard = { state: 'new', lastReview: null, due: 0 };
  const reviewed = { state: 'review', lastReview: 5, due: 100 };
  ok(sched.isDue(newCard, 1000), '新卡随时可学');
  ok(!sched.isDue(reviewed, 50), '未到期不算 due');
  ok(sched.isDue(reviewed, 200), '到期算 due');
}

/* ------------------------------- 汇总 ------------------------------- */
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed) process.exit(1);
console.log('全部通过 ✔');
