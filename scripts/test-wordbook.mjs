#!/usr/bin/env node
// ============================================================================
// test-wordbook.mjs — v0.5.9「我的生词」批量管理测试
//   运行: node scripts/test-wordbook.mjs
// 覆盖：纯函数内核（归一化 / 去重分组 / 主卡选取 / 合并 / 标签 / 筛选排序 / 多选）
//       → 存储层（addWords 合并释义 / mergeCards / updateCards / 级联清日志）
//       → #/words 页面（渲染 / 批量操作 / 报告）
// ============================================================================

import { installFakeIndexedDB } from './fake-idb.mjs';

/* ---------- 浏览器全局桩（须在 import store.js 前定义） ---------- */
const mem = {};
const storage = {
  getItem(k) { return k in mem ? mem[k] : null; },
  setItem(k, v) { mem[k] = String(v); },
  removeItem(k) { delete mem[k]; }
};
globalThis.localStorage = storage;
globalThis.sessionStorage = storage;
function fakeEl() {
  return {
    innerHTML: '', value: '', checked: false, dataset: {}, style: {}, className: '', textContent: '', children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, remove() {}, focus() {}, setAttribute() {}, scrollIntoView() {}
  };
}
const els = {};
const elFor = (id) => (els[id] = els[id] || fakeEl());
globalThis.document = {
  body: fakeEl(),
  documentElement: fakeEl(),
  addEventListener() {}, removeEventListener() {},
  querySelector() { return null; }, querySelectorAll() { return []; },
  getElementById: (id) => elFor(id),
  createElement() { return fakeEl(); }
};
globalThis.window = { addEventListener() {}, dispatchEvent() {}, scrollTo() {} };
globalThis.location = { hash: '#/home', href: '' };
globalThis.HashChangeEvent = class HashChangeEvent { constructor(t) { this.type = t; } };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
installFakeIndexedDB();

const wb = await import('../js/wordbook.js');

let pass = 0;
let fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

/** 造一张「够用」的卡片 */
function card(id, front, extra = {}) {
  return {
    id, front, back: extra.back ?? '释义-' + front, example: '', exampleZh: '', phonetic: '',
    tags: [], groups: [], extraBacks: [], createdAt: extra.createdAt ?? 1700000000000,
    level: extra.level ?? 0, state: extra.state ?? 'new', repetitions: extra.repetitions ?? 0,
    interval: extra.interval ?? 0, easeFactor: extra.easeFactor ?? 2.5, due: extra.due ?? 0,
    lastReview: extra.lastReview ?? null, src: extra.src ?? null, addedAt: extra.addedAt ?? null,
    ...extra
  };
}

console.log('\n[单词归一化 / 重复分组 / 主卡选取]');
{
  ok(wb.normKey(' Apple ') === 'apple', '归一化：去空白 + 转小写');
  ok(wb.normKey('New   York') === 'new york', '归一化：折叠内部空白');
  ok(wb.normKey(null) === '' && wb.normKey(undefined) === '', '归一化：空值安全');

  const list = [
    card('a', 'Apple', { addedAt: 100 }),
    card('b', 'apple ', { addedAt: 200 }),
    card('c', 'APPLE', { addedAt: 300 }),
    card('d', 'pear', { addedAt: 400 }),
    card('e', '  ', { addedAt: 500 })
  ];
  const groups = wb.dupGroups(list);
  ok(groups.length === 1, '只切出 1 组重复（apple 三种写法）', groups.length);
  ok(groups[0].cards.length === 3 && groups[0].key === 'apple', '组内 3 张、key=apple');

  // 进度更深的卡当主卡（即使加入更晚）
  const learned = card('l', 'apple', { state: 'review', repetitions: 5, interval: 30, addedAt: 900 });
  ok(wb.pickKeeper([...groups[0].cards, learned]).id === 'l', '主卡优先取「复习状态」的卡片');
  ok(wb.pickKeeper(groups[0].cards).id === 'a', '同为新卡时取「加入最早」的卡片');
  const learning = card('x', 'apple', { state: 'learning', repetitions: 1, interval: 0.01, addedAt: 950 });
  const review = card('y', 'apple', { state: 'review', repetitions: 1, interval: 1, addedAt: 960 });
  ok(wb.pickKeeper([learning, review]).id === 'y', 'review 优先于 learning');
  ok(wb.pickKeeper([]) === null, '空列表返回 null');

  const st = wb.dedupeStats(list);
  ok(st.groupCount === 1 && st.redundant === 2 && st.words[0] === 'Apple', '概览：1 组 / 可删 2 条', st);
}

