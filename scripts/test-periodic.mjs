#!/usr/bin/env node
// ============================================================================
// test-periodic.mjs — 内置中文元素周期表（v0.15.0）
//   运行: node scripts/test-periodic.mjs
// 覆盖：数据完整性（118 种元素 / 中文名 / 缩写 · 全名 / 原子序号 / 中文简介）/
//       背面 2、背面 3 字段全链路（播种 / 编辑 / 同步 / 导出 / 导入别名）/
//       9 种专属题型 / 可选题默认关闭 / 范围拆卡组 / 多卡组补简介 / 配置页
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
const lang = await import('../js/lang.js');
const periodic = await import('../js/periodic.js');
const engine = await import('../js/test-engine.js');
const testMod = await import('../js/test.js');

let pass = 0;
let fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

/* ==========================================================================
 * ① 数据文件
 * ========================================================================== */

const payload = JSON.parse(read('data/periodic-table.json'));
const words = Array.isArray(payload.words) ? payload.words : [];

console.log('\n[数据：118 种元素]');
ok(words.length === 118, '恰好 118 种元素', words.length);
ok(
  words.every((w, i) => w && w.front && w.back2 === '原子序号：' + (i + 1)),
  '每种元素都有中文名，且背面 2 为连续的原子序号 1–118'
);
ok(
  words.every((w) => /^[A-Z][a-z]? · [A-Z][a-z]+$/.test(w.back)),
  '背面统一为「缩写 · 英文全名」格式',
  words.find((w) => !/^[A-Z][a-z]? · [A-Z][a-z]+$/.test(w.back))
);
ok(new Set(words.map((w) => w.front)).size === 118, '中文名无重复');
ok(new Set(words.map((w) => w.back)).size === 118, '英文缩写 / 全名无重复');
ok(
  words.every((w) => Array.isArray(w.tags) && w.tags.includes('元素周期表')),
  '每种元素都带「元素周期表」标签'
);
ok(
  words.every((w) => typeof w.back3 === 'string' && w.back3.trim().length >= 8 && w.back3.trim().length <= 80),
  '每种元素都有背面 3 中文简介（8–80 字）',
  words.find((w) => !w.back3 || w.back3.trim().length < 8)
);
ok(
  words.every((w) => /[。]$/.test(w.back3) && (w.back3.match(/。/g) || []).length === 1 && /[\u3400-\u9fff]/.test(w.back3)),
  '背面 3 均为一句中文（单个句号结尾）'
);
ok(new Set(words.map((w) => w.back3)).size === 118, '118 条中文简介互不重复');

const spot = (n) => words[n - 1];
ok(spot(1).front === '氢' && spot(1).back === 'H · Hydrogen', '第 1 号：氢 / H · Hydrogen');
ok(spot(1).back3.startsWith('宇宙中最丰富的元素'), '第 1 号简介：宇宙中最丰富的元素', spot(1).back3);
ok(spot(26).front === '铁' && spot(26).back === 'Fe · Iron', '第 26 号：铁 / Fe · Iron');
ok(spot(47).front === '银' && spot(47).back === 'Ag · Silver', '第 47 号：银 / Ag · Silver');
ok(spot(79).front === '金' && spot(79).back === 'Au · Gold', '第 79 号：金 / Au · Gold');
ok(spot(82).front === '铅' && spot(82).back === 'Pb · Lead', '第 82 号：铅 / Pb · Lead');
ok(spot(118).front === '鿫' && spot(118).back === 'Og · Oganesson', '第 118 号：鿫 / Og · Oganesson');
ok(spot(118).back3.includes('原子序数最大'), '第 118 号简介：已知原子序数最大的元素', spot(118).back3);
ok(words.slice(0, 103).every((w) => /^[\u3400-\u9fff\uf900-\ufaff]$/.test(w.front)), '1–103 号中文名均为单个汉字');
ok(words.slice(103).every((w) => /^[\u3400-\u9fff\uf900-\ufaff\u{20000}-\u{2ffff}]$/u.test(w.front)), '104–118 号使用扩展区汉字（𬬻 / 鿫 等）');

