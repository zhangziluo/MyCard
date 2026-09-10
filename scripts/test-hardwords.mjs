#!/usr/bin/env node
// ============================================================================
// test-hardwords.mjs — 整卡组翻转循环 + 困难词标记测试
//   运行: node scripts/test-hardwords.mjs
// 覆盖：困难词标记/取消、整卡组队列(突破20张)、循环轮次、1整轮后解锁开始测试、
//       困难词前置、测试中困难词出现概率提高（多一题 + 优先干扰项）。
// ============================================================================

const mem = {};
const mkStorage = () => ({
  getItem: (k) => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: (k) => { delete mem[k]; },
  clear: () => { for (const k of Object.keys(mem)) delete mem[k]; }
});
globalThis.localStorage = mkStorage();
globalThis.sessionStorage = mkStorage();

function mkEl(tag = 'div') {
  return {
    tagName: String(tag).toUpperCase(),
    innerHTML: '', textContent: '', className: '', style: {}, dataset: {},
    _listeners: {},
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, f) { const has = this._s.has(c); const want = f === undefined ? !has : !!f; if (want) this._s.add(c); else this._s.delete(c); return want; },
      contains(c) { return this._s.has(c); }
    },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    setPointerCapture() {}, releasePointerCapture() {}, focus() {}, remove() {}, setAttribute() {}, appendChild() {}
  };
}

