#!/usr/bin/env node
// ============================================================================
// test-multi-sense.mjs — 第 7 种题型「多义多选 multi_sense」测试
//   运行: node scripts/test-multi-sense.mjs
// 覆盖：释义来源优先级（卡组中文 → GCIDE 英文）、选项构成、多选判分、
//       多选渲染（多选标识 + 提交按钮）、权重启用
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

engdefs.setEngDefs({
  bank: ['A financial institution that accepts deposits.', 'The rising ground bordering a lake or river.'],
  light: ['The quality of being luminous; the sensation of brightness.', 'Not heavy; of little weight.'],
  make: ['To cause to exist; to bring into being.', 'To produce, as something artificial.'],
  single: ['Being only one; individual.']
});

console.log('\n[可选题型注册与启用]');
ok(cfg.OPTIONAL_IDS.includes('multi_sense'), 'multi_sense 已登记为可选题型');
ok(cfg.TYPE_LABELS.multi_sense === '多义多选', '题型标签');
ok(cfg.DEFAULT_ENABLED.multi_sense === false, '默认关闭');
{
  const conf = cfg.loadConfig();
  const on = cfg.setTypeEnabled(conf.weights, conf.enabled, 'multi_sense', true);
  ok(on.enabled.multi_sense === true, '启用后 enabled.multi_sense = true');
  ok(cfg.ALL_TYPES.reduce((s, t) => s + (on.weights[t] || 0), 0) === 100, '权重合计 100%');
  ok(on.weights.multi_sense >= 16 && on.weights.multi_sense <= 17, '等比分配约 1/6', on.weights.multi_sense);
  cfg.saveConfig({ weights: on.weights, enabled: on.enabled });
}

console.log('\n[释义来源优先级：卡组中文 → GCIDE 英文]');
await store.init();
const deck = store.createDeck({ name: '多义测试' });
store.addManyCards(deck.id, [
  { front: 'bank', back: 'n. 银行', extraBacks: ['n. 河岸', 'v. 存款'] },
  { front: 'run', back: 'v. 跑', extraBacks: ['v. 经营', 'n. 连续演出', 'v. 竞选'] },
  { front: 'light', back: 'n. 光' },
  { front: 'make', back: 'v. 制作' },
  { front: 'single', back: 'adj. 单一的' }
]);
const d = store.getDeck(deck.id);
const cardOf = (w) => d.cards.find((c) => c.front === w);

{
  const set = testMod.multiSenseSet(cardOf('bank'));
  ok(set && set.kind === 'zh', 'bank 有 3 条中文释义 → 用中文（kind=zh）');
  ok(set.list.join(',') === 'n. 银行,n. 河岸,v. 存款', '正确项 = 该词全部中文释义', set.list);
  const set4 = testMod.multiSenseSet(cardOf('run'));
  ok(set4.kind === 'zh' && set4.list.length === 4, 'run 有 4 条中文释义（截前 4）', set4.list);
  const setEn = testMod.multiSenseSet(cardOf('light'));
  ok(setEn && setEn.kind === 'en', 'light 只有 1 条中文释义 → 回退 GCIDE 英文（kind=en）');
  ok(setEn.list.length === 2, '回退后用该词的全部英文释义（2 条）', setEn.list);
  ok(testMod.multiSenseSet(cardOf('single')) === null, 'single 中文/英文释义均 < 2 → 不生成（null）');
  ok(testMod.cardChineseSenses(cardOf('bank')).length === 3, 'cardChineseSenses 合并 back + extraBacks');
}

console.log('\n[出题：选项构成（正确 = 全部释义，干扰 = 其它词 1 条）]');
{
  const qs = testMod.buildQuestions(d, 0, { types: ['multi_sense'], random: () => 0 });
  const qBank = qs.find((x) => x.cardId === cardOf('bank').id);
  ok(!!qBank && qBank.type === 'multi_sense', '生成多义多选');
  ok(qBank.multi === true, '标注 multi');
  ok(qBank.prompt === 'bank', '题干为英文单词');
  ok(qBank.options.filter((o) => o.isCorrect).length === 3, '3 个正确项（该词 3 条释义）');
  ok(qBank.options.length === 4, '选项总数 4（3 正确 + 1 干扰）', qBank.options.length);

  const qRun = qs.find((x) => x.cardId === cardOf('run').id);
  ok(qRun.options.filter((o) => o.isCorrect).length === 4, 'run 4 个正确项');
  ok(qRun.options.length === 5, '正确 4 项时选项总数 5', qRun.options.length);

  const correctTexts = qBank.options.filter((o) => o.isCorrect).map((o) => o.text);
  ok(correctTexts.every((t) => testMod.cardChineseSenses(cardOf('bank')).includes(t)), '正确项均为该词释义');
  const distractor = qBank.options.find((o) => !o.isCorrect);
  ok(!testMod.cardChineseSenses(cardOf('bank')).includes(distractor.text), '干扰项不是该词释义', distractor.text);
  ok(correctTexts.every((t) => t !== distractor.text), '干扰项不与正确项重复');
}