console.log('\n[文本合并 / 重复词并入已有卡片]');
{
  ok(JSON.stringify(wb.mergeText(['a', 'B', ''], ['b', 'c'], null, 'D')) === JSON.stringify(['a', 'B', 'c', 'D']), 'mergeText：去空 + 大小写去重 + 保序');

  const existing = card('k', 'book', { back: 'n. 书', tags: ['en'], phonetic: '' });
  const snapshot = JSON.stringify(existing);
  const r1 = wb.mergeInto(existing, { front: 'book', back: 'v. 预订', extraBacks: ['n. 账簿'], phonetic: '/bʊk/', example: 'a book', tags: ['生词'] });
  ok(JSON.stringify(existing) === snapshot, 'mergeInto 不改动入参（返回 patch）');
  ok(r1.changed === true && r1.patch.back === undefined, '已有 back 保持第一义（不覆盖）');
  ok(JSON.stringify(r1.patch.extraBacks) === JSON.stringify(['v. 预订', 'n. 账簿']), '新释义追加为 extraBacks', r1.patch.extraBacks);
  ok(r1.patch.phonetic === '/bʊk/' && r1.patch.example === 'a book', '空字段才补（音标 / 例句）');
  ok(JSON.stringify(r1.patch.tags) === JSON.stringify(['en', '生词']), '标签取并集', r1.patch.tags);

  const same = wb.mergeInto(existing, { front: 'book', back: 'n. 书', tags: ['en'] });
  ok(same.changed === false && Object.keys(same.patch).length === 0, '完全重复 → changed=false（计入「跳过」）');

  const empty = card('z', 'void', { back: '' });
  const r2 = wb.mergeInto(empty, { front: 'void', back: '空的' });
  ok(r2.patch.back === '空的', '原 back 为空时用新释义补上');
}

console.log('\n[重复组合并方案（保留主卡 + 删除副卡）]');
{
  const c1 = card('n1', 'bank', { back: 'n. 银行', addedAt: 100, state: 'new' });
  const c2 = card('n2', 'Bank', { back: 'n. 河岸', extraBacks: ['v. 依靠'], addedAt: 200, state: 'learning', repetitions: 2, interval: 3, phonetic: '/bæŋk/', tags: ['生词'] });
  const c3 = card('n3', 'bank ', { back: 'n. 银行', example: 'river bank', tags: ['考试'], addedAt: 300 });
  const plan = wb.mergeGroup([c1, c2, c3]);
  ok(plan.keepId === 'n2', '主卡 = 进度最深的 n2');
  ok(JSON.stringify(plan.removeIds) === JSON.stringify(['n1', 'n3']), '待删除 = 其余两张', plan.removeIds);
  ok(!('back' in plan.patch) && JSON.stringify(plan.patch.extraBacks) === JSON.stringify(['v. 依靠', 'n. 银行']), '释义合并：主卡第一义保持不变 + 其它义（去重）', plan.patch);
  ok(!('phonetic' in plan.patch) && plan.patch.example === 'river bank', '已有音标不动，空例句用副卡补齐');
  ok(JSON.stringify(plan.patch.tags) === JSON.stringify(['生词', '考试']), '标签并集', plan.patch.tags);
  ok(!('state' in plan.patch) && !('interval' in plan.patch) && !('due' in plan.patch), '补丁不含复习进度（进度与日志留在主卡上）');
  ok(plan.groupSize === 3 && plan.senses === 3, '报告：组内 3 张 / 合并后 3 个释义', plan);

  const plans = wb.mergePlans([c1, c2, c3, card('p1', 'pear'), card('p2', 'Pear')]);
  ok(plans.length === 2 && plans[0].removeIds.length === 2, 'mergePlans：两组方案（按组大小排序）', plans.map((p) => p.front));
  ok(wb.mergeGroup([c1]) === null, '单张卡片不成组');
}

