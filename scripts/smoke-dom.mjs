#!/usr/bin/env node
// ============================================================================
// smoke-dom.mjs — 无头 DOM 冒烟测试（验证模块可加载、主要界面可渲染）
//   运行: node scripts/smoke-dom.mjs
// 需要先定义 localStorage/sessionStorage/document 桩，再用动态 import 加载模块。
// ============================================================================

function fakeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    toggle: (c) => (set.has(c) ? (set.delete(c), false) : (set.add(c), true)),
    contains: (c) => set.has(c)
  };
}

function fakeEl() {
  const node = {
    innerHTML: '',
    dataset: {},
    style: {},
    className: '',
    classList: fakeClassList(),
    textContent: '',
    children: [],
    _listeners: {},
    setAttribute(k, v) {
      if (k === 'data-') return;
      this[k] = String(v);
    },
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
    remove() {},
    focus() {}
  };
  return node;
}

// ---- 全局桩（在动态 import 前定义） ----
const mem = {};
const storage = {
  getItem(k) {
    return k in mem ? mem[k] : null;
  },
  setItem(k, v) {
    mem[k] = String(v);
  },
  removeItem(k) {
    delete mem[k];
  },
  clear() {
    for (const k of Object.keys(mem)) delete mem[k];
  }
};

const fakeBody = fakeEl();
const appViewEl = fakeEl();
const appbarSideEl = fakeEl();
const htmlEl = fakeEl();
/** 文档级监听表（type → handlers[]），用于验证粘贴绑定 */
const docListeners = {};
globalThis.localStorage = storage;
globalThis.sessionStorage = { ...storage };
globalThis.document = {
  body: fakeBody,
  documentElement: htmlEl,
  addEventListener(type, fn) {
    (docListeners[type] = docListeners[type] || []).push(fn); // 记录文档级监听（粘贴处理用）
  },
  removeEventListener() {},
  querySelector() {
    return null;
  },
  querySelectorAll() {
    return [];
  },
  getElementById(id) {
    if (id === 'view') return appViewEl;
    if (id === 'appbar-side') return appbarSideEl;
    return fakeEl();
  },
  createElement() {
    return fakeEl();
  }
};
/* window：捕获事件监听，便于测试中触发 hashchange（app.render → 设置页） */
const winListeners = {};
globalThis.window = {
  addEventListener(type, fn) {
    (winListeners[type] = winListeners[type] || []).push(fn);
  },
  dispatchEvent(evt) {
    (winListeners[evt.type] || []).forEach((fn) => fn(evt));
    return true;
  },
  scrollTo() {}
};
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.location = { hash: '#/home', href: '' };
// ui.navigate 在「同 hash」时会派发合成 hashchange；Node 无此全局类，补一个最小桩
globalThis.HashChangeEvent = class HashChangeEvent {
  constructor(type) { this.type = type; }
};

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + msg);
  } else {
    fail++;
    console.error('  ✗ ' + msg);
  }
}

/** 模拟 data-action 点击（走 ui.handleEvent 事件委托） */
async function fire(action, dataset = {}) {
  const ui = await import('../js/ui.js');
  const btn = { dataset: { action, ...dataset }, classList: { add() {}, remove() {} } };
  btn.closest = () => btn;
  ui.handleEvent({ type: 'click', target: { closest: () => btn }, preventDefault() {} });
}

/** 模拟 data-action 事件（可指定事件类型与附加属性，如 change 的 checked / value） */
async function fireOn(type, action, props = {}) {
  const ui = await import('../js/ui.js');
  const btn = Object.assign({ dataset: { action }, classList: { add() {}, remove() {} } }, props);
  btn.dataset = Object.assign({ action }, props.dataset || {});
  btn.closest = () => btn;
  ui.handleEvent({ type, target: { closest: () => btn }, preventDefault() {} });
}

// ---- 加载被测模块（全部浏览器模块，验证 import 图完整） ----
const store = await import('../js/store.js');
const decks = await import('../js/decks.js');
const review = await import('../js/review.js');
const testMod = await import('../js/test.js');
const match = await import('../js/match.js');
console.log('\n[模块加载]');
ok(true, 'store / decks / review / test / match 均可正常 import（依赖图完整）');

// ---- 造数据：60 张卡组 ----
const payload = {
  name: '冒烟测试组',
  tags: ['测试'],
  levelSize: 20,
  words: Array.from({ length: 60 }, (_, i) => ({
    front: 'word' + i,
    back: '释义 ' + i,
    example: 'Example ' + i + '.',
    exampleZh: '例句' + i
  }))
};
const demo = store.seedDemoDeck(payload);
ok(!!demo && demo.cards.length === 60, 'seedDemoDeck 导入 60 张');
ok(new Set(demo.cards.map((c) => c.level)).size === 3, '60 张按每关 20 拆为 3 个关卡');
ok(demo.cards.filter((c) => c.level === 0).length === 20, '第 1 关 20 张');

const db = store.getDb();
ok(db.decks.length === 1, '卡组已入库（仅示范词库）');

