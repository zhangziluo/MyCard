#!/usr/bin/env node
// ============================================================================
// test-countries.mjs — 内置「世界各国与首都（中英对照）」（v0.15.0）
//   运行: node scripts/test-countries.mjs
// 覆盖：195 个国家数据完整性 / 中文名 · 英文名与首都字段 / 播种与关卡 /
//       11 种专属题型（4 必选 + 7 可选）/ 配置页 / 首页横幅与自动导入 /
//       source 去重与标签兜底 / SW 预缓存 / 版本号
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

const payload = JSON.parse(read('data/countries-capitals.json'));
const words = Array.isArray(payload.words) ? payload.words : [];
let fetchUrl = '';
globalThis.fetch = async (url) => {
  fetchUrl = String(url);
  return { ok: true, status: 200, json: async () => payload };
};

const store = await import('../js/store.js');
const lang = await import('../js/lang.js');
const countries = await import('../js/countries.js');
const engine = await import('../js/test-engine.js');
const testMod = await import('../js/test.js');
const decksMod = await import('../js/decks.js');

let pass = 0;
let fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

/* ==========================================================================
 * ① 数据文件
 * ========================================================================== */

console.log('\n[数据：195 个国家]');
ok(words.length === 195, '恰好 195 个国家', words.length);
ok(payload.name === '世界各国与首都（中英对照）', '卡组名称正确');
ok(
  Array.isArray(payload.tags) && ['世界各国', '地理', '首都'].every((t) => payload.tags.includes(t)),
  '卡组标签包含 世界各国 / 地理 / 首都'
);
ok(payload.levelSize === 20, '每关 20 张');
ok(
  words.every((w) => typeof w.front === 'string' && w.front.includes(' · ')),
  '每条正面均为「国家中文名 · 英文名」'
);
ok(
  words.every((w) => typeof w.back === 'string' && w.back.includes(' · ')),
  '每条背面均为「首都中文名 · 英文名」'
);
ok(
  words.every((w) => /^[\u3400-\u9fff]/.test(w.front) && /^[\u3400-\u9fff]/.test(w.back)),
  '正面 / 背面都以中文名开头'
);
ok(new Set(words.map((w) => w.front)).size === 195, '国家条目无重复');
ok(new Set(words.map((w) => w.back)).size >= 190, '首都条目基本无重复（仅同名首都允许重复）');
ok(
  words.every((w) => Array.isArray(w.tags) && w.tags.includes('世界各国')),
  '每条都带「世界各国」标签'
);
ok(
  words.every((w) => !/(大学|的 ·|\*|[。])/.test(w.back)),
  '背面没有明显脏数据（大学 / 多余的「的」/ 星号 / 句号）'
);

const byFront = new Map(words.map((w) => [w.front, w.back]));
const entry = (zh, en) => byFront.get(`${zh} · ${en}`);
ok(entry('中国', 'China') === '北京 · Beijing', '中国 → 北京', entry('中国', 'China'));
ok(entry('美国', 'United States') === '华盛顿 · Washington, D.C.', '美国 → 华盛顿', entry('美国', 'United States'));
ok(entry('英国', 'United Kingdom') === '伦敦 · London', '英国 → 伦敦');
ok(entry('法国', 'France') === '巴黎 · Paris', '法国 → 巴黎');
ok(entry('日本', 'Japan') === '东京 · Tokyo', '日本 → 东京');
ok(entry('巴西', 'Brazil') === '巴西利亚 · Brasília', '巴西 → 巴西利亚');
ok(entry('波黑', 'Bosnia and Herzegovina') === '萨拉热窝 · Sarajevo', '波黑 → 萨拉热窝（补齐缺失国家）');
ok(entry('梵蒂冈', 'Vatican City') === '梵蒂冈城 · Vatican City', '梵蒂冈 → 梵蒂冈城（补齐缺失国家）');
ok(entry('韩国', 'South Korea') === '首尔 · Seoul', '韩国 → 首尔');
ok(entry('朝鲜', 'North Korea') === '平壤 · Pyongyang', '朝鲜 → 平壤');
ok(entry('南苏丹', 'South Sudan') === '朱巴 · Juba', '南苏丹 → 朱巴');
ok(entry('斯威士兰', 'Eswatini') === '姆巴巴内 · Mbabane', '斯威士兰 → 姆巴巴内');
ok(entry('捷克', 'Czech Republic') === '布拉格 · Prague', '捷克 → 布拉格');
ok(entry('科特迪瓦', 'Ivory Coast') === '亚穆苏克罗 · Yamoussoukro', '科特迪瓦 → 亚穆苏克罗');
ok(words[0].front === '阿富汗 · Afghanistan' && words[194].front === '津巴布韦 · Zimbabwe', '按英文名字母顺序排列');
ok(words.filter((w) => /^[A-Z]/.test(w.front.split(' · ')[1] || '')).length === 195, '英文名均以大写字母开头');