console.log('\n[标签整理]');
{
  const list = [
    card('t1', 'one', { tags: ['生词', '四级'] }),
    card('t2', 'two', { tags: ['生词'] }),
    card('t3', 'three', { tags: [] })
  ];
  const counts = wb.tagCounts(list);
  ok(counts.total === 2 && counts.untagged === 1, '标签种类 2 / 未打标签 1', counts);
  ok(counts.list[0].tag === '生词' && counts.list[0].count === 2, '按出现次数降序');

  ok(JSON.stringify(wb.applyTagEdit(['a'], { add: ['b', 'a'] })) === JSON.stringify(['a', 'b']), 'applyTagEdit：加标签去重');
  ok(JSON.stringify(wb.applyTagEdit(['a', 'B'], { remove: ['b'] })) === JSON.stringify(['a']), 'applyTagEdit：去标签忽略大小写');

  const plans = wb.tagPatchPlans(list, new Set(['t1', 't3']), { add: ['高频'] });
  ok(plans.length === 2 && plans[1].tags.includes('高频'), '批量加标签：2 张有变化', plans);
  const noChange = wb.tagPatchPlans(list, new Set(['t2']), { add: ['生词'] });
  ok(noChange.length === 0, '标签无变化时不产生写入');

  const renamed = wb.renameTagPlans(list, '生词', '核心');
  ok(renamed.length === 2 && renamed.every((p) => p.tags.includes('核心') && !p.tags.includes('生词')), '整本重命名标签', renamed);
  const removed = wb.renameTagPlans(list, '生词', '');
  ok(removed.length === 2 && removed[0].tags.join(',') === '四级', '整本删除标签（to 为空）', removed);

  const srcs = wb.srcCounts([card('s1', 'a', { src: 'online_lookup' }), card('s2', 'b', { src: 'online_lookup' }), card('s3', 'c', { src: 'batch_import' })]);
  ok(srcs[0].src === 'online_lookup' && srcs[0].count === 2 && srcs[0].label === '在线查词', '来源统计与中文名', srcs);
}

console.log('\n[筛选 / 排序 / 概览 / 多选]');
{
  const list = [
    card('f1', 'apple', { back: 'n. 苹果', tags: ['水果'], src: 'online_lookup', addedAt: 100, level: 1 }),
    card('f2', 'Banana', { back: 'n. 香蕉', tags: [], src: 'batch_import', addedAt: 300, level: 0 }),
    card('f3', 'cherry', { back: '', example: 'cherry tree', tags: ['水果'], src: 'online_lookup', addedAt: 200, level: 0 })
  ];
  ok(wb.filterWords(list, { q: '香' }).length === 1, '关键词命中释义');
  ok(wb.filterWords(list, { q: 'APPLE' }).length === 1, '关键词大小写不敏感');
  ok(wb.filterWords(list, { q: 'tree' }).length === 1, '关键词命中例句');
  ok(wb.filterWords(list, { tag: '水果' }).length === 2, '按标签筛选');
  ok(wb.filterWords(list, { tag: wb.UNTAGGED }).length === 1, '按「未打标签」筛选');
  ok(wb.filterWords(list, { src: 'batch_import' }).length === 1, '按来源筛选');
  ok(wb.filterWords(list, {}).length === 3, '默认全部');

  ok(wb.sortWords(list, 'added').map((c) => c.id).join(',') === 'f2,f3,f1', '排序：加入时间（新→旧）', wb.sortWords(list, 'added').map((c) => c.id));
  ok(wb.sortWords(list, 'alpha').map((c) => c.id).join(',') === 'f1,f2,f3', '排序：字母序');
  ok(wb.sortWords(list, 'level').map((c) => c.id).join(',') === 'f2,f3,f1', '排序：关卡顺序（同关卡按字母）', wb.sortWords(list, 'level').map((c) => c.id));
  ok(list.map((c) => c.id).join(',') === 'f1,f2,f3', '排序不修改入参数组');

  const st = wb.statsOf(list);
  ok(st.total === 3 && st.noBack === 1 && st.noExample === 2 && st.tagTotal === 1 && st.untagged === 1, '概览统计', st);

  const page = [list[0], list[1]];
  const sel = wb.toggleId(new Set(), 'f1');
  ok(sel.has('f1') && !wb.toggleId(sel, 'f1').has('f1'), 'toggleId：选中 / 取消');
  ok(wb.isAllSelected(page, new Set(['f1', 'f2'])) && !wb.isAllSelected(page, new Set(['f1'])), '全选判定');
  ok(wb.isPartialSelected(page, new Set(['f1'])) && !wb.isPartialSelected(page, new Set()), '部分选中判定');
  ok(wb.isAllSelected([], new Set()) === false, '空列表不算全选');
  ok([...wb.limitSelection(page, new Set(['f1', 'f3']))].join(',') === 'f1', '切换筛选后收敛选中集合');
  ok(wb.lookupTargets(list, new Set(['f3'])).join(',') === 'cherry', '补查目标 = 选中的词');
  ok(wb.lookupTargets(list, new Set(), { onlyMissing: true }).join(',') === 'cherry', '未选中时补查「缺释义」的词');
}

