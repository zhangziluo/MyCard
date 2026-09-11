#!/usr/bin/env node
// ============================================================================
// test-eng-eng.mjs — 第 6 种题型「英英选择 eng_eng」测试
//   运行: node scripts/test-eng-eng.mjs
// 覆盖：可选题型开关/权重、子模式 A/B、选项构成、无释义回退、渲染
// ============================================================================

import { installFakeIndexedDB } from './fake-idb.mjs';

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
    innerHTML: '', dataset: {}, style: {}, className: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(c) { return c; }, addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, remove() {}, focus() {}, setAttribute() {}
  };
}
globalThis.document = {
  body: fakeEl(), addEventListener() {}, removeEventListener() {},
  querySelector() { return null; }, querySelectorAll() { return []; },
  getElementById() { return fakeEl(); }, createElement() { return fakeEl(); }
};
globalThis.window = { addEventListener() {}, dispatchEvent() {}, scrollTo() {} };
globalThis.location = { hash: '#/home', href: '' };
globalThis.HashChangeEvent = class HashChangeEvent { constructor(t) { this.type = t; } };
installFakeIndexedDB();

const store = await import('../js/store.js');
const testMod = await import('../js/test.js');
const cfg = await import('../js/test-config.js');
const engdefs = await import('../js/engdefs.js');

let pass = 0;
let fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

/* ---------- 注入 GCIDE 英文释义（模拟 data/eng-defs.json） ---------- */
engdefs.setEngDefs({
  make: ['To cause to exist; to bring into being; to form.', 'To produce, as something artificial.'],
  run: ['To go swiftly; to pass at a swift pace; to hasten.', 'To contend in a race.', 'To flow, as a liquid.'],
  time: ['Duration, considered independently of any measurement.', 'A proper time; a season; an opportunity.'],
  abandon: ['To cast or drive out; to banish; to expel.', 'A complete giving up to natural impulses.'],
  execute: ['To follow out or through to the end; to carry out.', 'To put to death in conformity to a legal sentence.']
});

console.log('\n[可选题型注册与启用]');
ok(cfg.OPTIONAL_IDS.join(',') === 'eng_eng,multi_sense', '可选题型顺序：eng_eng → multi_sense');
ok(cfg.TYPE_LABELS.eng_eng === '英英选择', '题型标签');
ok(cfg.DEFAULT_ENABLED.eng_eng === false, '默认关闭（enabled:false）');
ok(cfg.DEFAULT_WEIGHTS.eng_eng === 0, '默认权重 0');
ok(cfg.QUESTION_TYPES.length === 5, '基础题型仍为 5 种（不影响旧逻辑）');

const conf0 = cfg.loadConfig();
ok(testMod.enabledTypes().includes('eng_eng') === false, '未启用时不在出题集合里');
{
  const on = cfg.setTypeEnabled(conf0.weights, conf0.enabled, 'eng_eng', true);
  ok(on.enabled.eng_eng === true, '启用后 enabled.eng_eng = true');
  const total = cfg.ALL_TYPES.reduce((s, t) => s + (on.weights[t] || 0), 0);
  ok(total === 100, '启用后权重合计仍 100%');
  ok(on.weights.eng_eng >= 16 && on.weights.eng_eng <= 17, '等比分配约 1/6（16~17%）', on.weights.eng_eng);
  ok(on.weights.word2def >= 16 && on.weights.word2def <= 17, '其余题型等比缩小', on.weights.word2def);
  cfg.saveConfig({ weights: on.weights, enabled: on.enabled });
  ok(testMod.enabledTypes().includes('eng_eng'), '启用后进入出题集合');
}

console.log('\n[出题：子模式 A（看词选英文释义）]');
await store.init();
const deck = store.createDeck({ name: '英英测试' });
store.addManyCards(deck.id, [
  { front: 'make', back: 'v. 制作' },
  { front: 'run', back: 'v. 跑' },
  { front: 'time', back: 'n. 时间' },
  { front: 'abandon', back: 'v. 放弃' },
  { front: 'execute', back: 'v. 执行' },
  { front: 'zzz_unknown', back: 'n. 无英文释义' }
]);
const d = store.getDeck(deck.id);
const cardOf = (word) => d.cards.find((c) => c.front === word);

