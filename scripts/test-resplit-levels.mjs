#!/usr/bin/env node
// ============================================================================
// test-resplit-levels.mjs — 修改「每关词数」后重新分组（问题 1 回归测试）
//   运行: node scripts/test-resplit-levels.mjs
// 覆盖：levels.resplitLevels 纯函数 + store.updateDeck / setSetting 联动重新拆分
// ============================================================================

import { installFakeIndexedDB } from './fake-idb.mjs';

const mem = {};
const storage = {
  getItem(k) { return k in mem ? mem[k] : null; },
  setItem(k, v) { mem[k] = String(v); },
  removeItem(k) { delete mem[k]; }
};
globalThis.localStorage = storage;
globalThis.sessionStorage = { getItem: storage.getItem, setItem: storage.setItem, removeItem: storage.removeItem };
globalThis.window = { addEventListener() {} };

installFakeIndexedDB();
const lv = await import('../js/levels.js');
const store = await import('../js/store.js');
await store.init();

let pass = 0;
let fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
const countsOf = (deck) => {
  const levels = lv.deckLevels(deck);
  return levels.map((l) => l.cards.length);
};

console.log('\n[纯函数 resplitLevels]');
{
  const cards = Array.from({ length: 60 }, (_, i) => ({ id: 'c' + i, front: 'w' + i, level: 0 }));
  const g = lv.resplitLevels(cards, 20);
  ok(g.length === 3, '60 张 / 20 → 3 组', g.length);
  ok(g.every((x) => x.length === 20), '每组 20 张');
  ok(cards.filter((c) => c.level === 0).length === 20, 'card.level 已重写');
  const g3 = lv.resplitLevels(cards, 15);
  ok(g3.length === 4 && g3.every((x) => x.length === 15), '60 张 / 15 → 4 组 × 15', g3.map((x) => x.length));
  const g4 = lv.resplitLevels(cards, 30);
  ok(g4.length === 2 && g4.every((x) => x.length === 30), '60 张 / 30 → 2 组 × 30', g4.map((x) => x.length));
  ok(lv.resplitLevels([], 20).length === 0, '空列表 → 无分组');
  const small = Array.from({ length: 25 }, () => ({ level: 0 }));
  ok(lv.resplitLevels(small, 15).length === 1, '25 张小卡组仍为单关卡');
}

console.log('\n[卡组级：修改 deck.cardsPerLevel 后立即重新分组]');
{
  const deck = store.createDeck({ name: '重排测试' });
  store.addManyCards(deck.id, Array.from({ length: 120 }, (_, i) => ({ front: 'w' + i, back: '释义' + i })));
  ok(countsOf(store.getDeck(deck.id)).length === 6, '全局 20/关 → 6 个关卡', countsOf(store.getDeck(deck.id)));
  ok(countsOf(store.getDeck(deck.id)).every((n) => n === 20), '每关 20 张');

  store.updateDeck(deck.id, { cardsPerLevel: 30 });
  ok(store.getDeck(deck.id).cardsPerLevel === 30, 'cardsPerLevel 已保存为 30');
  ok(countsOf(store.getDeck(deck.id)).length === 4, '改 30/关 → 4 个关卡', countsOf(store.getDeck(deck.id)));
  ok(countsOf(store.getDeck(deck.id)).every((n) => n === 30), '每关 30 张', countsOf(store.getDeck(deck.id)));
  ok(countsOf(store.getDeck(deck.id)).reduce((a, b) => a + b, 0) === 120, '卡片总数不变');

  store.updateDeck(deck.id, { cardsPerLevel: 25 });
  const c25 = countsOf(store.getDeck(deck.id));
  ok(c25.length === 5 && c25.every((n) => n === 24), '改 25/关 → 5 关 × 24 张（贴近 25 且均衡）', c25);

  store.updateDeck(deck.id, { cardsPerLevel: 15 });
  ok(countsOf(store.getDeck(deck.id)).every((n) => n === 15), '改 15/关 → 每关 15 张', countsOf(store.getDeck(deck.id)));
  ok(countsOf(store.getDeck(deck.id)).length === 8, '改 15/关 → 8 个关卡', countsOf(store.getDeck(deck.id)));

  store.updateDeck(deck.id, { name: '只改名字' });
  ok(countsOf(store.getDeck(deck.id)).every((n) => n === 15), '未改词数时不重排（保持 15/关）');

  // 清空卡组设置 → 回到全局设置（20）
  store.updateDeck(deck.id, { cardsPerLevel: null });
  ok(store.getDeck(deck.id).cardsPerLevel === null, '恢复跟随全局设置');
  ok(countsOf(store.getDeck(deck.id)).every((n) => n === 20), '恢复全局 20/关', countsOf(store.getDeck(deck.id)));
}

console.log('\n[全局设置：修改后重新分组所有跟随全局的卡组]');
{
  const a = store.createDeck({ name: '跟随全局 A' });
  store.addManyCards(a.id, Array.from({ length: 120 }, (_, i) => ({ front: 'a' + i, back: 'A' + i })));
  const b = store.createDeck({ name: '独立设置 B' });
  store.addManyCards(b.id, Array.from({ length: 120 }, (_, i) => ({ front: 'b' + i, back: 'B' + i })));
  store.updateDeck(b.id, { cardsPerLevel: 30 });
  ok(countsOf(store.getDeck(b.id)).every((n) => n === 30), 'B 独立设置 30/关（4 关）', countsOf(store.getDeck(b.id)));

  store.setSetting('cardsPerLevel', 25);
  ok(store.getDb().settings.cardsPerLevel === 25, '全局设置已更新为 25');
  ok(countsOf(store.getDeck(a.id)).every((n) => n === 24), 'A 跟随全局 → 重排为 5 关 × 24 张', countsOf(store.getDeck(a.id)));
  ok(countsOf(store.getDeck(b.id)).every((n) => n === 30), 'B 有独立设置 → 不受全局影响', countsOf(store.getDeck(b.id)));

  store.setSetting('cardsPerLevel', 15);
  ok(countsOf(store.getDeck(a.id)).every((n) => n === 15), 'A 跟随全局 → 15/关（8 关）', countsOf(store.getDeck(a.id)));
  ok(countsOf(store.getDeck(b.id)).every((n) => n === 30), 'B 仍为 30/关');

  // 相同值重复设置不触发无意义重排
  const before = store.getDeck(a.id).cards.map((c) => c.level).join(',');
  store.setSetting('cardsPerLevel', 15);
  ok(store.getDeck(a.id).cards.map((c) => c.level).join(',') === before, '重复设置相同值不改变分组');
}

console.log(`\n每关词数重排结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