const store = await import('../js/store.js');
await store.init();

console.log('\n[存储层：addWords 合并释义]');
{
  const r1 = store.addWords(
    [
      { word: 'apple', back: 'n. 苹果', extraBacks: ['n. 苹果树'], phonetic: '/ˈæpl/', tags: ['en'] },
      { word: 'banana', back: 'n. 香蕉' }
    ],
    { src: 'online_lookup' }
  );
  ok(r1.added === 2 && r1.merged === 0 && r1.skipped === 0, '首次写入 2 个词', r1);
  const deck = store.getUserDeck();
  ok(deck.name === '我的生词' && deck.source === 'custom', '写入「我的生词」（source=custom）');
  ok(deck.cards[0].src === 'online_lookup' && deck.cards[0].addedAt > 0, '新卡带 src / addedAt');

  const r2 = store.addWords([{ word: 'Apple', back: 'n. 苹果' }]);
  ok(r2.added === 0 && r2.skipped === 1 && r2.merged === 0, 'merge=false：重复词跳过（兼容旧行为）', r2);

  const r3 = store.addWords(
    [{ word: '  APPLE ', back: 'v. 争取好感', example: 'apple of my eye', tags: ['口语'] }],
    { merge: true }
  );
  ok(r3.merged === 1 && r3.added === 0 && r3.skipped === 0, 'merge=true：大小写/空格不同也视为同一个词并合并', r3);
  const apple = store.getUserDeck().cards.find((c) => c.front.toLowerCase() === 'apple');
  ok(apple.back === 'n. 苹果' && apple.extraBacks.join(',') === 'n. 苹果树,v. 争取好感', '原 back 保持第一义，新释义追加为 extraBacks', apple.extraBacks);
  ok(apple.example === 'apple of my eye' && apple.tags.includes('口语'), '空例句 / 标签被补上');
  ok(apple.state === 'new' && apple.repetitions === 0, '合并不影响复习进度');
  ok(store.getUserDeck().cards.length === 2, '全程没有产生重复卡片');

  const r4 = store.addWords(
    [{ word: 'apple', back: 'n. 苹果', extraBacks: ['n. 苹果树', 'v. 争取好感'], phonetic: '/ˈæpl/', tags: ['en', '口语'], example: 'apple of my eye' }],
    { merge: true }
  );
  ok(r4.merged === 0 && r4.skipped === 1, '内容完全一致 → 记为跳过（不产生空写入）', r4);
}

