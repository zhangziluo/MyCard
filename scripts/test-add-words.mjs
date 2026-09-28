#!/usr/bin/env node
// ============================================================================
// test-add-words.mjs — 首页「添加单词/词表」测试
//   运行: node scripts/test-add-words.mjs
// 覆盖：语种检测 / 输入模式判断 / 分词 / API 解析 / 缓存 / 限速+重试 /
//       卡片映射 / 去重加入「我的生词」/ 面板流程
// ============================================================================

import { installFakeIndexedDB } from './fake-idb.mjs';

/* ---------- 浏览器全局桩 ---------- */
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
    innerHTML: '', value: '', dataset: {}, style: {}, className: '', textContent: '', children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, remove() {}, focus() {}, setAttribute() {}
  };
}
const els = {};
const elFor = (id) => (els[id] = els[id] || fakeEl());
globalThis.document = {
  body: fakeEl(),
  documentElement: fakeEl(),
  addEventListener() {}, removeEventListener() {},
  querySelector() { return null; }, querySelectorAll() { return []; },
  getElementById: (id) => elFor(id),
  createElement() { return fakeEl(); }
};
globalThis.window = { addEventListener() {}, dispatchEvent() {}, scrollTo() {} };
globalThis.location = { hash: '#/home', href: '' };
globalThis.HashChangeEvent = class HashChangeEvent { constructor(t) { this.type = t; } };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
installFakeIndexedDB();

const store = await import('../js/store.js');
const aw = await import('../js/add-words.js');

let pass = 0;
let fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

console.log('\n[语种检测（字符范围）]');
ok(aw.detectLang('hello') === 'en', '英文默认 → en');
ok(aw.detectLang('你好世界') === 'ja', '含汉字 → ja');
ok(aw.detectLang('こんにちは') === 'ja', '含假名 → ja');
ok(aw.detectLang('γράφω') === 'el', '含希腊字母 → el');
ok(aw.detectLang('Straße') === 'de', '含 ß → de');
ok(aw.detectLang('über') === 'de', '含 ü → de（德语优先于法语）');
ok(aw.detectLang('café') === 'fr', '含 é → fr');
ok(aw.detectLang('français') === 'fr', '含 ç → fr');

console.log('\n[输入模式自动判断]');
ok(aw.classifyInput('hello').mode === 'single', '单行一个词 → single');
ok(aw.classifyInput('give up').mode === 'single', '单行短语 → single');
ok(aw.classifyInput('hello\nworld\nbook').mode === 'list', '每行一个词 → list');
ok(aw.classifyInput('hello\nworld\nbook').items.length === 3, 'list 提取 3 个词');
ok(aw.classifyInput('This is a sentence. It has punctuation!').mode === 'text', '带标点句子 → text');
ok(aw.classifyInput('one two three four five').mode === 'text', '多个单词无换行 → text（需勾选）');
ok(aw.classifyInput('   ').mode === 'empty', '空输入 → empty');
{
  const many = Array.from({ length: 1001 }, (_, i) => 'word' + i).join('\n');
  ok(aw.classifyInput(many).mode === 'text', '超过 1000 行 → 不再视为词表（转 text）');
  const exact = Array.from({ length: 1000 }, (_, i) => 'word' + i).join('\n');
  ok(aw.classifyInput(exact).mode === 'list', '恰好 1000 行 → list');
}

console.log('\n[大段文本分词]');
{
  const t = aw.tokenize('The quick brown fox, jumps over the lazy dog. The fox! 123 abc 日本語');
  ok(t.includes('quick') && t.includes('jumps') && t.includes('dog'), '按空格/标点切分', t);
  ok(new Set(t.map((x) => x.toLowerCase())).size === t.length, '去重（大小写不敏感）');
  ok(!t.includes('123'), '纯数字被丢弃');
  ok(!t.includes('a'), '孤立单字母被丢弃');
  ok(t.includes('日本語'), '保留 CJK 词');
  ok(aw.tokenize("don't").includes("don't"), '保留撇号词');
}