/* ==========================================================================
 * ② 播种：按原子序号拆关，背面 2 / 背面 3 完整落库
 * ========================================================================== */

console.log('\n[播种与字段]');
const deck = store.seedBuiltinDeck(payload, {
  demo: false,
  source: 'periodic',
  arrange: false, // 与 decks.importPeriodicDeck 一致
  meta: { name: payload.name, description: payload.description, tags: payload.tags, lang: 'zh', levelSize: payload.levelSize }
});
ok(!!deck && deck.cards.length === 118, '导入 118 张卡片', deck && deck.cards.length);
ok(deck.name === '元素周期表（中文）' && deck.source === 'periodic' && !deck.demo, '卡组名 / source / 非示范标记');
ok(deck.description.includes('背面 2 为原子序号') && deck.description.includes('背面 3 为中文简介'), '卡组描述说明四个字段');
ok(deck.cards[0].front === '氢' && deck.cards[0].back === 'H · Hydrogen' && deck.cards[0].back2 === '原子序号：1', '首卡三字段正确', deck.cards[0]);
ok(deck.cards[0].back3 === spot(1).back3, '首卡带背面 3 中文简介', deck.cards[0].back3);
ok(deck.cards[117].front === '鿫' && deck.cards[117].back2 === '原子序号：118', '末卡为第 118 号元素', deck.cards[117]);
ok(deck.cards[117].back3 === spot(118).back3, '末卡带背面 3 中文简介', deck.cards[117].back3);
ok(deck.cards.every((c) => c.back2), '所有卡片都带背面 2');
ok(deck.cards.every((c) => c.back3), '所有卡片都带背面 3');
ok(deck.cards.every((c) => c.tags.includes('元素周期表')), '卡片保留标签');

const levelCount = new Set(deck.cards.map((c) => c.level)).size;
ok(levelCount === 6, '118 张按每关 20 张拆成 6 关', levelCount);
ok(deck.cards[0].level === 0 && deck.cards[117].level === 5, '关卡按原子序号顺序推进（不重排）');
ok(store.hasSource('periodic'), 'hasSource(periodic) = true');
ok(store.getDb().seededPeriodic === true, '播种后 seededPeriodic 置位（删卡组后不会自动重建）');
ok(store.seedBuiltinDeck(payload, { demo: false, source: 'periodic' }) === null, '同一来源重复导入 → 跳过');

console.log('\n[原子序号范围拆分]');
ok(
  periodic.normalizeRange(20, 1).start === 1 && periodic.normalizeRange(20, 1).end === 20,
  '起止写反时自动交换'
);
ok(periodic.normalizeRange(0, 999).start === 1 && periodic.normalizeRange(0, 999).end === 118, '越界夹到 1–118');
const groups20 = periodic.splitRange(1, 118, 20);
ok(groups20.length === 6, '1–118 按每 20 个拆分 → 6 个卡组', groups20);
ok(groups20[0].start === 1 && groups20[0].end === 20 && groups20[5].start === 101 && groups20[5].end === 118, '首尾范围正确');
ok(periodic.splitRange(1, 118, 0).length === 1, 'size=0 → 不拆分（1 个卡组）');
ok(periodic.wordsInRange(words, 1, 20).length === 20, '1–20 号共 20 种元素');
ok(periodic.wordsInRange(words, 1, 20)[0].front === '氢', '范围筛选保持原顺序（首项为氢）');
ok(periodic.wordsInRange(words, 21, 40)[0].front === '钪', '21–40 号首项为钪');