console.log('\n[存储层：mergeCards（保留主卡 / 级联清日志）与 updateCards]');
{
  const deck = store.getUserDeck();
  const keeper = deck.cards.find((c) => c.front === 'banana');
  // 主卡先复习一次（写调度 + 日志）→ 制造「进度最深」的卡片
  store.updateCard(deck.id, keeper.id, {
    state: 'review', repetitions: 1, interval: 3, easeFactor: 2.6, due: Date.now() + 3 * 86400000
  });
  store.recordReview(deck.id, keeper, 'good', keeper);
  store.addCard(deck.id, { front: 'Banana', back: 'n. 香蕉（重复卡）' });
  store.addCard(deck.id, { front: 'BANANA', back: 'n. 香蕉（又一张）' });
  const dup = store.getUserDeck().cards.filter((c) => c.front.toLowerCase() === 'banana');
  ok(dup.length === 3, '制造出 3 张重复卡片', dup.length);
  const side = dup.find((c) => c.front === 'Banana');
  store.recordReview(deck.id, side, 'again', side);
  await store.flushPending();
  await new Promise((r) => setTimeout(r, 20));
  ok((await store.revlogsOfDeck(deck.id)).length === 2, '合并前：主卡 / 副卡各有 1 条日志', (await store.revlogsOfDeck(deck.id)).length);

  const plans = wb.mergePlans(store.getUserDeck().cards);
  const plan = plans.find((p) => p.front.toLowerCase() === 'banana');
  const res = store.mergeCards(deck.id, plans);
  ok(res.groups === 1 && res.removed === 2 && res.kept >= 1, 'mergeCards：1 组 → 删掉 2 张副卡', res);
  const kept = store.getUserDeck().cards.find((c) => c.front.toLowerCase() === 'banana');
  ok(store.getUserDeck().cards.filter((c) => c.front.toLowerCase() === 'banana').length === 1, '重复词只留 1 张');
  ok(kept.id === plan.keepId && kept.state === 'review' && kept.repetitions === 1, '保留进度最深的卡片（复习状态不丢）', kept.state);
  ok(kept.back === 'n. 香蕉（重复卡）' || kept.extraBacks.length > 0, '副卡释义并入主卡', kept.extraBacks);
  ok((await store.revlogsOfCard(deck.id, kept.id)).length === 1, '主卡日志仍在');
  await store.flushPending();
  await new Promise((r) => setTimeout(r, 20));
  ok((await store.revlogsOfDeck(deck.id)).length === 1, '副卡日志随卡片级联清理', (await store.revlogsOfDeck(deck.id)).length);

  const up = store.updateCards(deck.id, []); // 空批量 = 空操作
  ok(up.updated === 0, 'updateCards：空批量返回 0');
  const entries = store.getUserDeck().cards.map((c) => ({ id: c.id, patch: { tags: ['批量'] } }));
  const up2 = store.updateCards(deck.id, entries);
  ok(up2.updated === entries.length && store.getUserDeck().cards.every((c) => c.tags.join(',') === '批量'), 'updateCards：批量写标签（单次落库）', up2);
  ok(store.updateCards(deck.id, [{ id: 'missing', patch: { tags: ['x'] } }]).updated === 0, '未知卡片不产生写入');
}