console.log('\n[API 响应解析]');
const freePayload = [
  {
    word: 'book',
    phonetic: '/bʊk/',
    phonetics: [{ text: '/bʊk/' }],
    meanings: [
      { partOfSpeech: 'noun', definitions: [{ definition: 'A set of printed pages.', example: 'I read a book.' }] },
      { partOfSpeech: 'verb', definitions: [{ definition: 'To reserve in advance.' }] }
    ]
  }
];
{
  const card = aw.cardFromFreeDict('en', 'book', freePayload);
  ok(card.word === 'book', '单词');
  ok(card.ipa === '/bʊk/', 'IPA');
  ok(card.senses.length === 2, '两条释义', card.senses);
  ok(card.senses[0].pos === 'noun' && card.senses[1].pos === 'verb', '带词性');
  ok(card.example === 'I read a book.', '取首个例句');
  ok(card.level === 'custom' && card.src === 'online_lookup', 'level/src 标记');
  ok(aw.cardFromFreeDict('en', 'x', []) === null, '空响应 → null');
  ok(aw.cardFromFreeDict('en', 'x', [{ word: 'x' }]) === null, '无释义 → null');
}
const jishoPayload = { data: [{ japanese: [{ word: '本', reading: 'ほん' }], senses: [{ parts_of_speech: ['noun'], english_definitions: ['book', 'volume'] }] }] };
{
  const card = aw.cardFromJisho('本', jishoPayload);
  ok(card.word === '本', '日语：取 japanese[0].word');
  ok(card.ipa === 'ほん', '日语：读音');
  ok(card.senses[0].gloss === 'book; volume', '日语：英文释义合并', card.senses[0]);
  ok(card.lang === 'ja', '标记 ja');
}

console.log('\n[缓存 key 与读写]');
await store.init();
ok(aw.cacheKey('en', 'CacheMe') === 'en_cacheme', 'key = `${lang}_${word}`（小写）');
{
  const card = aw.cardFromFreeDict('en', 'cacheme', freePayload);
  await aw.putCached('en', 'cacheme', card);
  const hit = await aw.getCached('en', 'CACHEME');
  ok(!!hit && hit.word === 'book', '写入后可命中（大小写不敏感）');
  ok((await aw.getCached('fr', 'cacheme')) === null, '不同语种不串缓存');
}

console.log('\n[查询：缓存优先 / 404 / 日语接口]');
{
  let calls = 0;
  const fetchOk = async (url) => {
    calls += 1;
    ok(String(url).includes('api.dictionaryapi.dev'), '非日语走 Free Dictionary API', url);
    return { ok: true, status: 200, json: async () => freePayload };
  };
  const first = await aw.lookupWord('en', 'book', { fetchImpl: fetchOk });
  ok(first.card && first.cached === false && calls === 1, '首次：走网络（1 次请求）');
  const second = await aw.lookupWord('en', 'book', { fetchImpl: fetchOk });
  ok(second.card && second.cached === true && calls === 1, '再次：命中缓存（不再请求）');

  let jishoCalls = 0;
  const fetchJa = async (url) => {
    jishoCalls += 1;
    ok(String(url).includes('jisho.org'), '日语走 Jisho API', url);
    return { ok: true, status: 200, json: async () => jishoPayload };
  };
  const jaRes = await aw.lookupWord('ja', '本', { fetchImpl: fetchJa });
  ok(jaRes.card && jaRes.card.word === '本' && jishoCalls === 1, '日语查询成功');

  const fetch404 = async () => ({ ok: false, status: 404, json: async () => null });
  const nf = await aw.lookupWord('en', 'zzzzzz', { fetchImpl: fetch404 });
  ok(nf.card === null && nf.notFound === true, '404 → notFound');
}