console.log('\n[周期表专属题型与配置]');
ok(periodic.PERIODIC_TYPE_IDS.length === 9, '共 9 种周期表题型');
ok(
  periodic.PERIODIC_MANDATORY_IDS.join(',') === 'zh2symbol,zh2number,symbol2zh,number2zh',
  '4 种必选题型：中文名选缩写 / 中文名选原子序号 / 缩写选中名 / 原子序号选中名'
);
ok(
  periodic.PERIODIC_OPTIONAL_IDS.join(',') === 'zh2desc,desc2zh,listenDesc2zh,zh2enName,enName2zh',
  '5 种可选题型：描述往返 / 听描述 / 英文全名往返'
);
ok(
  periodic.PERIODIC_OPTIONAL_IDS.every((id) => periodic.PERIODIC_DEFAULT_ENABLED[id] === false),
  '可选题型默认全部关闭'
);
const pDefault = periodic.loadConfig();
ok(periodic.enabledTypeIds(pDefault.enabled).length === 4, '默认只启用 4 种必选题型');
ok(periodic.PERIODIC_MANDATORY_IDS.every((id) => pDefault.weights[id] === 25), '默认 4 种必选题各 25%');
ok(periodic.PERIODIC_OPTIONAL_IDS.every((id) => pDefault.weights[id] === 0), '默认可选题权重为 0');
ok(periodic.PERIODIC_TYPE_IDS.reduce((s, id) => s + pDefault.weights[id], 0) === 100, '默认权重合计 100%');
const pOn = periodic.setTypeEnabled(pDefault.weights, pDefault.enabled, 'desc2zh', true);
ok(pOn.enabled.desc2zh === true && pOn.weights.desc2zh === 20, '开启「描述选中名」→ 5 种各 20%');
ok(periodic.PERIODIC_TYPE_IDS.reduce((s, id) => s + pOn.weights[id], 0) === 100, '开启可选题后合计仍为 100%');
const pAdj = periodic.adjustWeights(pOn.weights, 'zh2symbol', 40, pOn.enabled);
ok(pAdj.zh2symbol === 40, '可调整必选题权重 → 40%');
ok(periodic.PERIODIC_TYPE_IDS.reduce((s, id) => s + pAdj[id], 0) === 100, '调整后合计仍为 100%');
const pOff = periodic.setTypeEnabled(pAdj, pOn.enabled, 'desc2zh', false);
ok(pOff.enabled.desc2zh === false && pOff.weights.desc2zh === 0, '关闭可选题 → 权重归 0');
ok(periodic.typesForRetry(1).length === 5, '关卡重刷：某一题型出现两次（4 → 5 题）');
const pRestore = periodic.saveConfig({ weights: pOn.weights, enabled: pOn.enabled });
ok(periodic.typesForRetry(0).length === 5 && pRestore.weights.desc2zh === 20, '开启可选题后关卡题型包含描述题');
let pSeed = 0;
const pRandom = () => (pSeed++ % 5) / 5;
const optionalQs = testMod.buildQuestions(deck, 0, { types: periodic.typesForRetry(0), random: pRandom });
ok(optionalQs.some((q) => q.type === 'desc2zh'), '开启「一句话描述选中文名」后关卡测试确实出该题型');
periodic.saveConfig({ weights: periodic.PERIODIC_DEFAULT_WEIGHTS, enabled: periodic.PERIODIC_DEFAULT_ENABLED });
ok(!periodic.typesForRetry(0).includes('desc2zh'), '恢复默认后可选描述题重新关闭');

const pe = periodic.parseElement(deck.cards[0]);
ok(pe.zh === '氢' && pe.symbol === 'H' && pe.enName === 'Hydrogen' && pe.atomicNumber === '1', '元素字段解析正确', pe);
ok(pe.description === spot(1).back3, '一句话描述解析正确');
ok(periodic.canBuild(deck.cards[0], 'zh2symbol') === true, '必选题数据齐全 → 可出题');
ok(periodic.canBuild(deck.cards[0], 'zh2desc') === true, '有背面 3 → 可出描述题');
ok(periodic.canBuild({ ...deck.cards[0], back3: '' }, 'zh2desc') === false, '缺背面 3 → 不出描述题');
ok(periodic.isPeriodicDeck({ source: null, tags: ['元素周期表'], cards: deck.cards.slice(0, 5) }), 'JSON 回导丢失 source 时，按标签 + 元素字段识别周期表卡组');
ok(!periodic.isPeriodicDeck({ source: null, tags: ['元素周期表'], cards: [{ front: 'x', back: 'y', back2: '' }] }), '仅标签但字段不完整 → 不误判周期表卡组');
const pPools = periodic.buildPools(deck);
ok(pPools.zh.length === 118 && pPools.symbol.length === 118 && pPools.atomicNumber.length === 118, '中文名 / 缩写 / 原子序号池各 118 条');
ok(pPools.enName.length === 118 && pPools.description.length === 118, '英文全名 / 描述池各 118 条');
ok(!pPools.symbol.some((e) => e.text.includes('·')), '缩写池只含缩写，不含「H · Hydrogen」整串');

