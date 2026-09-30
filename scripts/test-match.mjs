#!/usr/bin/env node
// ============================================================================
// test-match.mjs — 明牌配对游戏（v0.5.12，js/match.js）
//   运行: node scripts/test-match.mjs
// 覆盖：① 解锁判定（通关 ≥1 关解锁 / 可玩关卡 / 默认关卡）
//       ② 建牌与洗牌（2N 张、牌 id 唯一、rng 可注入 → 完全可复现、上限兜底）
//       ③ 轮次切分（每轮 5 对 / 多余的自动往后 / 每轮独立洗牌 / 完整性守门）
//       ④ 牌面文案（正面 / 背面 → 多释义 → 兜底文案）
//       ⑤ 点击状态机（select / cancel / replace / match / miss / ignore / 越界牌忽略）
//       ⑥ 轮次推进与连击（本轮清零自动铺下一轮 / 连击跨轮累计 / 失误清零 / 用时）
//       ⑦ 薄 UI（DOM 桩：只铺本轮 10 张 / 点击只打补丁 / 爆炸消除后从 DOM 移除 /
//          combo✖️N 连击抖动 / 一轮清空自动铺下一轮 / 结算面板 / 会话守门 / 入口横幅）
// ============================================================================

import { readFileSync, existsSync } from 'node:fs';
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

/* ---- 棋盘 DOM 桩：innerHTML 一写入，就按当前会话重建「牌 / 统计格」 ---- */
/* 牌 = 当前轮还没消掉的牌：配对成功 → 爆炸动画播完由 JS 从 DOM 移除（与真实页面一致） */

let tiles = [];
let statCells = [];
let rootSets = 0; // 整页重渲染次数（点击时必须为 0：只打补丁）
let boardSets = 0; // 棋盘重铺次数（本轮清空 → 铺下一轮时 +1）
let removedCount = 0; // 爆炸消除后从 DOM 移除的牌数
let matchApi = null; // 动态 import 后回填
const session = () => (matchApi ? matchApi.getMatchSession() : null);

const resultPanel = mkEl('div');
const replayBtn = mkEl('button');
resultPanel.querySelector = (sel) => (sel === '[data-action="match-replay"]' ? replayBtn : null);
const announceEl = mkEl('div');
const progressBar = mkEl('div');
const progressFill = mkEl('i');
progressBar.querySelector = (sel) => (sel === '.progress-fill' ? progressFill : null);

const comboEl = mkEl('span'); // #match-combo（combo✖️N）
const roundCell = mkEl('div'); // [data-match="round"]
roundCell.dataset.match = 'round';

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

const boardEl = mkEl('div'); // #match-board
Object.defineProperty(boardEl, 'innerHTML', {
  get() {
    return this._html;
  },
  set(v) {
    this._html = String(v);
    boardSets++;
    syncBoard();
  }
});

function mkTileEl(id) {
  const el = mkEl('button');
  el.dataset.tile = id;
  el.remove = () => {
    const i = tiles.indexOf(el);
    if (i >= 0) tiles.splice(i, 1);
    removedCount++;
  };
  return el;
}

/** 当前轮还没消掉的牌（= 页面上真正显示的那些） */
function liveBoardTiles() {
  const s = session();
  if (!s || !matchApi) return [];
  return matchApi.roundTiles(s).filter((t) => !(s.matched || []).includes(t.id));
}

function syncBoard() {
  tiles = liveBoardTiles().map((t) => mkTileEl(t.id));
}

function syncDom() {
  rootSets++;
  syncBoard();
  statCells = ['time', 'pairs', 'misses', 'combo'].map((k) => {
    const cell = mkEl('div');
    cell.classList.add('match-stat');
    const b = mkEl('b');
    b.dataset.match = k;
    b.parentElement = cell;
    cell._value = b;
    return cell;
  });
}

ROOT.querySelectorAll = (sel) => {
  if (sel === '.match-tile') return tiles.slice(); // 真实 DOM 是静态 NodeList → 返回副本
  if (sel === '.match-tile.is-wrong') return tiles.filter((t) => t.classList.contains('is-wrong'));
  if (sel === '[data-match]') return statCells.map((c) => c._value).concat([roundCell]);
  const one = /^\[data-match="([^"]+)"\]$/.exec(sel);
  if (one) return statCells.filter((c) => c._value.dataset.match === one[1]).map((c) => c._value);
  return [];
};

const doc = {
  body: mkEl('body'),
  documentElement: mkEl('html'),
  activeElement: null,
  addEventListener() {},
  removeEventListener() {},
  createElement: (t) => mkEl(t),
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: (id) =>
    id === 'view'
      ? ROOT
      : id === 'match-result'
        ? resultPanel
        : id === 'match-progress'
          ? progressBar
          : id === 'match-board'
            ? boardEl
            : id === 'match-combo'
              ? comboEl
              : id === 'sr-announce'
                ? announceEl
                : null
};
globalThis.document = doc;
globalThis.window = { addEventListener() {}, dispatchEvent() {}, scrollTo() {} };
globalThis.location = { hash: '#/deck/seed', href: '' };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

/* ------------------------------ 载入模块 ------------------------------ */

const store = await import('../js/store.js');
const ui = await import('../js/ui.js');
const matchMod = await import('../js/match.js');
const decks = await import('../js/decks.js'); // 卡组详情页入口横幅
matchApi = matchMod; // 回填给 DOM 桩（syncDom / liveBoardTiles 需要读会话）

/** 等一小会儿（爆炸 / 连击动画是 setTimeout 驱动的） */
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
/** 模拟系统「减少动效」：爆炸立即结束（避免测试等 20 × 420ms） */
const reduceMotion = () => {
  globalThis.window.matchMedia = () => ({ matches: true });
};

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
function act(action, data = {}) {
  const el = {
    dataset: { action, ...data },
    classList: { add() {}, remove() {}, contains: () => false },
    closest: (sel) => (sel === '#view' ? ROOT : null)
  };
  ui.handleEvent({ type: 'click', target: { closest: () => el }, preventDefault() {} });
}

const storedSession = () => {
  const raw = mem[matchMod.SESSION_KEY];
  return raw ? JSON.parse(raw) : null;
};
const tileEl = (id) => tiles.find((t) => t.dataset.tile === id);
const roundLine = () => roundCell.textContent;
const statText = (key) => {
  const cell = statCells.find((c) => c._value.dataset.match === key);
  return cell ? cell._value.textContent : '';
};

/** 线性同余随机源：seed 相同 → 洗牌结果完全一致（单测可复现） */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/* ------------------------------ 卡组夹具 ------------------------------ */

