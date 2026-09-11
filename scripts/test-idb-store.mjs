#!/usr/bin/env node
// ============================================================================
// test-idb-store.mjs — 存储层测试（IndexedDB 迁移 / 写穿 / 重载水合）
//   运行: node scripts/test-idb-store.mjs
// ============================================================================

import { installFakeIndexedDB, dumpStore } from './fake-idb.mjs';

/* ---------- 浏览器全局桩（须在 import store.js 前定义） ---------- */
const mem = {};
const storage = {
  getItem(k) { return k in mem ? mem[k] : null; },
  setItem(k, v) { mem[k] = String(v); },
  removeItem(k) { delete mem[k]; }
};
globalThis.localStorage = storage;
globalThis.sessionStorage = { ...storage, getItem: storage.getItem, setItem: storage.setItem, removeItem: storage.removeItem };
globalThis.window = { addEventListener() {} };

let pass = 0;
let fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

/* ---------- 准备旧版 localStorage 整库（用于验证迁移） ---------- */
const legacyCard = (id, front, back) => ({
  id, front, back, example: '', exampleZh: '', phonetic: '', tags: [], groups: [], extraBacks: [],
  createdAt: 1700000000000, level: 0, state: 'new', repetitions: 0, interval: 0, easeFactor: 2.5, due: 0, lastReview: null
});
mem['mycard-v1'] = JSON.stringify({
  version: 1,
  seededDemo: true,
  settings: { cardsPerLevel: 20 },
  decks: [
    {
      id: 'deck-legacy',
      name: '旧版卡组',
      description: '迁移测试',
      tags: ['英语'],
      paused: false,
      cardsPerLevel: null,
      createdAt: 1700000000000,
      demo: true,
      source: 'demo',
      passedLevels: { 0: true },
      cards: [legacyCard('c1', 'time', 'n. 时间'), legacyCard('c2', 'year', 'n. 年'), legacyCard('c3', 'day', 'n. 天')]
    }
  ]
});

const dbs = installFakeIndexedDB();
const store = await import('../js/store.js');

console.log('\n[初始化与迁移]');
const info = await store.init();
ok(info.idb === true, 'IndexedDB 可用', info);
ok(info.migrated === true, '识别为首次迁移');
ok(info.decks === 1 && info.cards === 3, '迁移 1 个卡组 / 3 张卡片', info);
ok(store.isIdbReady() === true, 'store 进入 IndexedDB 模式');
ok(mem['mycard-v1'] === undefined, '迁移后删除旧版整库 key（释放 localStorage）');
ok(!!mem['mycard-meta'], '写入精简元数据 mycard-meta');
{
  const meta = JSON.parse(mem['mycard-meta']);
  ok(meta.settings.cardsPerLevel === 20, '精简元数据保留设置');
  ok(meta.decks.length === 1 && !meta.decks[0].cards, '精简元数据只含卡组摘要（无 cards）', meta.decks[0]);
  ok(meta.decks[0].cardCount === 3, '摘要含卡片数量');
}

console.log('\n[IndexedDB 数据]');
{
  const deckRows = dumpStore(dbs, 'mycard', 'decks');
  const cardRows = dumpStore(dbs, 'mycard', 'cards');
  ok(deckRows.length === 1 && !deckRows[0].cards, 'decks store 只存元信息');
  ok(cardRows.length === 3, 'cards store 存了 3 张卡');
  ok(cardRows.every((c) => c.deckId === 'deck-legacy'), '每张卡带 deckId 归属');
  ok(cardRows.find((c) => c.id === 'c1').back === 'n. 时间', '卡片正文完整');
  ok(store.getDeck('deck-legacy').passedLevels[0] === true, '通关记录已水合');
}

console.log('\n[写穿：新增卡组 / 卡片]');
{
  const deck = store.createDeck({ name: '新卡组', tags: ['测试'] });
  store.addCard(deck.id, { front: 'apple', back: 'n. 苹果', example: 'an apple', exampleZh: '一个苹果' });
  await store.flushPending();
  ok(dumpStore(dbs, 'mycard', 'decks').length === 2, '新卡组已落盘');
  const cards = dumpStore(dbs, 'mycard', 'cards');
  ok(cards.length === 4, '新卡片已落盘', cards.length);
  ok(cards.some((c) => c.front === 'apple' && c.deckId === deck.id), '新卡片带正确 deckId');
  ok(JSON.parse(mem['mycard-meta']).decks.length === 2, '精简元数据同步更新');

  console.log('\n[写穿：复习进度更新]');
  const card = store.getDeck(deck.id).cards[0];
  store.updateCard(deck.id, card.id, { state: 'review', repetitions: 3, interval: 4, easeFactor: 2.6, due: 9999999999999, lastReview: 1700000001000 });
  await store.flushPending();
  const persisted = dumpStore(dbs, 'mycard', 'cards').find((c) => c.id === card.id);
  ok(persisted.state === 'review' && persisted.repetitions === 3, '复习状态已写穿', persisted);
  ok(persisted.due === 9999999999999, '到期时间已写穿');

  console.log('\n[写穿：删除卡片]');
  store.deleteCard(deck.id, card.id);
  await store.flushPending();
  ok(!dumpStore(dbs, 'mycard', 'cards').some((c) => c.id === card.id), '删除已写穿');
  ok(dumpStore(dbs, 'mycard', 'cards').length === 3, '剩余 3 张卡');
}

console.log('\n[重载水合：新模块实例读取 IndexedDB]');
{
  const store2 = await import('../js/store.js?reload=1');
  const info2 = await store2.init();
  ok(info2.idb === true, '第二个实例进入 IndexedDB 模式');
  ok(info2.decks === 2, '重载后卡组数一致（2）', info2);
  ok(info2.cards === 3, '重载后卡片数一致（3）', info2);
  ok(!!store2.getDeckBySource('demo'), '按来源可查到已导入词库');
  ok(store2.hasSource('demo') === true, 'hasSource 生效');
}

console.log('\n[关卡重排：动态调序不丢卡]');
{
  const deck = store.createDeck({ name: '重排测试' });
  const items = Array.from({ length: 40 }, (_, i) => ({ front: 'word' + i, back: '释义' + i }));
  store.addManyCards(deck.id, items);
  const before = store.getDeck(deck.id).cards.length;
  const target = store.getDeck(deck.id).cards[35];
  const res = store.rearrangeDeck(deck.id, { errorIds: new Set([target.id]), activeLevel: 0 });
  const after = store.getDeck(deck.id);
  ok(after.cards.length === before, '重排后卡片总数不变', after.cards.length);
  ok(res.levels >= 2, '关卡数 >= 2', res);
  ok(new Set(after.cards.map((c) => c.level)).size === res.levels, '关卡索引连续');
  ok(after.cards.find((c) => c.id === target.id).level === 0, '错题被提升到当前关卡（第 1 关）');
}

console.log(`\n存储层结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
