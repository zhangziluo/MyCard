#!/usr/bin/env node
// ============================================================================
// test-level-retry.mjs — 关卡「重新挑战 / 直接测试」流程测试
//   运行: node scripts/test-level-retry.mjs
// 覆盖：题型比例微调(typesForRetry)、挑战统计(levelstats)、通关即学完
//       (markLevelLearned)、直接测试通过→通关、重新挑战→重置标记+洗牌+计数。
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
const keyHandlers = [];
// 模拟填空输入框（可读写 value，并捕获 keydown 监听）
const fakeField = { value: '', _l: {}, addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); }, focus() {} };
globalThis.document = {
  body: mkEl('body'),
  documentElement: mkEl(),
  addEventListener: (t, fn) => { if (t === 'keydown') keyHandlers.push(fn); },
  removeEventListener() {},
  querySelector: (sel) => (sel === '.fill-field' ? fakeField : null),
  querySelectorAll: () => [],
  getElementById: (id) => (id === 'view' ? ROOT : null),
  createElement: (t) => mkEl(t)
};
globalThis.window = { addEventListener() {}, dispatchEvent() {}, scrollTo() {} };
globalThis.location = { hash: '#/deck/x', href: '' };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const store = await import('../js/store.js');
const lv = await import('../js/levels.js');
const ls = await import('../js/levelstats.js');
const testMod = await import('../js/test.js');
const ui = await import('../js/ui.js');
const decks = await import('../js/decks.js'); // 注册 level-retry 等动作

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.error('  ✗ ' + m); } };

/** 触发一次 data-action（走真实的事件委托） */
function act(action, data = {}) {
  const el = {
    dataset: { action, ...data },
    classList: { add() {}, remove() {}, contains: () => false },
    closest: (sel) => (sel === '#view' ? ROOT : null)
  };
  ui.handleEvent({ type: 'click', target: { closest: () => el }, preventDefault() {} });
}
const readTestSession = () => {
  const raw = mem['mycard-test-session'];
  return raw ? JSON.parse(raw) : null;
};
/** 触发一次键盘按键（走真实的 document keydown 监听） */
const key = (ev) => keyHandlers.forEach((fn) => fn({ preventDefault() {}, repeat: false, target: globalThis.document.body, ...ev }));
/** 在填空输入框内按 Enter（触发输入框自身的 keydown） */
const pressEnter = () => (fakeField._l.keydown || []).forEach((fn) => fn({ key: 'Enter', preventDefault() {}, repeat: false }));
/** 用固定「选择题型」构造第 2 关会话，保证当前题为选择题（用于键盘/高亮断言） */
const seedMcq = () => {
  const qs = testMod.buildQuestions(store.getDeck(deck.id), 1, { types: ['word2def'] });
  mem['mycard-test-session'] = JSON.stringify({ deckId: deck.id, level: 1, questions: qs, pos: 0, correct: 0 });
  testMod.renderTest(ROOT, deck.id, 1);
  return qs;
};
/** 作答当前题（自动适配选择题 / 填空题），返回是否作答 */
const answerCurrent = () => {
  const s = readTestSession();
  if (!s) return false;
  const cur = s.questions[s.pos];
  if (!cur) return false;
  if (cur.type === 'fill') {
    fakeField.value = cur.answer;
    act('test-fill-submit');
  } else {
    const idx = cur.options.findIndex((o) => o.isCorrect);
    act('test-pick', { i: String(idx) });
  }
  return true;
};

console.log('\n[题型比例微调 typesForRetry]');
ok(JSON.stringify(testMod.typesForRetry(0)) === JSON.stringify(['word2def', 'def2word', 'sentence2word', 'fill', 'listen']), '首次测试五种题型等权');
const r1 = testMod.typesForRetry(1);
ok(r1.length === 6 && r1.filter((t) => t === 'word2def').length === 2, '重刷 1 次 → 侧重 word2def');
const r2 = testMod.typesForRetry(2);
ok(r2.filter((t) => t === 'def2word').length === 2, '重刷 2 次 → 侧重 def2word');
const r3 = testMod.typesForRetry(3);
ok(r3.filter((t) => t === 'sentence2word').length === 2, '重刷 3 次 → 侧重 sentence2word');
ok(testMod.typesForRetry(4).filter((t) => t === 'fill').length === 2, '重刷 4 次 → 侧重填空 fill');
ok(testMod.typesForRetry(5).filter((t) => t === 'listen').length === 2, '重刷 5 次 → 侧重听音辨意 listen');
ok(testMod.typesForRetry(6).filter((t) => t === 'word2def').length === 2, '重刷 6 次 → 轮换回 word2def');