console.log('\n[网络失败：自动重试一次后放弃]');
{
  let n = 0;
  const flaky = async (url) => {
    n += 1;
    if (n === 1) throw new Error('boom');
    return { ok: true, status: 200, json: async () => [{ word: 'retryok', meanings: [{ partOfSpeech: 'n', definitions: [{ definition: 'ok' }] }] }] };
  };
  const r = await aw.lookupWord('en', 'retryok', { fetchImpl: flaky });
  ok(r.card && n === 2, '首次失败自动重试成功（共 2 次请求）', n);

  let m = 0;
  const dead = async () => { m += 1; throw new Error('offline'); };
  const r2 = await aw.lookupWord('en', 'offlineword', { fetchImpl: dead });
  ok(r2.card === null && m === 2 && r2.error === 'offline', '一直失败：重试 1 次后放弃并记录错误', { m, err: r2.error });
}

console.log('\n[批量：进度 / 失败收集 / 去重 / 限速]');
{
  const seen = [];
  const fetchStub = async (url) => {
    seen.push(Date.now());
    const w = decodeURIComponent(String(url).split('/').pop());
    if (w === 'badword') return { ok: false, status: 404, json: async () => null };
    return {
      ok: true,
      status: 200,
      json: async () => [{ word: w, phonetic: '/x/', meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'def of ' + w }] }] }]
    };
  };
  const steps = [];
  const res = await aw.lookupBatch(['alpha', 'beta', 'badword', 'alpha'], {
    fetchImpl: fetchStub,
    onProgress: (p) => steps.push(`${p.done}/${p.total}`)
  });
  ok(res.cards.length === 2, '成功 2 个词（重复项已去重）', res.cards.map((c) => c.word));
  ok(res.failed.length === 1 && res.failed[0] === 'badword', '未查到的词进入 failed[]', res.failed);
  ok(steps.join(',') === '1/3,2/3,3/3', '进度回调依次推进（去重后共 3 个）', steps);
  const gaps = seen.slice(1).map((t, i) => t - seen[i]);
  ok(gaps.every((g) => g >= 90), '请求间隔 ≥ 100ms（实测 ' + gaps.join('/') + 'ms）', gaps);
}

console.log('\n[卡片 → 卡组条目 / 加入「我的生词」]');
{
  const card = aw.cardFromFreeDict('en', 'book', freePayload);
  const item = aw.cardToDeckItem(card, card.lang);
  ok(item.front === 'book', 'front = word');
  ok(item.back === 'noun. A set of printed pages.', 'back = 首个释义（带词性）', item.back);
  ok(item.extraBacks.length === 1 && item.extraBacks[0] === 'verb. To reserve in advance.', 'extraBacks = 其余释义', item.extraBacks);
  ok(item.phonetic === '/bʊk/', 'phonetic = ipa');
  ok(item.tags.join(',') === 'en', 'tags 带语种');

  const r1 = aw.commitCards([card], 'online_lookup');
  ok(r1.added === 1, '首次加入 1 个词');
  ok(r1.deck.name === '我的生词' && r1.deck.source === 'custom', '写入「我的生词」（source=custom）', r1.deck.name);
  const saved = store.getDeck(r1.deck.id).cards[0];
  ok(saved.front === 'book' && saved.src === 'online_lookup' && !!saved.addedAt, '卡片带 src/addedAt');
  const r2 = aw.commitCards([card], 'online_lookup');
  ok(r2.added === 0 && r2.skipped === 1, '重复词不覆盖（skipped=1）');
  ok(store.getDeck(r1.deck.id).cards.length === 1, '卡组内不产生重复卡片');
}