/** 80 张 / 每关 20 → 4 关（示范词库每库只能有一本，这里用普通卡组 + 批量加卡） */
function seedDeck(name, words = 80) {
  const deck = store.createDeck({ name });
  store.addManyCards(
    deck.id,
    Array.from({ length: words }, (_, i) => ({
      front: 'w' + i,
      back: '释义' + i,
      example: 'I use w' + i + '.',
      exampleZh: '我用 w' + i + '。'
    }))
  );
  return store.getDeck(deck.id);
}

/** 把某几关标成「已通关」（测试标记 + 全部卡片已学） */
function passLevels(deckId, idxs) {
  for (const i of idxs) {
    store.markLevelLearned(deckId, i);
    store.markLevelPassed(deckId, i);
  }
  return store.getDeck(deckId);
}

console.log('\n[解锁判定：通关 ≥ 1 关即解锁]');
const deck = seedDeck('配对测试', 80);
ok(matchMod.UNLOCK_LEVELS === 1, 'UNLOCK_LEVELS = 1（v0.5.12 起通关 1 关就能玩）');
ok(new Set(deck.cards.map((c) => c.level)).size === 4, '卡组就绪（80 张 / 4 关）');
ok(matchMod.passedCount(deck) === 0 && matchMod.unlockInfo(deck).unlocked === false, '一关未通关 → 未解锁');
ok(matchMod.unlockInfo(deck).left === 1 && matchMod.unlockInfo(deck).need === 1, '解锁进度：还差 1 关');
ok(matchMod.defaultLevel(deck) === null && matchMod.passedLevels(deck).length === 0, '没有已通关关卡 → 无默认开局关卡');

const dOne = passLevels(deck.id, [0]);
ok(matchMod.passedCount(dOne) === 1 && matchMod.unlockInfo(dOne).unlocked === true, '通关第 1 关 → 直接解锁');
ok(matchMod.unlockInfo(dOne).left === 0 && matchMod.defaultLevel(dOne) === 0, '默认开局 = 唯一已通关关卡（索引 0）');
ok(matchMod.isPlayableLevel(dOne, 0) === true && matchMod.isPlayableLevel(dOne, 1) === false, '只能玩已通关的关卡');

const d2 = passLevels(deck.id, [1]);
ok(matchMod.passedCount(d2) === 2 && matchMod.defaultLevel(d2) === 1, '通关 2 关 → 默认开局为最高的已通关关卡（索引 1）');

const d3 = passLevels(deck.id, [2]);
ok(matchMod.unlockInfo(d3).unlocked === true, '通关 3 关 → 依旧解锁');
ok(JSON.stringify(matchMod.passedLevels(d3)) === '[0,1,2]', '已通关关卡升序 = [0,1,2]');
ok(matchMod.defaultLevel(d3) === 2, '默认开局为最高的已通关关卡（索引 2）');
ok(matchMod.isPlayableLevel(d3, 3) === false && matchMod.isPlayableLevel(d3, '2') === true, '关卡号按数字比较（字符串也能识别）');

console.log('\n[建牌与洗牌]');
const lvl0 = d3.cards.filter((c) => c.level === 0);
ok(lvl0.length === 20, '第 1 关 20 张卡片');
const t1 = matchMod.buildTiles(lvl0, lcg(42));
const t2 = matchMod.buildTiles(lvl0, lcg(42));
const ids = t1.map((t) => t.id);
ok(t1.length === 40, '20 张卡 → 40 张明牌（2N）');
ok(new Set(ids).size === 40, '牌 id 唯一');
ok(t1.filter((t) => t.kind === 'word').length === 20 && t1.filter((t) => t.kind === 'def').length === 20, '词牌 / 义牌各 20 张');
ok(t1.every((t) => t.id === `${t.kind === 'word' ? 'w' : 'd'}-${t.cardId}`), '牌 id 与卡片一一对应（w-{id} / d-{id}）');
ok(t1.filter((t) => t.kind === 'word').every((t) => new Set(lvl0.map((c) => c.front)).has(t.text)), '单词牌文字 = 卡片正面');
ok(JSON.stringify(ids) === JSON.stringify(t2.map((t) => t.id)), '同一随机源 → 洗牌完全可复现');
ok(
  JSON.stringify(matchMod.shuffle([1, 2, 3, 4, 5, 6], lcg(1))) !==
    JSON.stringify(matchMod.shuffle([1, 2, 3, 4, 5, 6], lcg(2))),
  '不同随机源 → 顺序不同'
);
const baseIds = lvl0.flatMap((c) => [`w-${c.id}`, `d-${c.id}`]);
ok(JSON.stringify(ids) !== JSON.stringify(baseIds), '牌面确实被打乱（不是原始顺序）');
ok(JSON.stringify([...ids].sort()) === JSON.stringify([...baseIds].sort()), '洗牌只换位置（牌集合不变）');
ok(matchMod.buildTiles(lvl0, lcg(1), 3).length === 6, 'limit 兜底：最多 3 对 = 6 张牌');
ok(matchMod.buildTiles(lvl0, lcg(1), 0).length === 2, 'limit 非法（0）→ 至少 1 对');
ok(matchMod.buildTiles([{ front: 'x' }, null, lvl0[0]], lcg(1)).length === 2, '忽略没有 id 的卡片');
ok(matchMod.buildTiles(null).length === 0 && matchMod.shuffle(null).length === 0, '空输入安全返回');
ok(matchMod.MAX_PAIRS === 30, 'MAX_PAIRS = 单关最大卡片数（30）');
ok(matchMod.levelCardsFor(d3, 0).length === 20 && matchMod.levelCardsFor(d3, 9).length === 0, 'levelCardsFor 只取该关卡片（不存在的关卡为空）');

console.log('\n[轮次切分：每轮 5 对，多余的自动往后]');
ok(matchMod.ROUND_PAIRS === 5, 'ROUND_PAIRS = 5（每轮 5 对 = 10 张牌）');
ok(matchMod.BOOM_MS === 420, 'BOOM_MS = 420（爆炸动画播完才移除这对牌）');
const rounds4 = matchMod.splitRounds(lvl0);
ok(rounds4.length === 4 && rounds4.every((g) => g.length === 5), '20 张卡 → 4 轮 × 5 对（整除）');
const groups = matchMod.splitRounds(lvl0.slice(0, 12));
ok(groups.length === 3 && groups.map((g) => g.length).join() === '5,5,2', '12 张卡 → 3 轮（5/5/2，多余的配对排到最后）');
ok(matchMod.splitRounds(lvl0, 0).length === 4, '每轮对数非法（0）→ 回落到 5 对');
ok(matchMod.splitRounds(null).length === 0 && matchMod.splitRounds([{ front: 'x' }, null]).length === 0, '空输入 / 无 id 卡片安全过滤');