console.log('\n[9 种周期表题型出题]');
const one = (type) => testMod.buildQuestions(deck, 0, { types: [type], random: () => 0 })[0];
const answerOf = (q) => q.options.find((o) => o.isCorrect).text;
const qSymbol = one('zh2symbol');
ok(qSymbol.type === 'zh2symbol' && qSymbol.prompt === '氢' && answerOf(qSymbol) === 'H', '中文名选缩写：氢 → H');
const qNumber = one('zh2number');
ok(qNumber.type === 'zh2number' && qNumber.prompt === '氢' && answerOf(qNumber) === '1', '中文名选原子序号：氢 → 1');
const qZhDesc = one('zh2desc');
ok(qZhDesc.type === 'zh2desc' && qZhDesc.prompt === '氢' && answerOf(qZhDesc) === spot(1).back3, '中文名选描述：氢 → 第 1 号简介');
const qSymbolZh = one('symbol2zh');
ok(qSymbolZh.type === 'symbol2zh' && qSymbolZh.prompt === 'H' && answerOf(qSymbolZh) === '氢', '缩写选中文名：H → 氢');
const qNumberZh = one('number2zh');
ok(qNumberZh.type === 'number2zh' && qNumberZh.prompt === '1' && answerOf(qNumberZh) === '氢', '原子序号选中文名：1 → 氢');
const qDescZh = one('desc2zh');
ok(qDescZh.type === 'desc2zh' && qDescZh.prompt === spot(1).back3 && answerOf(qDescZh) === '氢', '描述选中文名：简介 → 氢');
const qListen = one('listenDesc2zh');
ok(qListen.type === 'listenDesc2zh' && qListen.speakText === spot(1).back3 && answerOf(qListen) === '氢', '听描述选中文名：朗读简介 → 氢');
ok(read('js/test.js').includes('q.speakText ||') && read('js/test.js').includes('attachListenAudio'), '听描述题自动播放 / 重播都使用 speakText');
const qZhEn = one('zh2enName');
ok(qZhEn.type === 'zh2enName' && qZhEn.prompt === '氢' && answerOf(qZhEn) === 'Hydrogen', '中文名选英文全名：氢 → Hydrogen');
const qEnZh = one('enName2zh');
ok(qEnZh.type === 'enName2zh' && qEnZh.prompt === 'Hydrogen' && answerOf(qEnZh) === '氢', '英文全名选中文名：Hydrogen → 氢');
ok([qSymbol, qNumber, qZhDesc, qSymbolZh, qNumberZh, qDescZh, qListen, qZhEn, qEnZh].every((q) => q.options.length === 4), '每题固定 4 个选项');
ok(
  [qSymbol, qNumber, qSymbolZh, qNumberZh, qZhEn, qEnZh].every((q) => new Set(q.options.map((o) => o.text)).size === 4),
  '选项文本去重（无重复干扰项）'
);
ok(!qSymbol.options.some((o) => o.text.includes('·')), '「中文名选缩写」选项只有元素缩写');
ok(!qNumber.options.some((o) => o.text.startsWith('原子序号：')), '「中文名选原子序号」选项只有数字');
const mandatoryQs = testMod.buildQuestions(deck, 0);
ok(
  mandatoryQs.every((q) => periodic.PERIODIC_MANDATORY_IDS.includes(q.type)),
  '默认关卡测试只出 4 种必选题型'
);
ok(!mandatoryQs.some((q) => periodic.PERIODIC_OPTIONAL_IDS.includes(q.type)), '可选题型默认不出现');
ok(testMod.canBuildType(deck.cards[0], 'zh2symbol') === true, 'canBuildType 识别周期表必选题');
ok(testMod.canBuildType({ ...deck.cards[0], back3: '' }, 'desc2zh') === false, 'canBuildType 识别缺少简介的可选题');
const pPlan = engine.samplePlan(deck, {
  count: 60,
  weights: pDefault.weights,
  types: periodic.enabledTypeIds(pDefault.enabled),
  canType: (card, type) => testMod.canBuildType(card, type)
});
const pQuestions = testMod.buildQuestionsFromPlan(deck, pPlan, null, () => 0);
ok(pPlan.length === 60 && pQuestions.length === 60, '周期表整卡组抽题计划 / 出题各 60 道');
ok(pQuestions.every((q) => periodic.isPeriodicType(q.type)), '整卡组测试只出周期表专属题型');
ok(pQuestions.every((q) => q.options.some((o) => o.isCorrect)), '每道周期表题都有正确选项');