{
  const qs = testMod.buildQuestions(d, 0, { types: ['eng_eng'], random: () => 0 });
  const q = qs.find((x) => x.cardId === cardOf('make').id);
  ok(!!q && q.type === 'eng_eng', '生成英英选择题');
  ok(q.sub === 'word2def', '子模式 A（看词选义）');
  ok(q.prompt === 'make', '题干为英文单词', q.prompt);
  ok(q.options.length === 4, '4 个选项');
  ok(q.options.filter((o) => o.isCorrect).length === 1, '恰 1 个正确项');
  const correct = q.options.find((o) => o.isCorrect).text;
  ok(engdefs.defs('make').includes(correct), '正确项来自该词的 GCIDE 释义', correct);
  const others = q.options.filter((o) => !o.isCorrect).map((o) => o.text);
  ok(others.every((t) => !engdefs.defs('make').includes(t)), '干扰项不是该词自身的释义');
  ok(others.every((t) => /[a-z]{3}/i.test(t)), '干扰项为其它词的英文释义', others);
}

console.log('\n[出题：子模式 B（看英文释义猜词）]');
{
  const qs = testMod.buildQuestions(d, 0, { types: ['eng_eng'], random: () => 0.9 });
  const q = qs.find((x) => x.cardId === cardOf('run').id);
  ok(q.sub === 'def2word', '子模式 B（看义猜词）');
  ok(engdefs.defs('run').includes(q.prompt), '题干为该词的英文释义', q.prompt);
  ok(q.options.length === 4, '4 个选项');
  ok(q.options.find((o) => o.isCorrect).text === 'run', '正确项为单词 run');
  const others = q.options.filter((o) => !o.isCorrect).map((o) => o.text);
  ok(others.every((t) => t !== 'run'), '干扰项不含自身');
  ok(others.every((t) => d.cards.some((c) => c.front === t)), '干扰项为卡组内其它单词', others);
}

console.log('\n[无英文释义的卡片自动回退]');
{
  const qs = testMod.buildQuestions(d, 0, { types: ['eng_eng'], random: () => 0 });
  const q = qs.find((x) => x.cardId === cardOf('zzz_unknown').id);
  ok(!!q, '无释义卡片仍有题目');
  ok(q.type !== 'eng_eng', '自动回退到其它题型', q.type);
}

console.log('\n[作答与判分（英英题同普通选择题：逐个选项）]');
{
  const qs = testMod.buildQuestions(d, 0, { types: ['eng_eng'], random: () => 0 });
  const q = qs[0];
  const wrong = q.options.findIndex((o) => !o.isCorrect);
  const right = q.options.findIndex((o) => o.isCorrect);
  ok(!testMod.applyAttempt(q, wrong).resolved && q.attempts === 1, '第 1 次选错：可重选');
  ok(!testMod.applyAttempt(q, wrong).resolved, '第 2 次选错：仍可重选');
  const r = testMod.applyAttempt(q, right);
  ok(r.resolved && r.correct, '第 3 次选对：判对');
}

console.log('\n[渲染：题干 / 选项 / 题型名]');
{
  const qs = testMod.buildQuestions(d, 0, { types: ['eng_eng'], random: () => 0 });
  const i = qs.findIndex((x) => x.type === 'eng_eng');
  const q = qs[i];
  storage.setItem('mycard-test-session', JSON.stringify({ deckId: d.id, level: 0, questions: qs, pos: i, correct: 0 }));
  const root = fakeEl();
  testMod.renderTest(root, d.id, 0);
  ok(root.innerHTML.includes('q-prompt'), '渲染题干');
  ok((root.innerHTML.match(/class="opt /g) || []).length === 4, '渲染 4 个选项');
  ok(root.innerHTML.includes('英英选择'), '题型名显示「英英选择」');
  ok(
    root.innerHTML.includes('看单词，选择正确的英文释义') || root.innerHTML.includes('看英文释义，选择对应的单词'),
    '题干提示为英英说明'
  );
}

console.log(`\n英英选择结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