/* ==========================================================================
 * ② 导入与卡组结构
 * ========================================================================== */

console.log('\n[导入与卡组结构]');
const deck = await decksMod.importCountriesDeck();
ok(fetchUrl.includes('./data/countries-capitals.json'), '从 data/countries-capitals.json 读取', fetchUrl);
ok(!!deck && deck.cards.length === 195, '导入 195 张卡片', deck && deck.cards.length);
ok(deck.name === payload.name && deck.source === 'countries' && !deck.demo, '卡组名 / source=countries / 非示范');
ok(deck.cards[0].front === '阿富汗 · Afghanistan' && deck.cards[0].back === '喀布尔 · Kabul', '首卡字段正确', deck.cards[0]);
ok(deck.cards[194].front === '津巴布韦 · Zimbabwe' && deck.cards[194].back === '哈拉雷 · Harare', '末卡字段正确', deck.cards[194]);
ok(deck.cards.every((c) => c.tags.includes('世界各国')), '卡片保留「世界各国」标签');
const levelCount = new Set(deck.cards.map((c) => c.level)).size;
ok(levelCount === 10, '195 张按每关 20 张拆成 10 关', levelCount);
ok(deck.cards[0].level === 0 && deck.cards[194].level === 9, '关卡保持国家字母顺序（不重排）');
ok(store.hasSource('countries'), 'hasSource(countries) = true');
ok(store.getDb().seededCountries === true, '播种后 seededCountries 置位（删卡组后不会自动重建）');
ok(decksMod.isCountriesDeck(deck), 'isCountriesDeck(source=countries) = true');
ok(decksMod.isCountriesDeck({ source: null, tags: ['世界各国'] }), '备份回导丢失 source 时按标签兜底');
ok(!decksMod.isCountriesDeck({ source: null, tags: ['英语'] }), '无关卡组不会误判');
ok((await decksMod.importCountriesDeck()) === null, '同一来源重复导入 → 跳过');
ok((await decksMod.ensureCountriesDeck()).id === deck.id, 'ensureCountriesDeck 返回已存在卡组');


/* ==========================================================================
 * ③ 通用题型：正反面均可出题
 * ========================================================================== */

console.log('\n[通用题型]');
ok(lang.deckMode(deck) === 'same', '中英混合正反面判为同语种（不出句子选词）');
const random = () => 0.42;
const w2d = testMod.buildQuestions(deck, 1, { types: ['word2def'], random, mode: 'same' });
const d2w = testMod.buildQuestions(deck, 1, { types: ['def2word'], random, mode: 'same' });
ok(w2d.length === 20 && d2w.length === 20, '第 2 关各生成 20 道题');
ok(w2d.every((q) => q.options.some((o) => o.isCorrect)), '正面选背面：每题都有正确项');
ok(d2w.every((q) => q.options.some((o) => o.isCorrect)), '背面选正面：每题都有正确项');
const chinaCard = deck.cards.find((c) => c.front === '中国 · China');
const chinaQ = w2d.find((q) => q.cardId === chinaCard.id);
ok(!!chinaQ && chinaQ.options.find((o) => o.isCorrect).text === chinaCard.back, '正面选背面使用「首都 · 英文名」作答案');
const chinaBackQ = d2w.find((q) => q.cardId === chinaCard.id);
ok(!!chinaBackQ && chinaBackQ.options.find((o) => o.isCorrect).text === chinaCard.front, '背面选正面使用「国家 · 英文名」作答案');
ok(w2d.every((q) => q.options.filter((o) => o.isCorrect).length === 1), '每个选项组只有 1 个正确项');