console.log('\n[整卡组测试配置页（周期表）]');
const cfgRoot = fakeEl();
testMod.renderDeckTestConfig(cfgRoot, deck.id);
ok(cfgRoot.innerHTML.includes('中文名选缩写') && cfgRoot.innerHTML.includes('原子序号选中文名'), '配置页展示周期表必选题型');
ok((cfgRoot.innerHTML.match(/data-action="deck-test-weight"/g) || []).length === 4, '默认显示 4 个必选题权重滑块');
ok((cfgRoot.innerHTML.match(/data-action="deck-test-type-toggle"/g) || []).length === 5, '显示 5 个可选题型开关');
ok(cfgRoot.innerHTML.includes('中文名选一句话描述') && cfgRoot.innerHTML.includes('听一句话描述选中文名') && cfgRoot.innerHTML.includes('英文全名选中文名'), '可选题型名称完整');
ok((cfgRoot.innerHTML.match(/weight-name-wide/g) || []).length === 9, '必选 / 可选题长标签都使用加宽样式');
ok(read('css/style.css').includes('.weight-name-wide'), 'CSS 为周期表长题型名提供加宽样式');
ok(cfgRoot.innerHTML.includes('118 种元素'), '卡组规模用「种元素」而不是「词」');
ok(cfgRoot.innerHTML.includes('开始测试'), '周期表卡组可以开始整卡组测试');




console.log('\n[编辑背面 2 / 背面 3]');
const first = deck.cards[0];
store.updateCard(deck.id, first.id, { back2: '原子序号：1 · 第 1 周期', back3: '氢是宇宙中最常见的元素。' });
ok(store.getDeck(deck.id).cards[0].back2 === '原子序号：1 · 第 1 周期', 'updateCard 可写背面 2');
ok(store.getDeck(deck.id).cards[0].back3 === '氢是宇宙中最常见的元素。', 'updateCard 可写背面 3');
store.updateCard(deck.id, first.id, { back2: '', back3: '' });
ok(store.getDeck(deck.id).cards[0].back2 === '', '背面 2 可清空');
ok(store.getDeck(deck.id).cards[0].back3 === '', '背面 3 可清空');

console.log('\n[老卡组自动补简介]');
const cleared = store.getDeck(deck.id).cards.map((c) => ({ id: c.id, patch: { back3: '' } }));
store.updateCards(deck.id, cleared);
ok(store.getDeck(deck.id).cards.every((c) => !c.back3), '模拟 v0.11.0 老卡组：全部缺背面 3');
ok(store.backfillBack3(deck.id, words) === 118, 'backfillBack3 一次补齐 118 条简介');
ok(store.getDeck(deck.id).cards.every((c, i) => c.back3 === words[i].back3), '简介按正面（中文名）正确对应');
ok(store.backfillBack3(deck.id, words) === 0, '已补齐后再调用 → 0（幂等）');
store.updateCard(deck.id, first.id, { back3: '' });
ok(store.backfillBack3(deck.id, words) === 0, '用户清空个别简介时不会再次回填');
ok(store.getDeck(deck.id).cards[0].back3 === '', '用户清空的字段保持为空（不覆盖编辑）');

console.log('\n[测试题型不受背面 2 / 背面 3 影响]');
ok(lang.deckMode(deck) === 'cross', '中文名 ↔ 英文全名 → 跨语种模式');
const pool = testMod.buildOptionPool(deck);
ok(pool.length === 118, '选项池只有 118 条背面（不把原子序号 / 简介当释义）', pool.length);
ok(!pool.some((e) => /原子序号/.test(e.text)), '「原子序号」不会出现在选项里');
ok(!pool.some((e) => /[。]$/.test(e.text)), '中文简介不会出现在选项里');