console.log('\n[挑战统计 levelstats（sessionStorage）]');
ls.clearLevelStats();
ok(ls.getLevelStats('d1', 0).retries === 0 && ls.getLevelStats('d1', 0).best === null, '初始统计为空');
ls.bumpRetries('d1', 0); ls.bumpRetries('d1', 0);
ok(ls.getLevelStats('d1', 0).retries === 2, '重刷次数累计为 2');
ls.recordScore('d1', 0, 60); ls.recordScore('d1', 0, 80); ls.recordScore('d1', 0, 70);
ok(ls.getLevelStats('d1', 0).best === 80, '最佳成绩取历史最高（80）');
ok(ls.getLevelStats('d1', 1).best === null, '不同关卡互不影响');

console.log('\n[通关即学完 markLevelLearned]');
const deck = store.seedDemoDeck({
  name: '重刷测试',
  levelSize: 20,
  words: Array.from({ length: 40 }, (_, i) => ({
    front: 'word' + i,
    back: '释义' + i,
    example: 'I use word' + i + ' today.',
    exampleZh: '我今天用 word' + i + '。'
  }))
});
ok(!!deck && new Set(deck.cards.map((c) => c.level)).size === 2, '卡组就绪（40 张 / 2 关）');
const lv0 = () => store.getDeck(deck.id).cards.filter((c) => c.level === 0);
const lv1 = () => store.getDeck(deck.id).cards.filter((c) => c.level === 1);
ok(lv0().every((c) => c.lastReview == null), '第 1 关初始均未学习');
store.markLevelLearned(deck.id, 0);
ok(lv0().every((c) => c.lastReview != null), 'markLevelLearned 把第 1 关记为已学');
ok(lv1().every((c) => c.lastReview == null), '不影响第 2 关');
ok(lv.levelState(store.getDeck(deck.id), 0) === 'unlocked', '仅学完未测试 → 第 1 关 unlocked');

console.log('\n[直接测试通过 → 通关（走真实测试流程）]');
testMod.renderTest(ROOT, deck.id, 0);
const sess0 = readTestSession();
ok(!!sess0 && sess0.questions.length === 20, '测试会话建立（20 题）');
for (let guard = 0; guard < 120; guard++) {
  const s = readTestSession();
  if (!s) break;
  if (!s.questions[s.pos]) break;
  answerCurrent(); // 选择题点正确项 / 填空题输入答案
  testMod.renderTest(ROOT, deck.id, 0); // 立即推进（不等自动跳题定时器）
}
ok(readTestSession() === null, '全部答完后测试会话已清除');
const d2 = store.getDeck(deck.id);
ok(d2.passedLevels[0] === true, '第 1 关已写入通关标记');
ok(d2.cards.filter((c) => c.level === 0).every((c) => c.lastReview != null), '第 1 关卡片均为已学');
ok(lv.levelState(d2, 0) === 'passed', '第 1 关状态为 passed');
ok(lv.levelState(d2, 1) === 'unlocked', '第 2 关已解锁');
ok(ls.getLevelStats(deck.id, 0).best === 100, '历史最佳记录为 100');
ok(ROOT.innerHTML.includes('历史最佳') && ROOT.innerHTML.includes('100%'), '结果页展示历史最佳成绩');

console.log('\n[重新挑战 level-retry]');
act('level-retry', { id: deck.id, level: '0' });
const d3 = store.getDeck(deck.id);
ok(d3.passedLevels[0] !== true, '通关标记已清除');
ok(lv.levelState(d3, 1) === 'locked', '第 2 关随之重新锁定');
ok(ls.getLevelStats(deck.id, 0).retries === 1, '重刷次数 +1');
ok(ls.getLevelStats(deck.id, 0).best === 100, '最佳成绩保留（不清零）');
ok(d3.cards.filter((c) => c.level === 0).every((c) => c.lastReview != null), '复习进度保留（未重置为新卡）');
ok(location.hash === `#/test/${deck.id}/0`, '已跳转到该关测试');
ok(readTestSession() === null, '测试会话已清除（题目池重新洗牌）');