const board = matchMod.buildBoard(lvl0, lcg(5));
ok(board.length === 40, '整副牌 40 张（4 轮 × 10 张）');
ok(matchMod.isBoardComplete(board, 5) === true, '整副牌每轮都「词义成对完整」（会话可安全复活）');
ok(
  JSON.stringify(matchMod.buildBoard(lvl0, lcg(5)).map((t) => t.id)) === JSON.stringify(board.map((t) => t.id)),
  '同一随机源 → 整副牌完全可复现'
);
const r0 = board.slice(0, 10);
ok(
  r0.filter((t) => t.kind === 'word').length === 5 && r0.filter((t) => t.kind === 'def').length === 5,
  '每轮独立洗牌 → 每轮都是 5 词 + 5 义（不会整轮全是词牌）'
);
ok(matchMod.isBoardComplete(matchMod.buildTiles(lvl0, lcg(5)), 5) === false, '整盘平铺（v0.5.11 老版）→ 不满足每轮成对，会被丢弃');
ok(
  matchMod.isRoundComplete([
    { id: 'w-a', cardId: 'a', kind: 'word' },
    { id: 'w-a2', cardId: 'a', kind: 'word' }
  ]) === false,
  '同一张卡两张词牌 → 不算成对（防死局）'
);
ok(
  matchMod.isRoundComplete([
    { id: 'w-a', cardId: 'a', kind: 'word' },
    { id: 'd-a', cardId: 'a', kind: 'def' }
  ]) === true,
  '一卡一词汇 + 一释义 = 成对'
);
ok(matchMod.isRoundComplete([]) === false && matchMod.isBoardComplete([]) === false, '空牌面不视为完整');

const rs = matchMod.newSession('dR', 0, lvl0, 1000, lcg(9));
ok(rs.roundPairs === 5 && rs.round === 0 && rs.tiles.length === 40, '会话记录每轮对数 / 当前轮次（0 基）');
ok(matchMod.roundSize(rs) === 10 && matchMod.roundCount(rs) === 4, '每轮 10 张牌 / 共 4 轮');
ok(
  JSON.stringify(matchMod.roundTiles(rs).map((t) => t.id)) === JSON.stringify(rs.tiles.slice(0, 10).map((t) => t.id)),
  'roundTiles 只取当前轮（第 1 轮 = 前 10 张）'
);
ok(matchMod.liveTiles(rs).length === 10, '开局棋盘只有 10 张牌（本轮 5 对）');
const rs0 = matchMod.roundStats(rs);
ok(
  rs0.round === 1 && rs0.rounds === 4 && rs0.pairs === 5 && rs0.left === 5 && rs0.done === false && rs0.allDone === false,
  '轮次进度：第 1/4 轮 · 本轮 5 对 · 未完成'
);
ok(matchMod.roundStats({ ...rs, round: 99 }).round === 4, '轮次越界时展示值收敛到最后一轮');
ok(matchMod.roundCount({ tiles: [] }) === 0 && matchMod.roundStats({}).rounds === 0, '空会话安全返回');
ok(matchMod.roundSize({}) === 10 && matchMod.roundCount({ tiles: lvl0.slice(0, 1) }) === 1, '缺 roundPairs → 按 5 对兜底');
ok(matchMod.roundStats({ tiles: matchMod.buildTiles([{ id: 'a', front: 'A', back: '甲' }], lcg(1)) }).rounds === 1, '没有轮次信息的老状态 → 整盘一轮（行为与单轮版一致）');

console.log('\n[牌面文案]');
ok(matchMod.wordText({ front: 'apple' }) === 'apple', '单词牌取正面');
ok(matchMod.wordText({ front: '   ' }) === '（无正面）', '无正面 → 兜底文案');
ok(matchMod.defText({ back: '苹果' }) === '苹果', '释义牌取背面');
ok(matchMod.defText({ back: '  苹果  ' }) === '苹果', '释义去掉首尾空白');
ok(matchMod.defText({ back: '', extraBacks: ['苹果树'] }) === '苹果树', '无背面 → 取第一条其它释义');
ok(matchMod.defText({ back: '', extraBacks: ['', 'x'] }) === '（无释义）', '其它释义也空 → 继续兜底');
ok(matchMod.defText({}) === '（无释义）' && matchMod.defText(null) === '（无释义）', '既无背面也无其它释义 → 兜底文案');

console.log('\n[点击状态机]');
const cards3 = [
  { id: 'a', front: 'A', back: '甲' },
  { id: 'b', front: 'B', back: '乙' },
  { id: 'c', front: 'C', back: '丙' }
];
const s0 = matchMod.newSession('d1', 0, cards3, 1000, lcg(7));
ok(s0.tiles.length === 6 && s0.matched.length === 0 && s0.selectedId === null, 'newSession 初始状态（未选中 / 未配对）');
ok(s0.deckId === 'd1' && s0.level === 0 && s0.startedAt === 1000, '会话记录卡组 / 关卡 / 开始时间');
ok(s0.roundPairs === 5 && matchMod.roundCount(s0) === 1, '3 张卡（6 张牌）→ 只有 1 轮（不足 5 对也算一轮）');
ok(matchMod.nextSelection(rs, rs.tiles[11].id).event === 'ignore', '点非当前轮的牌 → ignore（越界牌不会搅乱轮次）');
ok(matchMod.nextSelection(rs, 'nope').event === 'ignore', '点未知牌 → ignore');

const pick = (state, id, now = 2000) => matchMod.applyPick(state, id, now);
ok(pick(s0, 'w-zzz').event === 'ignore' && pick(s0, 'w-zzz').state.selectedId === null, '点未知牌 → ignore（不选中）');
const selA = pick(s0, 'w-a').state;
ok(selA.selectedId === 'w-a', '首次点击 → select（选中）');
ok(pick(selA, 'w-a').event === 'cancel' && pick(selA, 'w-a').state.selectedId === null, '再点同一张 → cancel（取消选中）');
const selB = pick(selA, 'w-b').state;
ok(pick(selA, 'w-b').event === 'replace' && selB.selectedId === 'w-b', '点同类另一张 → replace（改选）');
ok(pick(selA, 'd-a').event === 'match' && pick(selA, 'd-a').pair.join() === 'w-a,d-a', '词 + 义且同卡 → match（配对成功）');
ok(pick(selA, 'd-b').event === 'miss' && pick(selA, 'd-b').pair.join() === 'w-a,d-b', '词 + 义但不同卡 → miss（配对失败）');
ok(matchMod.isMatch(s0.tiles.find((t) => t.id === 'w-a'), s0.tiles.find((t) => t.id === 'd-a')) === true, 'isMatch 同卡异面 = true');
ok(matchMod.isMatch(s0.tiles.find((t) => t.id === 'w-a'), s0.tiles.find((t) => t.id === 'w-b')) === false, 'isMatch 同面不同卡 = false');
ok(matchMod.isMatch(null, null) === false, 'isMatch 空值安全返回 false');

