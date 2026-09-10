#!/usr/bin/env node
// ============================================================================
// test-fill.mjs — 填空题（fill）测试
//   运行: node scripts/test-fill.mjs
// 覆盖：输入规范化（大小写/空格）、单复数容错、applyFill 判题与重试、
//       出题（题干随机例句/释义）、渲染输入框、提交（按钮 + Enter）判分。
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
// 模拟填空输入框（可读写 value，并捕获 keydown 监听）
const fakeField = { value: '', _l: {}, addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); }, focus() {} };
globalThis.document = {
  body: mkEl('body'),
  documentElement: mkEl(),
  addEventListener() {},
  removeEventListener() {},
  querySelector: (sel) => (sel === '.fill-field' ? fakeField : null),
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
/** 触发一次动作（与真实 DOM 事件同路径）；返回模拟元素，便于检查 classList */
const act = (action, data = {}) => {
  const cls = new Set();
  const el = {
    dataset: { action, ...data },
    classList: {
      add(...c) { c.forEach((x) => cls.add(x)); },
      remove(...c) { c.forEach((x) => cls.delete(x)); },
      contains: (c) => cls.has(c)
    },
    closest: (s) => (s === '#view' ? ROOT : null)
  };
  ui.handleEvent({ type: 'click', target: { closest: () => el }, preventDefault() {} });
  return el;
};
const readSession = () => (mem['mycard-test-session'] ? JSON.parse(mem['mycard-test-session']) : null);
const pressEnter = () => (fakeField._l.keydown || []).forEach((fn) => fn({ key: 'Enter', preventDefault() {}, repeat: false }));

console.log('\n[答案规范化 normalizeAnswer（大小写 / 空格）]');
ok(testMod.normalizeAnswer('  Run  ') === 'run', '去首尾空格 + 转小写');
ok(testMod.normalizeAnswer('RUN') === 'run', '大写容错');
ok(testMod.normalizeAnswer('a   b') === 'a b', '折叠连续空格');
ok(testMod.normalizeAnswer(null) === '', 'null → 空串');
ok(testMod.normalizeAnswer('') === '', '空串保持');

console.log('\n[可接受词形 wordForms（单复数容错）]');
const wf = testMod.wordForms('run');
ok(['run', 'runs', 'running'].every((f) => wf.includes(f)), 'run → run / runs / running');
ok(testMod.wordForms('study').includes('studies'), 'study → studies（辅音+y → ies）');
ok(testMod.wordForms('study').includes('studied'), 'study → studied（y → ied）');
ok(testMod.wordForms('box').includes('boxes'), 'box → boxes（+es）');
ok(testMod.wordForms('book').includes('books'), 'book → books（+s）');
ok(testMod.wordForms('').length === 0, '空词返回空数组');

console.log('\n[填空题判题 applyFill]');
const mkFill = (answer) => ({ type: 'fill', answer, accepts: testMod.wordForms(answer), answered: false, correct: false, attempts: 0, wrongInputs: [] });
ok(testMod.applyFill(mkFill('book'), 'BOOK').correct === true, '大小写不敏感判对');
ok(testMod.applyFill(mkFill('book'), '  book  ').correct === true, '首尾空格容错');
ok(testMod.applyFill(mkFill('book'), 'books').correct === true, '单复数容错（books 判对）');
ok(testMod.applyFill(mkFill('study'), 'studies').correct === true, 'y→ies 容错（studies 判对）');
let q = mkFill('book');
ok(testMod.applyFill(q, 'table').resolved === false && q.attempts === 1, '答错第 1 次：可重试');
ok(testMod.applyFill(q, 'desk').resolved === false && q.attempts === 2, '答错第 2 次：仍可重试');
const last = testMod.applyFill(q, 'chair');
ok(last.resolved === true && last.correct === false && q.answered === true, '第 3 次答错：机会用尽并揭示答案');
q = mkFill('book');
ok(testMod.applyFill(q, '   ').resolved === false && q.attempts === 0, '空输入不判题、不消耗机会');

console.log('\n[填空题出题 buildQuestions types:fill]');
const deck = store.seedDemoDeck({
  name: '填空测试',
  levelSize: 20,
  words: Array.from({ length: 20 }, (_, i) => ({
    front: 'word' + i,
    back: '释义' + i,
    example: 'I use word' + i + ' today.',
    exampleZh: '我今天用 word' + i + '。'
  }))
});
const fills = testMod.buildQuestions(deck, 0, { types: ['fill'] });
ok(fills.length === 20 && fills.every((x) => x.type === 'fill'), '全部生成填空题');
ok(fills.every((x) => Array.isArray(x.accepts) && x.accepts.includes(String(x.answer).toLowerCase())), '每题 accepts 含原形');
ok(fills.every((x) => !x.options), '填空题不生成选项');
const sentenceOnly = testMod.buildQuestions(deck, 0, { types: ['fill'], random: () => 0 });
ok(sentenceOnly.every((x) => x.promptKind === 'sentence'), 'random<0.5 → 例句挖空题干');
ok(sentenceOnly.every((x) => x.prompt.includes('word')), '例句题干保留原句（渲染时挖空）');
const meaningOnly = testMod.buildQuestions(deck, 0, { types: ['fill'], random: () => 0.9 });
ok(meaningOnly.every((x) => x.promptKind === 'meaning'), 'random≥0.5 → 中文释义题干');
ok(meaningOnly.every((x) => x.prompt.startsWith('释义')), '释义题干取 back');

console.log('\n[填空题渲染 + 提交（端到端）]');
const seed = () => {
  const qs = testMod.buildQuestions(deck, 0, { types: ['fill'], random: () => 0 }); // 题干=例句挖空
  mem['mycard-test-session'] = JSON.stringify({ deckId: deck.id, level: 0, questions: qs, pos: 0, correct: 0 });
  testMod.renderTest(ROOT, deck.id, 0);
  return qs;
};
let qs = seed();
ok(ROOT.innerHTML.includes('fill-field') && ROOT.innerHTML.includes('test-fill-submit'), '渲染输入框与提交按钮');
ok(ROOT.innerHTML.includes('q-blank'), '例句挖空高亮显示');
ok(ROOT.innerHTML.includes('填空'), '进度行显示题型「填空」');

// 大小写 + 空格 + 提交按钮
fakeField.value = '  ' + qs[0].answer.toUpperCase() + '  ';
act('test-fill-submit');
let s = readSession();
ok(s.questions[0].correct === true && s.correct === 1, '按钮提交（大写+空格）→ 判对并计分');

// Enter 提交 + 单复数容错
qs = seed();
qs[0].answer = 'book';
qs[0].accepts = testMod.wordForms('book');
mem['mycard-test-session'] = JSON.stringify({ deckId: deck.id, level: 0, questions: qs, pos: 0, correct: 0 });
testMod.renderTest(ROOT, deck.id, 0);
fakeField.value = 'books';
pressEnter();
s = readSession();
ok(s.questions[0].correct === true && s.correct === 1, '输入框 Enter 提交 + 单复数容错 → 判对');

// 答错 → 可重试并提示剩余次数
seed();
fakeField.value = 'zzz';
act('test-fill-submit');
s = readSession();
ok(s.questions[0].attempts === 1 && s.questions[0].answered === false, '提交错误 → 留在本题可重试');
ok(ROOT.innerHTML.includes('还可以再试'), '提示剩余重试次数');
ok(ROOT.innerHTML.includes('fill-field'), '答错后仍显示输入框');

console.log('\n[困难词对填空题同样加权]');
const hardIds = new Set([deck.cards[0].id]);
const hardFills = testMod.buildQuestions(deck, 0, { types: ['fill'], hardIds });
ok(hardFills.filter((q) => q.cardId === deck.cards[0].id).length === 2, '困难词在填空题中额外多出一题');
ok(hardFills[0].cardId === deck.cards[0].id, '困难词填空题排在最前');
ok(hardFills.filter((q) => q.cardId !== deck.cards[0].id).length === 19, '非困难词每题仅一题');
ok(hardFills.length === 21, '20 张 + 困难词多 1 题 = 21 题');

console.log('\n[填空首字母提示（答错后逐字揭示）]');
const seedWithAnswer = (word) => {
  const qs = testMod.buildQuestions(deck, 0, { types: ['fill'], random: () => 0 });
  Object.assign(qs[0], { answer: word, accepts: testMod.wordForms(word), attempts: 0, wrongInputs: [], answered: false, correct: false });
  mem['mycard-test-session'] = JSON.stringify({ deckId: deck.id, level: 0, questions: qs, pos: 0, correct: 0 });
  testMod.renderTest(ROOT, deck.id, 0);
};
seedWithAnswer('banana');
ok(!ROOT.innerHTML.includes('class="fill-hint"'), '未答错时不显示提示');
fakeField.value = 'zzz';
act('test-fill-submit');
ok(ROOT.innerHTML.includes('class="fill-hint"'), '答错后出现首字母提示');
ok(ROOT.innerHTML.includes('>b</b>') && ROOT.innerHTML.includes('共 6 个字母'), '第 1 次答错：揭示首字母 b + 词长 6');
fakeField.value = 'yyy';
act('test-fill-submit');
ok(ROOT.innerHTML.includes('>ba</b>'), '第 2 次答错：揭示 2 个字母（ba）');
fakeField.value = 'banana';
act('test-fill-submit');
ok(!ROOT.innerHTML.includes('class="fill-hint"'), '答对后不再显示提示');
ok(readSession().questions[0].correct === true, '答对判定正确');

console.log('\n[填空「提示」按钮（手动请求，不消耗机会）]');
seedWithAnswer('banana');
ok(ROOT.innerHTML.includes('test-fill-hint'), '未答错时也能看到「提示」按钮');
act('test-fill-hint');
let hs = readSession();
ok(hs.questions[0].attempts === 0 && hs.questions[0].hintLevel === 1, '点提示：揭示 1 个字母且不消耗作答机会');
ok(ROOT.innerHTML.includes('>b</b>') && ROOT.innerHTML.includes('共 6 个字母'), '提示内容正确（b + 词长 6）');
act('test-fill-hint');
hs = readSession();
ok(hs.questions[0].hintLevel === 2 && ROOT.innerHTML.includes('>ba</b>'), '再点一次 → 揭示 2 个字母');
for (let i = 0; i < 6; i++) act('test-fill-hint');
hs = readSession();
ok(hs.questions[0].hintLevel === 5, '最多揭示到「词长 - 1」（5 个字母）');
ok(!ROOT.innerHTML.includes('test-fill-hint'), '到上限后隐藏「提示」按钮');
const hintSeg = (ROOT.innerHTML.match(/<p class="fill-hint">[\s\S]*?<\/p>/) || [''])[0];
ok(!/>banana</.test(hintSeg), '「首字母提示」始终不揭示完整答案');

// 点提示保留已输入内容
seedWithAnswer('banana');
fakeField.value = 'ban';
act('test-fill-hint');
hs = readSession();
ok(hs.questions[0].draft === 'ban', '点提示保留已输入内容（draft）');
ok(ROOT.innerHTML.includes('value="ban"'), '重渲染后输入框回填草稿');
fakeField.value = '';
act('test-fill-submit');
hs = readSession();
ok(hs.questions[0].attempts === 0 && hs.questions[0].lastInput === null, '空输入不判题（不消耗机会、无 lastInput）');

console.log('\n[填空 🔊 发音按钮：无 TTS 环境降级]');
ok(testMod.canSpeak() === false, '无 speechSynthesis → canSpeak() false');
seedWithAnswer('banana');
ok(!ROOT.innerHTML.includes('data-action="fill-speak"'), '无 TTS → 不渲染 🔊 按钮');
ok(ROOT.innerHTML.includes('class="fill-ipa"'), '无 TTS → 渲染降级音标位');
ok(ROOT.innerHTML.includes('>banana</span>'), '无 phonetic 数据 → 降级显示单词本身');
ok(ROOT.innerHTML.includes('fill-field') && ROOT.innerHTML.includes('test-fill-submit'), '输入框与提交按钮不受影响');

console.log('\n[填空 🔊 发音按钮：有 TTS 环境（播放 / 停止 / 重播）]');
const spoken = [];
const cancels = [];
globalThis.speechSynthesis = { cancel() { cancels.push(1); }, speak(u) { spoken.push(u); } };
globalThis.SpeechSynthesisUtterance = function (t) { this.text = t; };
ok(testMod.canSpeak() === true, '有 speechSynthesis → canSpeak() true');

seedWithAnswer('banana');
ok(ROOT.innerHTML.includes('data-action="fill-speak"') && ROOT.innerHTML.includes('🔊'), '有 TTS → 渲染 🔊 按钮');
ok(!ROOT.innerHTML.includes('fill-ipa'), '有 TTS → 不显示降级音标');
ok(/<input class="fill-field"[\s\S]*fill-speak[\s\S]*test-fill-submit/.test(ROOT.innerHTML), '🔊 紧邻输入框（位于输入框与「提交」之间）');

const btn1 = act('fill-speak');
ok(spoken.length === 1 && spoken[0].text === 'banana', '点 🔊 → 朗读当前目标词');
ok(spoken[0].lang === 'en-US' && spoken[0].rate === 0.8, '英文词 en-US + 语速 0.8（便于听清拼写）');
ok(btn1.classList.contains('speaking'), '播放中按钮加 .speaking（变红 + 脉动）');
ok(testMod.isSpeaking('banana') === true && testMod.isSpeaking('cherry') === false, 'isSpeaking 精确到具体词');

const c1 = cancels.length;
act('fill-speak');
ok(cancels.length === c1 + 1 && spoken.length === 1, '播放中再点 → cancel 停止（不重复朗读）');
ok(testMod.isSpeaking() === false, '停止后无播放中的词');

act('fill-speak');
ok(spoken.length === 2 && testMod.isSpeaking('banana') === true, '再点 → 重新播放');
spoken[1].onend();
ok(testMod.isSpeaking() === false, 'onend（播放结束）→ 自动复原状态');

act('fill-speak'); // 先让词 A 处于播放中
const c2 = cancels.length;
seedWithAnswer('cherry'); // 换题
act('fill-speak');
ok(cancels.length > c2, '播放新词前先 cancel 旧词（同一时间只播放一个）');
ok(spoken[spoken.length - 1].text === 'cherry', '朗读新题的目标词');
act('fill-speak'); // 停止，避免影响后续断言

seedWithAnswer('苹果');
act('fill-speak');
ok(spoken[spoken.length - 1].lang === 'zh-CN', '含中文字符 → 用 zh-CN 朗读');

// 切题 / 离开测试页 → 停止上一题发音（避免声音串题）
seedWithAnswer('banana');
act('fill-speak');
ok(testMod.isSpeaking('banana') === true, '播放中（准备切题）');
fakeField.value = 'banana';
act('test-fill-submit'); // 答对 → 850ms 后自动跳下一题
await new Promise((r) => setTimeout(r, 950));
ok(testMod.isSpeaking() === false, '自动跳题 → 停止上一题发音（声音不串题）');

act('fill-speak');
ok(testMod.isSpeaking() === true, '播放中（准备离开）');
testMod.clearTestSession();
ok(testMod.isSpeaking() === false, '离开测试页 → 停止发音');

console.log('\n[降级：优先读 card.phonetic]');
const firstQ = testMod.buildQuestions(deck, 0, { types: ['fill'], random: () => 0 })[0];
const firstCard = store.getDeck(deck.id).cards.find((c) => c.id === firstQ.cardId);
store.updateCard(deck.id, firstCard.id, { phonetic: '/bəˈnɑːnə/' });
ok(store.getDeck(deck.id).cards.find((c) => c.id === firstCard.id).phonetic === '/bəˈnɑːnə/', 'updateCard 支持写入 phonetic');
delete globalThis.speechSynthesis;
delete globalThis.SpeechSynthesisUtterance;
ok(testMod.canSpeak() === false, '移除 TTS → 回到降级分支');
seedWithAnswer(firstCard.front);
const ipaSeg = (ROOT.innerHTML.match(/<span class="fill-ipa"[^>]*>([^<]*)<\/span>/) || [])[1];
ok(ipaSeg === '/bəˈnɑːnə/', '有 phonetic → 降级显示音标');

const dIpa = store.createDeck({ name: 'IPA 测试' });
const added = store.addCard(dIpa.id, { front: 'pear', back: '梨', phonetic: '/peə/' });
ok(store.getDeck(dIpa.id).cards.find((c) => c.id === added.id).phonetic === '/peə/', 'addCard 保留 phonetic 字段');
const imported = store.addManyCards(dIpa.id, [{ front: 'apple', back: '苹果', phonetic: '/ˈæpl/' }]);
ok(imported === 1, 'addManyCards 导入 1 张');
ok(store.getDeck(dIpa.id).cards.find((c) => c.front === 'apple').phonetic === '/ˈæpl/', 'addManyCards 保留 phonetic 字段');
const store2 = await import('../js/store.js?reload=1');
ok(store2.getDeck(dIpa.id).cards.find((c) => c.front === 'apple').phonetic === '/ˈæpl/', 'localStorage 重载后 phonetic 仍在（normalizeCard 保留）');

console.log(`\n填空题结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