console.log('\n[重复词处理偏好（重复时合并释义）]');
{
  const ui = await import('../js/ui.js');
  const fireChange = (action, props = {}) => {
    const el = Object.assign({ dataset: { action }, classList: { add() {}, remove() {} } }, props);
    el.closest = () => el;
    ui.handleEvent({ type: 'change', target: { closest: () => el }, preventDefault() {} });
  };
  const cardOf = (w, gloss) =>
    aw.cardFromFreeDict('en', w, [{ word: w, meanings: [{ partOfSpeech: 'v', definitions: [{ definition: gloss }] }] }]);

  ok(aw.loadMergePref() === true && aw.isMergeEnabled() === true, '默认开启（localStorage 无记录 → true）');
  ok(aw.addWordsPanelHtml().includes('重复时合并释义'), '面板渲染「重复时合并释义」开关');
  ok(/id="aw-merge-box"[^>]*checked/.test(aw.addWordsPanelHtml()), '默认勾选');

  ok(aw.commitCards([cardOf('giveup', '放弃')], 'online_lookup').added === 1, '加入 giveup（原卡 back = v. 放弃）');
  const r1 = aw.commitCards([cardOf('GiveUp', '投降')], 'online_lookup');
  ok(r1.added === 0 && r1.merged === 1 && r1.skipped === 0, '开启时：大小写不同的同一个词 → 合并（merged=1）', r1);
  const kept = store.getUserDeck().cards.find((c) => c.front.toLowerCase() === 'giveup');
  ok(kept.back === 'v. 放弃', '原释义保持第一义', kept.back);
  ok(kept.extraBacks.join(',') === 'v. 投降', '新释义追加到「其它释义」', kept.extraBacks);
  ok(store.getUserDeck().cards.filter((c) => c.front.toLowerCase() === 'giveup').length === 1, '不产生重复卡片');

  fireChange('aw-merge', { checked: false });
  ok(aw.isMergeEnabled() === false && globalThis.localStorage.getItem('mycard-aw-merge') === '0', '关掉开关 → 写入 localStorage（0）');
  ok(aw.getPanelState().merge === false, '面板状态同步');
  ok(!/id="aw-merge-box"[^>]*checked/.test(aw.addWordsPanelHtml()), '重渲染后面板不再勾选');
  const r2 = aw.commitCards([cardOf('giveup', '又一条释义')], 'online_lookup');
  ok(r2.added === 0 && r2.merged === 0 && r2.skipped === 1, '关闭时：重复词直接跳过', r2);
  ok(store.getUserDeck().cards.find((c) => c.front.toLowerCase() === 'giveup').extraBacks.length === 1, '跳过后不追加释义');

  fireChange('aw-merge', { checked: true });
  ok(aw.loadMergePref() === true && aw.isMergeEnabled() === true, '重新开启 → 偏好读取为 true');
  ok(globalThis.localStorage.getItem('mycard-aw-merge') === '1', 'localStorage 记录已开启（1）');
}

console.log('\n[生词本整理页「在线补查」预填查词框]');
{
  elFor('add-words-input').value = '旧内容';
  ok(aw.prefillInput(['eel', 'eel', '  ', 'eel'], { merge: true }) === 1, '预填去重 + 去空白 → 1 个词');
  ok(elFor('add-words-input').value === 'eel', '待查词写入查词框（覆盖旧内容）');
  ok(aw.getPanelState().mode === 'empty' && aw.getPanelState().cards.length === 0, '预填时清掉上一次预览');
  ok(aw.isMergeEnabled() === true && elFor('aw-merge-box').checked === true, '预填同步「合并释义」开关（默认开）');
  ok(aw.peekPendingPrefill() === null, '面板已在 DOM → 立即消费，不再暂存');
  ok(aw.prefillInput([], {}) === 0 && elFor('add-words-input').value === 'eel', '空数组不改动查词框');

  ok(aw.prefillInput(['aa', 'bb'], { merge: false }) === 2, '多个词全部填入');
  ok(elFor('add-words-input').value === 'aa\nbb', '每行一个词');
  ok(aw.isMergeEnabled() === false && elFor('aw-merge-box').checked === false, '预填可显式关闭合并（补查的重复词不再跳过）');

  // 面板尚未渲染（在 #/words 上点补查 → 再跳首页）：先暂存，等 addWordsPanelHtml() 消费
  const realGetById = globalThis.document.getElementById;
  globalThis.document.getElementById = (id) => (id === 'add-words-input' ? null : elFor(id));
  ok(aw.prefillInput(['eel'], { merge: true }) === 1, '面板未渲染时也能接受预填');
  ok((aw.peekPendingPrefill() || {}).words?.join(',') === 'eel', '待查词暂存，等面板渲染');
  ok(/>eel<\/textarea>/.test(aw.addWordsPanelHtml()), '面板渲染时把暂存词写进 textarea');
  ok(aw.peekPendingPrefill() === null, '消费后清除暂存');
  globalThis.document.getElementById = realGetById;
}

