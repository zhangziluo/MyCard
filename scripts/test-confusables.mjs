#!/usr/bin/env node
// ============================================================================
// test-confusables.mjs — v0.2 易混干扰项生成测试
//   运行: node scripts/test-confusables.mjs
// 验证：分组/多释义随词库导入 → 同组优先 → 兜底 → 自身多释义排除 → 池去重
// ============================================================================

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

/* ---------- 浏览器全局桩（须在 import 浏览器模块前定义） ---------- */
const mem = {};
const storage = {
  getItem(k) { return k in mem ? mem[k] : null; },
  setItem(k, v) { mem[k] = String(v); },
  removeItem(k) { delete mem[k]; }
};
function fakeEl() {
  return {
    innerHTML: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
    appendChild() {}, addEventListener() {}, querySelector() { return null; },
    querySelectorAll() { return []; }, closest() { return null; }, remove() {}
  };
}
globalThis.localStorage = storage;
globalThis.sessionStorage = { ...storage };
globalThis.document = {
  body: fakeEl(), addEventListener() {}, removeEventListener() {},
  querySelector() { return null; }, querySelectorAll() { return []; },
  getElementById() { return fakeEl(); }, createElement() { return fakeEl(); }
};
globalThis.window = { addEventListener() {}, dispatchEvent() {}, scrollTo() {} };
globalThis.location = { hash: '#/home', href: '' };

const store = await import('../js/store.js');
const testMod = await import('../js/test.js');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ ' + msg); }
}

/* ---------- 载入真实数据并模拟 decks.importDemoDeck 的合并 ---------- */
const words = JSON.parse(read('data/words.json'));
const conf = JSON.parse(read('data/confusables.json'));
const groupsMap = {};
for (const g of conf.groups) for (const m of g.members) {
  if (!groupsMap[m]) groupsMap[m] = [];
  groupsMap[m].push(g.id);
}
const deck = store.seedDemoDeck({ ...words, groupsMap, extraDefs: conf.extraDefs });
const byFront = new Map(deck.cards.map((c) => [c.front, c]));
const take = byFront.get('take');
const makeCard = byFront.get('make');
const oldCard = byFront.get('old');
const bookCard = byFront.get('book');
const pool = testMod.buildOptionPool(deck);

console.log('\n[导入与字段]');
ok(!!deck && deck.cards.length === 60, '真实词库导入 60 张');
ok(makeCard.groups.includes('s-ake') && take.groups.includes('s-ake'), 'make/take 已打上同组 s-ake');
ok(makeCard.groups.length >= 1, 'make 至少一组');
ok(deck.cards.filter((c) => (c.groups || []).length > 0).length === 57, '57 张卡已分组');
ok(['water', 'money', 'time'].every((w) => byFront.get(w).groups.length === 0), 'water/money/time 已改为不分组');
ok(byFront.get('day').groups.includes('r-time') && !byFront.get('time').groups.includes('r-time'), 'r-time 保留但已剔除 time');
ok(bookCard.extraBacks.length > 0, 'book 已带多释义');
ok(deck.cards.filter((c) => (c.extraBacks || []).length > 0).length > 20, '多释义覆盖 > 20 个词');

console.log('\n[干扰项池]');
const primary = new Set(deck.cards.map((c) => c.back));
ok(primary.size === 60, '每词独立主释义');
ok(pool.some((e) => e.text === 'v. 预订；预约'), '多释义「v. 预订；预约」已入池');
ok(pool.some((e) => !primary.has(e.text)), '池中包含主释义之外的多释义');
ok(new Set(pool.map((e) => e.text)).size === pool.length, '池内释义文本无重复');

console.log('\n[自身多释义入题 + 同组优先 pickDistractors]');
{
  // make：自身 2 条多释义最先占位，第 3 个取同组兄弟 take
  const dist = testMod.pickDistractors(makeCard, pool, 3);
  ok(dist.length === 3, 'make 取到 3 个干扰项');
  const makeExtras = makeCard.extraBacks;
  ok(makeExtras.length === 2, 'make 有 2 条自身多释义');
  ok(dist[0].text === makeExtras[0] && dist[1].text === makeExtras[1], '前 2 个干扰项为 make 自身多释义');
  ok(dist[2].id === take.id, '第 3 个干扰项来自同组兄弟 take');
  ok(!dist.some((d) => d.text === makeCard.back), '不含 make 主释义');
  ok(new Set(dist.map((d) => d.text)).size === 3, '干扰项文本互不重复');
}
{
  // take：自身 3 条多释义 ≥ 3 → 干扰项全为自身多释义
  const dist = testMod.pickDistractors(take, pool, 3);
  const takeExtras = new Set(take.extraBacks);
  ok(take.extraBacks.length === 3, 'take 有 3 条自身多释义');
  ok(dist.length === 3, 'take 取到 3 个干扰项');
  ok(dist.every((d) => takeExtras.has(d.text)), 'take 的 3 个干扰项均为其自身多释义');
  ok(!dist.some((d) => d.text === take.back), '不含 take 主释义');
}
{
  // book：自身多释义也应进入干扰项，主释义不进入
  const dist = testMod.pickDistractors(bookCard, pool, 3);
  ok(dist.length === 3, 'book 取到 3 个干扰项');
  ok(bookCard.extraBacks.every((t) => dist.some((d) => d.text === t)), 'book 自身多释义已进入干扰项');
  ok(!dist.some((d) => d.text === bookCard.back), '不含 book 主释义');
}