// ---- 首页 ----
const root = fakeEl();
decks.renderHome(root);
ok(root.innerHTML.includes('我的卡组'), '首页可渲染（标题）');
ok(root.innerHTML.includes('冒烟测试组'), '首页展示卡组名');
ok(root.innerHTML.includes('data-action="import-history"'), '首页含「导入历史」入口');
ok(root.innerHTML.includes('data-action="download-csv-template"'), '首页导入栏含「下载 CSV 模版」');
ok(root.innerHTML.includes('data-action="download-json-template"'), '首页导入栏含「下载 JSON 模版」（v0.5.4）');
ok(root.innerHTML.includes('示例行可选'), '首页模版提示已更新（示例行可选）');
ok(root.innerHTML.includes('关卡 0/3'), '首页展示关卡进度 0/3');
ok(root.innerHTML.includes('filter-tag'), '首页包含标签筛选');
ok(root.innerHTML.includes('内置词库') === false, '首页不再有「内置词库」区块（考试词库已移除）');
ok(root.innerHTML.includes('import-builtin') === false, '不再有按需「导入」词库按钮');

// ---- 首页：统一「添加单词/词表」面板 ----
{
  ok(root.innerHTML.includes('class="add-words glass"'), '首页顶部渲染「添加单词」面板');
  const inputs = root.innerHTML.match(/<textarea/g) || [];
  ok(inputs.length === 1, '添加区域只有一个 textarea 输入框（实际 ' + inputs.length + ' 个）');
  ok(root.innerHTML.includes('输入单词查释义，或粘贴词表（每行一个）...'), 'textarea 占位提示符合要求');
  ok(root.innerHTML.includes('data-action="aw-submit"') && root.innerHTML.includes('>添加<'), '面板含 [添加] 按钮');
  ok(root.innerHTML.includes('class="preview-area"'), '面板含 .preview-area 预览区');
  ok(root.innerHTML.includes('aw-token-list') === false, '初始状态预览区为空（未渲染候选）');
  ok(root.innerHTML.includes('data-action="import-file"'), '首页提供「导入词库」按钮（CSV / JSON）');
  ok(root.innerHTML.includes('data-dropzone'), '首页提供拖拽区（data-dropzone）');
  ok(root.innerHTML.includes('拖入 CSV / TSV / JSON / XLSX 文件'), '拖拽区含提示文案');
}

// ---- 卡组详情 ----
decks.renderDeck(root, demo.id);
ok(root.innerHTML.includes('第 1 关') && root.innerHTML.includes('第 2 关') && root.innerHTML.includes('第 3 关'), '详情页渲染 3 个关卡');
ok(root.innerHTML.includes('level-learn'), '第 1 关有「开始学习」入口');
ok(root.innerHTML.includes('未解锁') || root.innerHTML.includes('lock'), '后续关卡显示锁定状态');
ok(root.innerHTML.includes('管理卡片'), '详情页有管理入口');
ok(root.innerHTML.includes('open-all-review') && root.innerHTML.includes('翻转记忆'), '详情页顶部有整卡组「翻转记忆」入口');
ok(root.innerHTML.includes('rearrange-deck'), '详情页提供「按难度重排关卡」入口');