const matched = pick(selA, 'd-a').state;
ok(matched.matched.join() === 'w-a,d-a' && matched.matched.length === 2, '配对成功记下两张牌');
ok(pick(matched, 'w-a').event === 'ignore', '点已配对的牌 → ignore');
ok(pick(matched, 'w-a').state.combo === matched.combo, 'ignore 不影响连击');
const snapshot = JSON.stringify(selA);
pick(selA, 'd-b');
ok(JSON.stringify(selA) === snapshot, 'applyPick 不改动入参（纯函数）');
ok(matchMod.nextSelection(s0, 'w-a').event === 'select' && matchMod.nextSelection(s0, 'nope').event === 'ignore', 'nextSelection 可直接单测');
ok(matchMod.nextSelection(s0, 'w-a').pair === null, '非终局事件不带 pair');

console.log('\n[连击 / 失误 / 用时]');
const cards4 = cards3.concat([{ id: 'd', front: 'D', back: '丁' }]);
const s4 = matchMod.newSession('d2', 0, cards4, 1000, lcg(11));
const run = (state, ids, now = 3000) => ids.reduce((s, id) => matchMod.applyPick(s, id, now).state, state);
let st = run(s4, ['w-a', 'd-a', 'w-b', 'd-b']);
ok(st.combo === 2 && st.maxCombo === 2, '连续配对成功 → 连击 2 / 最大连击 2');
st = run(st, ['w-c', 'd-d']);
ok(st.mistakes === 1 && st.combo === 0, '配对失败 → 失误 +1、连击清零');
ok(st.maxCombo === 2, '失败清零连击，但最大连击保留');
st = run(st, ['w-c', 'd-c']);
ok(st.combo === 1 && st.maxCombo === 2 && st.matched.length === 6, '再次配对成功 → 连击重新累计');
st = run(st, ['w-d', 'd-d']);
ok(st.combo === 2 && st.matched.length === 8, '最后一对配完 → 连击 2');
ok(matchMod.isDone(st) === true && st.endedAt === 3000, '全部配完 → done 并定格用时');
ok(matchMod.playStats(st, 99999).elapsedMs === 2000, '已完成对局用时定格（不随 now 增长）');
ok(matchMod.playStats(s4, 5000).elapsedMs === 4000, '未完成对局用时按 now 计算');
ok(matchMod.playStats(s4, 5000).mistakes === 0 && matchMod.boardStats(s4).left === 8, '开局统计为零');
const bs = matchMod.boardStats(st);
ok(bs.pairs === 4 && bs.totalPairs === 4 && bs.matched === 8 && bs.left === 0 && bs.done === true, 'boardStats 进度正确');
ok(matchMod.isDone(s4) === false && matchMod.boardStats(s4).done === false, '未配完不算完成');
ok(matchMod.formatDuration(0) === '0秒' && matchMod.formatDuration(45000) === '45秒', '用时文案：秒');
ok(matchMod.formatDuration(65000) === '1分05秒' && matchMod.formatDuration(600000) === '10分00秒', '用时文案：分秒补零');
ok(matchMod.formatDuration(-5) === '0秒' && matchMod.formatDuration('x') === '0秒', '异常用时兜底 0 秒');
ok(matchMod.boardStats(null).tiles === 0 && matchMod.isDone(null) === false, '空状态安全返回');

console.log('\n[轮次推进：本轮消完自动铺下一轮]');
const cards12 = Array.from({ length: 12 }, (_, i) => ({ id: 'k' + i, front: 'K' + i, back: '义' + i }));
const r12 = matchMod.newSession('rm', 0, cards12, 1000, lcg(21));
ok(matchMod.roundCount(r12) === 3 && matchMod.roundStats(r12).pairs === 5, '12 张卡 → 3 轮（5/5/2，多余的自动往后）');

/** 整轮配对消掉（返回每一步的结果，便于断言 roundCleared / 连击） */
function clearRound(state, now = 5000) {
  const steps = [];
  let s = state;
  for (const w of matchMod.roundTiles(s).filter((t) => t.kind === 'word')) {
    s = matchMod.applyPick(s, w.id, now).state;
    const last = matchMod.applyPick(s, 'd-' + w.cardId, now);
    s = last.state;
    steps.push(last);
  }
  return { state: s, steps };
}

const c1 = clearRound(r12);
ok(c1.state.round === 1, '本轮 5 对全部消完 → 自动进入下一轮（round +1）');
ok(c1.steps[c1.steps.length - 1].roundCleared === true, '本轮最后一对返回 roundCleared = true（UI 据此铺下一轮）');
ok(c1.steps.slice(0, -1).every((st) => st.roundCleared === false), '本轮前 4 对不触发铺轮');
ok(matchMod.roundLeft(c1.state) === 5 && matchMod.roundTiles(c1.state).length === 10, '新一轮重新铺 5 对');
ok(c1.state.matched.length === 10 && matchMod.isDone(c1.state) === false, '已消除 10 张（跨轮累计），整局未结束');
ok(c1.state.combo === 5 && c1.state.maxCombo === 5, '本轮 5 连（无失误 → 连击连续累计）');

const c2 = clearRound(c1.state);
ok(c2.state.round === 2 && c2.state.combo === 10 && c2.state.maxCombo === 10, '第二轮再 5 连 → 连击跨轮累计到 10');

const c3 = clearRound(c2.state);
ok(c3.state.round === 2 && c3.steps[c3.steps.length - 1].roundCleared === false, '最后一轮消完 → 不再推进轮次（直接结算）');
ok(matchMod.isDone(c3.state) === true && c3.state.endedAt === 5000, '整关 12 对全部消完 → done 并定格用时');
ok(matchMod.roundLeft(c3.state) === 0 && matchMod.liveTiles(c3.state).length === 0, '最后一轮不再剩牌（棋盘清空）');
ok(matchMod.roundStats(c3.state).allDone === true && matchMod.roundStats(c3.state).rounds === 3, '结算时轮次信息仍可读（共 3 轮）');