const ROOT = mkEl('div');
ROOT.closest = (sel) => (sel === '#view' ? ROOT : null);
globalThis.document = {
  body: mkEl('body'),
  documentElement: mkEl(),
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: (id) => (id === 'view' ? ROOT : null),
  createElement: (t) => mkEl(t)
};
globalThis.window = { addEventListener() {}, dispatchEvent() {}, scrollTo() {} };
globalThis.location = { hash: '#/deck/x', href: '' };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const store = await import('../js/store.js');
const review = await import('../js/review.js');
const testMod = await import('../js/test.js');
const hw = await import('../js/hardwords.js');
const ui = await import('../js/ui.js');
await import('../js/decks.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.error('  ✗ ' + m); } };

/** 触发一次 data-action（走真实事件委托） */
function act(action, data = {}) {
  const el = {
    dataset: { action, ...data },
    classList: { add() {}, remove() {}, contains: () => false },
    closest: (sel) => (sel === '#view' ? ROOT : null)
  };
  ui.handleEvent({ type: 'click', target: { closest: () => el }, preventDefault() {} });
}
const allSession = () => {
  const raw = mem['mycard-review-all-session'];
  return raw ? JSON.parse(raw) : null;
};

console.log('\n[困难词模块 hardwords]');
hw.clearAll();
const deck = store.seedDemoDeck({
  name: '困难词测试',
  levelSize: 20,
  words: Array.from({ length: 40 }, (_, i) => ({
    front: 'word' + i,
    back: '释义' + i,
    example: 'I use word' + i + ' today.',
    exampleZh: '我今天用 word' + i + '。'
  }))
});
ok(!!deck && deck.cards.length === 40, '卡组就绪（40 张 / 2 关）');
const c0 = store.getDeck(deck.id).cards[0];
ok(hw.hardCount(deck.id) === 0 && !hw.isHard(deck.id, c0.id), '初始无困难词');
hw.markHard(deck.id, c0.id);
ok(hw.isHard(deck.id, c0.id) && hw.hardCount(deck.id) === 1, 'markHard 标记困难词');
hw.markHard(deck.id, c0.id);
ok(hw.hardCount(deck.id) === 1, '重复标记不重复计数');
hw.clearHard(deck.id, c0.id);
ok(!hw.isHard(deck.id, c0.id) && hw.hardCount(deck.id) === 0, 'clearHard 取消标记');

console.log('\n[整卡组翻转循环 review mode=all]');
review.renderReview(ROOT, deck.id, null, 'all');
let S = allSession();
ok(!!S && S.mode === 'all', '整卡组会话建立');
ok(S.queue.length === 40, '队列 = 全部 40 张（突破 20 张/关限制）');
ok(S.round === 0 && S.pos === 0 && S.total === 40, '初始为第 1 轮 / 进度 0');
ok(ROOT.innerHTML.includes('第 1 轮'), '界面显示当前轮次');
ok(ROOT.innerHTML.includes('困难词 0 个'), '界面显示困难词数量');
ok(ROOT.innerHTML.includes('review-start-test') && ROOT.innerHTML.includes('btn-disabled'), '未完成 1 整轮时「开始测试」置灰');

for (let i = 0; i < 40; i++) act('review-rate', { fb: 'good' });
S = allSession();
ok(S.round === 1 && S.pos === 0, '走完 40 张后回到第 1 张、轮次 +1（循环不退出）');
ok(ROOT.innerHTML.includes('第 2 轮'), '界面轮次更新为第 2 轮');
ok(ROOT.innerHTML.includes('review-start-test') && !ROOT.innerHTML.includes('btn-disabled'), '完成 1 整轮后「开始测试」高亮可点');

console.log('\n[困难词标记与前置]');
S = allSession();
const targetId = S.queue[S.pos];
act('review-rate', { fb: 'again' });
ok(hw.isHard(deck.id, targetId), '「重来 / 不认识」标记为困难词');
ok(ROOT.innerHTML.includes('困难词 1 个'), '界面困难词数量实时 +1');
S = allSession();
const cur2 = S.queue[S.pos];
hw.markHard(deck.id, cur2);
act('review-rate', { fb: 'easy' });
ok(!hw.isHard(deck.id, cur2), '「轻松」取消困难词标记');

sessionStorage.removeItem('mycard-review-all-session');
review.renderReview(ROOT, deck.id, null, 'all');
S = allSession();
ok(S.queue[0] === targetId, '重新进入时困难词排到队列第一张（重刷优先）');
ok(S.round === 0 && S.pos === 0, '重刷从第 1 轮重新开始（题目池重新洗牌）');

console.log('\n[测试中困难词出现概率提高]');
const deckNow = store.getDeck(deck.id);
let hardCard = deckNow.cards.find((c) => hw.isHard(deck.id, c.id) && c.level === 0);
if (!hardCard) {
  hw.clearAll(deck.id);
  hardCard = deckNow.cards.find((c) => c.level === 0);
  hw.markHard(deck.id, hardCard.id);
}
const hardIds = hw.hardSet(deck.id);
const qs = testMod.buildQuestions(deckNow, 0, { hardIds, types: ['word2def'] });
ok(qs.filter((q) => q.cardId === hardCard.id).length === 2, '困难词在测试中额外多出一道题');
ok(qs[0].cardId === hardCard.id && qs[1].cardId === hardCard.id, '困难词排在被考序列最前');
const other = qs.find((q) => q.cardId !== hardCard.id);
ok(!!other && other.options.some((o) => !o.isCorrect && o.text === hardCard.back), '困难词释义优先作为干扰项');
ok(qs.length === 21, '关卡 20 张 + 困难词多 1 题 = 21 题');

console.log('\n[开始测试 → 第一个未通关关卡]');
ok(review.nextLevelToTest(store.getDeck(deck.id)) === 0, '下一个待通关关卡指向第 1 关');
store.markLevelLearned(deck.id, 0);
store.markLevelPassed(deck.id, 0);
ok(review.nextLevelToTest(store.getDeck(deck.id)) === 1, '第 1 关通关后指向第 2 关');
sessionStorage.removeItem('mycard-review-all-session');
review.renderReview(ROOT, deck.id, null, 'all');
for (let i = 0; i < 40; i++) act('review-rate', { fb: 'good' });
act('review-start-test', {});
ok(location.hash === `#/test/${deck.id}/1`, '「开始测试」跳转到第一个未通关关卡（第 2 关）');

console.log(`\n整卡组翻转/困难词结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
