#!/usr/bin/env node
// ============================================================================
// test-crossword.mjs — 填字游戏（v0.6.0，js/crossword.js）
//   运行: node scripts/test-crossword.mjs
// 覆盖：① 解锁判定（通关 ≥1 关解锁 / 词源合法性 / 默认词源）
//       ② 词条清洗（纯字母 / 长度边界 / 线索兜底 / 同词去重）
//       ③ 交叉排版规则（canPlace 四条 + findPlacement 评分 + 可复现）
//       ④ 棋盘生成（按词数抽词 / 词全在盘上 / 每词与格子字母一致 / 无非法相邻 / 编号）
//       ⑤ 状态机（写入与清除 / 检查标错 / 提示 / 显示本词 / 进度 / 用时文案 / 格子尺寸）
//       ⑥ 薄 UI（DOM 桩：整页渲染 / 输入打补丁不整页重渲染 / 焦点推进 / 检查 / 结算 /
//          会话复活与清场 / 卡组详情页入口横幅）
// ============================================================================

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOTDIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOTDIR, p), 'utf8');

const mem = {};
const mkStorage = () => ({
  getItem: (k) => (k in mem ? mem[k] : null),
  setItem: (k, v) => {
    mem[k] = String(v);
  },
  removeItem: (k) => {
    delete mem[k];
  },
  clear: () => {
    for (const k of Object.keys(mem)) delete mem[k];
  }
});
globalThis.localStorage = mkStorage();
globalThis.sessionStorage = mkStorage();