console.log('\n[面板渲染与三种输入流程]');
{
  const html = aw.addWordsPanelHtml();
  ok(html.includes('add-words-input') && html.includes('<textarea'), '渲染唯一 textarea');
  ok(html.includes('输入单词查释义，或粘贴词表（每行一个）...'), 'placeholder 符合要求');
  ok(html.includes('data-action="aw-submit"') && html.includes('>添加<'), '渲染 [添加] 按钮');
  ok(html.includes('preview-area'), '渲染 .preview-area');

  const fetchStub = async (url) => {
    const w = decodeURIComponent(String(url).split('/').pop());
    return {
      ok: true,
      status: 200,
      json: async () => [{ word: w, phonetic: '/p/', meanings: [{ partOfSpeech: 'n', definitions: [{ definition: 'd-' + w }] }] }]
    };
  };
  aw.resetPanel(false);

  // ① 单词模式
  elFor('add-words-input').value = 'apple';
  await aw.submitInput({ fetchImpl: fetchStub });
  ok(aw.getPanelState().mode === 'single', '① 单词模式');
  ok(aw.getPanelState().cards.length === 1, '① 查到 1 张卡');
  ok(elFor('aw-preview').innerHTML.includes('确认加入'), '① 预览区出现「确认加入」');

  // ② 词表模式（带进度）
  aw.resetPanel(false);
  elFor('add-words-input').value = 'one\ntwo\nthree';
  await aw.submitInput({ fetchImpl: fetchStub });
  ok(aw.getPanelState().mode === 'list', '② 词表模式');
  ok(aw.getPanelState().cards.length === 3, '② 批量查到 3 张卡');
  const c2 = aw.confirmAdd('batch_import');
  ok(c2.added === 3, '② 批量加入 3 个词');
  ok(store.getUserDeck().cards.some((c) => c.front === 'one'), '②「我的生词」内含批量加入的词');

  // ③ 大段文本 → 候选勾选 → 查词
  aw.resetPanel(false);
  elFor('add-words-input').value = 'Alpha beta gamma. Alpha delta!';
  const textRes = await aw.submitInput({ fetchImpl: fetchStub });
  ok(textRes.mode === 'text' && aw.getPanelState().candidates.length === 4, '③ 文本模式识别 4 个候选', aw.getPanelState().candidates);
  ok(aw.getPanelState().selected.length === 4, '③ 默认勾选候选');
  ok(elFor('aw-preview').innerHTML.includes('aw-token'), '③ 预览区渲染候选词按钮');
  await aw.runLookup(aw.getPanelState().selected, { fetchImpl: fetchStub });
  ok(aw.getPanelState().cards.length === 4, '③ 勾选的候选全部查到');

  // ④ 确认加入「我的生词」
  const committed = aw.confirmAdd('batch_import');
  ok(committed.added === 4, '④ 确认加入 4 个词', committed.added);
  ok(store.getUserDeck().cards.some((c) => c.front === 'delta'), '④「我的生词」内含分词查词结果');
  ok(store.getUserDeck().cards.some((c) => c.front === 'apple') === false, '④ 未确认的单词（apple）不会被写入');
  ok(aw.getPanelState().mode === 'empty' && aw.getPanelState().cards.length === 0, '④ 加入后面板复位');
  ok(elFor('add-words-input').value === '', '④ 加入后清空输入框');
  ok(elFor('aw-preview').innerHTML === '', '④ 加入后预览区清空');
  ok(aw.isBusy() === false, '④ 空闲状态（busy=false）');
}

console.log(`\n添加单词结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);