/* ==========================================================================
 * ③ 代码接线：导入入口 / 自动导入 / 同步与导出
 * ========================================================================== */


console.log('\n[按范围导入 → 多个卡组]');
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => payload });
const decksMod = await import('../js/decks.js');
const beforeDecks = store.getDb().decks.length;
const created = await decksMod.importPeriodicDecks({ start: 1, end: 20, size: 10 });
ok(created === 2, '1–20 按每 10 个拆分 → 创建 2 个卡组', created);
const rangeDecks = store
  .getDb()
  .decks.filter((d) => d.name === '元素周期表 1–10（中文）' || d.name === '元素周期表 11–20（中文）');
ok(rangeDecks.length === 2, '两个范围卡组均已落库', rangeDecks.map((d) => d.name));
ok(store.getDb().decks.length === beforeDecks + 2, '同来源允许创建多个卡组（allowMultiple）');
ok(rangeDecks.every((d) => d.source === 'periodic'), '范围卡组仍标记 source=periodic（走周期表题型）');
const r1 = rangeDecks.find((d) => d.name.includes('1–10'));
const r2 = rangeDecks.find((d) => d.name.includes('11–20'));
ok(r1.cards.length === 10 && r1.cards[0].front === '氢' && r1.cards[9].back2 === '原子序号：10', '1–10 卡组：氢…氖');
ok(r2.cards.length === 10 && r2.cards[0].front === '钠' && r2.cards[9].back2 === '原子序号：20', '11–20 卡组：钠…钙');
ok(r1.description.includes('原子序号 1–10') && r1.description.includes('共 10 种元素'), '卡组描述写入范围与规模');
ok(r1.cards.every((c) => c.back3) && r2.cards.every((c) => c.back3), '范围卡组保留一句话描述');

// 多卡组补齐背面 3：先清空两个范围卡组，再一次补齐
for (const d of [r1, r2]) {
  store.updateCards(d.id, store.getDeck(d.id).cards.map((c) => ({ id: c.id, patch: { back3: '' } })));
}
ok(store.getDeck(r1.id).cards.every((c) => !c.back3), '模拟多个老周期表卡组（全部缺简介）');
const fixed = await decksMod.ensurePeriodicBack3();
ok(!!fixed, 'ensurePeriodicBack3 返回补齐后的卡组');
ok(store.getDeck(r1.id).cards.every((c) => c.back3) && store.getDeck(r2.id).cards.every((c) => c.back3), '多个范围卡组一次性全部补齐简介');
ok(store.getDeck(r1.id).cards[0].back3 === spot(1).back3, '范围卡组按中文名正确匹配简介');
ok((await decksMod.importPeriodicDeck()) === null, '兼容入口 importPeriodicDeck 仍按 source 去重（不会无意重复导入）');