console.log('\n[关卡卡渲染：重新挑战按钮 + 成绩提示]');
store.markLevelPassed(deck.id, 0); // 恢复通关状态用于渲染
const deckRoot = mkEl('div');
decks.renderDeck(deckRoot, deck.id);
ok(deckRoot.innerHTML.includes('level-retry'), '已通关关卡显示「重新挑战」按钮');
ok(deckRoot.innerHTML.includes('重新挑战'), '按钮文案正确');
ok(deckRoot.innerHTML.includes('最佳 100%'), '显示历史最佳成绩');
ok(deckRoot.innerHTML.includes('已刷 1 次'), '显示重刷次数');

console.log('\n[翻转记忆页：直接测试入口]');
const review = await import('../js/review.js');
const rRoot = mkEl('div');
review.renderReview(rRoot, deck.id, 1, 'learn');
ok(rRoot.innerHTML.includes('review-direct-test'), 'learn 模式显示「直接测试」入口');
// 构造第 2 关的到期卡片，验证 due 模式不显示该入口
store.markLevelLearned(deck.id, 1);
for (const c of store.getDeck(deck.id).cards.filter((c) => c.level === 1)) {
  store.updateCard(deck.id, c.id, { ...c, due: Date.now() - 1000 });
}
const rRootDue = mkEl('div');
review.renderReview(rRootDue, deck.id, 1, 'due');
ok(rRootDue.innerHTML.includes('review-view'), 'due 模式正常渲染复习界面');
ok(!rRootDue.innerHTML.includes('review-direct-test'), '复习(due)模式不显示「直接测试」');

console.log('\n[测试题键盘作答 A/B/C/D]');
ok(testMod.keyToOptionIndex({ key: 'a' }) === 0, 'A → 第 1 个选项');
ok(testMod.keyToOptionIndex({ key: 'B' }) === 1, 'B → 第 2 个选项（大写亦可）');
ok(testMod.keyToOptionIndex({ key: 'c' }) === 2, 'C → 第 3 个选项');
ok(testMod.keyToOptionIndex({ key: 'D' }) === 3, 'D → 第 4 个选项');
ok(testMod.keyToOptionIndex({ key: 'z' }) === null, '无关按键返回 null');
ok(testMod.keyToOptionIndex({ key: 'Enter' }) === null, 'Enter 不映射为选项');
ok(testMod.keyToOptionIndex({ key: '1' }) === 0, '数字键 1 → 第 1 个选项');
ok(testMod.keyToOptionIndex({ key: '2' }) === 1, '数字键 2 → 第 2 个选项');
ok(testMod.keyToOptionIndex({ key: '4' }) === 3, '数字键 4 → 第 4 个选项');
// 多义多选题最多 5 个选项（4 正确 + 1 干扰）→ E / 5 也需映射
ok(testMod.keyToOptionIndex({ key: 'e' }) === 4, 'E → 第 5 个选项（多选）');
ok(testMod.keyToOptionIndex({ key: '5' }) === 4, '数字键 5 → 第 5 个选项（多选）');
ok(testMod.keyToOptionIndex({ key: '6' }) === null, '数字键 6 不映射选项');

// 键盘作答真实流程：按正确选项对应的字母
testMod.clearTestSession();
seedMcq();
let ks = readTestSession();
ok(!!ks && ks.questions && ks.questions.length > 0, '第 2 关测试会话建立');
const correctIdx = ks.questions[ks.pos].options.findIndex((o) => o.isCorrect);
key({ key: String.fromCharCode(97 + correctIdx) });
ks = readTestSession();
ok(ks.questions[ks.pos].correct === true, '按对应字母 → 该题判为正确');
ok(ks.correct === 1, '正确计数 +1');
const beforeCorrect = ks.correct;
key({ key: 'a' });
key({ key: 'b' });
ks = readTestSession();
ok(ks.correct === beforeCorrect, '本题已作答后按键不再计分（防重复）');
testMod.clearTestSession();

console.log('\n[测试题 ↑↓ 移动高亮 + Enter 确认]');
testMod.clearTestSession();
seedMcq();
key({ key: 'ArrowDown' }); // 启用高亮并移动到第 2 项
key({ key: 'Enter' });     // 确认高亮项
let as = readTestSession();
ok(as.questions[as.pos].lastPicked === 1, '↓ 移动后 Enter → 选中高亮的第 2 项');
testMod.clearTestSession();

seedMcq();
key({ key: 'ArrowUp' });   // 0 → 3（环绕）
key({ key: 'Enter' });
as = readTestSession();
ok(as.questions[as.pos].lastPicked === 3, '↑ 从第 1 项环绕到第 4 项');
testMod.clearTestSession();