function mkEl(tag = 'div') {
  return {
    tagName: String(tag).toUpperCase(),
    _html: '',
    textContent: '',
    value: '',
    className: '',
    style: {},
    dataset: {},
    disabled: false,
    hidden: false,
    focusCount: 0,
    parentElement: null,
    _attrs: {},
    _listeners: {},
    classList: {
      _s: new Set(),
      add(...c) {
        c.forEach((x) => this._s.add(x));
      },
      remove(...c) {
        c.forEach((x) => this._s.delete(x));
      },
      toggle(c, force) {
        const want = force === undefined ? !this._s.has(c) : !!force;
        if (want) this._s.add(c);
        else this._s.delete(c);
        return want;
      },
      contains(c) {
        return this._s.has(c);
      }
    },
    get innerHTML() {
      return this._html;
    },
    set innerHTML(v) {
      this._html = String(v);
    },
    setAttribute(k, v) {
      this._attrs[k] = String(v);
    },
    getAttribute(k) {
      return k in this._attrs ? this._attrs[k] : null;
    },
    insertAdjacentHTML() {},
    addEventListener(t, fn) {
      (this._listeners[t] = this._listeners[t] || []).push(fn);
    },
    removeEventListener() {},
    appendChild(c) {
      c.parentElement = c.parentElement || this;
      return c;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
    focus() {
      this.focusCount++;
      doc.activeElement = this;
    },
    remove() {},
    click() {}
  };
}

/* ---- 棋盘 DOM 桩：innerHTML 一写入，就按当前会话重建「格 / 线索 / 统计格」 ---- */
/* 规则与真实页面一致：格是持久 input 节点 → 打字只改 value / class（不重建网格） */

let cells = []; // 字母格（.cw-cell，内含 .cw-input）
let inputs = []; // .cw-input
let clueBtns = []; // .cw-clue
let rootSets = 0; // 整页重渲染次数（打字时必须为 0：只打补丁）
let cwApi = null; // 动态 import 后回填
const session = () => (cwApi ? cwApi.getCrosswordSession() : null);

const resultPanel = mkEl('div');
const newBtn = mkEl('button');
resultPanel.querySelector = (sel) => (sel === '[data-action="cw-new"]' ? newBtn : null);
const announceEl = mkEl('div');
const progressBar = mkEl('div');
const progressFill = mkEl('i');
progressBar.querySelector = (sel) => (sel === '.progress-fill' ? progressFill : null);
const statEls = {};
for (const k of ['status', 'words', 'time', 'hints', 'empty']) statEls[k] = mkEl('b');

const ROOT = mkEl('div');
Object.defineProperty(ROOT, 'innerHTML', {
  get() {
    return this._html;
  },
  set(v) {
    this._html = String(v);
    syncDom();
  }
});
ROOT.closest = (sel) => (sel === '#view' ? ROOT : null);

function mkCellEl(cell) {
  const wrap = mkEl('div');
  wrap.dataset.cell = `${cell.row},${cell.col}`;
  wrap.classList.add('cw-cell');
  const input = mkEl('input');
  input.classList.add('cw-input'); // 真实页面由 class="cw-input" 标出
  input.dataset.action = 'cw-type';
  input.dataset.cell = wrap.dataset.cell;
  input.closest = (sel) => (sel === '[data-action]' ? input : null);
  input.parentElement = wrap;
  inputs.push(input);
  cells.push(wrap);
  return wrap;
}

function syncDom() {
  rootSets++;
  doc.activeElement = null; // 整页重写会丢焦点（与真实 DOM 一致）→ 键盘落点回退到「当前线索」
  cells = [];
  inputs = [];
  clueBtns = [];
  const s = session();
  if (!s || !s.board || !s.board.cells || !s.board.cells.length) return;
  const map = new Map(s.board.cells.map((c) => [`${c.row},${c.col}`, c]));
  for (let r = 0; r < s.board.rows; r++) {
    for (let c = 0; c < s.board.cols; c++) {
      const cell = map.get(`${r},${c}`);
      if (cell) mkCellEl(cell);
    }
  }
  for (const w of s.board.words) {
    const btn = mkEl('button');
    btn.dataset.action = 'cw-clue';
    btn.dataset.word = String(w.id);
    btn.closest = (sel) => (sel === '[data-action]' ? btn : null);
    clueBtns.push(btn);
  }
  // 统计格：真实页面由 HTML 直接渲染初值，这里按会话状态回填（便于断言）
  if (cwApi) {
    const p = cwApi.progress(s);
    const st = cwApi.playStats(s);
    statEls.status.textContent = cwApi.statusText(s, p);
    statEls.words.textContent = `${p.wordsSolved}/${p.words}`;
    statEls.time.textContent = cwApi.formatDuration(st.elapsedMs);
    statEls.hints.textContent = String(st.hints);
    statEls.empty.textContent = String(p.empty);
  }
}

ROOT.querySelectorAll = (sel) => {
  if (sel === '.cw-input') return inputs.slice();
  if (sel === '.cw-cell') return cells.slice();
  if (sel === '.cw-clue') return clueBtns.slice();
  return [];
};

const docListeners = {}; // type → handlers[]（键盘 / 焦点监听，用于验证只绑一次 + 键盘交互）
const doc = {
  body: mkEl('body'),
  documentElement: mkEl('html'),
  activeElement: null,
  addEventListener(type, fn) {
    (docListeners[type] = docListeners[type] || []).push(fn);
  },
  removeEventListener() {},
  createElement: (t) => mkEl(t),
  querySelector: () => null,
  // 字母键盘（js/keyboard.js）用 document.querySelectorAll 同步输入框 inputmode → 委托给棋盘桩
  querySelectorAll: (sel) => ROOT.querySelectorAll(sel),
  getElementById: (id) =>
    id === 'view'
      ? ROOT
      : id === 'cw-result'
        ? resultPanel
        : id === 'cw-progress'
          ? progressBar
          : id === 'sr-announce'
            ? announceEl
            : id === 'kb-bar'
              ? kbBar
              : id.startsWith('cw-')
                ? statEls[id.slice(3)] || null
                : null
};
// 记录 keyboard.js 创建的底栏（模拟真实 DOM 里 <body> 下的 #kb-bar 单例）
let kbBar = null;
{
  const bodyEl = doc.body;
  const append = bodyEl.appendChild.bind(bodyEl);
  bodyEl.appendChild = (c) => {
    if (c && c.id === 'kb-bar') kbBar = c;
    return append(c);
  };
}
const bar = () => kbBar;
globalThis.document = doc;
globalThis.window = { addEventListener() {}, dispatchEvent() {}, scrollTo() {}, innerWidth: 390, innerHeight: 780 };
globalThis.location = { hash: '#/home', href: '' };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.HashChangeEvent = class HashChangeEvent {
  constructor(type) {
    this.type = type;
  }
};


/* ------------------------------ 载入模块 ------------------------------ */

const store = await import('../js/store.js');
const ui = await import('../js/ui.js');
const cw = await import('../js/crossword.js');
const kb = await import('../js/keyboard.js'); // v0.7.0 移动端字母键盘
const decks = await import('../js/decks.js'); // 卡组详情页入口横幅
cwApi = cw;

let pass = 0;
let fail = 0;
const ok = (c, m, extra) => {
  if (c) {
    pass++;
    console.log('  ✓ ' + m);
  } else {
    fail++;
    console.error('  ✗ ' + m + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
};

/** 触发一次 data-action（走真实的事件委托） */
function act(action, data = {}, type = 'click') {
  const el = {
    dataset: { action, ...data },
    value: '',
    classList: { add() {}, remove() {}, contains: () => false },
    closest: (sel) => (sel === '[data-action]' || sel === '#view' ? el : null)
  };
  ui.handleEvent({ type, target: { closest: () => el }, preventDefault() {} });
}

/** 在某个格子里「打字」：设置 value 后派发 input 事件（走真实委托） */
function type_(row, col, ch) {
  const el = inputEl(row, col);
  if (!el) return null;
  el.value = ch;
  ui.handleEvent({ type: 'input', target: { closest: () => el }, preventDefault() {} });
  return el;
}

const storedSession = () => {
  const raw = mem[cw.SESSION_KEY];
  return raw ? JSON.parse(raw) : null;
};
const inputEl = (row, col) => inputs.find((i) => i.dataset.cell === `${row},${col}`);
const statText = (key) => (statEls[key] ? statEls[key].textContent : '');

/** 线性同余随机源：seed 相同 → 抽词 / 排版结果完全一致（单测可复现） */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 固定词库（20 个交叉字母丰富的常见词，便于排版） */
const WORDS = [
  'apple',
  'table',
  'radio',
  'ocean',
  'eagle',
  'raise',
  'train',
  'north',
  'story',
  'years',
  'heart',
  'laser',
  'angle',
  'green',
  'alert',
  'steam',
  'pearl',
  'crane',
  'trace',
  'least'
];

function fixtureCards(words = WORDS) {
  return words.map((w, i) => ({ id: `c${i}`, front: w, back: `释义${i}`, extraBacks: [] }));
}

/** 棋盘自检：词都落在盘上、每格字母与所属线索一致、无非法相邻、编号不重复 */
function boardIssues(board) {
  const issues = [];
  const map = new Map(board.cells.map((c) => [`${c.row},${c.col}`, c]));
  for (const w of board.words) {
    for (let i = 0; i < w.len; i++) {
      const r = w.dir === 'across' ? w.row : w.row + i;
      const c = w.dir === 'across' ? w.col + i : w.col;
      const cell = map.get(`${r},${c}`);
      if (!cell) issues.push(`缺格 ${w.answer}@${r},${c}`);
      else if (cell.letter !== w.answer[i]) issues.push(`字母不符 ${w.answer}@${r},${c}`);
      else if (w.dir === 'across' && cell.acrossId !== w.id) issues.push(`横向线索未挂上 ${w.answer}`);
      else if (w.dir === 'down' && cell.downId !== w.id) issues.push(`纵向线索未挂上 ${w.answer}`);
    }
    if (w.num == null) issues.push(`未编号 ${w.answer}`);
  }
  for (const w of board.words) {
    const dr = w.dir === 'across' ? 0 : 1;
    const dc = w.dir === 'across' ? 1 : 0;
    if (map.has(`${w.row - dr},${w.col - dc}`)) issues.push(`词首前有字母 ${w.answer}`);
    if (map.has(`${w.row + dr * w.len},${w.col + dc * w.len}`)) issues.push(`词尾后有字母 ${w.answer}`);
  }
  for (const cell of board.cells) {
    if (cell.acrossId == null && cell.downId == null) issues.push(`孤儿格 ${cell.row},${cell.col}`);
  }
  const nums = board.words.map((w) => w.num).sort((a, b) => a - b);
  if (new Set(nums).size !== nums.length) issues.push('线索编号重复');
  return issues;
}

/** 造卡组：80 张 / 每关 20 → 4 关（单词都含字母，可作为填字词条） */
function seedDeck(name, words = 80) {
  const deck = store.createDeck({ name });
  const suffix = 'abcdefgh';
  store.addManyCards(
    deck.id,
    Array.from({ length: words }, (_, i) => {
      const front = WORDS[i % WORDS.length] + suffix[Math.floor(i / WORDS.length) % suffix.length];
      return { front, back: `释义${i}`, example: `I use ${front}.`, exampleZh: `我用 ${front}。` };
    })
  );
  return store.getDeck(deck.id);
}

function passLevels(deckId, idxs) {
  for (const i of idxs) {
    store.markLevelLearned(deckId, i);
    store.markLevelPassed(deckId, i);
  }
  return store.getDeck(deckId);
}


/* ==========================================================================
 * ① 解锁判定
 * ========================================================================== */

console.log('\n[解锁判定：通关 ≥ 1 关即解锁]');
const deck0 = seedDeck('填字测试', 80);
ok(cw.UNLOCK_LEVELS === 1, 'UNLOCK_LEVELS = 1（通关 1 关就能玩）');
ok(cw.passedCount(deck0) === 0 && !cw.unlockInfo(deck0).unlocked, '一关未通关 → 未解锁');
ok(cw.unlockInfo(deck0).left === 1, '未解锁时提示「还差 1 关」');
passLevels(deck0.id, [0]);
let d1 = store.getDeck(deck0.id);
ok(cw.unlockInfo(d1).unlocked === true && cw.passedCount(d1) === 1, '通关 1 关 → 解锁');
ok(cw.isPlayableLevel(d1, 0) === true && cw.isPlayableLevel(d1, 1) === false, '只有已通关关卡可作词源');
ok(cw.defaultSource(d1).kind === 'level' && cw.defaultSource(d1).level === 0, '默认词源 = 最高的已通关关卡');
ok(cw.isValidSource(d1, { kind: 'deck', level: null }) === true, '「整卡组」永远有效');
ok(cw.isValidSource(d1, { kind: 'level', level: 3 }) === false, '未通关关卡无效（重排后会话会被丢弃）');

passLevels(d1.id, [1, 2, 3]);
d1 = store.getDeck(d1.id);
ok(cw.passedLevels(d1).join() === '0,1,2,3', '已通关关卡升序返回');
ok(cw.defaultSource(d1).level === 3, '默认词源 = 最后一关（第 4 关）');
ok(cw.sourceCards(d1, { kind: 'level', level: 0 }).length === 20, '关卡词源 = 该关 20 张卡');
ok(cw.sourceCards(d1, { kind: 'deck', level: null }).length === 80, '整卡组词源 = 全部 80 张卡');
ok(cw.sourceLabel({ kind: 'level', level: 2 }) === '第 3 关' && cw.sourceLabel({ kind: 'deck' }) === '整卡组', '词源文案');

/* ==========================================================================
 * ② 词条清洗
 * ========================================================================== */

console.log('\n[词条清洗：纯字母 / 长度边界 / 去重]');
ok(cw.sanitizeAnswer('apple') === 'APPLE', '转大写');
ok(cw.sanitizeAnswer('ice cream') === 'ICECREAM', '空格被剔除（只留字母）');
ok(cw.sanitizeAnswer('well-known') === 'WELLKNOWN', '连字符被剔除');
ok(cw.sanitizeAnswer('苹果') === '' && cw.sanitizeAnswer('123') === '', '非字母 → 空串（不可填词）');
ok(cw.MIN_LEN === 2 && cw.MAX_LEN === 12, '长度范围 2–12');
ok(cw.entryFromCard({ id: 'a', front: 'go', back: '走' }).answer === 'GO', '2 字母词可用');
ok(cw.entryFromCard({ id: 'a', front: 'a', back: '一' }) === null, '1 字母词不可用');
ok(cw.entryFromCard({ id: 'a', front: 'abcdefghijklmn', back: 'x' }) === null, '超过 12 字母不可用');
ok(cw.entryFromCard({ id: 'a', front: '   ', back: 'x' }) === null, '空正面不可用');
ok(cw.entryFromCard(null) === null, '空卡片安全返回');
ok(cw.entryFromCard({ id: 'a', front: 'apple' }).clue === '（无释义）', '无释义 → 线索兜底文案');
ok(cw.clueText({ back: '苹果\n一种水果' }) === '苹果 一种水果', '线索换行压成空格');
ok(cw.clueText({ back: '', extraBacks: ['第一条其它释义'] }) === '第一条其它释义', '线索回退到第一条多释义');
const entries = cw.candidateEntries([
  { id: 'a', front: 'apple', back: '苹果' },
  { id: 'b', front: 'APPLE', back: '重复' },
  { id: 'c', front: 'go', back: '去' },
  { id: 'd', front: '123', back: '数字' },
  null
]);
ok(entries.length === 2, '过滤不可填词 + 同词去重（apple 只留一张）');
ok(entries[0].cardId === 'a' && entries[1].cardId === 'c', '去重保留先出现的那张');

/* ==========================================================================
 * ③ 交叉排版规则
 * ========================================================================== */

console.log('\n[交叉排版：canPlace 规则 / findPlacement]');
const grid = new Map();
cw.placeWord(grid, { answer: 'APPLE' }, 0, 0, 'across');
ok(grid.size === 5 && grid.get('0,0').letter === 'A' && grid.get('0,0').across === true, 'placeWord 写入 5 格并标记方向');

ok(cw.canPlace(grid, 'PLAN', 0, 1, 'down').ok === true, '交叉放置（PLAN 经 P 向下）可行');
ok(cw.canPlace(grid, 'PLAN', 0, 1, 'down').cross === 1, '交叉数 = 1');
ok(cw.canPlace(grid, 'PLAN', 0, 0, 'down').ok === false, '首字母不匹配 → 不可放');
ok(cw.canPlace(grid, 'APPLE', 0, 0, 'across').ok === false, '同向重叠 → 不可放');
ok(cw.canPlace(grid, 'APRON', 0, 0, 'across').ok === false, '同向重叠即使字母一致也不可放');
ok(cw.canPlace(grid, 'LEMON', 1, 0, 'across').ok === false, '紧贴下一行会拼出多余纵列 → 不可放');
ok(cw.canPlace(grid, 'APEX', 0, -1, 'across').ok === false, '词尾紧邻已有字母 → 不可放');
ok(cw.canPlace(grid, '', 1, 1, 'across').ok === false, '空答案不可放');
const g2 = new Map();
cw.placeWord(g2, { answer: 'CAT' }, 0, 0, 'across');
ok(cw.canPlace(g2, 'DOT', 0, 3, 'across').ok === false, '词首紧邻已有字母 → 不可放');
const spot = cw.findPlacement(grid, { answer: 'PLAN' });
ok(!!spot && spot.cross >= 1 && spot.dir === 'down', 'findPlacement 找到交叉落点（纵向穿过 A/P）');
ok(cw.canPlace(grid, 'PLAN', spot.row, spot.col, spot.dir).ok === true, '落点复核：canPlace 判定可行');
const gridPlaced = new Map(grid);
cw.placeWord(gridPlaced, { answer: 'PLAN' }, spot.row, spot.col, spot.dir);
ok(
  gridPlaced.size === 5 + 4 - spot.cross,
  `交叉共享 ${spot.cross} 格 → 合并后共 ${5 + 4 - spot.cross} 格（不重复计格）`
);
ok(cw.findPlacement(new Map(), { answer: 'PLAN' }) === null, '空盘不产生落点（首词单独处理）');
ok(cw.findPlacement(grid, { answer: 'ZZZ' }) === null, '无交叉可能 → 返回 null');


/* ==========================================================================
 * ④ 棋盘生成
 * ========================================================================== */

console.log('\n[棋盘生成：按词数抽词 / 完全由当前词库生成]');
const cards20 = fixtureCards();
const board = cw.generateCrossword(cards20, { size: 12, rng: lcg(7) });
ok(board.used >= 6 && board.used <= 12, `12 词档抽出并落盘 ${board.used} 个词（交叉不上的会跳过）`);
ok(board.used + board.unplaced === 12, '落盘词数 + 跳过词数 = 抽取词数（12）');
ok(board.candidates === 20, 'candidates = 词库里可填词的唯一单词数');
ok(board.size === 12, '棋盘记住档位（换一批沿用）');
ok(board.rows >= 1 && board.cols >= 1, `棋盘尺寸 ${board.rows}×${board.cols}`);
ok(board.cells.length >= board.used * 3, '格子数不少于「词数 × 3」（有交叉共享格）');
ok(boardIssues(board).length === 0, '棋盘自检（词全在盘上 / 字母一致 / 无非法相邻 / 编号不重复）', boardIssues(board));
ok(board.words.every((w) => w.answer.length >= 2), '每条线索都是可填单词');
ok(board.words.every((w) => w.clue && w.clue !== ''), '每条线索都有释义（可为兜底文案）');
ok(board.cells.every((c) => c.num == null || c.num >= 1), '编号从 1 开始（非起始格为 null）');
ok(board.words[0].num === 1, '线索列表按编号升序（首条编号为 1）');
ok(
  board.words.every((w, i) => i === 0 || w.num >= board.words[i - 1].num),
  '线索编号单调不减（同一号横向排在纵向之前）'
);
ok(
  board.words.some((w) => w.answer.length === Math.max(...board.words.map((x) => x.len))),
  '最长的词一定入选（按长度降序打底）'
);
ok(board.words.some((w) => w.dir === 'across') && board.words.some((w) => w.dir === 'down'), '横竖两种线索都存在');

const boardSame = cw.generateCrossword(cards20, { size: 12, rng: lcg(7) });
ok(JSON.stringify(boardSame) === JSON.stringify(board), '同一随机源 → 棋盘完全可复现');
const boardOther = cw.generateCrossword(cards20, { size: 12, rng: lcg(99) });
ok(
  JSON.stringify(boardOther.words.map((w) => w.answer)) !== JSON.stringify(board.words.map((w) => w.answer)),
  '换随机源 → 抽到不同的词'
);
ok(cw.generateCrossword(cards20, { size: 6, rng: lcg(7) }).size === 6, '6 词档生效');
ok(cw.clampSize(7) === cw.DEFAULT_SIZE && cw.clampSize(0) === cw.DEFAULT_SIZE, '非法词数档位回落到默认 8');
ok(cw.clampSize(10) === 10 && cw.SIZES.join() === '6,8,10,12', '词数档位 = 6/8/10/12');

const empty = cw.generateCrossword([], { rng: lcg(1) });
ok(empty.rows === 0 && empty.cols === 0 && empty.cells.length === 0 && empty.words.length === 0, '空词库 → 空棋盘（不报错）');
const noLetters = cw.generateCrossword([{ id: 'x', front: '中文', back: 'y' }], { rng: lcg(1) });
ok(noLetters.used === 0 && noLetters.candidates === 0, '没有可填单词 → 空棋盘');
const oneWord = cw.generateCrossword([{ id: 'x', front: 'apple', back: '苹果' }], { size: 12, rng: lcg(1) });
ok(oneWord.used === 1 && oneWord.rows === 1 && oneWord.cols === 5, '只有一个词 → 单行 1×5');
ok(oneWord.words[0].num === 1 && oneWord.words[0].answer === 'APPLE', '单词也正常编号');

// 「整卡组」抽词范围 = 全部卡片；「关卡」= 该关卡片
const deckLv = passLevels(seedDeck('填字词源', 80).id, [0]);
const srcLevel = cw.sourceCards(deckLv, cw.defaultSource(deckLv));
const boardLv = cw.generateCrossword(srcLevel, { size: 8, rng: lcg(3) });
const levelFronts = new Set(srcLevel.map((c) => cw.sanitizeAnswer(c.front)));
ok(boardLv.words.every((w) => levelFronts.has(w.answer)), '关卡词源生成的词全部来自该关');
const boardAll = cw.generateCrossword(cw.sourceCards(deckLv, { kind: 'deck' }), { size: 8, rng: lcg(3) });
ok(boardAll.candidates === 80 && boardAll.used <= 8, '整卡组词源：候选 80，本局最多 8 词');


/* ==========================================================================
 * ⑤ 状态机
 * ========================================================================== */

console.log('\n[状态机：写入 / 检查 / 提示 / 进度]');
let st = cw.newGame(board, { deckId: 'd1', source: { kind: 'deck', level: null }, size: 12, now: 1000 });
ok(
  st.selected === board.words[0].id && st.hints === 0 && Object.keys(st.letters).length === 0,
  '新对局：选中 1 号线索、无填充、0 提示'
);
ok(cw.progress(st).filled === 0 && cw.progress(st).empty === board.cells.length && !cw.isSolved(st), '初始进度：未填 / 未完成');

const w0 = board.words[0];
st = cw.setLetter(st, w0.row, w0.col, w0.answer[0].toLowerCase());
ok(st.letters[`${w0.row},${w0.col}`] === w0.answer[0], '写字母自动转大写');
ok(cw.wordProgress(st, w0.id).filled === 1 && cw.wordProgress(st, w0.id).state === 'partial', '线索进度 = 部分填写');
st = cw.setLetter(st, w0.row, w0.col, '');
ok(!st.letters[`${w0.row},${w0.col}`], '清空该格');
ok(cw.setLetter(st, 99, 99, 'A') === st, '越界格子写入被忽略');

const two = cw.generateCrossword(
  [
    { id: 'x', front: 'go', back: '走' },
    { id: 'y', front: 'on', back: '在…上' }
  ],
  { size: 2, rng: lcg(2) }
);
let gst = cw.newGame(two, { deckId: 'd2', size: 2, now: 5000 });
for (const w of two.words) {
  for (let i = 0; i < w.len; i++) {
    const r = w.dir === 'across' ? w.row : w.row + i;
    const c = w.dir === 'across' ? w.col + i : w.col;
    gst = cw.setLetter(gst, r, c, w.answer[i]);
  }
}
ok(
  cw.isSolved(gst) === true && gst.solved === true && typeof gst.endedAt === 'number',
  '全部填对 → solved 且用时定格（endedAt 有值）'
);
ok(cw.progress(gst).wordsSolved === gst.board.words.length, '所有线索标记为已完成');

// 检查
let cst = cw.newGame(board, { deckId: 'd3', size: 12, now: 2000 });
const c0 = board.cells[0];
cst = cw.setLetter(cst, c0.row, c0.col, c0.letter === 'A' ? 'B' : 'A');
const chk = cw.checkAll(cst);
ok(chk.wrong.length === 1 && chk.wrong[0] === `${c0.row},${c0.col}`, '检查标出填错的格');
ok(chk.empty === board.cells.length - 1, '检查同时报告剩余空格数');
ok(chk.solved === false, '有错时不判定完成');
const stOneWord = cw.revealWord(st, w0.id).state;
ok(cw.checkAll(stOneWord).wrong.length === 0, '全对 → 检查无错误格');
ok(cw.checkAll(stOneWord).empty === board.cells.length - w0.len, '检查的空格数 = 总格数 − 已填格数');

// 提示 / 显示本词
const hint0 = cw.hintCell(st, lcg(4));
ok(!!hint0.cell && hint0.state.hints === 1, '提示补一格并计 1 次');
ok(hint0.state.revealed.includes(`${hint0.cell.row},${hint0.cell.col}`), '提示过的格标记为「已提示」');
ok(cw.hintCell(hint0.state, lcg(4)).state.hints === 2, '再次提示累计次数');
const rev = cw.revealWord(st, w0.id);
ok(rev.count === w0.len && cw.wordProgress(rev.state, w0.id).done === true, '显示本词 → 该线索全部填对');
ok(rev.state.hints === w0.len, '显示本词按格数计提示次数');
ok(cw.revealWord(rev.state, w0.id).count === 0, '已经填好的线索不再计次');
ok(cw.hintCell(st, lcg(1)).cell !== null, '正常状态下提示一定有格可补');
ok(cw.hintCell(cw.newGame(cw.generateCrossword([], {}), {}), lcg(1)).cell === null, '空棋盘提示安全返回');

// 用时 / 格子尺寸
ok(cw.formatDuration(0) === '0秒' && cw.formatDuration(45000) === '45秒', '用时文案（秒）');
ok(cw.formatDuration(65000) === '1分05秒' && cw.formatDuration(150000) === '2分30秒', '用时文案（分秒）');
ok(cw.playStats({ startedAt: 1000, endedAt: 4000 }).elapsedMs === 3000, '对局统计取起止差');
ok(cw.playStats({ hints: 3 }).hints === 3, '对局统计带提示次数');
ok(
  cw.cellSize(8, 8, { width: 390, height: 780 }) > cw.cellSize(20, 20, { width: 390, height: 780 }),
  '格子尺寸随行列数收敛（格子越多越小）'
);
ok(cw.cellSize(1, 1, { width: 390, height: 780 }) === cw.MAX_CELL, '小棋盘的格子不超过上限');
ok(cw.cellSize(8, 8) > 0, '缺视口信息也能算出合理尺寸');

// 移动端适配：触屏格子有更高的下限（手指点得准、字母看得清）→ 放不下就横向滚动
ok(cw.TOUCH_MIN_CELL === 30 && cw.MIN_CELL === 24 && cw.MAX_CELL === 40, '格子尺寸常量：触屏下限 30 / 桌面下限 24 / 上限 40');
ok(
  cw.cellSize(60, 60, { width: 320, height: 480, touch: true }) === cw.TOUCH_MIN_CELL,
  '触屏超大棋盘收敛到 30px（不再压成 18px 的“蚂蚁格”）'
);
ok(
  cw.cellSize(60, 60, { width: 320, height: 480, touch: false }) === cw.MIN_CELL,
  '桌面超大棋盘收敛到 24px'
);
ok(
  cw.cellSize(60, 60, { width: 320, height: 480 }) === cw.TOUCH_MIN_CELL,
  '窄视口未显式给 touch → 按「视口 ≤ 600px」推断为触屏布局'
);
ok(
  cw.cellSize(14, 14, { width: 390, height: 780, touch: true }) >= cw.TOUCH_MIN_CELL,
  '触屏 14×14 棋盘：格子仍 ≥ 30px（靠横向滚动兜底，而不是缩小格子）'
);
ok(
  cw.cellSize(14, 14, { width: 390, height: 780, touch: true }) >= cw.cellSize(14, 14, { width: 390, height: 780, touch: false }),
  '同样尺寸的棋盘：触屏格子不小于桌面格子'
);


/* ==========================================================================
 * ⑥ 薄 UI（DOM 桩）
 * ========================================================================== */

/** 触发一次 keydown（走真实文档级监听） */
function fireKey(el, key) {
  const evt = { key, target: el, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  for (const fn of docListeners['keydown'] || []) fn(evt);
  return evt;
}

console.log('\n[卡组详情页入口横幅（复用解锁判定）]');
const mp = store.seedBuiltinDeck(
  {
    name: '填字冒烟组',
    levelSize: 20,
    words: Array.from({ length: 60 }, (_, i) => ({
      front: WORDS[i % WORDS.length] + 'abcdefgh'[Math.floor(i / WORDS.length) % 8],
      back: `释义${i}`
    }))
  },
  { demo: false, source: 'smoke-crossword' }
);
ok(cw.unlockInfo(store.getDeck(mp.id)).unlocked === false, '一关未通关 → 未解锁');
decks.renderDeck(ROOT, mp.id);
ok(!ROOT.innerHTML.includes('open-crossword'), '未解锁的卡组详情页没有填字入口');
passLevels(mp.id, [0]);
decks.renderDeck(ROOT, mp.id);
ok(ROOT.innerHTML.includes('data-action="open-crossword"'), '通关 1 关 → 卡组详情页出现「填字游戏」入口横幅');
ok(ROOT.innerHTML.includes('cw-banner glass'), '横幅挂 .cw-banner 样式');
ok(ROOT.innerHTML.includes('填字游戏 · 拼一局'), '横幅标题');
ok(ROOT.innerHTML.includes('每局 8 词起'), '横幅写明默认每局词数（复用 DEFAULT_SIZE）');

console.log('\n[填字页渲染（#/crossword/{deck}）]');
const kdBefore = (docListeners['keydown'] || []).length; // review / test 模块级的键盘监听
cw.renderCrossword(ROOT, mp.id);
const html = ROOT.innerHTML;
ok(html.includes('填字游戏 · 第 1 关'), '默认词源 = 最高已通关关卡');
ok(html.includes('role="group" aria-label="填字棋盘"'), '棋盘 role=group + aria-label');
ok(html.includes('role="group" aria-label="选择词源"') && html.includes('data-action="cw-source"'), '词源 chips（整卡组 / 已通关关卡）');
ok(html.includes('role="group" aria-label="选择每局词数"') && html.includes('data-action="cw-size"'), '每局词数 chips');
ok(html.includes('role="progressbar" aria-label="填字进度"'), '进度条 role=progressbar + aria');
ok(html.includes('data-action="cw-check"') && html.includes('data-action="cw-hint"'), '检查 / 提示按钮已渲染');
ok(html.includes('data-action="cw-clue"') && html.includes('aria-pressed="true"'), '线索是原生 button 且带 aria-pressed');
ok(html.includes('maxlength="1"') && html.includes('inputmode="latin"'), '答题格是单字符 input（移动端拉丁键盘）');
ok(html.includes('id="cw-result"'), '结算面板容器已渲染');
ok(
  (docListeners['keydown'] || []).length === kdBefore + 1 && (docListeners['focusin'] || []).length >= 1,
  '填字页首次渲染只新增 1 个键盘监听 + 监听焦点',
  { keydown: (docListeners['keydown'] || []).length, before: kdBefore }
);

const s0 = cw.getCrosswordSession();
ok(!!s0 && s0.deckId === mp.id && s0.source.kind === 'level' && s0.source.level === 0, '会话已建立（词源 = 第 1 关）');
ok(s0.size === cw.DEFAULT_SIZE, '默认每局 8 词');
ok(inputs.length === s0.board.cells.length, '棋盘渲染了全部字母格');
ok(clueBtns.length === s0.board.words.length, '线索条数与线索一一对应');
ok(!!storedSession() && storedSession().board.cells.length === s0.board.cells.length, '会话写入 sessionStorage');

console.log('\n[打字只打补丁 + 焦点推进]');
const uiWord = s0.board.words[0];
const cellA = cw.wordCells(s0.board, uiWord.id)[0];
const cellB = cw.wordCells(s0.board, uiWord.id)[1];
const setsBeforeType = rootSets;
type_(cellA.row, cellA.col, uiWord.answer[0].toLowerCase());
ok(cw.getCrosswordSession().letters[`${cellA.row},${cellA.col}`] === uiWord.answer[0], '输入字母进入会话（自动大写）');
ok(rootSets === setsBeforeType, '打字不整页重渲染（只打补丁）');
ok(statText('empty') === String(s0.board.cells.length - 1), '统计格「空格」实时减 1');
ok(inputEl(cellB.row, cellB.col).focusCount > 0, '自动推进到本线索下一个空格');
ok(inputEl(cellA.row, cellA.col).classList.contains('is-active'), '当前格标 is-active（线索高亮）');
ok(clueBtns.filter((b) => b.classList.contains('is-active')).length === 1, '当前线索标 is-active（唯一）');

console.log('\n[检查 / 提示 / 显示本词]');
const wrongKey = `${cellA.row},${cellA.col}`;
const wrongLetter = w0.answer[0] === 'Z' ? 'Y' : 'Z';
type_(cellA.row, cellA.col, wrongLetter);
act('cw-check');
ok(cw.getCrosswordSession().wrong.includes(wrongKey), '检查标出填错的格');
ok(inputEl(cellA.row, cellA.col).classList.contains('is-wrong'), '填错的格挂 is-wrong');
ok(statText('empty') === String(s0.board.cells.length - 1), '检查不改变已填数量');
const hintsBefore = cw.getCrosswordSession().hints;
const focusSumBefore = inputs.reduce((n, i) => n + i.focusCount, 0);
act('cw-hint');
ok(cw.getCrosswordSession().hints === hintsBefore + 1, '提示一字母 → 提示次数 +1');
ok(cw.getCrosswordSession().revealed.length === 1, '提示的格标记为「已提示」');
ok(inputs.reduce((n, i) => n + i.focusCount, 0) === focusSumBefore + 1, '提示后焦点落到新填的格');
const selectedBefore = cw.getCrosswordSession().selected;
act('cw-reveal');
ok(cw.wordProgress(cw.getCrosswordSession(), selectedBefore).done === true, '显示本词 → 当前线索填对');
ok(!cw.getCrosswordSession().wrong.includes(wrongKey), '显示本词后该格不再标错');
const clueBtn = clueBtns.find((b) => b.dataset.word === String(selectedBefore));
ok(clueBtn && clueBtn.classList.contains('is-correct'), '填对的线索标 is-correct');


console.log('\n[全部填对 → 结算]');
const s1 = cw.getCrosswordSession();
const focusBeforeFinish = newBtn.focusCount;
for (const w of s1.board.words) {
  if (cw.getCrosswordSession().solved) break;
  act('cw-clue', { word: String(w.id) });
  act('cw-reveal');
}
const solvedSession = cw.getCrosswordSession();
ok(solvedSession.solved === true && cw.isSolved(solvedSession), '全部线索填对 → 判定完成');
ok(resultPanel.hidden === false && resultPanel.innerHTML.includes('填字完成'), '结算面板显示成绩');
ok(newBtn.focusCount > focusBeforeFinish, '完成时焦点交给「换一批」（纯键盘可连玩）');
ok(announceEl.textContent.includes('填字完成'), 'announce 播报成绩（读屏可感知）');
ok(statText('words') === `${solvedSession.board.words.length}/${solvedSession.board.words.length}`, '统计格「线索」全部完成');
ok(statText('empty') === '0', '统计格「空格」= 0');
ok(statText('hints') === String(solvedSession.hints), '统计格「提示」= 本局提示次数');
ok(progressBar.getAttribute('aria-valuenow') === '100', '进度条 aria-valuenow 到 100');

console.log('\n[换一批 / 换词源 / 换每局词数 / 重新开始]');
const setsBeforeNew = rootSets;
act('cw-new');
const s2 = cw.getCrosswordSession();
ok(s2 !== solvedSession && s2.solved === false && Object.keys(s2.letters).length === 0, '换一批 → 全新未完成对局');
ok(rootSets > setsBeforeNew, '换一批整页重渲染（棋盘 / 线索全换）');
ok(s2.board.used >= 1, '换一批同样按当前词源生成棋盘');

act('cw-source', { kind: 'deck' });
ok(cw.getCrosswordSession().source.kind === 'deck', '换词源 → 整卡组');
ok(cw.getCrosswordSession().board.candidates === 60, '整卡组词源：候选 = 全部 60 词');
act('cw-source', { kind: 'level', level: 0 });
ok(cw.getCrosswordSession().source.kind === 'level' && cw.getCrosswordSession().source.level === 0, '换词源 → 第 1 关');
const sameSourceBoard = cw.getCrosswordSession().board.words.map((w) => w.answer).join();
act('cw-source', { kind: 'level', level: 0 });
ok(cw.getCrosswordSession().board.words.map((w) => w.answer).join() === sameSourceBoard, '点同一个词源 → 不重排（避免误触白换一局）');
act('cw-source', { kind: 'level', level: 9 });
ok(cw.getCrosswordSession().source.level === 0, '未通关的关卡词源被忽略');

act('cw-size', { size: 6 });
ok(cw.getCrosswordSession().size === 6, '换每局词数 → 6 词');
act('cw-size', { size: 99 });
ok(cw.getCrosswordSession().size === cw.DEFAULT_SIZE, '非法词数档位 → 收敛到默认 8');

const boardBeforeReset = JSON.stringify(cw.getCrosswordSession().board);
const anyCell = cw.getCrosswordSession().board.cells[0];
type_(anyCell.row, anyCell.col, anyCell.letter);
ok(Object.keys(cw.getCrosswordSession().letters).length === 1, '重新开始前先填一格');
act('cw-reset');
const s5 = cw.getCrosswordSession();
ok(Object.keys(s5.letters).length === 0 && s5.hints === 0 && s5.solved === false, '重新开始 → 清空填写与提示次数');
ok(JSON.stringify(s5.board) === boardBeforeReset, '重新开始沿用同一盘棋盘（不重新抽词）');
ok(statText('empty') === String(s5.board.cells.length), '重新开始后统计格「空格」恢复为全部格数');

console.log('\n[会话复活 / 锁定页 / 清场]');
const reviveCell = cw.getCrosswordSession().board.cells[0];
type_(reviveCell.row, reviveCell.col, reviveCell.letter);
const lettersBefore = JSON.stringify(cw.getCrosswordSession().letters);
const boardJson = JSON.stringify(cw.getCrosswordSession().board);
cw.renderCrossword(ROOT, mp.id);
ok(JSON.stringify(cw.getCrosswordSession().letters) === lettersBefore, '重渲染沿用会话（不丢已填字母）');
ok(JSON.stringify(cw.getCrosswordSession().board) === boardJson, '重渲染不重新抽词 / 不重新排版');
ok(inputs.length === cw.getCrosswordSession().board.cells.length, '重渲染后棋盘格数与棋盘一致');

const lockedDeck = seedDeck('填字未解锁', 20);
cw.renderCrossword(ROOT, lockedDeck.id);
ok(ROOT.innerHTML.includes('填字游戏还没解锁'), '未解锁 → 显示「还差 N 关」引导页');
ok(cw.getCrosswordSession() === null, '未解锁不建立会话');
cw.renderCrossword(ROOT, 'no-such-deck');
ok(ROOT.innerHTML.includes('卡组不存在'), '不存在的卡组 → 提示页');
cw.clearCrosswordSession();
ok(cw.getCrosswordSession() === null && mem[cw.SESSION_KEY] === undefined, 'clearCrosswordSession 清空会话与 sessionStorage');

console.log('\n[键盘：退格回上一格 / 方向键换方向]');
cw.renderCrossword(ROOT, mp.id);
const ks = cw.getCrosswordSession();
const kw = ks.board.words[0];
const wCells = cw.wordCells(ks.board, kw.id);
const ka = wCells[0];
const kbCell = wCells[1];
type_(ka.row, ka.col, kw.answer[0]);
ok(cw.getCrosswordSession().letters[`${ka.row},${ka.col}`] === kw.answer[0], '先填第一格');
ok(inputEl(kbCell.row, kbCell.col).focusCount > 0, '焦点推进到第二格');
const evBs = fireKey(inputEl(kbCell.row, kbCell.col), 'Backspace');
ok(evBs.defaultPrevented === true, '退格被接管（不走浏览器默认行为）');
ok(!cw.getCrosswordSession().letters[`${ka.row},${ka.col}`], '空格上退格 → 回上一格并清掉它');
ok(inputEl(ka.row, ka.col).focusCount > 0, '焦点回到上一格');
type_(ka.row, ka.col, 'Q');
fireKey(inputEl(ka.row, ka.col), 'Delete');
ok(!cw.getCrosswordSession().letters[`${ka.row},${ka.col}`], 'Delete 清掉当前格');
fireKey(inputEl(ka.row, ka.col), 'ArrowDown');
ok(cw.getCrosswordSession().dir === 'down', '方向键下 → 切到纵向线索');
fireKey(inputEl(ka.row, ka.col), 'ArrowRight');
ok(cw.getCrosswordSession().dir === 'across', '方向键右 → 切回横向线索');
const evSpace = fireKey(inputEl(ka.row, ka.col), ' ');
ok(evSpace.defaultPrevented === true, '空格被拦截（不滚动页面）');

console.log('\n[返回卡组 / 路由清场]');
const backId = cw.getCrosswordSession().deckId;
act('cw-back');
ok(globalThis.location.hash === `#/deck/${backId}`, '返回卡组 → 跳到卡组详情页');
ok(cw.getCrosswordSession() === null, '返回卡组同时清空会话');

/* ==========================================================================
 * ⑦ 移动端适配：触屏格子尺寸 + 底部英文字母键盘（v0.7.0）
 * ========================================================================== */

console.log('\n[移动端：触屏布局 + 底部字母键盘]');
/** 模拟触屏（pointer: coarse）—— keyboard.js / 页面都按这个信号判断 */
const setTouch = (on) => {
  globalThis.window.matchMedia = (q) => ({ matches: !!on && String(q).includes('coarse') });
};

setTouch(false);
cw.clearCrosswordSession();
cw.renderCrossword(ROOT, mp.id);
ok(kb.isTouchDevice() === false && kb.isKeyboardOpen() === false, '非触屏：不弹字母键盘（继续用系统键盘）');
ok(bar() === null || bar().hidden === true, '非触屏：底部键盘条不存在 / 隐藏');
ok(kb.keyboardConfig() === null, '非触屏：不注册键盘宿主（页面完全不知道键盘存在）');
ok(/inputmode="latin"/.test(ROOT._html), '非触屏：答题格 inputmode=latin');

setTouch(true);
cw.clearCrosswordSession();
cw.renderCrossword(ROOT, mp.id);
const tS = cw.getCrosswordSession();
ok(kb.isTouchDevice() === true && kb.isKeyboardOpen() === true, '触屏：进入填字页自动弹出字母键盘');
ok(kb.inputMode() === 'none' && /inputmode="none"/.test(ROOT._html), '键盘展开 → inputmode=none（抑制系统输入法）');
ok(!!bar() && bar().hidden === false && bar().classList.contains('is-open'), '底部键盘条 #kb-bar 已创建并展开（挂在 #view 之外，路由重渲染不重建）');
ok((bar().innerHTML.match(/data-key="/g) || []).length === 27, '字母键盘 = 26 个字母 + 退格（27 键）');
ok(bar().innerHTML.includes('data-action="kb-hide"'), '键盘带「收起键盘」键');
ok(!bar().innerHTML.includes('data-key="SPACE"'), '填字键盘不带空格键（答案只含字母）');
ok(!ROOT._html.includes('data-action="kb-show"'), '页面 HTML 不需要「⌨ 字母键盘」按钮（改由键盘条迷你态提供）');
const cellPx = Number((ROOT._html.match(/--cw-cell:(\d+)px/) || [])[1]);
ok(cellPx >= cw.TOUCH_MIN_CELL, `触屏棋盘格子 ≥ ${cw.TOUCH_MIN_CELL}px（当前 ${cellPx}px，放不下靠横向滚动）`);
ok(
  inputs.every((i) => i.getAttribute && i.getAttribute('inputmode') === 'none'),
  'syncInputs：键盘展开时全部答题格都写成 inputmode=none'
);
ok(inputs.length === tS.board.cells.length, '触屏下棋盘格数量不变（只是尺寸变大 + 可滚动）');

console.log('\n[字母键盘：敲字母 / 退格 / 收起 / 唤出]');
const tWord = tS.board.words[0];
const tCells = cw.wordCells(tS.board, tWord.id);
const setsBeforeKb = rootSets;
act('kb-key', { key: tWord.answer[0] });
ok(
  cw.getCrosswordSession().letters[`${tCells[0].row},${tCells[0].col}`] === tWord.answer[0],
  '点字母键 → 写进当前线索第一个空格'
);
ok(rootSets === setsBeforeKb, '屏幕键盘打字同样只打补丁（不整页重渲染）');
ok(inputEl(tCells[1].row, tCells[1].col).focusCount > 0, '写完自动推进到下一格');
act('kb-key', { key: tWord.answer[1] });
ok(cw.getCrosswordSession().letters[`${tCells[1].row},${tCells[1].col}`] === tWord.answer[1], '继续敲第二个字母');
act('kb-key', { key: 'BACK' });
ok(!cw.getCrosswordSession().letters[`${tCells[1].row},${tCells[1].col}`], '点退格键 → 清掉当前格');
act('kb-key', { key: 'BACK' });
ok(!cw.getCrosswordSession().letters[`${tCells[0].row},${tCells[0].col}`], '空格上再退格 → 回上一格并清掉它');
act('kb-key', { key: 'zz' });
ok(rootSets === setsBeforeKb && cw.getCrosswordSession().letters[tCells[0].row + ',' + tCells[0].col] === undefined, '非法键值被忽略（不写入）');

act('kb-hide');
ok(kb.isKeyboardOpen() === false && bar().hidden === false, '点「收起键盘」→ 底栏收成迷你态（不是整条消失）');
ok(bar().classList.contains('is-mini') && bar().innerHTML.includes('data-action="kb-show"'), '迷你态只留「⌨ 字母键盘」胶囊（点它可再唤出）');
ok(kb.inputMode() === 'latin', '收起后 inputMode 回到 latin（恢复系统键盘）');
ok(
  inputs.every((i) => i.getAttribute && i.getAttribute('inputmode') === 'latin'),
  '收起后输入框恢复 inputmode=latin'
);
ok(kb.shouldAutoOpen() === false, '同页内手动收起过 → 不再自动弹回');
cw.renderCrossword(ROOT, mp.id); // 模拟切主题等重渲染
ok(kb.isKeyboardOpen() === false, '重渲染也不自动弹回（尊重用户的「收起」）');
ok(bar().innerHTML.includes('data-action="kb-show"'), '重渲染后迷你胶囊仍在（不需要页面自己渲染按钮）');
act('kb-show');
ok(kb.isKeyboardOpen() === true && bar().hidden === false && bar().classList.contains('is-open'), '点「⌨ 字母键盘」→ 键盘重新展开');
ok(!bar().innerHTML.includes('kb-mini'), '展开后迷你胶囊消失（换成键位）');
ok(
  inputs.every((i) => i.getAttribute && i.getAttribute('inputmode') === 'none'),
  '重新展开 → 再次抑制系统输入法'
);
act('cw-new');
ok(kb.isKeyboardOpen() === true && cw.getCrosswordSession().board.cells.length > 0, '换一批后键盘仍展开可用');

console.log('\n[完成 / 离场：键盘收场]');
for (const w of cw.getCrosswordSession().board.words) {
  if (cw.getCrosswordSession().solved) break;
  act('cw-clue', { word: String(w.id) });
  act('cw-reveal');
}
ok(cw.getCrosswordSession().solved === true, '全部填对（键盘敲字与「显示本词」混用）');
ok(kb.isKeyboardOpen() === false && bar().hidden === true, '完成后键盘条整条隐藏（腾出屏幕看结算）');
cw.clearCrosswordSession();
ok(kb.isKeyboardOpen() === false && cw.getCrosswordSession() === null, '离开填字页清场：会话 + 键盘一起收');
setTouch(false);

/* ==========================================================================
 * 汇总
 * ========================================================================== */

console.log(`\n填字游戏测试: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