/* ==========================================================================
 * ③-b 国家 / 首都专属题型与配置
 * ========================================================================== */

console.log('\n[国家专属题型与配置]');
ok(countries.COUNTRIES_TYPE_IDS.length === 11, '共 11 种国家专属题型');
ok(
  countries.COUNTRIES_MANDATORY_IDS.join(',') ===
    'countryZh2capitalZh,capitalZh2countryZh,countryEn2capitalEn,capitalEn2countryEn',
  '默认启用 4 种「国家 ↔ 首都」必选题型'
);
ok(countries.COUNTRIES_OPTIONAL_IDS.length === 7, '另有 7 种可选中英对照 / 听力题型');
ok(countries.COUNTRIES_OPTIONAL_IDS.every((id) => countries.COUNTRIES_DEFAULT_ENABLED[id] === false), '可选题型默认关闭');
const cDefault = countries.loadConfig();
ok(
  countries.COUNTRIES_MANDATORY_IDS.every((id) => cDefault.weights[id] === 25),
  '默认权重：4 种必选题各 25%'
);
ok(countries.COUNTRIES_OPTIONAL_IDS.every((id) => cDefault.weights[id] === 0), '默认权重：可选题 0%');
const cEnabled = countries.setTypeEnabled(cDefault.weights, cDefault.enabled, 'listenCountryEn2capitalEn', true);
ok(cEnabled.enabled.listenCountryEn2capitalEn === true, '可开启「听国家英文选首都英文」');
ok(
  countries.enabledTypeIds(cEnabled.enabled).length === 5 &&
    countries.COUNTRIES_TYPE_IDS.reduce((s, t) => s + cEnabled.weights[t], 0) === 100,
  '开启可选题后 5 种题型合计仍为 100%'
);
const cAdjusted = countries.adjustWeights(cEnabled.weights, 'countryZh2capitalZh', 60, cEnabled.enabled);
ok(
  cAdjusted.countryZh2capitalZh === 60 &&
    countries.COUNTRIES_TYPE_IDS.reduce((s, t) => s + cAdjusted[t], 0) === 100,
  '拖动滑块后合计仍为 100%'
);
const cReset = countries.resetDefaults(cEnabled.enabled);
ok(
  countries.enabledTypeIds(cEnabled.enabled).every((id) => cReset.weights[id] === 20),
  '恢复默认：5 种已启用题型各 20%'
);
// 历史实现按「最后一项补差」在极端比例下可能合计 101%；最大余数法必须恒为 100%
const allOn = Object.fromEntries(countries.COUNTRIES_OPTIONAL_IDS.map((id) => [id, true]));
const weirdRaw = [5, 7, 11, 20, 7, 10, 20, 20, 19, 9, 1];
const cWeird = countries.normalizeWeights(
  Object.fromEntries(countries.COUNTRIES_TYPE_IDS.map((id, i) => [id, weirdRaw[i]])),
  allOn
);
ok(
  countries.COUNTRIES_TYPE_IDS.reduce((s, t) => s + cWeird[t], 0) === 100,
  '极端比例归一化后合计恰好 100%（最大余数法）'
);
ok(
  countries.typesForRetry(1).filter((t) => t === 'countryZh2capitalZh').length === 2,
  '重刷时微调题型分布（首个题型出现两次）'
);

const china = countries.parseCountry(chinaCard);
ok(china.countryZh === '中国' && china.countryEn === 'China', '解析国家中文 / 英文');
ok(china.capitalZh === '北京' && china.capitalEn === 'Beijing', '解析首都中文 / 英文');
ok(countries.canBuild(chinaCard, 'countryZh2capitalZh'), '必选题型字段齐全');
ok(countries.canBuild(chinaCard, 'listenCountryEn2capitalEn'), '听力题型字段齐全');
ok(
  countries.isCountriesDeck({ source: null, tags: ['世界各国'] }) === true,
  '轻量卡组对象可用标签兜底'
);
ok(
  countries.isCountriesDeck({ source: null, tags: ['世界各国'], cards: [{ front: '只有正面', back: '' }] }) === false,
  '缺少国家 / 首都字段时不误判'
);
const cPools = countries.buildPools(deck);
ok(cPools.byId.size === 195, '选项池收录 195 个国家');
ok(cPools.countryZh.length === 195 && cPools.countryEn.length === 195, '国家中英文池各 195 条');
ok(cPools.capitalZh.length >= 193 && cPools.capitalEn.length >= 194, '首都中英文池按文本去重（同名首都允许重复）');