console.log('\n[同组不足与随机兜底]');
{
  // old：自身 2 条多释义占满前 2 位，同组 young 仅 1 条文本正好补足第 3 位
  const dist = testMod.pickDistractors(oldCard, pool, 3);
  ok(dist.length === 3, 'old 仍取满 3 个干扰项');
  ok(dist[0].text === oldCard.extraBacks[0] && dist[1].text === oldCard.extraBacks[1], '前 2 个为 old 自身多释义');
  ok(dist[2].text === byFront.get('young').back, '第 3 个为同组 young 释义');
}
{
  // money：不分组且无多释义 → 3 个干扰项全部随机兜底
  const moneyCard = byFront.get('money');
  ok(moneyCard.groups.length === 0 && moneyCard.extraBacks.length === 0, 'money 无分组无多释义');
  const dist = testMod.pickDistractors(moneyCard, pool, 3);
  ok(dist.length === 3, 'money 仍取满 3 个干扰项');
  ok(dist.every((d) => d.id !== moneyCard.id), '不与自身冲突');
  ok(dist.every((d) => d.text !== moneyCard.back), '不含自身主释义');
  ok(new Set(dist.map((d) => d.text)).size === 3, '文本不重复');
}
{
  // 无任何分组的合成卡片 → 全部随机兜底
  const lonely = { ...makeCard, id: 'lonely-card', groups: [], extraBacks: [] };
  const dist = testMod.pickDistractors(lonely, pool, 3);
  ok(dist.length === 3, '无分组词仍取满 3 个');
  ok(dist.every((d) => d.id !== 'lonely-card'), '不与自身冲突');
  ok(new Set(dist.map((d) => d.text)).size === 3, '文本不重复');
}

console.log('\n[单词池与单词干扰项 buildWordPool/pickWordDistractors]');
{
  const wordPool = testMod.buildWordPool(deck);
  ok(wordPool.length === 60, '单词池含 60 个不重复 front');
  const makeW = testMod.pickWordDistractors(makeCard, wordPool, 3);
  ok(makeW.length === 3, 'make 取到 3 个单词干扰项');
  ok(makeW.every((d) => d.text !== 'make'), '单词干扰项不含自身 front');
  ok(makeW.some((d) => d.text === 'take'), '同组兄弟 take 优先进入单词干扰项');
  ok(new Set(makeW.map((d) => d.text)).size === 3, '单词干扰项文本互不重复');
}

console.log('\n[例句挖空 blankWord]');
{
  const bw = testMod.blankWord;
  ok(bw('Time is money.', 'time') === '____ is money.', '首字母大写 Time 可挖空');
  ok(bw('I have many things to do today.', 'thing') === 'I have many ____ to do today.', '复数 things → thing');
  ok(bw('He runs five kilometers every day.', 'run') === 'He ____ five kilometers every day.', '三单 runs → run');
  ok(bw('The children are playing in the park.', 'play') === 'The children are ____ in the park.', '分词 playing → play');
  ok(bw('She studies English every day.', 'study') === 'She ____ English every day.', 'y→ies studies → study');
  ok(bw('This book is worth reading.', 'book') === 'This ____ is worth reading.', '名词 book 挖空');
  ok(bw('How are you?', 'zzz') === 'How are you?', '例句不含目标词时原样返回');
  ok(bw('', 'time') === '', '空例句返回空串');
}

console.log('\n[三种题型 buildQuestions 随机混合]');
{
  let pick = 0;
  const cycling = () => (pick++ % 3) / 3; // 依次命中第 0/1/2 种题型
  const mix = testMod.buildQuestions(deck, 0, { random: cycling });
  ok(mix.length === 20, '第 1 关生成 20 题（每卡一题）');
  const mcq = mix.filter((q) => q.type !== 'fill');
  const kinds = new Set(mix.map((q) => q.type)).size;
  ok(kinds >= 3, '一次出题即可覆盖多种题型（实际 ' + kinds + ' 种）');
  ok(mix.every((q) => testMod.QUESTION_TYPES.includes(q.type)), '每题 type 合法');
  ok(mcq.every((q) => q.options.length === 4), '选择题每题 4 个选项');
  ok(mcq.every((q) => q.options.filter((o) => o.isCorrect).length === 1), '每题恰 1 个正确项');
  ok(mcq.every((q) => new Set(q.options.map((o) => o.text)).size === 4), '每题选项文本互不重复');
  ok(mix.every((q) => !q.answered && q.attempts === 0), '初始均未作答');
}