console.log('\n[#/words 页面：渲染 / 筛选 / 分页]');
const view = await import('../js/wordbook-view.js');
const aw = await import('../js/add-words.js');
{
  const d0 = store.getUserDeck();
  const ids0 = d0.cards.map((c) => c.id);
  store.updateCards(d0.id, [
    { id: ids0[0], patch: { tags: ['水果'] } },
    { id: ids0[1], patch: { tags: ['水果'] } }
  ]);
  store.addWords(
    [
      { word: 'cherry', back: 'n. 樱桃', tags: ['水果'] },
      { word: 'dog', back: '', tags: [] } // 缺释义
    ],
    { src: 'custom' }
  );
  const cherry = store.getUserDeck().cards.find((c) => c.front === 'cherry');
  const dog = store.getUserDeck().cards.find((c) => c.front === 'dog');

  globalThis.location.hash = '#/words';
  const root = elFor('view');
  view.renderWordbook(root);
  let html = root.innerHTML;
  ok(html.includes('view view-wordbook'), '渲染「生词本整理」页');
  ok(html.includes('id="wb-search"') && html.includes('data-action="wb-sort"'), '工具栏：搜索框 + 排序下拉');
  ok(html.includes('data-action="wb-tag" data-tag="水果"'), '标签 chips（含计数）');
  ok(html.includes('data-action="wb-src"'), '来源 chips');
  ok(html.includes('data-action="wb-dedupe-report"') && html.includes('data-action="wb-go-add"'), '底部：合并重复词 + 添加生词');
  ok(
    (html.match(/data-action="wb-pick"/g) || []).length === store.getUserDeck().cards.length,
    '每张卡片渲染一行（含勾选框）'
  );
  ok(html.includes('（缺释义，可「在线补查」）'), '缺释义的卡片给出补查提示');
  ok(view.WORDS_PER_PAGE === 100 && view.getViewState().page === 1, '每页 100 条；URL 无 page → 第 1 页');

  view.setViewState({ q: 'cherry' });
  ok(view.visibleCards().length === 1 && view.visibleCards()[0].id === cherry.id, '关键词搜索命中 1 张');
  view.setViewState({ q: '', tag: '水果' });
  ok(view.visibleCards().every((c) => (c.tags || []).includes('水果')), '按标签筛选');
  view.setViewState({ tag: wb.ALL, missing: true });
  ok(view.visibleCards().length === 1 && view.visibleCards()[0].id === dog.id, '「只看缺释义」只留缺释义的词');
  view.setViewState({ missing: false, src: 'custom' });
  ok(view.visibleCards().every((c) => c.src === 'custom'), '按来源筛选');
  view.setViewState({ src: wb.ALL, sort: 'alpha' });
  const alpha = view.visibleCards().map((c) => c.front);
  ok(alpha.join(',') === [...alpha].sort((a, b) => a.localeCompare(b)).join(','), '按字母排序');
  view.setViewState({ sort: 'added' });
  view.renderWordbook(root);
  ok(root.innerHTML.includes(`data-tag="${wb.UNTAGGED}"`), '未打标签 chip（dog 无标签）');

  // 分页：补到 100 条以上
  store.addWords(
    Array.from({ length: view.WORDS_PER_PAGE + 10 }, (_, i) => ({ word: 'pg' + i, back: '释义' + i })),
    { src: 'custom' }
  );
  const total = store.getUserDeck().cards.length;
  const rest = total - view.WORDS_PER_PAGE;
  globalThis.location.hash = '#/words';
  view.renderWordbook(root);
  ok(root.innerHTML.includes('第 1/2 页'), `共 ${total} 张 → 分页「第 1/2 页」`);
  ok((root.innerHTML.match(/data-action="wb-pick"/g) || []).length === view.WORDS_PER_PAGE, '第 1 页只渲染 100 行');
  globalThis.location.hash = '#/words?page=2';
  view.renderWordbook(root);
  ok(root.innerHTML.includes('第 2/2 页'), 'URL #/words?page=2 → 第 2 页（浏览器回退可用）');
  ok((root.innerHTML.match(/data-action="wb-pick"/g) || []).length === rest, `第 2 页只渲染剩余 ${rest} 行`);
  ok(view.getViewState().page === 2, 'getViewState().page 跟随 URL');
}

console.log('\n[#/words 页面：多选批量 / 标签 / 删除 / 补查 / 报告]');
{
  const cardById = (id) => store.getUserDeck().cards.find((c) => String(c.id) === String(id));
  const cherry = store.getUserDeck().cards.find((c) => c.front === 'cherry');
  const dog = store.getUserDeck().cards.find((c) => c.front === 'dog');
  const root = elFor('view');
  globalThis.location.hash = '#/words';

  // 多选 → 批量栏
  view.setViewState({ sel: [cherry.id, dog.id] });
  view.renderWordbook(root);
  ok(root.innerHTML.includes('data-action="wb-batch-tag"') && root.innerHTML.includes('已选 <b>2</b> 张'), '勾选后出现批量操作栏（含计数）');
  ok(view.getViewState().sel.size === 2, '选中集合 = 2');

  const addTag = view.applyTagsToSelected({ add: ['高频'] });
  ok(addTag.updated === 2 && cardById(cherry.id).tags.includes('高频') && cardById(dog.id).tags.includes('高频'), '批量加标签');
  ok(cardById(cherry.id).tags.includes('水果'), '加标签不覆盖原有标签');
  ok(view.applyTagsToSelected({ add: ['高频'] }).updated === 0, '已是目标状态 → 不产生空写入');
  const ren = view.renameTag('高频', '常用');
  ok(ren.updated === 2 && cardById(cherry.id).tags.includes('常用') && !cardById(cherry.id).tags.includes('高频'), '标签重命名（整本生效）');
  ok(view.renameTag('不存在', 'x').updated === 0, '未知标签不写入');
  const delTag = view.renameTag('水果', '');
  ok(delTag.updated >= 2 && !cardById(cherry.id).tags.includes('水果'), '留空 = 删除该标签（卡片保留）');
  ok(view.getViewState().tag === wb.ALL, '重命名 / 删除后筛选回落到「全部」');

  ok(view.deleteCardsByIds([dog.id]).deleted === 1 && !cardById(dog.id), '删除单张卡片');
  ok(!view.getViewState().sel.has(dog.id) && view.getViewState().sel.has(cherry.id), '删除后只收敛被删的选中 id');
  ok(view.deleteCardsByIds(['missing-id']).deleted === 0, '删除未知 id 是空操作');
  view.setViewState({ sel: [] });
  ok((await view.deleteSelected()).deleted === 0, '未勾选时「批量删除」不弹确认也不删卡片');
}

