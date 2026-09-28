#!/usr/bin/env node
// ============================================================================
// test-deck-test.mjs — 整卡组可配置测试（20~150 题）测试
//   运行: node scripts/test-deck-test.mjs
// 覆盖：配置（题数/档位/权重）、抽题（无重复 / 循环覆盖 / 间隔 / 优先换题型）、
//       优先池 50% 配额、优先池快路径（词数 ≥ 题数时不变量）、判分与通关、进度续做、
//       边界（<20 词禁用）、结果页与错题列表。
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
    children: [],
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
    setPointerCapture() {}, releasePointerCapture() {}, focus() {}, remove() {}, setAttribute() {},
    appendChild(c) { this.children.push(c); return c; }
  };
}

const ROOT = mkEl('div');
ROOT.closest = (sel) => (sel === '#view' ? ROOT : null);
const fakeField = { value: '', _l: {}, addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); }, focus() {} };
globalThis.document = {
  body: mkEl('body'),
  documentElement: mkEl(),
  addEventListener() {},
  removeEventListener() {},
  querySelector: (sel) => (sel === '.fill-field' ? fakeField : null),
  querySelectorAll: () => [],
  getElementById: (id) => (id === 'view' || id === 'deck-test-count-val' ? ROOT : null),
  createElement: (t) => mkEl(t)
};
globalThis.window = { addEventListener() {}, dispatchEvent() {}, scrollTo() {} };
globalThis.location = { hash: '#/test/x', href: '' };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const store = await import('../js/store.js');
const cfg = await import('../js/test-config.js');
const engine = await import('../js/test-engine.js');
const testMod = await import('../js/test.js');
const ui = await import('../js/ui.js');
await import('../js/decks.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.error('  ✗ ' + m); } };
const act = (action, data = {}, opts = {}) => {
  const el = {
    dataset: { action, ...data },
    value: opts.value,
    classList: { add() {}, remove() {}, contains: () => false },
    closest: (s) => (s === '#view' ? ROOT : null)
  };
  ui.handleEvent({ type: opts.type || 'click', target: { closest: () => el }, preventDefault() {} });
};
const readProg = (deckId, kind = 'deck') => engine.loadProgress(deckId, kind);

/** 造一个 words 词的卡组（真实入库，可创建多个） */
let seqNo = 0;
function makeDeck(words) {
  const n = ++seqNo;
  const deck = store.createDeck({ name: '测试卡组' + n });
  store.addManyCards(
    deck.id,
    Array.from({ length: words }, (_, i) => ({
      front: 'w' + n + '_' + i,
      back: '释义' + n + '_' + i,
      example: 'I use w' + n + '_' + i + ' today.',
      exampleZh: '例句' + i
    }))
  );
  return store.getDeck(deck.id);
}

console.log('\n[配置 test-config]');
ok(cfg.DEFAULT_QUESTIONS === 50, '默认题数 50');
ok(cfg.MIN_QUESTIONS === 20 && cfg.MAX_QUESTIONS === 150 && cfg.STEP_QUESTIONS === 10, '范围 20~150，步长 10');
ok(cfg.PRESETS.map((p) => p.count).join(',') === '20,50,150', '档位：快速20 / 标准50 / 挑战150');
ok(cfg.clampCount(5) === 20 && cfg.clampCount(999) === 150, '题数越界被夹在 20~150');
ok(cfg.clampCount(53) === 50 && cfg.clampCount(58) === 60, '题数按步长 10 取整');
const saved = cfg.saveConfig({ count: 150 });
ok(cfg.loadConfig().count === 150, '配置持久化（题数）');
ok(JSON.stringify(saved.weights) === JSON.stringify(cfg.DEFAULT_WEIGHTS), '默认题型权重：5 种各 20');
cfg.saveConfig({ count: 50 });

console.log('\n[题型分配 allocateTypes]');
const t50 = engine.allocateTypes(50, cfg.DEFAULT_WEIGHTS);
ok(t50.length === 50, '50 题按 20% 分配');
ok(cfg.QUESTION_TYPES.every((t) => t50.filter((x) => x === t).length === 10), '5 种题型各 10 道');
const t150 = engine.allocateTypes(150, cfg.DEFAULT_WEIGHTS);
ok(cfg.QUESTION_TYPES.every((t) => t150.filter((x) => x === t).length === 30), '150 题时每种 30 道');
const tCustom = engine.allocateTypes(100, { word2def: 50, def2word: 50, sentence2word: 0, fill: 0, listen: 0 });
ok(tCustom.filter((t) => t === 'word2def').length === 50 && tCustom.filter((t) => t === 'def2word').length === 50, '自定义权重生效');

console.log('\n[题型权重 adjustWeights：合计恒为 100]');
const w1 = cfg.adjustWeights(cfg.DEFAULT_WEIGHTS, 'listen', 40);
ok(w1.listen === 40, '被调题型 = 40%');
ok(cfg.QUESTION_TYPES.reduce((s, t) => s + w1[t], 0) === 100, '合计仍为 100%');
ok(w1.word2def === 15 && w1.def2word === 15 && w1.sentence2word === 15 && w1.fill === 15, '其余题型按比例分摊为 15%');
const w2 = cfg.adjustWeights(cfg.DEFAULT_WEIGHTS, 'fill', 100);
ok(w2.fill === 100 && cfg.QUESTION_TYPES.reduce((s, t) => s + w2[t], 0) === 100, '某项 100% 时其余归 0 且合计 100%');

console.log('\n[同词优先换题型 assignTypesByCard]');
const at = engine.assignTypesByCard(['a', 'a', 'a'], ['word2def', 'def2word', 'fill'], () => 0);
ok(new Set(at).size === 3, '同词连续 3 次 → 题型互不相同');
const at2 = engine.assignTypesByCard(['a', 'a', 'a', 'a'], ['word2def', 'word2def', 'fill', 'fill'], () => 0);
ok(at2[0] !== at2[1] && at2[1] !== at2[2] && at2[2] !== at2[3], '题型用尽后仍避免相邻重复');

console.log('\n[抽题：词数 ≥ N（50 题 / 200 词）→ 无重复]');
const deck200 = makeDeck(200);
const plan50 = engine.samplePlan(deck200, { count: 50, weights: cfg.DEFAULT_WEIGHTS });
ok(plan50.length === 50, '生成 50 题');
ok(new Set(plan50.map((p) => p.cardId)).size === 50, '50 题对应 50 个不同词（无重复）');
const c50 = {};
plan50.forEach((p) => { c50[p.type] = (c50[p.type] || 0) + 1; });
ok(cfg.QUESTION_TYPES.every((t) => c50[t] === 10), '5 种题型各 10 道');

console.log('\n[抽题：词数 < N（150 题 / 20 词）→ 循环覆盖 + 间隔]');
const deck20 = makeDeck(20);
const plan150 = engine.samplePlan(deck20, { count: 150, weights: cfg.DEFAULT_WEIGHTS });
ok(plan150.length === 150, '生成 150 题');
const per = {};
const posOf = {};
plan150.forEach((p, i) => {
  per[p.cardId] = (per[p.cardId] || 0) + 1;
  (posOf[p.cardId] = posOf[p.cardId] || []).push(i);
});
ok(Object.keys(per).length === 20, '覆盖全部 20 个词（每词至少一次）');
const minCount = Math.min(...Object.values(per));
ok(minCount >= 7, `每个词至少出现 7 次（实际最少 ${minCount} 次）`);
let gapOk = true;
for (const id of Object.keys(posOf)) {
  for (let k = 1; k < posOf[id].length; k++) if (posOf[id][k] - posOf[id][k - 1] < 7) gapOk = false;
}
ok(gapOk, '同一词两次出现间隔 ≥ 7 题');

console.log('\n[优先池：约 50% 配额]');
engine.clearPriority(deck20.id);
const wrongPool = [...new Set(plan150.slice(0, 8).map((p) => p.cardId))].slice(0, 4);
engine.recordWrong(deck20.id, wrongPool);
ok(engine.priorityCount(deck20.id) === wrongPool.length, '错题写入优先池');
const planPrio = engine.samplePlan(deck20, { count: 100, weights: cfg.DEFAULT_WEIGHTS, priorityIds: engine.getPriorityIds(deck20.id) });
const prioHit = planPrio.filter((p) => wrongPool.includes(p.cardId)).length;
ok(prioHit >= 40, `优先池题目约占 50%（实际 ${prioHit}/100）`);
engine.clearPriority(deck20.id);
ok(engine.priorityCount(deck20.id) === 0, '优先池可清空');

console.log('\n[优先池快路径：词数 ≥ 题数（非优先槽位走部分洗牌）]');
{
  const big = makeDeck(300);
  const prioIds = big.cards.slice(0, 20).map((c) => c.id);
  const prioSet = new Set(prioIds);
  const lcg = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const COUNT = 100;
  const seq = engine.buildCardSequence(big.cards, COUNT, prioSet, lcg(21));
  ok(seq.length === COUNT, `生成 ${COUNT} 题`);
  const counts = new Map();
  for (const id of seq) counts.set(id, (counts.get(id) || 0) + 1);
  const prioHit = seq.filter((id) => prioSet.has(id)).length;
  // 引擎的优先槽位配额：min(floor(n/2), n)（不因池小于配额而减少，池小时重复出题）
  const prioCap = Math.min(Math.floor(COUNT / 2), COUNT); // 50
  ok(prioHit >= prioCap, `优先槽位全部命中错题池（${prioHit} ≥ ${prioCap}）`);
  ok(
    prioHit <= prioCap + prioIds.length,
    `错题命中 ≤ 优先槽位 + 池内词数（${prioHit} ≤ ${prioCap + prioIds.length}；非优先槽位最多再各带 1 个错题）`
  );
  const repeated = [...counts].filter(([, c]) => c > 1).map(([id]) => id);
  ok(repeated.every((id) => prioSet.has(id)), '只有优先池的词可能重复（非优先槽位永远取未用过的词）');

  const s1 = engine.buildCardSequence(big.cards, COUNT, prioSet, lcg(21));
  ok(JSON.stringify(s1) === JSON.stringify(seq), '同一随机源 → 序列完全一致（可复现）');

  // 池内仅 1 词：该词被 10 个优先槽位重复取用（10 次），其余 10 个非优先槽位各取一个未用过的词
  const soloId = big.cards[0].id;
  const solo = new Set([soloId]);
  const s3 = engine.buildCardSequence(big.cards, 20, solo, lcg(9));
  const soloCount = s3.filter((id) => id === soloId).length;
  const soloPrioCap = Math.min(Math.floor(20 / 2), 20); // 10
  ok(s3.length === 20, '池内仅 1 词：仍取满 20 题');
  ok(
    soloCount >= soloPrioCap && soloCount <= soloPrioCap + 1,
    `唯一错题出现 ${soloCount} 次（≈ 优先槽位数 ${soloPrioCap}，非优先槽位最多再取 1 次）`
  );
  ok(
    s3.filter((id) => id !== soloId).every((id) => s3.filter((x) => x === id).length === 1),
    '其余词各出现且仅出现一次'
  );

  const small = big.cards.slice(0, 20);
  const sp = new Set(small.slice(0, 8).map((c) => c.id));
  const s4 = engine.buildCardSequence(small, 20, sp, lcg(11));
  ok(s4.length === 20 && new Set(s4).size >= 20 - 10, `词数 === 题数（带 8 题优先池）→ 取满 20 题，重复只可能来自错题（不同词 ${new Set(s4).size}）`);

  const planFast = engine.samplePlan(big, { count: COUNT, weights: cfg.DEFAULT_WEIGHTS, priorityIds: prioSet, random: lcg(31) });
  const hitFast = planFast.filter((p) => prioSet.has(p.cardId)).length;
  ok(planFast.length === COUNT, `samplePlan 生成 ${COUNT} 题`);
  ok(hitFast >= prioCap && hitFast <= prioCap + prioIds.length, `优先池配额仍约 50%（实际 ${hitFast}/${COUNT}，优先槽位 ${prioCap}）`);
  engine.clearPriority(big.id);
}

console.log('\n[判分与通关]');
ok(engine.isPassed(85) === true && engine.isPassed(80) === true, '≥80% 通关');
ok(engine.isPassed(60) === false, '<80% 未通关');
const fakeQ = (n, correctN) => Array.from({ length: n }, (_, i) => ({ cardId: 'c' + i, answered: true, correct: i < correctN }));
const sum85 = engine.summarize(fakeQ(20, 17));
ok(sum85.pct === 85 && sum85.passed === true, '85% → 通关（17/20）');
const sum60 = engine.summarize(fakeQ(20, 12));
ok(sum60.pct === 60 && sum60.passed === false && sum60.wrongIds.length === 8, '60% → 未通关 + 8 道错题');

console.log('\n[进度：中途退出续做]');
const deck40 = makeDeck(40);
engine.saveProgress(deck40.id, { deckId: deck40.id, mode: 'deck', count: 40, questions: [{ cardId: 'x' }], pos: 1, correct: 0 });
ok(!!engine.loadProgress(deck40.id), '进度写入 localStorage');
ok(engine.progressKey(deck40.id) === 'test_progress_' + deck40.id, '进度 key = test_progress_{deckId}');
engine.clearProgress(deck40.id);
ok(engine.loadProgress(deck40.id) === null, '进度可清除');

console.log('\n[配置页：≥20 词可开启 / <20 词禁用]');
const d15 = makeDeck(15);
ROOT.innerHTML = '';
testMod.renderDeckTestConfig(ROOT, d15.id);
ok(ROOT.innerHTML.includes('至少需要 20 个词才能开始测试'), '15 词 → 提示至少需要 20 个词');
ok(ROOT.innerHTML.includes('disabled'), '15 词 → 滑块与按钮禁用');
ok(!ROOT.innerHTML.includes('deck-test-start'), '15 词 → 无开始按钮');

const d20 = makeDeck(20);
ROOT.innerHTML = '';
testMod.renderDeckTestConfig(ROOT, d20.id);
ok(ROOT.innerHTML.includes('deck-test-start'), '20 词 → 显示「开始测试」');
ok(ROOT.innerHTML.includes('type="range"') && ROOT.innerHTML.includes('min="20"') && ROOT.innerHTML.includes('max="150"'), '滑块范围固定 20~150');
ok(ROOT.innerHTML.includes('快速') && ROOT.innerHTML.includes('标准') && ROOT.innerHTML.includes('挑战'), '预设档位：快速/标准/挑战');
ok(ROOT.innerHTML.includes('weight-box') && ROOT.innerHTML.includes('题型比例'), '含题型比例编辑面板');
ok(ROOT.innerHTML.includes('weight-box" open'), '题型比例面板默认展开');
ok(ROOT.innerHTML.includes('deck-test-weight-reset'), '含「恢复默认」按钮');
ok((ROOT.innerHTML.match(/data-action="deck-test-weight"/g) || []).length === 5, '5 个题型权重滑块');
ok(ROOT.innerHTML.includes('id="wt-total">100%'), '权重合计显示 100%');

act('deck-test-weight', { type: 'listen', id: d20.id }, { value: 40, type: 'input' });
const wconf = cfg.loadConfig();
ok(wconf.weights.listen === 40, '拖动滑块 → listen 40%');
ok(cfg.QUESTION_TYPES.reduce((s, t) => s + wconf.weights[t], 0) === 100, '保存后合计仍 100%');
ok(wconf.weights.word2def === 15, '其余题型自动分摊为 15%');

cfg.saveConfig({ weights: cfg.adjustWeights(cfg.DEFAULT_WEIGHTS, 'fill', 60) });
ok(cfg.loadConfig().weights.fill === 60, '先改为 fill 60%');
act('deck-test-weight-reset', { id: d20.id });
const wReset = cfg.loadConfig().weights;
ok(cfg.QUESTION_TYPES.every((t) => wReset[t] === 20), '点「恢复默认」→ 各 20%');

console.log('\n[开始测试：20 词可选 150 题 + 逐题作答]');
ROOT.innerHTML = '';
testMod.renderDeckTestConfig(ROOT, d20.id);
act('deck-test-start', { id: d20.id, count: '150' });
let prog = readProg(d20.id);
ok(!!prog && prog.questions.length === 150, '20 词可选 150 题（正常启动）');
ok(ROOT.innerHTML.includes('第 1 / 150 题'), '进入答题并显示「第 1 / 150 题」');
const answerCorrect = () => {
  const s = readProg(d20.id);
  if (!s) return false;
  const q = s.questions[s.pos];
  if (!q) return false;
  if (q.type === 'fill') {
    fakeField.value = q.answer;
    act('test-fill-submit');
  } else {
    act('test-pick', { i: String(q.options.findIndex((o) => o.isCorrect)) });
  }
  return true;
};
answerCorrect();
prog = readProg(d20.id);
ok(prog.questions[0].correct === true, '答对第 1 题（进度已保存）');
testMod.renderTest(ROOT, d20.id, null); // 立即推进（不等自动跳题）
prog = readProg(d20.id);
ok(prog.pos === 1, '推进到第 2 题');

console.log('\n[中途退出 → 再次进入提示继续]');
ROOT.innerHTML = '';
testMod.renderDeckTestConfig(ROOT, d20.id);
const bodyHtml = (globalThis.document.body.children || []).map((el) => String(el.innerHTML)).join('');
ok(bodyHtml.includes('继续上次测试'), '检测到未完成进度 → 弹窗「继续上次测试？」');
ok(bodyHtml.includes('重新开始') && bodyHtml.includes('继续'), '弹窗提供「继续 / 重新开始」');

console.log('\n[结果页：通关 / 未通关 + 错题列表]');
const dRes = makeDeck(30);
const mkFinished = (deckId, n, correctN, kind = 'deck') => {
  const qs = engine.samplePlan(store.getDeck(deckId), { count: n, weights: cfg.DEFAULT_WEIGHTS }).map((p, i) => ({
    cardId: p.cardId,
    type: 'word2def',
    options: [],
    answered: true,
    correct: i < correctN,
    attempts: 1,
    wrongPicks: [],
    lastPicked: 0
  }));
  engine.saveProgress(
    deckId,
    {
      deckId,
      mode: kind === 'wrong' ? 'wrong' : 'deck',
      level: null,
      count: n,
      questions: qs,
      pos: n,
      correct: correctN,
      startedAt: Date.now(),
      lastTick: Date.now(),
      elapsedMs: 65000
    },
    kind
  );
};
engine.clearPriority(dRes.id);
mkFinished(dRes.id, 20, 17);
ROOT.innerHTML = '';
testMod.renderTest(ROOT, dRes.id, null);
ok(ROOT.innerHTML.includes('通关！'), '85% → 显示「通关！」');
ok(ROOT.innerHTML.includes('85%') && ROOT.innerHTML.includes('用时 1 分 5 秒'), '显示正确率与用时');
ok(engine.priorityCount(dRes.id) === 3, '3 道错题写入优先池');
ok(engine.loadProgress(dRes.id) === null, '完成后清除续做进度');

engine.clearPriority(dRes.id);
mkFinished(dRes.id, 20, 12);
ROOT.innerHTML = '';
testMod.renderTest(ROOT, dRes.id, null);
ok(ROOT.innerHTML.includes('再练一次') && ROOT.innerHTML.includes('未达标'), '60% → 显示「再练一次」+ 未达标');
ok(ROOT.innerHTML.includes('deck-wrong-list') && ROOT.innerHTML.includes('错题 8 道'), '显示错题列表（8 道）');
ok(ROOT.innerHTML.includes('deck-test-again'), '提供「再练一次」按钮');
ok(ROOT.innerHTML.includes('deck-test-wrong') && ROOT.innerHTML.includes('错题专项再练'), '结果页提供「错题专项再练」入口');
ok(engine.priorityCount(dRes.id) === 8, '8 道错题进入优先池');

console.log('\n[错题专项再练：只出优先池]');
engine.clearProgress(dRes.id, 'deck');
engine.clearProgress(dRes.id, 'wrong');
ROOT.innerHTML = '';
testMod.renderDeckTestConfig(ROOT, dRes.id);
ok(ROOT.innerHTML.includes('优先池：8 道错题'), '配置页显示优先池题数');
act('deck-test-wrong', { id: dRes.id });
const wp = readProg(dRes.id, 'wrong');
ok(!!wp && wp.questions.length === 8, '错题专项只出 8 道错题');
const prioSet = engine.getPriorityIds(dRes.id);
ok(wp.questions.every((q) => prioSet.has(q.cardId)), '题目全部来自优先池');
engine.clearProgress(dRes.id, 'deck');
engine.clearProgress(dRes.id, 'wrong');

console.log('\n[错题专项：独立进度续做]');
const dW = makeDeck(30);
engine.clearPriority(dW.id);
engine.recordWrong(dW.id, store.getDeck(dW.id).cards.slice(0, 3).map((c) => c.id));
ROOT.innerHTML = '';
testMod.renderDeckTestConfig(ROOT, dW.id);
act('deck-test-wrong', { id: dW.id });
ok(engine.progressKey(dW.id, 'wrong') === 'test_progress_' + dW.id + '__wrong', '错题专项进度键带 __wrong 后缀');
ok(!!engine.loadProgress(dW.id, 'wrong'), '错题专项进度已保存');
ok(engine.loadProgress(dW.id, 'deck') === null, '常规测试进度未被写入');

engine.saveProgress(
  dW.id,
  { deckId: dW.id, mode: 'deck', level: null, count: 20, questions: [{ cardId: 'x', answered: true }], pos: 0, correct: 0 },
  'deck'
);
ok(!!engine.loadProgress(dW.id, 'deck') && !!engine.loadProgress(dW.id, 'wrong'), '两套进度互不覆盖');

globalThis.document.body.children.length = 0;
ROOT.innerHTML = '';
testMod.renderDeckTestConfig(ROOT, dW.id);
const bh2 = globalThis.document.body.children.map((el) => String(el.innerHTML)).join('');
ok(bh2.includes('常规测试') && bh2.includes('错题专项'), '弹窗同时列出常规测试与错题专项');
ok(bh2.includes('继续错题专项') && bh2.includes('继续上次测试'), '提供「继续错题专项 / 继续上次测试」两个入口');

testMod.resumeDeckTest(dW.id, 'wrong');
const wp2 = engine.loadProgress(dW.id, 'wrong');
ok(!!wp2 && wp2.mode === 'wrong', '继续错题专项 → 会话模式为 wrong');
ok(ROOT.innerHTML.includes('第 1 / 3 题'), '错题专项答题界面正常渲染（3 题）');

// 错题专项结算：只清错题专项进度，常规进度保留；「再练一次」仍在错题专项
mkFinished(dW.id, 3, 1, 'wrong');
ROOT.innerHTML = '';
testMod.renderTest(ROOT, dW.id, null, { kind: 'wrong' });
ok(ROOT.innerHTML.includes('错题专项 · '), '错题专项结算页标题带「错题专项」标识');
ok(ROOT.innerHTML.includes('data-action="deck-test-wrong"'), '错题专项「再练一次」仍走错题专项');
ok(!ROOT.innerHTML.includes('data-action="deck-test-again"'), '不出现常规「再练一次」按钮');
ok(engine.loadProgress(dW.id, 'wrong') === null, '结算后清除错题专项进度');
ok(!!engine.loadProgress(dW.id, 'deck'), '常规测试进度不受错题专项影响');

engine.clearProgress(dW.id, 'deck');
engine.clearProgress(dW.id, 'wrong');

console.log(`\n整卡组测试结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
