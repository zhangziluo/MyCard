#!/usr/bin/env node
// ============================================================================
// test-review-interaction.mjs — 翻转记忆「键盘快捷键 + 拖拽手势」交互链路测试
//   运行: node scripts/test-review-interaction.mjs
// 通过桩 DOM 模拟：空格翻面、方向键评分、右滑评分、轻触翻面、未翻面不评分。
// ============================================================================
// 交互链路验证：模拟键盘与拖拽手势 → 反馈是否落到卡片数据上
const mem = {};
const mkStorage = () => ({
  getItem: (k) => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: (k) => { delete mem[k]; },
  clear: () => { for (const k of Object.keys(mem)) delete mem[k]; }
});
globalThis.localStorage = mkStorage();
globalThis.sessionStorage = mkStorage();

let CARD, WRAP, VIEW, ROOT;

function mkEl(tag = 'div') {
  const node = {
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
    dispatch(t, ev) { (this._listeners[t] || []).forEach((fn) => fn(ev)); },
    querySelector(sel) { return sel === '.flashcard3d' ? CARD : null; },
    querySelectorAll() { return []; },
    closest(sel) {
      if (sel === '.flashcard3d-wrap') return WRAP;
      if (sel === '.review-view') return VIEW;
      if (sel === '#view') return ROOT;
      return null;
    },
    setPointerCapture() {}, releasePointerCapture() {}, focus() {}, remove() {}, setAttribute() {}, appendChild() {}
  };
  return node;
}

CARD = mkEl('div');
CARD.classList.add('flashcard3d');
WRAP = mkEl('div');
VIEW = mkEl('div');
ROOT = mkEl('div');
// 让 ROOT.innerHTML 赋值时模拟浏览器解析：同步 review-view 的 data-flipped 与卡片 flipped 状态
let _html = '';
Object.defineProperty(ROOT, 'innerHTML', {
  get() { return _html; },
  set(v) {
    _html = String(v);
    const m = _html.match(/data-flipped="(\d)"/);
    if (m) VIEW.dataset.flipped = m[1];
    CARD.classList.remove('flipped');
    if (/flashcard3d flipped/.test(_html)) CARD.classList.add('flipped');
  }
});
const BODY = mkEl('body');
const keyHandlers = [];
globalThis.document = {
  body: BODY,
  documentElement: mkEl(),
  addEventListener: (t, fn) => { if (t === 'keydown') keyHandlers.push(fn); },
  removeEventListener() {},
  querySelector: (sel) => (sel === '.review-view' ? VIEW : null),
  querySelectorAll: () => [],
  getElementById: (id) => (id === 'view' ? ROOT : null),
  createElement: (t) => mkEl(t)
};
globalThis.window = { addEventListener() {}, dispatchEvent() {}, scrollTo() {} };
globalThis.location = { hash: '#/review/x/0', href: '' };

const store = await import('../js/store.js');
const review = await import('../js/review.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.error('  ✗ ' + m); } };

// 造 5 张卡的卡组
const deck = store.seedDemoDeck({
  name: 'T', levelSize: 20,
  words: Array.from({ length: 5 }, (_, i) => ({ front: 'w' + i, back: '义' + i, example: 'e ' + i, exampleZh: 'zh' + i }))
});
ok(!!deck && deck.cards.length === 5, '卡组就绪（5 张）');

const key = (ev) => keyHandlers.forEach((fn) => fn({ preventDefault() {}, shiftKey: false, repeat: false, target: BODY, ...ev }));

review.renderReview(ROOT, deck.id, 0, 'learn');
ok(VIEW.dataset.flipped === '0', '初始为正面（未翻面）');
ok(!CARD.classList.contains('flipped'), '卡片未翻转');

// 未翻面时评分键无效
key({ key: 'ArrowUp' });
ok(store.getDeck(deck.id).cards[0].lastReview == null, '未翻面时评分键无效');

// 空格翻面
key({ key: ' ' });
ok(VIEW.dataset.flipped === '1', '空格 → 已翻面');
ok(CARD.classList.contains('flipped'), '卡片添加 flipped 类');

// ↑ = 记住 good
key({ key: 'ArrowUp' });
const c0 = store.getDeck(deck.id).cards[0];
ok(c0.lastReview != null && c0.state === 'review', '↑ → 已记录反馈（第 1 张）');

// 再翻面，用拖拽手势：右滑 = 轻松 easy
key({ key: ' ' });
ok(VIEW.dataset.flipped === '1', '再次翻面');
CARD.dispatch('pointerdown', { pointerType: 'mouse', button: 0, clientX: 100, clientY: 100, pointerId: 1 });
CARD.dispatch('pointermove', { clientX: 180, clientY: 105, pointerId: 1 });
CARD.dispatch('pointerup', { clientX: 180, clientY: 105, pointerId: 1 });
const c1 = store.getDeck(deck.id).cards[1];
ok(c1.lastReview != null, '右滑 → 已记录反馈（第 2 张）');
const s = JSON.parse(mem['mycard-review-session'] || '{}');
ok(s.counts && s.counts.easy === 1 && s.counts.good === 1, '会话统计 good=1 / easy=1');

// 轻触（位移不足阈值）→ 翻面，不评分
key({ key: ' ' }); // 先回到正面
const before = store.getDeck(deck.id).cards[2].lastReview;
CARD.dispatch('pointerdown', { pointerType: 'touch', button: 0, clientX: 10, clientY: 10, pointerId: 2 });
CARD.dispatch('pointerup', { clientX: 14, clientY: 12, pointerId: 2 });
ok(store.getDeck(deck.id).cards[2].lastReview === before, '轻触不评分');
ok(VIEW.dataset.flipped === '1', '轻触 → 翻面');

console.log(`\n交互链路结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
