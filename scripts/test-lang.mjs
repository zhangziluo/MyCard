#!/usr/bin/env node
// ============================================================================
// test-lang.mjs — 语种检测 / 卡组学习模式 / 同语种题型自适应测试
//   运行: node scripts/test-lang.mjs
// 覆盖：detectLang / isLatin / langTag / deckMode / blankWord / wordForms，
//       同语种模式的 4 种题型（无 sentence2word；listen=听写；fill 双向挖空），
//       samplePlan omitTypes、渲染与提交、跨语种英文路径、题型标签。
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
    innerHTML: '', textContent: '', className: '', style: {}, dataset: {}, hidden: false,
    _attrs: {},
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
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
    setPointerCapture() {}, releasePointerCapture() {}, focus() {}, remove() {}, appendChild(c) { return c; }
  };
}

const ROOT = mkEl('div');
ROOT.closest = (sel) => (sel === '#view' ? ROOT : null);
const fakeField = {
  value: '',
  disabled: false,
  _l: {},
  _attrs: {},
  addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); },
  focus() {},
  setSelectionRange() {},
  setAttribute(k, v) { this._attrs[k] = String(v); },
  getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; }
};
let kbBar = null;
const bodyEl = mkEl('body');
bodyEl.appendChild = (c) => {
  if (c && c.id === 'kb-bar') kbBar = c;
  return c;
};
globalThis.document = {
  body: bodyEl,
  documentElement: mkEl(),
  addEventListener() {},
  removeEventListener() {},
  querySelector: (sel) => (sel === '.fill-field' ? fakeField : null),
  querySelectorAll: (sel) => (sel === '.fill-field' ? [fakeField] : []),
  getElementById: (id) => (id === 'view' ? ROOT : id === 'kb-bar' ? kbBar : null),
  createElement: (t) => mkEl(t)
};
globalThis.window = { addEventListener() {}, dispatchEvent() {}, scrollTo() {} };
globalThis.location = { hash: '#/test/x/0', href: '' };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const store = await import('../js/store.js');
const testMod = await import('../js/test.js');
const lang = await import('../js/lang.js');
const engine = await import('../js/test-engine.js');
const cfg = await import('../js/test-config.js');
const ui = await import('../js/ui.js');
await import('../js/decks.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.error('  ✗ ' + m); } };
const act = (action, data = {}) => {
  const cls = new Set();
  const el = {
    dataset: { action, ...data },
    classList: { add(...c) { c.forEach((x) => cls.add(x)); }, remove(...c) { c.forEach((x) => cls.delete(x)); }, contains: (c) => cls.has(c) },
    closest: (s) => (s === '#view' ? ROOT : null)
  };
  ui.handleEvent({ type: 'click', target: { closest: () => el }, preventDefault() {} });
  return el;
};
const readSession = () => (mem['mycard-test-session'] ? JSON.parse(mem['mycard-test-session']) : null);

/* 同语种卡组：中文 ↔ 中文（正面词条 / 背面释义都是中文） */
const sameDeck = store.seedBuiltinDeck(
  {
    name: '中中卡组',
    levelSize: 20,
    words: Array.from({ length: 20 }, (_, i) => ({
      front: '词条' + i,
      back: '释义' + i,
      example: '我在例句里用到了词条' + i + '。',
      exampleZh: '示例翻译' + i
    }))
  },
  { demo: false, source: 'test-same-lang' }
);

/* 跨语种卡组：英文 ↔ 中文（保持既有行为） */
const crossDeck = store.seedBuiltinDeck(
  {
    name: '英中卡组',
    levelSize: 20,
    words: Array.from({ length: 20 }, (_, i) => ({
      front: 'word' + i,
      back: '释义' + i,
      example: 'I use word' + i + ' today.'
    }))
  },
  { demo: false, source: 'test-cross-lang' }
);

console.log('\n[1) detectLang：各语种]');
ok(lang.detectLang('hello') === 'en', '英文 → en');
ok(lang.detectLang('苹果') === 'zh', '纯汉字 → zh（默认）');
ok(lang.detectLang('学生') === 'zh', '纯汉字日语词默认也归 zh（靠卡组假名投票修正）');
ok(lang.detectLang('学生です') === 'ja', '含假名 → ja');
ok(lang.detectLang('こんにちは') === 'ja', '假名 → ja');
ok(lang.detectLang('안녕하세요') === 'ko', '谚文 → ko');
ok(lang.detectLang('γράφω') === 'el', '希腊字母 → el');
ok(lang.detectLang('привет') === 'ru', '西里尔字母 → ru');
ok(lang.detectLang('Straße') === 'de', 'ß → de');
ok(lang.detectLang('über') === 'de', 'ü → de（德语优先）');
ok(lang.detectLang('café') === 'fr', 'é → fr');
ok(lang.detectLang('mañana') === 'es', 'ñ → es');
ok(lang.detectLang('苹果', { hanAs: 'ja' }) === 'ja', "hanAs:'ja' → 纯汉字归日语（查词路由兼容）");
ok(lang.detectLang('') === 'en', '空串 → en（安全兜底）');

console.log('\n[2) isLatin / langTag]');
ok(lang.isLatin('banana') === true, 'banana → 拉丁');
ok(lang.isLatin('café') === true, 'café → 拉丁（带重音）');
ok(lang.isLatin('苹果') === false, '汉字 → 非拉丁');
ok(lang.isLatin('こんにちは') === false, '假名 → 非拉丁');
ok(lang.isLatin('hello世界') === false, '拉丁+汉字混排 → 非拉丁');
ok(lang.langTag('苹果') === 'zh-CN', '中文 → zh-CN');
ok(lang.langTag('hello') === 'en-US', '英文 → en-US');
ok(lang.langTag('こんにちは') === 'ja-JP', '日语 → ja-JP');
ok(lang.langTag('안녕') === 'ko-KR', '韩语 → ko-KR');
ok(lang.langTag('zh') === 'zh-CN', '语种代码 zh → zh-CN');
ok(lang.langTag('de') === 'de-DE', '语种代码 de → de-DE');

console.log('\n[3) deckLang / deckMode]');
ok(lang.deckLang(['学生', 'です', '学校']) === 'ja', '含假名时纯汉字也并入日语');
ok(lang.deckLang(['苹果', '香蕉', '学校']) === 'zh', '全汉字 → 中文');
ok(lang.deckMode(sameDeck) === 'same', '中文-中文卡组 → same');
ok(lang.deckMode(crossDeck) === 'cross', '英-中卡组 → cross');
ok(lang.deckMode({ cards: [] }) === 'cross', '空卡组 → cross（安全兜底）');
ok(testMod.deckMode(sameDeck) === 'same', 'test.js 导出 deckMode');

console.log('\n[4) blankWord / wordForms 非拉丁精确匹配]');
ok(testMod.blankWord('我爱苹果。', '苹果') === '我爱____。', '中文挖空：精确子串替换');
ok(testMod.blankWord('日本語を勉強します', '日本語').includes('____'), '日文挖空：子串替换');
ok(testMod.blankWord('没有目标词', '苹果') === '没有目标词', '找不到目标词 → 原样返回');
ok(JSON.stringify(testMod.wordForms('苹果')) === JSON.stringify(['苹果']), '中文答案不做英文屈折扩展');
ok(testMod.wordForms('apple').includes('apples'), '英文仍保留单复数容错');


console.log('\n[5) 同语种出题：4 种题型]');
const sameCard = sameDeck.cards[0];
ok(testMod.canBuildType(sameCard, 'sentence2word', { mode: 'same' }) === false, 'canBuildType：same 模式不出 sentence2word');
ok(testMod.canBuildType(sameCard, 'sentence2word', { mode: 'cross' }) === true, 'canBuildType：cross 模式仍可出 sentence2word');
const forcedSentence = testMod.buildQuestions(sameDeck, 0, { types: ['sentence2word'] });
ok(forcedSentence.every((q) => q.type !== 'sentence2word'), '同语种强制 sentence2word → 自动回退（不出现）');

const listens = testMod.buildQuestions(sameDeck, 0, { types: ['listen'] });
ok(listens.every((q) => q.type === 'listen' && q.sub === 'back2front'), 'listen → 听写（listen + sub=back2front）');
ok(listens.every((q) => !q.options), '听写题不生成选项');
const lc = sameDeck.cards.find((c) => c.id === listens[0].cardId);
ok(listens[0].answer === lc.front && listens[0].accepts.includes(String(lc.front).toLowerCase()), '听写答案 = 正面');

const fillsFront = testMod.buildQuestions(sameDeck, 0, { types: ['fill'], random: () => 0 });
ok(fillsFront.every((q) => q.promptKind === 'front'), 'random<0.5 → 看正面填背面');
ok(fillsFront.every((q) => q.prompt.startsWith('词条') && q.answer.startsWith('释义')), '题干 = front，答案 = back');
const fillsBack = testMod.buildQuestions(sameDeck, 0, { types: ['fill'], random: () => 0.9 });
ok(fillsBack.every((q) => q.promptKind === 'back'), 'random≥0.5 → 看背面填正面');
ok(fillsBack.every((q) => q.prompt.startsWith('释义') && q.answer.startsWith('词条')), '题干 = back，答案 = front');

const w2d = testMod.buildQuestions(sameDeck, 0, { types: ['word2def'] });
ok(w2d.every((q) => q.options.length === 4), '正面选背面：4 个选项');
const w2dCard = sameDeck.cards.find((c) => c.id === w2d[0].cardId);
ok(w2d[0].options.some((o) => o.isCorrect && o.text === w2dCard.back), '正面选背面：正确项 = back');
const d2w = testMod.buildQuestions(sameDeck, 0, { types: ['def2word'] });
const d2wCard = sameDeck.cards.find((c) => c.id === d2w[0].cardId);
ok(d2w[0].options.some((o) => o.isCorrect && o.text === d2wCard.front), '背面选正面：正确项 = front');

console.log('\n[6) samplePlan omitTypes]');
const plan = engine.samplePlan(sameDeck, {
  count: 30,
  omitTypes: ['sentence2word'],
  canType: (card, type) => testMod.canBuildType(card, type, { mode: 'same' }),
  random: () => 0.37
});
ok(plan.length === 30, '计划题数正确');
ok(plan.every((p) => p.type !== 'sentence2word'), '同语种计划中不出现 sentence2word');
ok(plan.some((p) => p.type === 'fill') && plan.some((p) => p.type === 'listen'), '计划包含 fill / listen（4 种题型参与分配）');


console.log('\n[7) 渲染 + 提交：听写 / 挖空填空]');
const seedSession = (qs) => {
  mem['mycard-test-session'] = JSON.stringify({ deckId: sameDeck.id, level: 0, questions: qs, pos: 0, correct: 0 });
  testMod.renderTest(ROOT, sameDeck.id, 0);
};

// 听写题：无 TTS → 降级显示背面
const listenQ = listens.slice(0, 1);
seedSession(listenQ);
ok(ROOT.innerHTML.includes('听写'), '进度行显示题型「听写」');
ok(ROOT.innerHTML.includes('listen-note') && ROOT.innerHTML.includes('已显示背面'), '无 TTS → 降级显示背面');
ok(ROOT.innerHTML.includes('fill-field') && ROOT.innerHTML.includes('test-fill-submit'), '听写题复用填空输入框');
ok(ROOT.innerHTML.includes('输入答案…'), '非拉丁答案 → 占位符「输入答案…」');
ok(!ROOT.innerHTML.includes('class="opt '), '听写题不渲染选项');
ok(!ROOT.innerHTML.includes('class="fill-hint"'), '未答错时不显示提示');

fakeField.value = listenQ[0].answer;
act('test-fill-submit');
ok(readSession().questions[0].correct === true, '听写题：输入正面 → 判对');
ok(readSession().correct === 1, '听写题：正确计数 +1');
testMod.clearTestSession();

// 挖空填空（看正面填背面）
const fillQ = fillsFront.slice(0, 1);
seedSession(fillQ);
ok(ROOT.innerHTML.includes('看正面内容，填写对应的背面'), '填空提示：看正面填背面');
ok(ROOT.innerHTML.includes(fillQ[0].prompt), '题干显示正面内容');
ok(ROOT.innerHTML.includes('输入答案…'), '非拉丁答案 → 占位符「输入答案…」');
fakeField.value = fillQ[0].answer;
act('test-fill-submit');
ok(readSession().questions[0].correct === true, '挖空填空：输入背面 → 判对');
testMod.clearTestSession();

// 挖空填空（看背面填正面）
const fillQ2 = fillsBack.slice(0, 1);
seedSession(fillQ2);
ok(ROOT.innerHTML.includes('看背面内容，填写对应的正面'), '填空提示：看背面填正面');
ok(ROOT.innerHTML.includes(fillQ2[0].prompt), '题干显示背面内容');
testMod.clearTestSession();

console.log('\n[8) 跨语种（英文）路径保持既有行为]');
const crossListens = testMod.buildQuestions(crossDeck, 0, { types: ['listen'] });
ok(crossListens.every((q) => q.type === 'listen' && !q.sub && Array.isArray(q.options)), '英文 listen 仍是 4 选 1');
ok(crossListens.every((q) => q.options.length === 4), '英文 listen 4 个选项');
const crossFills = testMod.buildQuestions(crossDeck, 0, { types: ['fill'], random: () => 0.9 });
ok(crossFills.every((q) => q.promptKind === 'meaning' && q.answer.startsWith('word')), '英文 fill 仍是「中文释义 → 英文单词」');
ok(testMod.wordForms('apple').includes('apples'), '英文 wordForms 仍含单复数');

console.log('\n[9) TTS 语音按语种切换]');
const spoken = [];
globalThis.speechSynthesis = { cancel() {}, speak(u) { spoken.push({ text: u.text, lang: u.lang }); } };
globalThis.SpeechSynthesisUtterance = function (t) { this.text = t; };
testMod.speakWord('苹果');
ok(spoken[spoken.length - 1].lang === 'zh-CN', '中文词 → zh-CN');
testMod.speakWord('hello');
ok(spoken[spoken.length - 1].lang === 'en-US', '英文词 → en-US');
testMod.speakWord('こんにちは');
ok(spoken[spoken.length - 1].lang === 'ja-JP', '日语词 → ja-JP');
delete globalThis.speechSynthesis;
delete globalThis.SpeechSynthesisUtterance;

console.log('\n[10) 题型标签按模式切换]');
ok(cfg.typeLabel('word2def', 'cross') === '英选中', 'cross：word2def → 英选中');
ok(cfg.typeLabel('word2def', 'same') === '正面选背面', 'same：word2def → 正面选背面');
ok(cfg.typeLabel('listen', 'same') === '听写', 'same：listen → 听写');
ok(cfg.TYPE_LABELS.word2def === '英选中', 'TYPE_LABELS 保持不变（兼容旧调用）');

console.log(`\n语种自适应结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