console.log('\n[导入入口与自动导入]');
const decksSrc = read('js/decks.js');
ok(/export async function importPeriodicDecks\(/.test(decksSrc) && /export async function importPeriodicDeck\(/.test(decksSrc), 'decks.js 暴露范围导入 importPeriodicDecks() 与兼容入口 importPeriodicDeck()');
ok(decksSrc.includes('allowMultiple: true') && read('js/store.js').includes('allowMultiple = false'), '播种支持同来源多卡组（范围拆分）');
ok(decksSrc.includes('id="periodic-start"') && decksSrc.includes('id="periodic-end"') && decksSrc.includes('id="periodic-size"'), '范围导入弹窗含起止序号 / 每卡组数量');
ok(decksSrc.includes('data-action="import-periodic-range"') && decksSrc.includes('periodicImportModal()'), '周期表卡组菜单可继续按范围导入');
ok(decksSrc.includes("fetch('./data/periodic-table.json'"), '从 data/periodic-table.json 读取');
ok(decksSrc.includes("source: 'periodic'") && decksSrc.includes('arrange: false'), '以 source=periodic、按序号顺序播种');
ok(decksSrc.includes('export async function ensurePeriodicDeck'), '提供 ensurePeriodicDeck()');
ok(decksSrc.includes('export async function ensurePeriodicBack3'), '提供 ensurePeriodicBack3()（为老卡组补简介）');
ok(decksSrc.includes('backfillPeriodicBack3') && decksSrc.includes('store.backfillBack3'), '仅补齐缺失的背面 3（不覆盖已有内容）');
ok(decksSrc.includes('data-action="import-periodic"'), '首页有「导入元素周期表」入口');
ok(decksSrc.includes("on('import-periodic'"), '注册 import-periodic 点击动作');

const appSrc = read('js/app.js');
ok(appSrc.includes('ensurePeriodicDeck()') && appSrc.includes('seededPeriodic'), '启动时按 seededPeriodic 自动导入');
ok(appSrc.includes('ensurePeriodicBack3()'), '已导入过时启动自动补齐背面 3');
ok(/APP_VERSION = 'v0\.16\.0'/.test(appSrc), 'APP_VERSION = v0.16.0');

const storeSrc = read('js/store.js');
ok(storeSrc.includes('back2: String(c.back2') && storeSrc.includes('back3: String(c.back3'), 'store 规范化保留背面 2 / 背面 3');
ok(storeSrc.includes("'back3'") && storeSrc.includes("if ('back3' in patch)"), '背面 3 参与内容编辑与更新时间');
ok(storeSrc.includes('export function backfillBack3'), 'store 提供 backfillBack3()（老卡组补简介）');
ok(storeSrc.includes('seededPeriodic'), 'store 持久化 seededPeriodic');
ok(storeSrc.includes("source === 'periodic'"), '播种 periodic 来源时置位标记');

console.log('\n[同步 / 导出 / 导入]');
const syncSrc = read('js/sync.js');
ok(syncSrc.includes('back2: String(c.back2') && syncSrc.includes('back3: String(c.back3'), '多端同步快照包含背面 2 / 背面 3');
const exportSrc = read('js/export.js');
ok(exportSrc.includes('back2: c.back2') && exportSrc.includes('back3: c.back3'), 'JSON 备份包含背面 2 / 背面 3');
ok(exportSrc.includes('ankiHtml(card.back2)') && exportSrc.includes('ankiHtml(card.back3)'), 'Anki 背面附带背面 2 / 背面 3');
const importSrc = read('js/import-file.js');
ok(importSrc.includes("back2: ['back2'") && importSrc.includes('w.back2 ?? w.back_2'), '文件导入识别 back2 / back_2');
ok(importSrc.includes("back3: ['back3'") && importSrc.includes('w.back3 ?? w.back_3'), '文件导入识别 back3 / back_3');
ok(importSrc.includes('背面-3') && importSrc.includes("take('back3')"), 'CSV 表头「背面3 / 背面-3」→ back3');

console.log('\n[界面展示 / SW]');
ok(read('js/review.js').includes('face-back2') && read('js/review.js').includes('face-back3'), '翻转卡片背面显示背面 2 / 背面 3');
ok(read('js/test.js').includes('card.back2') && read('js/test.js').includes('card.back3'), '答题后的完整信息卡显示背面 2 / 背面 3');
ok(decksSrc.includes('card-row-back2') && decksSrc.includes('card-row-back3'), '卡片列表显示背面 2 / 背面 3');
ok(decksSrc.includes('name="back2"') && decksSrc.includes('name="back3"'), '卡片编辑表单包含背面 2 / 背面 3');
const cssSrc = read('css/style.css');
ok(cssSrc.includes('.face-back2') && cssSrc.includes('.card-row-back2') && cssSrc.includes('.face-back3') && cssSrc.includes('.card-row-back3'), '背面 2 / 背面 3 有独立样式');
const swSrc = read('sw.js');
ok(swSrc.includes("'./data/periodic-table.json'"), 'SW 预缓存元素周期表');
ok(swSrc.includes("'./js/periodic.js'"), 'SW 预缓存周期表专属逻辑 periodic.js');
ok(/VERSION = 'v1\.28\.0'/.test(swSrc), 'SW 版本 v1.28.0');

console.log(`\n元素周期表结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