/* ==========================================================================
 * ③-c 专属出题：11 种题型 / 选项池 / 抽题计划
 * ========================================================================== */

console.log('\n[国家专属出题]');
const firstCard = deck.cards[0];
const firstFields = countries.parseCountry(firstCard);
const oneQ = (type) =>
  testMod.buildQuestions(deck, 0, { types: [type], random: () => 0.42, mode: 'same' })[0];
const correctText = (q) => (q.options.find((o) => o.isCorrect) || {}).text;
const cases = [
  ['countryZh2capitalZh', firstFields.countryZh, firstFields.capitalZh],
  ['capitalZh2countryZh', firstFields.capitalZh, firstFields.countryZh],
  ['countryEn2capitalEn', firstFields.countryEn, firstFields.capitalEn],
  ['capitalEn2countryEn', firstFields.capitalEn, firstFields.countryEn],
  ['countryZh2countryEn', firstFields.countryZh, firstFields.countryEn],
  ['countryEn2countryZh', firstFields.countryEn, firstFields.countryZh],
  ['capitalZh2capitalEn', firstFields.capitalZh, firstFields.capitalEn],
  ['capitalEn2capitalZh', firstFields.capitalEn, firstFields.capitalZh],
  ['countryZh2capitalEn', firstFields.countryZh, firstFields.capitalEn],
  ['countryEn2capitalZh', firstFields.countryEn, firstFields.capitalZh],
  ['listenCountryEn2capitalEn', firstFields.countryEn, firstFields.capitalEn]
];
for (const [type, prompt, answer] of cases) {
  const q = oneQ(type);
  ok(
    !!q && q.type === type && q.prompt === prompt && correctText(q) === answer,
    `${type}：${prompt} → ${answer}`
  );
}
ok(cases.every(([type]) => oneQ(type).options.length >= 2), '每种题型都生成多个选项');
ok(cases.every(([type]) => oneQ(type).options.filter((o) => o.isCorrect).length === 1), '每种题型只有 1 个正确项');
ok(cases.every(([type]) => new Set(oneQ(type).options.map((o) => o.text)).size === oneQ(type).options.length), '选项文本不重复');
ok(oneQ('listenCountryEn2capitalEn').speakText === firstFields.countryEn, '听力题朗读国家英文名');

// 耶路撒冷同时是两个国家的首都：出「首都中文选国家中文」时，不能把另一个正确答案当干扰项
const israelIdx = deck.cards.findIndex((c) => c.front.startsWith('以色列'));
const israelCard = deck.cards[israelIdx];
const israelQ = testMod
  .buildQuestions(deck, Math.floor(israelIdx / 20), { types: ['capitalZh2countryZh'], random: () => 0.42, mode: 'same' })
  .find((q) => q.cardId === israelCard.id);
ok(
  !!israelQ && israelQ.prompt === '耶路撒冷' && !israelQ.options.some((o) => o.text === '巴勒斯坦'),
  '同一首都对应多国时排除另一个正确答案'
);

const mandatoryQs = testMod.buildQuestions(deck, 0, {
  types: countries.COUNTRIES_MANDATORY_IDS,
  random: () => 0.42,
  mode: 'same'
});
ok(mandatoryQs.length === 20, '默认 4 种必选题型生成整关 20 题');
ok(mandatoryQs.every((q) => countries.COUNTRIES_MANDATORY_IDS.includes(q.type)), '默认只出 4 种必选题型');
ok(mandatoryQs.every((q) => q.options.some((o) => o.isCorrect)), '每道题都有正确项');

const cConf = countries.loadConfig();
const cTypes = countries.enabledTypeIds(cConf.enabled);
const cPlan = engine.samplePlan(deck, {
  count: 60,
  weights: cConf.weights,
  enabled: null,
  types: cTypes,
  omitTypes: [],
  canType: (card, type) => testMod.canBuildType(card, type, { allowEnSenses: false, mode: 'same' })
});
const planQs = testMod.buildQuestionsFromPlan(deck, cPlan, null, () => 0.42, {
  allowEnSenses: false,
  mode: 'same'
});
ok(planQs.length === 60, '按抽题计划生成 60 道国家题');
ok(planQs.every((q) => countries.isCountriesType(q.type)), '计划中全部为国家专属题型');
ok(planQs.every((q) => q.options.some((o) => o.isCorrect)), '计划题目全部带正确项');

