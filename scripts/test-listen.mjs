#!/usr/bin/env node
// ============================================================================
// test-listen.mjs — 听音辨意（listen）测试
//   运行: node scripts/test-listen.mjs
// 覆盖：题型注册、出题（4 选项、正确项=释义）、无 TTS 降级、有 TTS 播放/自动播放、
//       点击重播、键盘/点击作答（复用选择题逻辑）。
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
globalThis.location = { hash: '#/test/x/0', href: '' };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const store = await import('../js/store.js');
const testMod = await import('../js/test.js');
const ui = await import('../js/ui.js');
await import('../js/decks.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.error('  ✗ ' + m); } };
const act = (action, data = {}) => {
  const el = { dataset: { action, ...data }, classList: { add() {}, remove() {}, contains: () => false }, closest: (s) => (s === '#view' ? ROOT : null) };
  ui.handleEvent({ type: 'click', target: { closest: () => el }, preventDefault() {} });
};
const readSession = () => (mem['mycard-test-session'] ? JSON.parse(mem['mycard-test-session']) : null);

console.log('\n[题型注册]');
ok(testMod.QUESTION_TYPES.includes('listen'), 'QUESTION_TYPES 含 listen');
ok(testMod.QUESTION_TYPES.length === 5, '共 5 种题型');

const deck = store.seedDemoDeck({
  name: '听音测试',
  levelSize: 20,
  words: Array.from({ length: 20 }, (_, i) => ({
    front: 'word' + i,
    back: '释义' + i,
    example: 'I use word' + i + ' today.',
    exampleZh: '我今天用 word' + i + '。'
  }))
});

console.log('\n[出题 buildQuestions types:listen]');
const qs = testMod.buildQuestions(deck, 0, { types: ['listen'] });
ok(qs.length === 20 && qs.every((q) => q.type === 'listen'), '全部生成 listen 题');
ok(qs.every((q) => q.options.length === 4), '每题 4 个选项');
ok(qs.every((q) => q.options.filter((o) => o.isCorrect).length === 1), '每题恰 1 个正确项');
const card0 = store.getDeck(deck.id).cards.find((c) => c.id === qs[0].cardId);
ok(qs[0].options.some((o) => o.isCorrect && o.text === card0.back), '正确项为该卡的 back（释义）');
ok(qs[0].options.filter((o) => o.text === card0.front).length === 0, '选项中不含单词本身（只听音辨意）');

console.log('\n[无 TTS 环境：安全降级]');
ok(testMod.canSpeak() === false, 'Node 环境无 speechSynthesis → canSpeak() false');
ok(testMod.speakWord('hello') === false, 'speakWord 安全返回 false（不抛错）');
mem['mycard-test-session'] = JSON.stringify({ deckId: deck.id, level: 0, questions: qs, pos: 0, correct: 0 });
testMod.renderTest(ROOT, deck.id, 0);
ok(ROOT.innerHTML.includes('listen-note'), '降级提示：当前环境不支持发音');
ok(!ROOT.innerHTML.includes('listen-play'), '不渲染播放按钮');
ok(ROOT.innerHTML.includes('听音辨意'), '进度行显示题型「听音辨意」');
ok((ROOT.innerHTML.match(/class="opt /g) || []).length === 4, '选项仍正常渲染（可作答）');

console.log('\n[有 TTS 环境：播放 / 自动播放 / 重播]');
const spoken = [];
globalThis.speechSynthesis = { cancel() {}, speak(u) { spoken.push(u.text); } };
globalThis.SpeechSynthesisUtterance = function (t) { this.text = t; };
ok(testMod.canSpeak() === true, '有 speechSynthesis → canSpeak() true');
ok(testMod.speakWord('hello') === true && spoken[spoken.length - 1] === 'hello', 'speakWord 朗读指定单词');

const qs2 = testMod.buildQuestions(deck, 0, { types: ['listen'] });
mem['mycard-test-session'] = JSON.stringify({ deckId: deck.id, level: 0, questions: qs2, pos: 0, correct: 0 });
spoken.length = 0;
testMod.renderTest(ROOT, deck.id, 0);
ok(ROOT.innerHTML.includes('listen-play'), '渲染「🔊 播放发音」按钮');
const curCard = store.getDeck(deck.id).cards.find((c) => c.id === qs2[0].cardId);
ok(spoken.includes(curCard.front), '渲染时自动播放当前单词发音');

spoken.length = 0;
act('listen-play');
ok(spoken.length === 1 && spoken[0] === curCard.front, '点击按钮 → 重播当前单词');

console.log('\n[作答复用选择题逻辑]');
const correctIdx = qs2[0].options.findIndex((o) => o.isCorrect);
act('test-pick', { i: String(correctIdx) });
ok(readSession().questions[0].correct === true, '点选正确释义 → 判对');
const s = readSession();
ok(s.correct === 1, '正确计数 +1');
ok(!ROOT.innerHTML.includes('listen-play') || ROOT.innerHTML.includes('opt-right'), '作答后揭示正确项');

console.log(`\n听音辨意结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);