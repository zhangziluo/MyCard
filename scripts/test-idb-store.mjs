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

/* ---------- 预置一个 v2 库（只含 4 个旧 store，缺 revlog）验证 v2 → v3 增量升级 ---------- */
await new Promise((resolve) => {
  const req = indexedDB.open('mycard', 2);
  req.onupgradeneeded = () => {
    const d = req.result;
    d.createObjectStore('decks', { keyPath: 'id' });
    const cards = d.createObjectStore('cards', { keyPath: 'id' });
    cards.createIndex('byDeck', 'deckId');
    d.createObjectStore('meta', { keyPath: 'key' });
    d.createObjectStore('lookup', { keyPath: 'key' });
  };
  req.onsuccess = () => resolve(true);
});

const store = await import('../js/store.js');

console.log('\n[初始化与迁移]');
const info = await store.init();
ok(info.idb === true, 'IndexedDB 可用', info);
ok(info.migrated === true, '识别为首次迁移');
ok(info.decks === 1 && info.cards === 3, '迁移 1 个卡组 / 3 张卡片', info);
ok(store.isIdbReady() === true, 'store 进入 IndexedDB 模式');
{
  const db = dbs.get('mycard');
  ok(db.version === 3, '旧库从 v2 增量升级到 v3', db.version);
  ok(db.objectStoreNames.contains('revlog'), '升级时补建 revlog store（不重建旧数据）');
  ok(db.objectStoreNames.contains('lookup') && db.objectStoreNames.contains('decks'), '旧 store 保留');
  const rl = db.stores.get('revlog');
  ok(rl.keyPath === 'id', 'revlog 以 id 为主键', rl.keyPath);
  ok(rl.indexes.has('byDeck') && rl.indexes.has('byCard'), 'revlog 建有 byDeck / byCard 索引');
}
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

console.log('\n[旧内置词库清理 purgeRemovedBuiltins]');
{
  // 造：旧版本自动导入的考研卡组 + 示范卡组 + 用户自建卡组 + 「我的生词」
  const legacy = store.seedBuiltinDeck(
    { name: '考研英语核心词汇', tags: ['英语', '考研'], words: [{ front: 'abandon', back: 'v. 放弃' }] },
    { demo: false, source: 'kaoyan' }
  );
  const demoDeck = store.getDb().decks.find((d) => d.demo) || store.seedDemoDeck({ name: '示范', words: [{ front: 'x', back: '例' }] });
  const mine = store.createDeck({ name: '我的自建' });
  const wordDeck = store.ensureUserDeck();
  await store.flushPending();
  const before = store.getDb().decks.length;
  ok(store.getDb().decks.some((d) => d.source === 'kaoyan'), '准备：存在 source=kaoyan 的遗留卡组');

  const res = store.purgeRemovedBuiltins();
  ok(res.count === 1 && res.names[0] === '考研英语核心词汇', '只清理 source 命中的旧内置词库', res.names);
  ok(store.getDeck(legacy.id) === null, '考研卡组已从内存移除');
  ok(!!store.getDeck(demoDeck.id), '示范卡组保留');
  ok(!!store.getDeck(mine.id), '用户自建卡组保留');
  ok(!!store.getDeck(wordDeck.id), '「我的生词」保留');
  ok(store.getDb().decks.length === before - 1, '卡组数 -1', store.getDb().decks.length);
  ok(store.purgeRemovedBuiltins().count === 0, '重复执行无副作用（幂等）');

  await store.flushPending();
  ok(!dumpStore(dbs, 'mycard', 'decks').some((x) => x.id === legacy.id), 'IndexedDB 中该卡组已删除');
  ok(!dumpStore(dbs, 'mycard', 'cards').some((c) => c.deckId === legacy.id), 'IndexedDB 中其卡片已删除');
  ok(store.REMOVED_BUILTIN_SOURCES.includes('kaoyan') && store.REMOVED_BUILTIN_SOURCES.length === 10, '下线来源清单含 10 本考试词库');
}