const rm2 = matchMod.newSession('rm2', 0, cards12, 1000, lcg(22));
const fw = matchMod.roundTiles(rm2).find((t) => t.kind === 'word');
const badDef = matchMod.roundTiles(rm2).find((t) => t.kind === 'def' && t.cardId !== fw.cardId);
const mp = matchMod.applyPick(matchMod.applyPick(rm2, fw.id, 1000).state, badDef.id, 1000);
ok(mp.event === 'miss' && mp.state.mistakes === 1 && mp.state.combo === 0, '连击途中配对失败 → 失误 +1、连击清零');
const lockPick = matchMod.applyPick(rm2, rm2.tiles[20].id, 1000);
ok(lockPick.event === 'ignore' && lockPick.state.selectedId === null, 'applyPick 点非当前轮的牌 → ignore（不改状态）');

/* ------------------------- 薄 UI：渲染 / 点击打补丁 ------------------------- */

console.log('\n[薄 UI：棋盘渲染（只铺本轮 5 对）]');
matchMod.clearMatchSession();
matchMod.renderMatch(ROOT, d3.id);
ok(ROOT._html.includes('class="view view-match"'), '渲染明牌配对页');
ok(ROOT._html.includes('明牌配对 · 第 3 关'), '默认开局最高已通关关卡（第 3 关）');
ok(tiles.length === 10, 'DOM 里只铺当前轮 10 张牌（5 对，不再整盘平铺）');
ok((ROOT._html.match(/data-action="match-pick"/g) || []).length === 10, '棋盘里每张牌都是 match-pick 按钮（原生 button，键盘可达）');
ok(ROOT._html.includes('class="match-board" id="match-board" role="group" aria-label="配对棋盘"'), '棋盘容器 #match-board 已渲染');
ok(ROOT._html.includes('class="match-board-wrap"'), '棋盘外层 wrap（连击提示定位用）');
ok(ROOT._html.includes('每轮 5 对 · 点单词再点它的释义'), '标题行写明本轮对数与玩法');
ok(ROOT._html.includes('<div class="match-round" data-match="round">第 1/4 轮 · 本轮还剩 5 对</div>'), '轮次行：第 1/4 轮 · 本轮还剩 5 对');
ok(ROOT._html.includes('id="match-combo" aria-hidden="true" hidden'), '连击提示初始隐藏（aria-hidden，不干扰读屏）');
ok(ROOT._html.includes('combo✖️2'), '连击提示文案为「combo✖️N」形式');
ok(ROOT._html.includes('role="progressbar" aria-label="配对进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"'), '进度条 role=progressbar + aria-valuemin/max/now');
ok(ROOT._html.includes('aria-pressed="false"'), '未选中的牌 aria-pressed=false');
ok(ROOT._html.includes('match-tile-word') && ROOT._html.includes('match-tile-def'), '词牌 / 义牌 class 区分（视觉可辨）');
ok(ROOT._html.includes('aria-label="单词「') && ROOT._html.includes('aria-label="释义「'), '牌面有中文 aria-label（读屏可懂）');
ok((ROOT._html.match(/data-action="match-level"/g) || []).length === 3, '关卡选择只列 3 个已通关关卡');
ok(ROOT._html.includes('class="match-lv is-active" data-action="match-level" data-level="2"'), '当前关卡 chip 高亮');
ok(ROOT._html.includes('id="match-result"') && ROOT._html.includes('hidden'), '结算面板初始隐藏');
ok(session().level === 2 && session().tiles.length === 40, '会话已建立（第 3 关整关 40 张牌 = 4 轮）');
ok(session().roundPairs === 5 && session().round === 0, '会话记住每轮 5 对 / 当前第 1 轮');
ok(!!storedSession() && storedSession().deckId === d3.id, '会话写入 sessionStorage（刷新不丢牌面）');
ok(storedSession().roundPairs === 5, '每轮对数一并落盘（刷新后轮次划分不变）');
ok(
  ROOT._html.includes('<b data-match="time">0秒</b>') &&
    ROOT._html.includes('<b data-match="pairs">0/20</b>') &&
    ROOT._html.includes('<b data-match="misses">0</b>') &&
    ROOT._html.includes('<b data-match="combo">0</b>'),
  '统计区初值直接写在页面 HTML 上（用时 / 已配对 / 失误 / 连击）'
);

console.log('\n[薄 UI：点击 → 局部打补丁（不整页重渲染）]');
let S = session();
const live0 = matchMod.liveTiles(S);
const wTile = live0.find((t) => t.kind === 'word');
const dTile = live0.find((t) => t.id === 'd-' + wTile.cardId);
const wrongDef = live0.find((t) => t.kind === 'def' && t.cardId !== wTile.cardId);
const setsBefore = rootSets;
act('match-pick', { tile: wTile.id });
ok(session().selectedId === wTile.id, '点词牌 → 选中');
ok(tileEl(wTile.id).classList.contains('is-selected'), '选中态打上（is-selected）');
ok(tileEl(wTile.id).getAttribute('aria-pressed') === 'true', '选中态 aria-pressed=true');
ok(rootSets === setsBefore, '点击只打补丁，不写 innerHTML（不整页重渲染）');
act('match-pick', { tile: wTile.id });
ok(session().selectedId === null && tileEl(wTile.id).classList.contains('is-selected') === false, '再点同一张 → 取消选中');
act('match-pick', { tile: wTile.id });
act('match-pick', { tile: wrongDef.id });
ok(session().mistakes === 1 && session().combo === 0 && session().selectedId === null, '配对失败 → 失误 +1、连击清零、取消选中');
ok(tileEl(wTile.id).classList.contains('is-wrong') && tileEl(wrongDef.id).classList.contains('is-wrong'), '两张牌抖动（is-wrong）');
ok(!tileEl(wTile.id).classList.contains('is-matched'), '配对失败不爆炸消除（没有 is-matched）');
ok(statText('misses') === '1', '失误数打到页面上');
ok(session().matched.length === 0, '失败的组合不计入已配对');

const boardsBefore = boardSets;
const removedBefore = removedCount;
act('match-pick', { tile: wTile.id });
ok(session().selectedId === wTile.id, '重新选中原词牌');
act('match-pick', { tile: dTile.id });
ok(session().matched.length === 2 && session().combo === 1, '词 + 义（同一张卡）→ 配对成功');
ok(tileEl(wTile.id).classList.contains('is-matched') && tileEl(dTile.id).classList.contains('is-matched'), '两张牌金光（is-matched）');
ok(tileEl(wTile.id).classList.contains('is-boom') && tileEl(dTile.id).classList.contains('is-boom'), '两张牌进入爆炸动画（is-boom）');
ok(tileEl(wTile.id).disabled === true && tileEl(dTile.id).disabled === true, '已配对的牌不可再点（disabled）');
ok(tileEl(wTile.id).getAttribute('aria-pressed') === 'true', '已配对的牌 aria-pressed=true');
ok(statText('pairs') === '1/20' && statText('combo') === '1', '进度 / 连击已刷新');
ok(roundLine() === '第 1/4 轮 · 本轮还剩 4 对', '轮次行同步（本轮还剩 4 对）');
ok(progressBar.getAttribute('aria-valuenow') === '5' && progressFill.style.width === '5%', '进度条 aria-valuenow / 填充宽度随配对更新');
ok(boardSets === boardsBefore, '配对成功不重铺棋盘（等爆炸播完再移除这两张）');
act('match-pick', { tile: wTile.id });
ok(session().matched.length === 2 && session().combo === 1, '点已配对的牌无效（ignore）');