/* ==========================================================================
 * ③-d 配置页 / 题面展示接线
 * ========================================================================== */

console.log('\n[国家测试配置页]');
countries.saveConfig({ weights: cConf.weights, enabled: cConf.enabled });
const cfgRoot = { innerHTML: '' };
testMod.renderDeckTestConfig(cfgRoot, deck.id);
const cfgHtml = cfgRoot.innerHTML || '';
ok(cfgHtml.includes('国家中文选首都中文') && cfgHtml.includes('首都英文选国家英文'), '配置页列出 4 种必选题型');
ok(cfgHtml.includes('听国家英文选首都英文'), '配置页列出可选的听力题型');
ok((cfgHtml.match(/deck-test-type-toggle/g) || []).length === 7, '配置页提供 7 个可选题型开关');
ok((cfgHtml.match(/weight-name-wide/g) || []).length === 11, '配置页 11 种题型均使用宽标签布局');
ok(cfgHtml.includes('195 个国家'), '配置页显示 195 个国家');
ok(cfgHtml.includes('data-action="deck-test-start"'), '配置页提供开始测试按钮');
ok(cfgHtml.includes('世界各国卡组默认启用 4 种'), '配置页说明国家专属题型规则');

const testSrc = read('js/test.js');
ok(testSrc.includes('countries.isCountriesDeck(deck)') && testSrc.includes('国家英文'), '答错后展示国家 / 首都中英字段');
ok(testSrc.includes("'播放国家英文名'"), '听力题提供「播放国家英文名」按钮');



/* ==========================================================================
 * ④ 入口 / 自动导入 / 缓存 / 版本
 * ========================================================================== */

console.log('\n[入口与接线]');
const decksSrc = read('js/decks.js');
ok(/export async function importCountriesDeck\(/.test(decksSrc), 'decks.js 暴露 importCountriesDeck()');
ok(/export async function ensureCountriesDeck\(/.test(decksSrc), 'decks.js 暴露 ensureCountriesDeck()');
ok(decksSrc.includes("source: 'countries'") && decksSrc.includes('arrange: false'), '以 source=countries、保持字母顺序播种');
ok(decksSrc.includes('data-action="import-countries"'), '首页有「导入世界各国与首都」入口');
ok(decksSrc.includes("on('import-countries'"), '注册 import-countries 点击动作');
ok(decksSrc.includes("icon('globe'") && read('js/ui.js').includes('globe:'), '使用地球图标');
ok(decksSrc.includes('195 个国家') && decksSrc.includes('正面国家名称与英文名'), '横幅文案说明内容');

const appSrc = read('js/app.js');
ok(appSrc.includes('ensureCountriesDeck()') && appSrc.includes('seededCountries'), '启动时按 seededCountries 自动导入');
ok(/APP_VERSION = 'v0\.15\.0'/.test(appSrc), 'APP_VERSION = v0.15.0');

const storeSrc = read('js/store.js');
ok(storeSrc.includes('seededCountries: false'), 'store 默认数据库包含 seededCountries');
ok(storeSrc.includes('d.seededCountries = !!raw.seededCountries'), 'normalize 保留 seededCountries');
ok(storeSrc.includes('seededCountries: d.seededCountries'), 'persistMeta 写入 seededCountries');
ok(storeSrc.includes('seededCountries: !!(meta && meta.seededCountries)'), 'IndexedDB 水合读取 seededCountries');
ok(storeSrc.includes("source === 'countries'"), '播种 countries 来源时置位标记');

const swSrc = read('sw.js');
ok(swSrc.includes("'./data/countries-capitals.json'"), 'SW 预缓存 countries-capitals.json');
ok(swSrc.includes("'./js/countries.js'"), 'SW 预缓存 countries.js');
ok(/VERSION = 'v1\.27\.0'/.test(swSrc), 'SW 版本 v1.27.0');

console.log(`\n世界各国与首都结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