console.log('\n[复习日志（revlog）：写穿 / 重载读回 / 级联清理]');
{
  const deck = store.createDeck({ name: '日志卡组' });
  const c1 = store.addCard(deck.id, { front: 'log1', back: '日志一' });
  const c2 = store.addCard(deck.id, { front: 'log2', back: '日志二' });
  const b1 = { id: c1.id, state: 'new', interval: 0, easeFactor: 2.5 };
  const r1 = { id: c1.id, state: 'review', interval: 6, easeFactor: 2.6 };
  store.recordReview(deck.id, b1, 'good', r1, { now: 1700000001000, timeMs: 3000 });
  store.recordReview(deck.id, r1, 'again', { id: c1.id, state: 'learning', interval: 10 / 1440, easeFactor: 2.3 }, { now: 1700000002000, timeMs: 500 });
  store.recordReview(deck.id, { id: c2.id, state: 'new' }, 'easy', { id: c2.id, state: 'review', interval: 10, easeFactor: 2.7 }, { now: 1700000003000, timeMs: 120 });
  const mem = await store.revlogsOfDeck(deck.id);
  ok(mem.length === 3, '未落盘也能读到 3 条（内存合并）', mem.length);
  ok(mem[0].ts === 1700000001000 && mem[2].ts === 1700000003000, '按时间升序返回', mem.map((r) => r.ts));
  ok(store.recordReview('no-such-deck', b1, 'good', b1) === null, '未知卡组不写日志');
  ok(store.recordReview(deck.id, null, 'good', b1) === null, '无卡片不写日志');
  ok(store.recordReview(deck.id, b1, 'bogus', b1) === null, '未知档位不写日志');

  const written = await store.flushPending();
  ok(written >= 5, 'flushPending 把日志一并落盘', written);
  const rows = dumpStore(dbs, 'mycard', 'revlog');
  ok(rows.length === 3 && rows.every((r) => r.deckId === deck.id), 'IDB revlog 表 3 条且带 deckId', rows.length);
  ok(rows.every((r) => r.cardId === c1.id || r.cardId === c2.id), '每条日志带 cardId');
}

console.log('\n[重载水合：复习日志从 IndexedDB 读回]');
{
  const store3 = await import('../js/store.js?reload=2');
  await store3.init();
  const deck = store3.getDb().decks.find((d) => d.name === '日志卡组');
  ok(!!deck, '重载后仍能定位日志卡组');
  const back = await store3.revlogsOfDeck(deck.id);
  ok(back.length === 3, '刷新后从 IDB 完整读回 3 条', back.length);
  ok(back[0].ease === 3 && back[1].ease === 1 && back[2].ease === 4, 'ease 正确（3 / 1 / 4）', back.map((r) => r.ease));
  ok(back[1].type === 2 && back[1].ivl < 0.02, '遗忘条目 type=2 且步长按天保存', back[1]);
  const stats = await store3.revlogStats(deck.id);
  ok(stats.total === 3 && stats.lapses === 1 && stats.timeMs === 3620, 'revlogStats 汇总正确', stats);
  const one = await store3.revlogsOfCard(deck.id, back[0].cardId);
  ok(one.length === 2, 'revlogsOfCard 按卡片过滤', one.length);
  ok((await store3.revlogsOfDeck('nope')).length === 0, '未知卡组 → 空数组');

  // 导入外部日志：只接受属于本卡组卡片的条目
  const cid = back[0].cardId;
  const n = store3.importRevlogs(deck.id, [
    { cardId: cid, ts: 1700000004000, ease: 2, type: 1, ivl: 15, lastIvl: 6, factor: 2600, time: 800 },
    { cardId: 'foreign-card', ts: 1700000005000, ease: 3 },
    { cardId: cid, ts: 0 }
  ]);
  ok(n === 1, 'importRevlogs 只写入归属本卡组卡片的条目', n);
  ok((await store3.revlogsOfDeck(deck.id)).length === 4, '写入后共 4 条');
  await store3.flushPending();

  // 级联清理：删卡片 → 删卡组
  store3.deleteCard(deck.id, cid);
  await store3.flushPending();
  await new Promise((r) => setTimeout(r, 20)); // 等异步 purge 完成
  ok((await store3.revlogsOfDeck(deck.id)).length === 1, '删除卡片后其日志被清理（4-3）', (await store3.revlogsOfDeck(deck.id)).length);
  store3.deleteDeck(deck.id);
  await store3.flushPending();
  await new Promise((r) => setTimeout(r, 20));
  ok(dumpStore(dbs, 'mycard', 'revlog').length === 0, '删除卡组后日志全部清理');
  ok((await store3.revlogsOfDeck(deck.id)).length === 0, '查询已删卡组返回空数组');
}