console.log('\n[端到端渲染（固定题型 · 真实词库）]');
function renderWith(types, { apply, resolved = false } = {}) {
  const questions = testMod.buildQuestions(deck, 0, { types });
  if (apply) apply(questions);
  storage.setItem('mycard-test-session', JSON.stringify({ deckId: deck.id, level: 0, questions, pos: 0, correct: 0 }));
  const root = fakeEl();
  testMod.renderTest(root, deck.id, 0, { renderResolved: resolved });
  return root;
}
{
  // word2def：题干 front（time），选项为释义
  const root = renderWith(['word2def']);
  ok(root.innerHTML.includes('q-prompt'), '测试界面渲染题目');
  ok((root.innerHTML.match(/class="opt /g) || []).length === 4, '每道题 4 个选项');
  ok(root.innerHTML.includes('q-prompt">time</p>'), 'word2def 题干显示 front（time）');
  ok((root.innerHTML.match(/>n\. 时间</g) || []).length === 1, '正确释义「n. 时间」仅出现 1 次（无重复选项）');
  ok((root.innerHTML.match(/>n\. 次数；回数</g) || []).length === 1, 'time 自身多释义「n. 次数；回数」进入干扰项');
  ok(root.innerHTML.includes('请选择与例句最匹配的释义'), 'word2def 提示按例句语境选择');
  ok(root.innerHTML.includes('Time is money.'), 'word2def 同时展示例句');
  ok(root.innerHTML.includes('test-pick'), '选项可交互');
}
{
  // def2word：题干 back，选项为 front（单词）
  const root = renderWith(['def2word']);
  ok(root.innerHTML.includes('q-prompt q-prompt-def'), 'def2word 题干为释义样式');
  ok((root.innerHTML.match(/>n\. 时间</g) || []).length === 1, 'def2word 题干显示 back（释义 n. 时间）');
  ok((root.innerHTML.match(/>time<\/span>/g) || []).length === 1, '正确单词 time 作为唯一选项出现');
  ok(!root.innerHTML.includes('Time is money.'), 'def2word 不泄露含答案的例句');
  ok(root.innerHTML.includes('看释义，选择对应的单词'), 'def2word 提示选择单词');
}
{
  // sentence2word：题干 example 挖空，选项为 front（单词）
  const root = renderWith(['sentence2word']);
  ok(root.innerHTML.includes('q-prompt q-prompt-sent'), 'sentence2word 题干为句子样式');
  ok(root.innerHTML.includes('q-blank'), 'sentence2word 例句中的单词已挖空高亮');
  ok(root.innerHTML.includes('____</span> is money.'), '例句 Time is money. 被正确挖空');
  ok(!root.innerHTML.includes('Time is money.'), '原例句（含答案）不再直接显示');
  ok((root.innerHTML.match(/>time<\/span>/g) || []).length === 1, '正确单词 time 作为唯一选项出现');
  ok(root.innerHTML.includes('根据例句意思，选出正确的单词'), 'sentence2word 提示按例句选词');
}

console.log('\n[答错展示完整信息 front + back + example]');
{
  // 最终答错（3 次机会用尽）→ 完整信息卡（front + back + example）
  const wrongRoot = renderWith(['def2word'], {
    resolved: true,
    apply(qs) {
      const q = qs[0]; // time 的 def2word 题
      const wrong = q.options.findIndex((o) => !o.isCorrect);
      testMod.applyAttempt(q, wrong);
      testMod.applyAttempt(q, wrong);
      testMod.applyAttempt(q, wrong); // 第 3 次 → resolved & wrong
    }
  });
  ok(wrongRoot.innerHTML.includes('quiz-full-info'), '答错（机会用尽）后展示完整信息卡');
  ok(wrongRoot.innerHTML.includes('fi-label">单词<') && wrongRoot.innerHTML.includes('fi-label">释义<') && wrongRoot.innerHTML.includes('fi-label">例句<'), '完整信息含单词/释义/例句三行');
  ok(wrongRoot.innerHTML.includes('Time is money.'), '完整信息含例句 example');
  ok(wrongRoot.innerHTML.includes('>n. 时间</p>'), '完整信息仍保留释义题干');
  ok(wrongRoot.innerHTML.includes('opt-right'), '同时标出正确选项');
  ok(wrongRoot.innerHTML.includes('机会已用尽'), '保留机会用尽提示');
}
{
  // 答对 → 不显示完整信息卡
  const okRoot = renderWith(['def2word'], {
    resolved: true,
    apply(qs) {
      const q = qs[0];
      const right = q.options.findIndex((o) => o.isCorrect);
      testMod.applyAttempt(q, right);
    }
  });
  ok(okRoot.innerHTML.includes('fb-ok') && !okRoot.innerHTML.includes('quiz-full-info'), '答对仅提示正确，不展示完整信息卡');
}

console.log(`\nv0.2/v0.3 干扰项与题型结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