console.log('\n[#/words 页面：在线补查 / 合并报告]');
{
  const cardById = (id) => store.getUserDeck().cards.find((c) => String(c.id) === String(id));
  const cherry = store.getUserDeck().cards.find((c) => c.front === 'cherry');
  const root = elFor('view');
  globalThis.location.hash = '#/words';

  // 在线补查：未勾选 → 缺释义的词；勾选 → 勾选的词
  store.addWords([{ word: 'eel', back: '', tags: [] }], { src: 'custom' });
  view.setViewState({ sel: [], q: '', tag: wb.ALL, src: wb.ALL, missing: false });
  const n1 = view.lookupSelected();
  ok(n1 === 1, '未勾选 → 补查「缺释义」的词', n1);
  ok(String(elFor('add-words-input').value).includes('eel'), '待查词写入首页查词框');
  ok(aw.isMergeEnabled() === true && elFor('aw-merge-box').checked === true, '补查默认开启「合并释义」（避免又造出重复卡）');
  ok(aw.peekPendingPrefill() === null, '预填词被查词面板一次性消费');
  ok(globalThis.location.hash === '#/home', '补查后跳到首页 #/home');
  globalThis.location.hash = '#/words';
  view.setViewState({ sel: [cherry.id] });
  const n2 = view.lookupSelected();
  ok(n2 === 1 && String(elFor('add-words-input').value).includes('cherry'), '勾选后 → 补查勾选的词（即使已有释义）');
  view.setViewState({ sel: [] });

  // 去重合并：先出报告（保留哪张 / 几个释义 / 删几张）→ 确认后落库
  // 注意：addWords 遇到重复词只会跳过（不合并时），所以这里用 addCard 造出真正的重复卡
  store.updateCard(store.getUserDeck().id, cherry.id, { state: 'review', repetitions: 2, interval: 5, easeFactor: 2.6 });
  store.addCard(store.getUserDeck().id, { front: 'Cherry', back: 'n. 樱桃（重复）', tags: ['水果'] });
  const plans = view.openDedupeReport();
  ok(Array.isArray(plans) && plans.length === 1, '打开合并报告：1 组重复词');
  ok(plans[0].keepId === cherry.id, '保留已在复习的那张（复习进度不丢）');
  ok(
    plans[0].front.toLowerCase() === 'cherry' && plans[0].groupSize === 2 && plans[0].backs.length === 2,
    '报告含组大小与合并后的完整释义序列'
  );
  ok(view.wbReportHtml(plans).includes('合并后删掉'), '报告说明「删几张 + 释义并入保留卡片」');
  const merged = view.mergeDuplicates();
  ok(merged.groups === 1 && merged.removed === 1 && merged.kept >= 1, '一键合并重复词（删掉 1 张副卡）', merged);
  ok(store.getUserDeck().cards.filter((c) => c.front.toLowerCase() === 'cherry').length === 1, '合并后同一个词只剩 1 张');
  ok(cardById(cherry.id).tags.includes('水果'), '合并把副卡标签并入主卡');
  ok(cardById(cherry.id).state === 'review' && cardById(cherry.id).repetitions === 2, '复习进度不受合并影响');
  ok(view.mergeDuplicates().removed === 0 && view.openDedupeReport() === null, '没有重复词时合并 / 报告都是空操作');
  view.renderWordbook(root);
  ok(root.innerHTML.includes('view view-wordbook'), '合并后页面仍能渲染');
}

console.log(`\n生词本内核结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