await tick(460); // 等爆炸动画播完（BOOM_MS = 420）
ok(removedCount === removedBefore + 2, '爆炸播完 → 这一对真的被移除（不再显示）');
ok(tiles.length === 8 && !tileEl(wTile.id) && !tileEl(dTile.id), '这两张牌从 DOM 上消失（棋盘只剩 8 张）');
ok(boardSets === boardsBefore, '移除单对牌不需要重铺棋盘（只摘掉这两个元素）');
ok(statText('pairs') === '1/20', '统计区保持「已配对 1 对」');
const focused = tiles.filter((t) => t.focusCount > 0);
ok(focused.length === 1 && focused[0].disabled === false, '爆炸消除后焦点交给下一张还能点的牌（键盘连玩）');

const wOther = 'w-' + wrongDef.cardId;
// 必须挑「另一张」词牌：点到同一张会走成 cancel 而不是 replace
const w2 = liveBoardTiles().find((t) => t.kind === 'word' && t.id !== wOther);
ok(!!w2 && w2.id !== wOther, '棋盘上还有另一张可改选的词牌');
act('match-pick', { tile: w2.id });
act('match-pick', { tile: wOther });
ok(session().selectedId === wOther, '点同类另一张 → 改选（replace）');
ok(tileEl(w2.id).classList.contains('is-selected') === false, '旧选中取消高亮');
act('match-pick', { tile: wOther });
ok(session().selectedId === null, '再点同一张 → 取消选中（cancel）');

console.log('\n[薄 UI：连击提示 combo✖️N（连续配对成功）]');
reduceMotion(); // 之后爆炸立即结束（不必等 20 × 420ms）
ok(comboEl.hidden === true, '连击 <2 时提示隐藏');
const setsInCombo = rootSets;
const playPair = async () => {
  if (session().selectedId) act('match-pick', { tile: session().selectedId });
  const w = matchMod.liveTiles(session()).find((t) => t.kind === 'word');
  act('match-pick', { tile: w.id });
  act('match-pick', { tile: 'd-' + w.cardId });
  await tick(); // 等 rAF 回填 is-pop + 爆炸移除
  return w;
};
await playPair();
ok(session().combo === 2 && comboEl.hidden === false, '第 2 次连续配对成功 → 提示浮出');
ok(comboEl.textContent === 'combo✖️2', '文字 = combo✖️2');
ok(comboEl.classList.contains('is-pop'), '带抖动动画（is-pop，由 rAF 重放）');
await playPair();
ok(session().combo === 3 && comboEl.textContent === 'combo✖️3', '第 3 次连续成功 → combo✖️3（N 次就是 combo✖️N）');
ok(rootSets === setsInCombo, '连击提示只改文字 + 重放动画，不整页重渲染');
const liveC = matchMod.liveTiles(session());
const cw = liveC.find((t) => t.kind === 'word');
const badd = liveC.find((t) => t.kind === 'def' && t.cardId !== cw.cardId);
act('match-pick', { tile: cw.id });
act('match-pick', { tile: badd.id });
ok(session().combo === 0 && comboEl.hidden === true, '配对失败 → 连击清零，提示收起');
ok(!comboEl.classList.contains('is-pop'), '抖动动画一并复位');

console.log('\n[薄 UI：本轮清空 → 自动铺下一轮]');
/** 把「当前轮」剩下的对全部点掉（走真实事件委托 + 等爆炸移除） */
async function playOneRound() {
  const target = matchMod.roundIndex(session());
  let guard = 0;
  while (matchMod.roundIndex(session()) === target && guard++ < 20) {
    if (session().selectedId) act('match-pick', { tile: session().selectedId });
    const w = matchMod.liveTiles(session()).find((t) => t.kind === 'word');
    if (!w) break;
    act('match-pick', { tile: w.id });
    act('match-pick', { tile: 'd-' + w.cardId });
    await tick();
  }
}
const boardSetsBefore = boardSets;
const rootsBefore = rootSets;
const oldFirst = tiles[0].dataset.tile;
await playOneRound();
ok(session().round === 1 && session().matched.length === 10, '本轮 5 对全消完 → 自动进入下一轮（已消 10 张）');
ok(tiles.length === 10 && matchMod.roundLeft(session()) === 5, '新一轮重新铺 5 对（棋盘 10 张）');
ok(!matchMod.liveTiles(session()).some((t) => t.id === oldFirst), '上一轮的牌不再出现在棋盘上');
ok(boardSets === boardSetsBefore + 1, '铺下一轮只重写 #match-board 一次');
ok(rootSets === rootsBefore, '整页 innerHTML 没有被再次写入（不整页重渲染）');
ok((boardEl._html.match(/data-action="match-pick"/g) || []).length === 10, '棋盘区域 HTML 换成新一轮的 10 张牌');
ok(roundLine() === '第 2/4 轮 · 本轮还剩 5 对', '轮次行更新为第 2/4 轮');
ok(comboEl.hidden === false && comboEl.textContent.startsWith('combo✖️'), '连击提示跨轮保留（连击没有中断）');
ok(!boardEl._html.includes(oldFirst), '棋盘区域被整体替换（不含上一轮的牌面）');