console.log('\n[批量整理写穿：mergeCards / updateCards / addWords({merge}) ]');
{
  const wb = await import('../js/wordbook.js');
  const deck = store.createDeck({ name: '整理卡组' });
  store.addManyCards(deck.id, [
    { front: 'time', back: 'n. 时间', tags: ['基础'] },
    { front: 'Time', back: 'n. 时代' },
    { front: 'TIME', back: 'n. 次数' },
    { front: 'space', back: 'n. 空间' }
  ]);
  await store.flushPending();
  // 让其中一张先复习过 → 合并时必须保留它（复习进度优先）
  const reviewed = store.getDeck(deck.id).cards.find((c) => c.front === 'Time');
  store.updateCard(deck.id, reviewed.id, { state: 'review', repetitions: 3, interval: 6, easeFactor: 2.6 });
  await store.flushPending();
  const plans = wb.mergePlans(store.getDeck(deck.id).cards);
  ok(plans.length === 1 && plans[0].removeIds.length === 2, '识别 1 组重复词（3 张 → 1 张）', plans.length);
  ok(plans[0].keepId === reviewed.id, '保留已在复习的那张（复习进度不丢）');
  const res = store.mergeCards(deck.id, plans);
  await store.flushPending();
  ok(res.removed === 2, 'mergeCards 删除 2 张副卡', res);
  const rows = dumpStore(dbs, 'mycard', 'cards').filter((c) => c.deckId === deck.id);
  ok(rows.length === 2, '合并结果写穿（IDB 只剩 2 张）', rows.length);
  const keeper = rows.find((c) => c.front.toLowerCase() === 'time');
  ok(
    keeper.back === 'n. 时代' && keeper.extraBacks.join(',') === 'n. 时间,n. 次数',
    '保留卡片的原释义是第一义，副卡释义全部并入',
    [keeper.back].concat(keeper.extraBacks)
  );
  ok(keeper.state === 'review' && keeper.repetitions === 3, '复习进度与状态一并写穿', keeper.state);
  const metaDeck = JSON.parse(globalThis.localStorage.getItem('mycard-meta')).decks.find((d) => d.id === deck.id);
  ok(metaDeck.cardCount === 2, '精简元数据卡片数同步为 2', metaDeck);

  // 批量写标签（单次落库）
  const up = store.updateCards(deck.id, store.getDeck(deck.id).cards.map((c) => ({ id: c.id, patch: { tags: ['整理'] } })));
  await store.flushPending();
  ok(up.updated === 2, 'updateCards 批量写 2 张', up);
  const rows2 = dumpStore(dbs, 'mycard', 'cards').filter((c) => c.deckId === deck.id);
  ok(rows2.every((c) => c.tags.join(',') === '整理'), '标签写穿到 IDB', rows2.map((c) => c.tags));

  // addWords({merge:true}) 写穿「我的生词」
  const r1 = store.addWords([{ word: 'merge1', back: '释义一', tags: ['x'] }], { src: 'online_lookup' });
  const r2 = store.addWords([{ word: ' MErge1 ', back: '释义二' }], { merge: true });
  await store.flushPending();
  ok(r1.added === 1 && r2.merged === 1 && r2.added === 0, 'addWords：1 新增 / 1 合并', r2);
  const ud = store.getUserDeck();
  const udRows = dumpStore(dbs, 'mycard', 'cards').filter((c) => c.deckId === ud.id);
  ok(udRows.length === 1 && udRows[0].extraBacks.join(',') === '释义二', '合并释义写穿（无重复卡）', udRows[0] && udRows[0].extraBacks);

  // 重载水合：合并 + 标签结果一致
  const store4 = await import('../js/store.js?reload=3');
  await store4.init();
  const d4 = store4.getDeck(deck.id);
  ok(d4.cards.length === 2 && d4.cards.every((c) => c.tags.join(',') === '整理'), '重载后合并 + 标签结果一致');
  const t4 = store4.getDeck(ud.id).cards.find((c) => c.front.toLowerCase() === 'merge1');
  ok(!!t4 && t4.extraBacks.join(',') === '释义二', '重载后「我的生词」合并结果一致', t4 && t4.extraBacks);
}

console.log(`\n存储层结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