// ---- 关卡分页（> 15 关）----
const bigPayload = {
  name: '分页冒烟组',
  tags: ['测试'],
  levelSize: 20,
  words: Array.from({ length: 400 }, (_, i) => ({ front: 'pg' + i, back: '释义' + i }))
};
const big = store.seedBuiltinDeck(bigPayload, { demo: false, source: 'smoke-page' });
ok(!!big && store.getDeck(big.id).cards.length === 400, '分页卡组导入 400 张');
ok(store.getDeck(big.id).cards.filter((c) => c.level === 0).length === 20, '400 张按每关 20 拆为 20 关');
decks.renderDeck(root, big.id);
ok(root.innerHTML.includes('第 1/2 页'), '关卡 20 个 → 分页显示「第 1/2 页」');
ok(root.innerHTML.includes('pager-btn'), '渲染分页按钮');
ok((root.innerHTML.match(/class="level-card glass/g) || []).length === 15, '每页只渲染 15 个关卡');
ok(root.innerHTML.includes('第 15 关') && !root.innerHTML.includes('第 16 关'), '第 1 页只含第 1–15 关');
{
  const prevHash = globalThis.location.hash;
  globalThis.location.hash = '#/deck/' + big.id + '?page=2';
  decks.renderDeck(root, big.id);
  ok(root.innerHTML.includes('第 2/2 页'), 'URL ?page=2 → 显示第 2 页');
  ok(root.innerHTML.includes('第 16 关') && root.innerHTML.includes('第 20 关'), '第 2 页含第 16–20 关');
  ok(!root.innerHTML.includes('第 1 关<'), '第 2 页不再渲染第 1 关');
  globalThis.location.hash = prevHash;
}

// ---- 卡片管理分页（400 张 / 每页 100）----
console.log('\n[卡片管理 · 分页（400 张 / 每页 100）]');
{
  const prevHash = globalThis.location.hash;
  ok(decks.CARDS_PER_PAGE === 100, 'CARDS_PER_PAGE = 100');
  globalThis.location.hash = '#/deck/' + big.id + '/cards';
  decks.renderCards(root, big.id);
  ok(root.innerHTML.includes('卡片管理'), '渲染卡片管理页');
  ok(root.innerHTML.includes('第 1/4 页'), '400 张 → 第 1/4 页');
  ok(root.innerHTML.includes('第 1–100 张 / 共 400 张'), '第 1 页区间文案');
  ok((root.innerHTML.match(/class="card-row glass"/g) || []).length === 100, '第 1 页只渲染 100 行（非全部 400）');

  globalThis.location.hash = '#/deck/' + big.id + '/cards?page=3';
  decks.renderCards(root, big.id);
  ok(root.innerHTML.includes('第 3/4 页'), 'URL ?page=3 → 第 3/4 页');
  ok(root.innerHTML.includes('第 201–300 张 / 共 400 张'), '第 3 页区间文案');
  ok((root.innerHTML.match(/class="card-row glass"/g) || []).length === 100, '第 3 页渲染 100 行');

  globalThis.location.hash = '#/deck/' + big.id + '/cards?page=4';
  decks.renderCards(root, big.id);
  ok(root.innerHTML.includes('第 4/4 页'), '末页页号正确');
  ok((root.innerHTML.match(/class="card-row glass"/g) || []).length === 100, '末页渲染 100 行');

  globalThis.location.hash = '#/deck/' + big.id + '/cards?page=99';
  decks.renderCards(root, big.id);
  ok(root.innerHTML.includes('第 4/4 页'), '越界页号被夹取到最后一页');

  // 小卡组不出分页条
  globalThis.location.hash = '#/deck/' + demo.id + '/cards';
  decks.renderCards(root, demo.id);
  ok(!root.innerHTML.includes('cards-page'), '≤100 张不渲染卡片分页条');
  globalThis.location.hash = prevHash;
}

// ---- 翻转记忆 ----
review.renderReview(root, demo.id, 0, 'learn');
ok(root.innerHTML.includes('review-view') && root.innerHTML.includes('flashcard3d'), '翻转记忆界面渲染');
ok(root.innerHTML.includes('review-flip'), '卡片可点击翻面');
ok(root.innerHTML.includes('review-rate'), '四档反馈按钮渲染');
ok((root.innerHTML.match(/fb-btn/g) || []).length === 4, '反馈按钮恰为 4 个');
ok(root.innerHTML.includes('word0') && root.innerHTML.includes('1 / 20'), '进度与第一张卡片正确');
ok(root.innerHTML.includes('swipe-hint'), '翻转记忆含快捷键/手势提示');
ok((root.innerHTML.match(/fb-key/g) || []).length === 4, '四个反馈按钮均含快捷键标记');

// ---- 翻转记忆 · 键盘与手势映射 ----
console.log('\n[翻转记忆 · 键盘与手势映射]');
ok(review.directionToFeedback(60, 0) === 'easy', '右滑 → 轻松 easy');
ok(review.directionToFeedback(-60, 0) === 'hard', '左滑 → 困难 hard');
ok(review.directionToFeedback(0, -60) === 'good', '上滑 → 记住 good');
ok(review.directionToFeedback(0, 60) === 'again', '下滑 → 重来 again');
ok(review.directionToFeedback(10, 10) === null, '位移不足阈值 → 视为点击');
ok(review.directionToFeedback(60, 40) === 'easy', '横向占优 → 按左右判定');
ok(review.directionToFeedback(0, -40, 32) === 'good', '自定义阈值生效');
ok(review.keyToFeedback({ key: 'ArrowRight' }) === 'easy', '→ 轻松');
ok(review.keyToFeedback({ key: 'ArrowUp' }) === 'good', '↑ 记住');
ok(review.keyToFeedback({ key: 'ArrowLeft' }) === 'hard', '← 困难');
ok(review.keyToFeedback({ key: 'ArrowDown' }) === 'again', '↓ 重来');
ok(review.keyToFeedback({ key: 'Enter' }) === 'easy', 'Enter 轻松');
ok(review.keyToFeedback({ key: 'Enter', shiftKey: true }) === 'good', 'Shift+Enter 记住');
ok(review.keyToFeedback({ key: 'Backspace' }) === 'hard', 'Backspace 困难');
ok(review.keyToFeedback({ key: 'a' }) === null, '无关按键返回 null');
ok(review.isFlipKey({ key: ' ' }) === true, '空格 → 翻面');
ok(review.isFlipKey({ key: 'Enter' }) === false, 'Enter 不是翻面键');
ok(review.SWIPE_THRESHOLD > 0, '滑动阈值已定义（' + review.SWIPE_THRESHOLD + 'px）');

// ---- 测试题 ----
testMod.renderTest(root, demo.id, 0);
ok(root.innerHTML.includes('q-prompt'), '测试题渲染题目');
const optCount = (root.innerHTML.match(/class="opt /g) || []).length;
ok(optCount === 4 || root.innerHTML.includes('fill-field'), '渲染当前题（选择题 4 选项 或 填空题输入框）');
ok(root.innerHTML.includes('test-pick') || root.innerHTML.includes('test-fill-submit'), '题目可作答');
ok(root.innerHTML.includes('已答对 0 / 0'), '进度为 0');
ok(root.innerHTML.includes('quiz-kbd-hint'), '含键盘操作提示');
ok(!root.innerHTML.includes('quiz-feedback'), '未作答时无反馈条');

// ---- 三种题型随机混合 buildQuestions（v0.3）----
console.log('\n[三种题型随机混合 buildQuestions]');
{
  const qs = testMod.buildQuestions(demo, 0);
  ok(qs.length === 20, 'buildQuestions 每张卡一题（20 题）');
  ok(qs.every((q) => testMod.QUESTION_TYPES.includes(q.type)), '每题 type 均属于五种题型之一');
  const mcq = qs.filter((q) => q.type !== 'fill');
  ok(mcq.every((q) => q.options.length === 4), '选择题每题 4 个选项');
  ok(mcq.every((q) => q.options.filter((o) => o.isCorrect).length === 1), '选择题恰有 1 个正确项');
  ok(mcq.every((q) => new Set(q.options.map((o) => o.text)).size === 4), '选择题选项文本互不重复');
  const fills = testMod.buildQuestions(demo, 0, { types: ['fill'] });
  ok(fills.every((q) => q.type === 'fill' && Array.isArray(q.accepts) && q.accepts.length > 0), 'fill：每题含可接受答案集 accepts');

  // 填空 🔊 发音控件（本环境无 TTS → 走降级分支）
  storage.setItem('mycard-test-session', JSON.stringify({ deckId: demo.id, level: 0, questions: fills, pos: 0, correct: 0 }));
  testMod.renderTest(root, demo.id, 0);
  ok(testMod.canSpeak() === false, '无 speechSynthesis → canSpeak() false');
  ok(!root.innerHTML.includes('class="fill-speak"'), '无 TTS → 不渲染 🔊 按钮');
  ok(root.innerHTML.includes('class="fill-ipa"'), '无 TTS → 渲染降级音标位（无 phonetic 时显示单词）');
  ok(root.innerHTML.includes('fill-field') && root.innerHTML.includes('test-fill-submit'), '填空输入框与提交按钮不受影响');
  const listens = testMod.buildQuestions(demo, 0, { types: ['listen'] });
  ok(
    listens.every((q) => q.type === 'listen' && q.options.length === 4 && q.options.filter((o) => o.isCorrect).length === 1),
    'listen：听音辨意题含 4 选项且恰 1 个正确项'
  );
  const def = testMod.buildQuestions(demo, 0, { types: ['def2word'] })[0];
  ok(def.type === 'def2word' && def.options.some((o) => o.isCorrect && o.text === 'word0'), 'def2word：正确项为 front（word0）');
  const w2d = testMod.buildQuestions(demo, 0, { types: ['word2def'] })[0];
  ok(w2d.type === 'word2def' && w2d.options.some((o) => o.isCorrect && o.text === '释义 0'), 'word2def：正确项为释义（释义 0）');
  const s2w = testMod.buildQuestions(demo, 0, { types: ['sentence2word'] })[0];
  ok(s2w.type === 'word2def', '例句不含目标词时 sentence2word 安全回退为 word2def');
}

// ---- 选择题作答机会（答对自动跳；两次答错重选；第三次也自动跳）----
console.log('\n[选择题作答机会 applyAttempt]');
const mkQuizQ = () => ({
  options: [
    { key: 0, text: 'A', isCorrect: false },
    { key: 1, text: 'B', isCorrect: false },
    { key: 2, text: 'C', isCorrect: false },
    { key: 3, text: 'D', isCorrect: true }
  ],
  answered: false,
  correct: false,
  attempts: 0,
  wrongPicks: [],
  lastPicked: null
});
{
  const q = mkQuizQ();
  const r1 = testMod.applyAttempt(q, 0);
  ok(!r1.resolved && q.attempts === 1 && q.wrongPicks.includes(0) && !q.answered, '第 1 次选错：留在本题可重选');
  const r2 = testMod.applyAttempt(q, 1);
  ok(!r2.resolved && q.attempts === 2 && q.wrongPicks.length === 2 && !q.answered, '第 2 次选错：仍有最后 1 次机会');
  const r3 = testMod.applyAttempt(q, 2);
  ok(r3.resolved && !r3.correct && q.answered && q.attempts === 3, '第 3 次选错：本题结束并自动跳下一题（计错）');
  const r4 = testMod.applyAttempt(q, 3);
  ok(!r4.correct && q.attempts === 3 && !q.correct, '已解决后不再响应作答');
}
{
  const q = mkQuizQ();
  testMod.applyAttempt(q, 0);
  const r2 = testMod.applyAttempt(q, 3);
  ok(r2.resolved && r2.correct && q.correct && q.attempts === 2, '第 2 次选对：计为正确');
}
{
  const q = mkQuizQ();
  const r = testMod.applyAttempt(q, 3);
  ok(r.resolved && r.correct && q.correct && q.attempts === 1, '首次即答对：立即正确并自动跳下一题');
}
ok(testMod.MAX_ATTEMPTS === 3, 'MAX_ATTEMPTS = 3（两次机会，第三次自动跳）');

// ---- 设置页（经由 app.render 需要 DOM 较复杂，跳过）----

// ---- 题型比例面板：可选题型（英英选择 / 多义多选） ----
console.log('\n[题型比例面板 · 可选题型]');
{
  const cfg = await import('../js/test-config.js');
  const panel = fakeEl();
  testMod.renderDeckTestConfig(panel, demo.id);
  ok(panel.innerHTML.includes('题型比例'), '渲染题型比例面板');
  ok(panel.innerHTML.includes('deck-test-type-toggle'), '提供可选题型启用开关');
  ok(panel.innerHTML.includes('建议考研及以上水平使用'), '标注「建议考研及以上水平使用」');
  ok(panel.innerHTML.includes('英英选择') && panel.innerHTML.includes('多义多选'), '列出两种可选题型');
  ok(!panel.innerHTML.includes('wt-input-eng_eng'), '未启用时不渲染 eng_eng 滑块');

  const c0 = cfg.loadConfig();
  const on = cfg.setTypeEnabled(c0.weights, c0.enabled, 'eng_eng', true);
  cfg.saveConfig({ weights: on.weights, enabled: on.enabled });
  testMod.renderDeckTestConfig(panel, demo.id);
  ok(panel.innerHTML.includes('wt-input-eng_eng'), '启用后出现第 6 个滑块');
  ok(panel.innerHTML.includes('已启用'), '开关显示「已启用」');

  const c1 = cfg.loadConfig();
  const off = cfg.setTypeEnabled(c1.weights, c1.enabled, 'eng_eng', false);
  cfg.saveConfig({ weights: off.weights, enabled: off.enabled });
  testMod.renderDeckTestConfig(panel, demo.id);
  ok(!panel.innerHTML.includes('wt-input-eng_eng'), '停用后滑块消失');
  ok(cfg.loadConfig().enabled.eng_eng === false, '停用状态已保存');
}

// ---- 应用入口（app.js）：启动流程与首页渲染 ----
console.log('\n[应用入口 app.js]');
ok(typeof store.storageInfo === 'function', 'store.storageInfo 可用（设置页数据）');
ok(store.storageInfo().mode === 'localstorage', '无 IndexedDB 环境自动回退 localStorage 模式');
ok(store.storageInfo().cards === store.getDb().decks.reduce((n, d) => n + d.cards.length, 0), 'storageInfo 卡片数统计正确');
try {
  await import('../js/app.js'); // 触发 boot()：store.init() → 自动导入（离线失败已兜底）→ render()
  await new Promise((r) => setTimeout(r, 80));
  ok(true, 'app.js 启动流程未抛错（存储初始化 + 路由渲染）');
} catch (e) {
  ok(false, 'app.js 启动抛错：' + (e && e.message));
}

// ---- 表格编辑页（app.render → #/editor）----
console.log('\n[表格编辑页 #/editor]');
{
  const te = await import('../js/table-editor.js');
  ok(appViewEl.innerHTML.includes('data-action="open-table-editor"'), '首页导入栏含「在网页里填表格」入口');

  globalThis.location.hash = '#/editor';
  (winListeners['hashchange'] || []).forEach((fn) => fn({ type: 'hashchange' }));
  const html = appViewEl.innerHTML;
  ok(html.includes('class="view table-editor-view"'), '路由 #/editor 渲染表格编辑页');
  ok(html.includes('class="te-table"'), '渲染可编辑表格');
  ok(html.includes('class="te-stats"'), '渲染统计条');
  ok(html.includes('class="te-tools"'), '渲染工具栏');
  ok(html.includes('class="te-target"'), '渲染目标卡组选择');
  for (const col of te.TABLE_COLUMNS) {
    ok(html.includes(`<th scope="col">${col}</th>`), `表头列「${col}」`);
  }
  ok((html.match(/class="te-cell"/g) || []).length === 18, '默认 3 行 × 6 列可编辑单元格（实际 ' + (html.match(/class="te-cell"/g) || []).length + '）');
  ok(
    ['te-import-deck', 'te-load-file', 'te-add-row', 'te-download', 'te-clear', 'te-target', 'te-deck-name', 'te-cell'].every((a) =>
      html.includes(`data-action="${a}"`)
    ),
    '工具栏 / 目标卡组控件齐全'
  );
  ok(html.includes('value="表格导入"'), '默认新卡组名「表格导入」');
  ok(html.includes('＋ 新建卡组'), '默认目标为「新建卡组」');
  ok((html.match(/<textarea class="te-cell"/g) || []).length === 18, '单元格为自适应 textarea（长文本可编辑，v0.5.5）');
  ok(html.includes('<input class="te-cell"') === false && html.includes('rows="1"'), '不再用单行 <input>（rows=1 + 自动增高）');
  ok(html.includes('粘贴到单元格') && html.includes('预览 / 校验报告'), '页面提示含「粘贴多行」与「导入前预览」');
  ok((docListeners.paste || []).length >= 1, '编辑页注册文档级 paste 监听（多行粘贴自动扩行）');

  await fire('te-add-row');
  ok((appViewEl.innerHTML.match(/class="te-cell"/g) || []).length === 24, '点「＋ 添加一行」→ 4 行（24 格）');

  globalThis.location.hash = '#/home';
  (winListeners['hashchange'] || []).forEach((fn) => fn({ type: 'hashchange' }));
  ok(appViewEl.innerHTML.includes('我的卡组'), '从编辑页返回首页仍正常渲染');
}

// ---- 设置页（app.render → renderSettings）：主题色区块 ----
console.log('\n[设置页 · 主题色]');
{
  globalThis.location.hash = '#/settings';
  (winListeners['hashchange'] || []).forEach((fn) => fn({ type: 'hashchange' }));
  ok(appViewEl.innerHTML.includes('主题色'), '设置页渲染「主题色」区块');
  ok(appViewEl.innerHTML.includes('theme-swatches') && appViewEl.innerHTML.includes('set-accent'), '渲染预设色块且可点击');
  ok(appViewEl.innerHTML.includes('accent-input'), '渲染自定义取色输入框');
  ok(appViewEl.innerHTML.includes('is-active'), '当前主题色对应色块高亮');
  ok(appViewEl.innerHTML.includes('重新划分'), '关卡设置说明含「改词数即刻重新划分」提示');
  ok(appViewEl.innerHTML.includes('hard-refresh'), '设置页提供「强制刷新到最新版」入口（清理旧缓存）');
  await fire('set-accent', { color: '#34d399' });
  ok(globalThis.localStorage.getItem('mycard-accent') === '#34d399', '点击预设色块后保存主题色到 localStorage');
  ok(appViewEl.innerHTML.includes('#34d399'), '设置页重渲染后新主题色高亮');
}

// ---- 设置页：外观（明暗模式）+ 顶栏快捷切换 ----
console.log('\n[设置页 · 外观（明暗模式）]');
{
  ok(appViewEl.innerHTML.includes('外观'), '设置页渲染「外观」区块');
  ok(appViewEl.innerHTML.includes('segmented') && appViewEl.innerHTML.includes('set-mode'), '渲染分段按钮（set-mode）');
  ok(
    appViewEl.innerHTML.includes('data-mode="light"') &&
      appViewEl.innerHTML.includes('data-mode="dark"') &&
      appViewEl.innerHTML.includes('data-mode="system"'),
    '三档：浅色 / 深色 / 跟随系统'
  );
  ok(appViewEl.innerHTML.includes('跟随系统'), '含「跟随系统」文案');

  ok(appbarSideEl.innerHTML.includes('toggle-mode'), '顶栏渲染明暗快捷切换按钮');
  ok(/切换到(浅色|深色)模式/.test(appbarSideEl.innerHTML), '顶栏按钮带无障碍标签', appbarSideEl.innerHTML.slice(0, 80));

  await fire('set-mode', { mode: 'light' });
  ok(globalThis.localStorage.getItem('mycard-mode') === 'light', '点击「浅色」保存到 localStorage');
  ok(globalThis.document.documentElement.dataset.theme === 'light', '<html data-theme="light">');
  ok(appViewEl.innerHTML.includes('is-active') && appViewEl.innerHTML.includes('data-mode="light"'), '浅色档位高亮');

  await fire('toggle-mode');
  ok(globalThis.localStorage.getItem('mycard-mode') === 'dark', '顶栏切换 → 深色并保存');
  ok(globalThis.document.documentElement.dataset.theme === 'dark', '<html data-theme="dark">');

  await fire('toggle-mode');
  ok(globalThis.localStorage.getItem('mycard-mode') === 'light', '再切一次 → 回到浅色');
}

console.log('\n[卡组菜单 · 导出 txt / csv / md / json / apkg]');
{
  globalThis.location.hash = '#/home';
  (winListeners['hashchange'] || []).forEach((fn) => fn({ type: 'hashchange' }));
  await fire('deck-options', { id: demo.id });
  const modal = fakeBody.children.filter((c) => c && c.className === 'modal-overlay').pop();
  const html = modal ? String(modal.innerHTML) : '';
  ok(html.includes('export-txt'), '卡组菜单含「导出为 txt 词表」');
  ok(html.includes('export-csv'), '卡组菜单含「导出为 CSV（带表头）」');
  ok(html.includes('export-md'), '卡组菜单含「导出为 Markdown」');
  ok(html.includes('export-json'), '卡组菜单含「导出为 JSON（含复习进度）」');
  ok(html.includes('export-apkg'), '卡组菜单含「导出为 Anki 卡包（.apkg）」');
  ok(html.includes('data-action="export-txt"') && html.includes(`data-id="${demo.id}"`), '导出按钮带卡组 id');
  ok(html.includes('data-action="export-csv"') && html.includes(`data-id="${demo.id}"`), 'CSV 按钮带卡组 id');
  ok(html.includes('data-action="export-md"') && html.includes(`data-id="${demo.id}"`), 'Markdown 按钮带卡组 id');
  ok(html.includes('data-action="export-json"') && html.includes(`data-id="${demo.id}"`), 'JSON 按钮带卡组 id');
  ok(html.includes('导出为 txt 词表') && html.includes('Anki'), '导出文案正确');
  ok(html.includes('导出为 CSV（带表头）') && html.includes('导出为 Markdown'), 'CSV / Markdown 文案正确');
  ok(html.includes('导出为 JSON（含复习进度）'), 'JSON 导出文案正确');
}

// ---- 生词本整理页（app.render → #/words，v0.5.9）----
console.log('\n[生词本整理页 #/words]');
{
  const wb = await import('../js/wordbook.js');
  const wbv = await import('../js/wordbook-view.js');

  // 造数据：我的生词（含标签 / 缺释义 / 大小写不同的重复卡）
  store.addWords(
    [
      { word: 'apple', back: 'n. 苹果', tags: ['水果'] },
      { word: 'banana', back: 'n. 香蕉', tags: ['水果'] },
      { word: 'cherry', back: '', tags: [] }
    ],
    { src: 'custom' }
  );
  const ud = store.getUserDeck();
  store.addCard(ud.id, { front: 'Apple', back: 'n. 苹果树' });
  const cherry = store.getUserDeck().cards.find((c) => c.front === 'cherry');

  globalThis.location.hash = '#/words';
  (winListeners['hashchange'] || []).forEach((fn) => fn({ type: 'hashchange' }));
  let html = appViewEl.innerHTML;
  ok(html.includes('class="view view-wordbook"'), '路由 #/words 渲染生词本整理页');
  ok(html.includes('id="wb-search"') && html.includes('data-action="wb-sort"'), '工具栏：搜索框 + 排序下拉');
  ok(html.includes('data-action="wb-tag"') && html.includes('data-action="wb-src"'), '筛选：标签 chips + 来源 chips');
  ok(html.includes('data-action="wb-toggle-missing"') && html.includes('只看缺释义'), '筛选：只看缺释义');
  ok(html.includes('data-action="wb-dedupe-report"') && html.includes('data-action="wb-go-add"'), '底部：合并重复词 + 添加生词');
  ok(html.includes('重复词组') && html.includes('未打标签'), '概览含重复词组 / 未打标签统计');
  ok(html.includes('（缺释义，可「在线补查」）'), '缺释义的卡片带补查提示');
  ok(!html.includes('class="wb-batch glass"'), '未勾选时不出批量操作栏');

  // 多选 → 批量操作栏
  await fireOn('change', 'wb-pick', { dataset: { card: cherry.id }, checked: true });
  ok(appViewEl.innerHTML.includes('已选 <b>1</b> 张'), '勾选 1 张 → 批量操作栏显示计数');
  await fireOn('change', 'wb-pick-page', { checked: true });
  ok(appViewEl.innerHTML.includes(`已选 <b>${store.getUserDeck().cards.length}</b> 张`), '「本页全选」勾选本页全部卡片');
  await fireOn('change', 'wb-pick-page', { checked: false });
  ok(!appViewEl.innerHTML.includes('class="wb-batch glass"'), '取消本页全选 → 批量操作栏消失');

  // 批量标签弹窗
  await fireOn('change', 'wb-pick', { dataset: { card: cherry.id }, checked: true });
  await fire('wb-batch-tag');
  const tm = fakeBody.children.filter((c) => c && c.className === 'modal-overlay').pop();
  const thtml = tm ? String(tm.innerHTML) : '';
  ok(thtml.includes('给选中的 1 张加标签') && thtml.includes('name="tags"'), '「加标签」弹窗（含标签输入框）');
  ok(thtml.includes('data-action="wb-quick-tag"'), '弹窗提供已用标签快捷填入');
  ok(thtml.includes('只影响当前勾选的 1 张卡片'), '弹窗说明只影响勾选卡片');

  // 标签管理弹窗（重命名 / 删除）
  await fire('wb-tag-manage');
  const gm = fakeBody.children.filter((c) => c && c.className === 'modal-overlay').pop();
  const ghtml = gm ? String(gm.innerHTML) : '';
  ok(ghtml.includes('标签管理') && ghtml.includes('name="from"') && ghtml.includes('name="to"'), '「标签管理」弹窗含 from/to 字段');
  ok(ghtml.includes('留空 = 删除该标签'), '标签管理说明「留空 = 删除」');

  // 搜索 / 筛选（DOM 层）
  await fire('wb-all');
  ok(wbv.getViewState().tag === wb.ALL && wbv.getViewState().src === wb.ALL && !wbv.getViewState().missing, '「全部」清空筛选');
  await fire('wb-tag', { tag: '水果' });
  ok(wbv.getViewState().tag === '水果' && /筛选出 \d+/.test(appViewEl.innerHTML), '点标签 chip → 筛选并显示结果数');
  await fire('wb-toggle-missing');
  ok(wbv.getViewState().missing === true && appViewEl.innerHTML.includes('显示全部'), '「只看缺释义」切换为显示全部');

  // 分页（>100 张）：先清掉筛选，否则「只看缺释义」会只剩 1 张
  await fire('wb-all');
  store.addWords(
    Array.from({ length: 120 }, (_, i) => ({ word: 'smoke' + i, back: '释义' + i })),
    { src: 'custom' }
  );
  globalThis.location.hash = '#/words';
  (winListeners['hashchange'] || []).forEach((fn) => fn({ type: 'hashchange' }));
  ok(appViewEl.innerHTML.includes('第 1/2 页'), '超过 100 张 → 渲染分页条');
  await fire('wb-page', { page: '2' });
  ok(globalThis.location.hash === '#/words?page=2', '点「下一页」→ URL 写入 #/words?page=2（可回退）');
  (winListeners['hashchange'] || []).forEach((fn) => fn({ type: 'hashchange' }));
  ok(appViewEl.innerHTML.includes('第 2/2 页'), '回到第 2 页仍能渲染');

  // 去重合并：报告弹窗 → 确认合并
  globalThis.location.hash = '#/words';
  (winListeners['hashchange'] || []).forEach((fn) => fn({ type: 'hashchange' }));
  await fire('wb-dedupe-report');
  const dm = fakeBody.children.filter((c) => c && c.className === 'modal-overlay').pop();
  const dhtml = dm ? String(dm.innerHTML) : '';
  ok(dhtml.includes('合并重复词 · 1 组'), '「合并重复词」先弹报告（1 组）');
  ok(dhtml.includes('apple') && dhtml.includes('n. 苹果树') && dhtml.includes('合并后删掉'), '报告列出重复词与合并后的释义（原释义仍是第一义）');
  const merged = wbv.mergeDuplicates();
  ok(merged.groups === 1 && merged.removed === 1, '确认后合并：1 组 → 删 1 张副卡', merged);
  ok(store.getUserDeck().cards.filter((c) => c.front.toLowerCase() === 'apple').length === 1, '合并后重复词只剩 1 张');

  // 首页 / 卡组菜单入口
  globalThis.location.hash = '#/home';
  (winListeners['hashchange'] || []).forEach((fn) => fn({ type: 'hashchange' }));
  ok(appViewEl.innerHTML.includes('data-action="nav-words"'), '首页有「整理生词本」入口');
  await fire('deck-options', { id: store.getUserDeck().id });
  const om = fakeBody.children.filter((c) => c && c.className === 'modal-overlay').pop();
  ok(String(om ? om.innerHTML : '').includes('整理生词本（去重 / 标签）'), '生词卡组菜单含「整理生词本（去重 / 标签）」');
  await fire('nav-words');
  ok(globalThis.location.hash === '#/words', '点入口 → 跳到 #/words');
}

// ---- 明牌配对（#/match/{deck}，v0.5.11）----
console.log('\n[明牌配对 · 棋盘页（#/match）]');
{
  const mp = store.seedBuiltinDeck(
    {
      name: '配对冒烟组',
      levelSize: 20,
      words: Array.from({ length: 60 }, (_, i) => ({ front: 'mt' + i, back: '释义' + i }))
    },
    { demo: false, source: 'smoke-match' }
  );
  ok(!!mp && new Set(store.getDeck(mp.id).cards.map((c) => c.level)).size === 3, '配对卡组就绪（60 张 / 3 关）');
  ok(match.unlockInfo(store.getDeck(mp.id)).unlocked === false, '一关未通关 → 未解锁');

  decks.renderDeck(root, mp.id);
  ok(!root.innerHTML.includes('open-match'), '未解锁的卡组详情页没有配对入口');

  for (const i of [0, 1, 2]) {
    store.markLevelLearned(mp.id, i);
    store.markLevelPassed(mp.id, i);
  }
  ok(match.unlockInfo(store.getDeck(mp.id)).unlocked === true, '通关 3 关 → 解锁');
  decks.renderDeck(root, mp.id);
  ok(root.innerHTML.includes('data-action="open-match"'), '卡组详情页出现「明牌配对」入口横幅');
  ok(root.innerHTML.includes('match-banner glass'), '横幅挂上 .match-banner 样式');

  globalThis.location.hash = '#/match/' + mp.id;
  (winListeners['hashchange'] || []).forEach((fn) => fn({ type: 'hashchange' }));
  const html = appViewEl.innerHTML;
  ok(html.includes('明牌配对 · 第 3 关'), '默认开局最高已通关关卡（第 3 关）');
  ok((html.match(/data-action="match-pick"/g) || []).length === 40, '渲染 40 张明牌（2N）');
  ok(html.includes('match-tile-word') && html.includes('match-tile-def'), '词牌 / 义牌外观区分');
  ok(html.includes('role="progressbar" aria-label="配对进度"'), '进度条带 aria 标注');
  ok(html.includes('id="match-result"'), '结算面板容器已渲染');
  const ms = match.getMatchSession();
  ok(!!ms && ms.deckId === mp.id && ms.level === 2 && ms.tiles.length === 40, '会话已建立（第 3 关 / 40 张牌）');

  const mw = ms.tiles.find((t) => t.kind === 'word');
  await fire('match-pick', { tile: mw.id });
  ok(match.getMatchSession().selectedId === mw.id, '点词牌 → 选中');
  await fire('match-pick', { tile: 'd-' + mw.cardId });
  ok(match.getMatchSession().matched.length === 2, '词 + 义（同卡）→ 配对成功');

  globalThis.location.hash = '#/deck/' + mp.id;
  (winListeners['hashchange'] || []).forEach((fn) => fn({ type: 'hashchange' }));
  ok(match.getMatchSession() === null, '路由切换 → 清空配对会话');
}

console.log(`\n冒烟结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