console.log('\n[薄 UI：全部配完 → 结算面板]');
const comboBeforeFinish = session().combo;
let guard = 0;
while (!matchMod.isDone(session()) && guard++ < 40) {
  if (session().selectedId) act('match-pick', { tile: session().selectedId });
  const w = matchMod.liveTiles(session()).find((t) => t.kind === 'word');
  act('match-pick', { tile: w.id });
  act('match-pick', { tile: 'd-' + w.cardId });
  await tick();
}
const fin = session();
ok(matchMod.isDone(fin) === true && fin.endedAt != null, '全部配对完成（会话定格用时）');
ok(fin.tiles.length === 40 && fin.matched.length === 40, '整关 20 对全部消除');
ok(resultPanel.innerHTML.includes('全部配对完成'), '结算面板渲染「全部配对完成」');
ok(
  resultPanel.innerHTML.includes('用时') && resultPanel.innerHTML.includes('失误') && resultPanel.innerHTML.includes('最大连击'),
  '结算面板含 用时 / 失误 / 最大连击'
);
ok(resultPanel.hidden === false && resultPanel.classList.contains('show'), '结算面板显示（去掉 hidden）');
ok(replayBtn.focusCount >= 1, '焦点移到「再玩一次」（键盘可继续）');
ok(fin.mistakes === 2, '本局成绩：失误 2 次（两处故意配错）');
ok(fin.maxCombo === fin.combo && fin.combo === comboBeforeFinish + 15, '全程只失误 2 次 → 连击跨轮连续累计到底');
ok(statText('pairs') === '20/20' && statText('misses') === '2', '页面上进度 / 失误同步');
ok(roundLine() === '全部完成 · 共 4 轮', '轮次行变成「全部完成 · 共 4 轮」');
ok(tiles.length === 0 && boardEl._html.includes('全部配对完成'), '棋盘清空并给出完成提示（所有牌都已爆炸消除）');
ok(progressBar.getAttribute('aria-valuenow') === '100' && progressFill.style.width === '100%', '进度条走到 100%');

console.log('\n[薄 UI：换关 / 再玩一次 / 返回]');
const before = session();
act('match-replay');
ok(matchMod.isDone(session()) === false && session().matched.length === 0, '再玩一次 → 重新开局（清空进度）');
ok(session().level === 2 && session().tiles.length === 40, '重开保持同一关');
ok(session().tiles.map((t) => t.id).join() !== before.tiles.map((t) => t.id).join(), '重开会重新洗牌');
ok(tiles.length === 10 && session().round === 0, '重开后 DOM 只铺第 1 轮的 10 张牌');
ok(session().matched.length === 0 && matchMod.roundLeft(session()) === 5, '重开后回到第 1 轮 / 本轮还剩 5 对');
act('match-level', { level: '0' });
ok(session().level === 0 && ROOT._html.includes('明牌配对 · 第 1 关'), '换关 → 重新开局到指定关卡');
ok(ROOT._html.includes('class="match-lv is-active" data-action="match-level" data-level="0"'), '关卡 chips 高亮跟随');
act('match-level', { level: '3' });
ok(session().level === 0, '未通关的关卡不可切换');
act('match-level', { level: 'xx' });
ok(session().level === 0, '非法关卡号安全忽略');
act('match-back');
ok(location.hash === '#/deck/' + d3.id, '返回卡组 → 跳回 #/deck/{id}');
ok(session() === null && !mem[matchMod.SESSION_KEY], '返回时清空会话与 sessionStorage');

console.log('\n[薄 UI：会话延续 / 重渲染不重新洗牌]');
matchMod.renderMatch(ROOT, d3.id);
const order1 = session().tiles.map((t) => t.id).join();
const wFirst = matchMod.liveTiles(session()).find((t) => t.kind === 'word');
act('match-pick', { tile: wFirst.id });
const selId = session().selectedId;
ok(selId === wFirst.id, '本轮的牌可选中（越界牌才 ignore）');
matchMod.renderMatch(ROOT, d3.id); // 模拟主题切换等重渲染
ok(session().selectedId === selId, '重渲染沿用会话（选中态保留）');
ok(session().tiles.map((t) => t.id).join() === order1, '重渲染不重新洗牌');
ok(ROOT._html.includes('is-selected'), '重渲染后选中高亮恢复');
ok(tiles.length === 10 && session().round === 0, '重渲染只铺当前轮的 10 张牌');
ok(ROOT._html.includes('第 1/4 轮 · 本轮还剩 5 对'), '重渲染后轮次行按会话还原');

/* 消掉一对 → 重渲染：已消的牌不能复活 */
act('match-pick', { tile: selId }); // 再点一次 → 取消选中
ok(session().selectedId === null, '再点同一张 → 取消选中（会话随之落盘）');
act('match-pick', { tile: wFirst.id });
act('match-pick', { tile: 'd-' + wFirst.cardId });
await tick(); // 减少动效 → 爆炸立即结束，这一对从 DOM 移除
ok(!matchMod.liveTiles(session()).some((t) => t.id === wFirst.id), '消掉的一对不再出现在棋盘上');
matchMod.renderMatch(ROOT, d3.id);
ok(tiles.length === 8 && session().matched.length === 2, '重渲染后依旧只剩 8 张（已消的牌不复活）');
ok(ROOT._html.includes('第 1/4 轮 · 本轮还剩 4 对'), '重渲染后本轮剩余对数正确');

/* 旧版（整盘平铺）会话 → 丢弃重开，避免出现「半截棋盘」 */
matchMod.clearMatchSession();
mem[matchMod.SESSION_KEY] = JSON.stringify({
  deckId: d3.id,
  level: 2,
  tiles: [{ id: 'w-x', kind: 'word', cardId: 'a' }],
  matched: [],
  selectedId: null,
  startedAt: Date.now()
});
matchMod.renderMatch(ROOT, d3.id);
ok(session().roundPairs === 5 && session().tiles.length === 40, '旧版 / 损坏会话被丢弃 → 重新开局（每轮 5 对）');
ok(session().matched.length === 0 && session().round === 0, '新局干净：未消牌、第 1 轮');

matchMod.clearMatchSession();
matchMod.renderMatch(ROOT, d3.id);
ok(!!session() && matchMod.isDone(session()) === false && session().matched.length === 0, '会话丢失 → 自动开新局');
ok(session().level === 2 && session().tiles.length === 40, '新局默认最高已通关关卡');

console.log('\n[入口横幅 / 未解锁兜底 / 卡组不存在]');
const fresh = seedDeck('未通关卡组', 40); // 40 张 / 2 关，一关都没通关
ok(matchMod.unlockInfo(fresh).unlocked === false && matchMod.unlockInfo(fresh).left === 1, '一关未通关 → 未解锁（还差 1 关）');
matchMod.clearMatchSession();
matchMod.renderMatch(ROOT, fresh.id);
ok(ROOT._html.includes('明牌配对尚未解锁') && !ROOT._html.includes('id="match-board"'), '未解锁 → 引导页（不出现棋盘）');
ok(ROOT._html.includes('还差 1 关'), '引导页写明还差几关');
ok(ROOT._html.includes('每轮 5 对明牌') && ROOT._html.includes('combo✖️N'), '引导页写明新玩法（每轮 5 对 / 爆炸消除 / 连击）');
ok(session() === null, '未解锁不建会话');
decks.renderDeck(ROOT, fresh.id);
ok(!ROOT._html.includes('data-action="open-match"'), '未解锁的卡组没有入口横幅');