console.log('\n[测试题 ←→ 移动高亮 & 作答后 Enter 立即跳题]');
// ←→ 也可移动高亮
testMod.clearTestSession();
seedMcq();
key({ key: 'ArrowRight' }); // 0 → 1
key({ key: 'Enter' });
let rs = readTestSession();
ok(rs.questions[rs.pos].lastPicked === 1, '→ 移动高亮后 Enter → 第 2 项');
testMod.clearTestSession();

seedMcq();
key({ key: 'ArrowLeft' }); // 0 → 3（环绕）
key({ key: 'Enter' });
rs = readTestSession();
ok(rs.questions[rs.pos].lastPicked === 3, '← 从第 1 项环绕到第 4 项');
testMod.clearTestSession();

// 作答后 Enter 立即跳下一题（跳过自动跳题等待）
seedMcq();
rs = readTestSession();
const p0 = rs.pos;
const ci = rs.questions[p0].options.findIndex((o) => o.isCorrect);
key({ key: String.fromCharCode(97 + ci) }); // 答对（展示反馈，停留在本题）
rs = readTestSession();
ok(rs.questions[rs.pos].answered === true && rs.pos === p0, '作答后停留在本题展示反馈');
key({ key: 'Enter' });
rs = readTestSession();
ok(!!rs && rs.pos === p0 + 1, '作答后按 Enter → 立即跳到下一题（不等自动跳题）');
testMod.clearTestSession();

console.log('\n[空格键确认 / 跳题]');
ok(testMod.isConfirmKey({ key: ' ' }) === true, '空格是确认键');
ok(testMod.isConfirmKey({ key: 'Enter' }) === true, 'Enter 是确认键');
ok(testMod.isConfirmKey({ key: 'a' }) === false, '字母不是确认键');
testMod.clearTestSession();
seedMcq();
key({ key: 'ArrowDown' }); // 启用高亮并移动到第 2 项
key({ key: ' ' });         // 空格确认
let sp = readTestSession();
ok(sp.questions[sp.pos].lastPicked === 1, '空格键确认高亮项（第 2 项）');

// 把高亮移到「正确项」后按空格确认（答对）→ 再按空格立即跳题
testMod.clearTestSession();
const smq2 = seedMcq();
const ciS = smq2[0].options.findIndex((o) => o.isCorrect);
key({ key: 'ArrowDown' }); // hlOn = true, hl = 1
let curS = 1;
for (let i = 0; i < 4 && curS !== ciS; i++) {
  key({ key: 'ArrowDown' });
  curS = (curS + 1) % 4;
}
key({ key: ' ' });         // 空格确认正确项
sp = readTestSession();
ok(sp.questions[sp.pos].correct === true, '空格键确认正确项 → 判对');
key({ key: ' ' });         // 已作答 → 空格立即跳题
sp = readTestSession();
ok(!!sp && sp.pos === 1, '作答后按空格 → 立即跳到下一题');
testMod.clearTestSession();

console.log('\n[纯键盘端到端完成一整关]');
store.unmarkLevelPassed(deck.id, 0);
testMod.clearTestSession();
testMod.renderTest(ROOT, deck.id, 0);
let e2e = readTestSession();
const totalQ = e2e.questions.length;
ok(totalQ > 0, `第 1 关共 ${totalQ} 题`);
let answeredN = 0;
for (let guard = 0; guard < 120; guard++) {
  e2e = readTestSession();
  if (!e2e) break;
  const cur = e2e.questions[e2e.pos];
  if (!cur) break;
  if (cur.type === 'fill') {
    fakeField.value = cur.answer; // 输入正确答案
    pressEnter();                 // 输入框内 Enter 提交
  } else {
    const ci2 = cur.options.findIndex((o) => o.isCorrect);
    key({ key: String.fromCharCode(97 + ci2) }); // 字母作答
  }
  key({ key: 'Enter' }); // 立即跳题
  answeredN++;
}
ok(answeredN === totalQ, `键盘答完全部 ${totalQ} 题`);
ok(readTestSession() === null, '全部答完后测试会话结束');
const dEnd = store.getDeck(deck.id);
ok(dEnd.passedLevels[0] === true, '第 1 关通过（纯键盘完成）');
ok(lv.levelState(dEnd, 0) === 'passed', '第 1 关状态为 passed');
ok(ls.getLevelStats(deck.id, 0).best === 100, '历史最佳 100%');
ok(ROOT.innerHTML.includes('关卡通关') && ROOT.innerHTML.includes('100%'), '结果页展示通关与 100%');

console.log(`\n关卡重刷结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
