#!/usr/bin/env node
// ============================================================================
// test-review-complete.mjs — 翻转完成后「进入测试 · 冲刺通关」可跳转（问题 2 回归）
//   运行: node scripts/test-review-complete.mjs
//
// 复现原 Bug：学完最后一张卡时，rate() 先 clearSession() 再渲染完成页，
// 此时 S 已为 null，旧处理器 `if (!S) return;` 直接空返回 → 点击无反应。
// ============================================================================

function fakeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    contains: (c) => set.has(c),
    toggle: (c) => (set.has(c) ? (set.delete(c), false) : (set.add(c), true))
  };
}
function fakeEl() {
  return {
    innerHTML: '', dataset: {}, style: {}, className: '', textContent: '', children: [],
    classList: fakeClassList(),
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, remove() {}, focus() {}, setAttribute() {}
  };
}

const mem = {};
const storage = {
  getItem(k) { return k in mem ? mem[k] : null; },
  setItem(k, v) { mem[k] = String(v); },
  removeItem(k) { delete mem[k]; }
};
globalThis.localStorage = storage;
globalThis.sessionStorage = storage;
const viewEl = fakeEl();
globalThis.document = {
  body: fakeEl(),
  addEventListener() {}, removeEventListener() {},
  querySelector() { return null; }, querySelectorAll() { return []; },
  getElementById(id) { return id === 'view' ? viewEl : fakeEl(); },
  createElement() { return fakeEl(); }
};
globalThis.window = { addEventListener() {}, dispatchEvent() {}, scrollTo() {} };
globalThis.location = { hash: '#/home', href: '' };

const store = await import('../js/store.js');
const review = await import('../js/review.js');
const ui = await import('../js/ui.js');

let pass = 0;
let fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

/** 模拟 data-action 点击（走 ui.handleEvent 事件委托） */
function click(action, dataset = {}) {
  const el = { dataset: { action, ...dataset }, classList: fakeClassList() };
  el.closest = () => el;
  ui.handleEvent({ type: 'click', target: { closest: () => el }, preventDefault() {} });
  return el;
}

console.log('\n[准备：15 张卡的单关卡卡组]');
const deck = store.createDeck({ name: '完成页测试' });
store.addManyCards(
  deck.id,
  Array.from({ length: 15 }, (_, i) => ({
    front: 'word' + i,
    back: '释义' + i,
    example: 'This is word' + i + '.',
    exampleZh: '例句' + i
  }))
);
ok(store.getDeck(deck.id).cards.length === 15, '导入 15 张卡');
ok(new Set(store.getDeck(deck.id).cards.map((c) => c.level)).size === 1, '≤30 张 → 单关卡');

console.log('\n[翻转学习：翻完最后一张进入完成页]');
review.renderReview(viewEl, deck.id, 0, 'learn');
ok(viewEl.innerHTML.includes('review-view'), '进入翻转学习界面');
ok(viewEl.innerHTML.includes('1 / 15'), '进度显示 1 / 15');
for (let i = 0; i < 15; i++) {
  if (!viewEl.innerHTML.includes('review-rate')) break;
  click('review-rate', { fb: 'good' });
}
ok(!viewEl.innerHTML.includes('review-view'), '15 张全部翻完，退出学习界面');
ok(viewEl.innerHTML.includes('review-go-test'), '完成页渲染「进入测试 · 冲刺通关」按钮');

console.log('\n[关键：完成页按钮携带兜底参数]');
ok(viewEl.innerHTML.includes(`data-id="${deck.id}"`), '按钮含 data-id', deck.id);
ok(viewEl.innerHTML.includes('data-level="0"'), '按钮含 data-level="0"');
ok(store.getDeck(deck.id).cards.every((c) => c.lastReview != null), '全部卡片已标记为已学（S 已清空的同一时刻）');

console.log('\n[点击按钮 → 必须跳转到本关测试]');
globalThis.location.hash = `#/review/${deck.id}/0`;
click('review-go-test', { id: deck.id, level: '0' });
ok(globalThis.location.hash === `#/test/${deck.id}/0`, '跳转到 #/test/{deck}/0', globalThis.location.hash);

console.log('\n[回归保护：直接调用 renderTest 能进入该关测试]');
{
  const testMod = await import('../js/test.js');
  const root = fakeEl();
  testMod.renderTest(root, deck.id, 0);
  ok(root.innerHTML.includes('q-prompt'), '关卡测试界面可渲染（q-prompt）');
}

console.log(`\n完成页进测试结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