const dOne2 = store.getDeck(passLevels(fresh.id, [0]).id);
ok(matchMod.unlockInfo(dOne2).unlocked === true, '通关 1 关 → 解锁（v0.5.12 新规则）');
decks.renderDeck(ROOT, dOne2.id);
ok(ROOT._html.includes('class="match-banner glass" data-action="open-match"'), '解锁 1 关的卡组也显示入口横幅');
ok(/match-banner[\s\S]{0,700}可选 1 个已通关关卡/.test(ROOT._html), '横幅写明可玩的已通关关卡数（1 关）');
decks.renderDeck(ROOT, d3.id);
ok(/match-banner[\s\S]{0,700}可选 3 个已通关关卡/.test(ROOT._html), '通关 3 关 → 横幅写 可选 3 个已通关关卡');
ok(
  ROOT._html.indexOf('deck-hero') < ROOT._html.indexOf('match-banner') &&
    ROOT._html.indexOf('match-banner') < ROOT._html.indexOf('levels-wrap'),
  '横幅位于卡组头盔与关卡列表之间'
);
act('open-match', { id: d3.id });
ok(location.hash === '#/match/' + d3.id, '点横幅 → #/match/{id}');
matchMod.clearMatchSession();
matchMod.renderMatch(ROOT, 'nope');
ok(ROOT._html.includes('卡组不存在') && session() === null, '卡组不存在 → 兜底页');

console.log('\n[接线：路由 / 顶栏 / SW / 版本 / 样式]');
const appSrc = read('js/app.js');
const decksSrc = read('js/decks.js');
const swSrc = read('sw.js');
const cssSrc = read('css/style.css');
ok(/import \{ renderMatch, clearMatchSession \} from '\.\/match\.js'/.test(appSrc), 'app.js 引入 match.js（renderMatch / clearMatchSession）');
ok(/seg\[0\] === 'match' && seg\[1\]/.test(appSrc), 'app.js 解析 #/match/{deckId} 路由');
ok(/case 'match':[\s\S]{0,200}t = '明牌配对'/.test(appSrc), "顶栏标题「明牌配对」+ 返回卡组");
ok(/route\.view === 'match'[\s\S]{0,140}renderMatch\(root, route\.id\)/.test(appSrc), 'render() 分发到 renderMatch');
ok(/clearMatchSession\(\); \/\/ 同时清除配对棋局与计时器/.test(appSrc), 'hashchange 清空配对会话与计时器');
ok(/v0\.5\.12/.test(appSrc) && /通关 ≥\s?1 关/.test(appSrc), 'APP_VERSION 升到 v0.5.12（解锁 ≥1 关）');
ok(swSrc.includes("'./js/match.js'") && /VERSION = 'v1\.10\.2'/.test(swSrc), 'sw.js 预缓存 match.js 且 VERSION = v1.10.2');
ok(existsSync(resolve(ROOTDIR, 'js/match.js')) && existsSync(resolve(ROOTDIR, 'scripts/test-match.mjs')), 'js/match.js 与 scripts/test-match.mjs 均存在');
ok(/data-action="open-match" data-id="\$\{esc\(deck\.id\)\}"/.test(decksSrc), 'decks.js 入口横幅 data-action=open-match');
ok(/on\('open-match', \(el\) => navigate\(`#\/match\/\$\{el\.dataset\.id\}`\)\)/.test(decksSrc), 'decks.js 注册 open-match 动作');
ok(/import \* as match from '\.\/match\.js'/.test(decksSrc), 'decks.js 复用 match.js 的解锁判定（规则只写一处）');
ok(/const passedCount = levels\.filter/.test(decksSrc), 'decks.js 复用已算好的通关关数（不重复遍历）');
ok(/\.match-banner \{/.test(cssSrc) && /\.match-board \{/.test(cssSrc) && /\.match-tile \{/.test(cssSrc), 'CSS：横幅 / 棋盘 / 牌面样式齐备');
ok(
  /@keyframes match-goldflash/.test(cssSrc) && /@keyframes match-burst/.test(cssSrc) && /@keyframes match-shake/.test(cssSrc),
  'CSS：金光 / 迸发 / 抖动关键帧'
);
const animStart = cssSrc.indexOf('.match-tile.is-matched');
const animEnd = cssSrc.indexOf('@keyframes match-shake');
const animBlock = animStart >= 0 && animEnd > animStart ? cssSrc.slice(animStart, animEnd) : '';
ok(animBlock && !/infinite/.test(animBlock), '配对动画都是一次性的（非 infinite → 减少动效可收敛）');
ok(/\.match-tile\.is-matched::after \{[\s\S]{0,400}match-burst/.test(cssSrc), '金色迸发由 ::after 承载（一次性播放）');
ok(
  /@media \(prefers-reduced-motion: reduce\)/.test(cssSrc) && /animation-iteration-count: 1 !important/.test(cssSrc),
  '既有全局「减少动效」仍覆盖新动画'
);
ok(/\.match-result\[hidden\] \{ display: none; \}/.test(cssSrc), '结算面板隐藏态有显式样式');

/* v0.5.12：固定两列 + 轮次行 + combo✖️N 提示 + 爆炸消除动画 */
ok(
  /\.match-board \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)[^}]*gap: clamp\(/.test(cssSrc),
  '棋盘固定两列（间距用 clamp 自适应，不随屏宽变多列）'
);
ok(
  /\.match-tile \{[^}]*min-height: clamp\([^)]+\)[^}]*font-size: clamp\(/.test(cssSrc),
  '牌高 / 字号随屏宽 clamp（两列下移动端不挤）'
);
const desktopBlocks = [...cssSrc.matchAll(/@media \(min-width: [^)]+\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]);
ok(
  desktopBlocks.length > 0 && desktopBlocks.every((b) => !/\.match-(board|tile|combo)/.test(b)),
  '桌面端媒体查询不再改棋盘列数 / 牌面尺寸（固定两列）'
);
ok(/\.match-round \{/.test(cssSrc), 'CSS：轮次行 .match-round');
ok(
  /\.match-tile\.is-boom[\s\S]{0,260}match-boom/.test(cssSrc) && /@keyframes match-boom/.test(cssSrc),
  'CSS：爆炸消除 .is-boom + match-boom 关键帧'
);
ok(
  /\.match-combo \{[\s\S]{0,900}left: 50%[\s\S]{0,120}top: 50%/.test(cssSrc) && /\.match-combo\[hidden\] \{ display: none; \}/.test(cssSrc),
  'CSS：连击提示浮在棋盘正中 + 隐藏态显式样式'
);
ok(
  /@keyframes combo-kick/.test(cssSrc) && /\.match-combo\.is-pop \{ animation: combo-kick/.test(cssSrc),
  'CSS：combo✖️N 抖动动画（combo-kick，改文字后重放）'
);

console.log(`\n明牌配对结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