console.log('\n[不满足条件的卡片回退到其它题型]');
{
  const qs = testMod.buildQuestions(d, 0, { types: ['multi_sense'], random: () => 0 });
  const q = qs.find((x) => x.cardId === cardOf('single').id);
  ok(!!q && q.type !== 'multi_sense', 'single 回退为其它题型', q && q.type);
}

console.log('\n[多选判分：全对才算对，漏选/多选/错选均算错]');
{
  const qs = testMod.buildQuestions(d, 0, { types: ['multi_sense'], random: () => 0 });
  const q = qs.find((x) => x.cardId === cardOf('bank').id);
  const correctIdx = q.options.map((o, i) => (o.isCorrect ? i : -1)).filter((i) => i >= 0);
  const wrongIdx = q.options.map((o, i) => (o.isCorrect ? -1 : i)).filter((i) => i >= 0);

  ok(testMod.applyMulti(q, []).resolved === false && q.attempts === 0, '未勾选任何项 → 不判分');

  // 漏选：少选一个正确项
  const r1 = testMod.applyMulti(q, correctIdx.slice(0, -1));
  ok(!r1.resolved && !r1.correct && q.attempts === 1, '漏选 → 算错（可再提交）');
  ok(q.selected.length === 0, '判错后清空勾选，允许重选');
  ok(q.wrongPicks.length === 0, '多选不禁用任何选项（否则永远无法全对）');

  // 错选：正确项 + 干扰项
  const r2 = testMod.applyMulti(q, [...correctIdx, ...wrongIdx]);
  ok(!r2.resolved && q.attempts === 2, '多选（含干扰项）→ 算错');

  // 全对 → 判对
  const r3 = testMod.applyMulti(q, correctIdx);
  ok(r3.resolved && r3.correct && q.answered, '全对 → 判对');

  // 机会用尽
  const q2 = testMod.buildQuestions(d, 0, { types: ['multi_sense'], random: () => 0 })
    .find((x) => x.cardId === cardOf('bank').id);
  testMod.applyMulti(q2, [correctIdx[0]]);
  testMod.applyMulti(q2, [correctIdx[0]]);
  const r4 = testMod.applyMulti(q2, [correctIdx[0]]);
  ok(r4.resolved && !r4.correct, '3 次未全对 → resolved + 错误（进错题优先池）');
}

console.log('\n[渲染：多选标识 + 勾选态 + 提交按钮]');
{
  const qs = testMod.buildQuestions(d, 0, { types: ['multi_sense'], random: () => 0 });
  const i = qs.findIndex((x) => x.type === 'multi_sense');
  storage.setItem('mycard-test-session', JSON.stringify({ deckId: d.id, level: 0, questions: qs, pos: i, correct: 0 }));
  const root = fakeEl();
  testMod.renderTest(root, d.id, 0);
  ok(root.innerHTML.includes('多选'), '左上角显示「多选」标识');
  ok(root.innerHTML.includes('multi-badge'), '多选徽标类名存在');
  ok(root.innerHTML.includes('data-action="test-multi-submit"'), '提供「提交」按钮');
  ok(root.innerHTML.includes('提交（'), '提交按钮文案提示全对才算通过');
  ok(root.innerHTML.includes('全对才算通过'), '提示「全对才算通过」');
  ok(root.innerHTML.includes('q-options-multi'), '多选选项容器');
  ok(root.innerHTML.includes('data-action="test-pick"'), '选项可勾选');
  ok(root.innerHTML.includes('disabled'), '未勾选时提交按钮禁用');
}

console.log(`\n多义多选结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

