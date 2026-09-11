#!/usr/bin/env node
// ============================================================================
// test-arrange.mjs — 关卡编排策略测试（平缓进阶 / 错峰排列 / 动态调序）
//   运行: node scripts/test-arrange.mjs
// ============================================================================

import * as arr from '../js/arrange.js';
import * as d from '../js/difficulty.js';
import * as lv from '../js/levels.js';

let pass = 0;
let fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

/** 造 n 张等长卡片（w000…），词频序号随下标递增 → 难度随下标递增 */
function makeCards(n) {
  const freq = {};
  const cards = [];
  for (let i = 0; i < n; i++) {
    const front = 'w' + String(i).padStart(3, '0');
    freq[front] = i + 1;
    cards.push({ id: 'c' + i, front, back: '释义' + i, createdAt: i, lastReview: null, repetitions: 0, easeFactor: 2.5 });
  }
  return { cards, freq };
}

const means = (levels) => levels.map((l) => {
  const scores = d.scoreCards(l, { lang: 'en' });
  return scores.reduce((s, x) => s + x, 0) / (scores.length || 1);
});

console.log('\n[平缓进阶：难度分层]');
{
  const { cards, freq } = makeCards(120);
  d.setFrequency(freq);
  const levels = arr.arrangeCards(cards, { perLevel: 20, lang: 'en' });
  ok(levels.length === 6, '120 张 / 20 → 6 关', levels.length);
  ok(levels.every((l) => l.length >= lv.MIN_PER_LEVEL && l.length <= lv.MAX_PER_LEVEL), '每关 15–30 张', levels.map((l) => l.length));
  ok(levels.flat().length === 120 && new Set(levels.flat().map((c) => c.id)).size === 120, '卡片不重不漏');
  const m = means(levels);
  ok(m.every((x, i) => i === 0 || x >= m[i - 1] - 1e-9), '各关平均难度单调不降（平缓进阶）', m.map((x) => Math.round(x * 10) / 10));
  ok(m[0] < m[m.length - 1], '首关难度明显低于末关', [Math.round(m[0]), Math.round(m[m.length - 1])]);
  const firstIds = new Set(levels[0].map((c) => c.front));
  ok(firstIds.has('w000') && firstIds.has('w009') && !firstIds.has('w119'), '第 1 关以高频短词打基础', [...firstIds].slice(0, 3));
  const lastIds = new Set(levels[levels.length - 1].map((c) => c.front));
  ok(lastIds.has('w119') && !lastIds.has('w000'), '末关为最低频词');
}

console.log('\n[小卡组：单关卡 + 难度升序]');
{
  const { cards, freq } = makeCards(25);
  d.setFrequency(freq);
  const levels = arr.arrangeCards(cards, { perLevel: 20, lang: 'en' });
  ok(levels.length === 1, '25 张不拆分（单关卡）');
  ok(levels[0][0].front === 'w000', '关内按难度升序（先易后难）', levels[0].slice(0, 2).map((c) => c.front));
  ok(levels[0][24].front === 'w024', '最简单切到最难');
}

console.log('\n[错峰排列：同易混组强制间隔]');
{
  const { cards, freq } = makeCards(120);
  d.setFrequency(freq);
  const groupsMap = { w000: ['g1'], w001: ['g1'], w002: ['g1'] };
  const levels = arr.arrangeCards(cards, { perLevel: 20, lang: 'en', groupsMap, minGapLevels: 2 });
  const levelOf = (front) => levels.findIndex((l) => l.some((c) => c.front === front));
  const [a, b, c] = ['w000', 'w001', 'w002'].map(levelOf);
  ok(a !== b && b !== c && a !== c, '同组 3 词分布在不同关卡', [a, b, c]);
  ok(Math.abs(a - b) >= 2 && Math.abs(b - c) >= 2 && Math.abs(a - c) >= 2, '两两间隔 ≥ 2 关', [a, b, c]);
  ok(levels.flat().length === 120, '错峰后卡片总数不变');
  // 交换不改变每关容量
  ok(levels.every((l) => l.length === 20), '每关容量保持 20', levels.map((l) => l.length));
}

console.log('\n[错峰排列：可手动关闭]');
{
  const { cards, freq } = makeCards(120);
  d.setFrequency(freq);
  const groupsMap = { w000: ['g1'], w001: ['g1'], w002: ['g1'] };
  const levels = arr.arrangeCards(cards, { perLevel: 20, lang: 'en', groupsMap, minGapLevels: 0 });
  const levelOf = (front) => levels.findIndex((l) => l.some((c) => c.front === front));
  ok(levelOf('w000') === levelOf('w001'), 'minGap=0 时不强制错峰');
}

console.log('\n[动态调序：错题提前]');
{
  const { cards, freq } = makeCards(120);
  d.setFrequency(freq);
  const target = cards[119]; // 最难、原本在末关
  const levels = arr.arrangeCards(cards, { perLevel: 20, lang: 'en', errorIds: new Set([target.id]), activeLevel: 0 });
  const at = levels.findIndex((l) => l.some((c) => c.id === target.id));
  ok(at === 0, '错题被提升到当前关卡（第 1 关）', at);
  ok(levels.flat().length === 120 && new Set(levels.flat().map((c) => c.id)).size === 120, '提升后卡片不重不漏');

  // 困难词同样生效
  const hard = cards[100];
  const levels2 = arr.arrangeCards(cards, { perLevel: 20, lang: 'en', hardIds: new Set([hard.id]), activeLevel: 1 });
  const at2 = levels2.findIndex((l) => l.some((c) => c.id === hard.id));
  ok(at2 === 1, '困难词被提升到指定关卡', at2);
}

console.log('\n[辅助函数]');
{
  const { cards, freq } = makeCards(45);
  d.setFrequency(freq);
  ok(arr.levelSizes(45, 20).length === 2, 'levelSizes(45,20) → 2 关');
  ok(arr.levelSizes(45, 20).reduce((a, b) => a + b, 0) === 45, 'levelSizes 合计等于总数');
  const sorted = arr.sortIndicesByDifficulty(cards, { lang: 'en' });
  ok(sorted.length === 45 && sorted[0] === 0 && sorted[44] === 44, 'sortIndicesByDifficulty 升序');
  ok(arr.groupIdsOf({ front: 'x', groups: ['a'] }, { x: ['b'] }).size === 2, 'groupIdsOf 合并卡片自带与分组表');
}

console.log(`\n关卡编排结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
