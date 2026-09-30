#!/usr/bin/env node
// ============================================================================
// test-match.mjs — 明牌配对游戏（v0.5.11，js/match.js）
//   运行: node scripts/test-match.mjs
// 覆盖：① 解锁判定（已通关关卡数 / 可玩关卡 / 默认关卡）
//       ② 建牌与洗牌（2N 张、牌 id 唯一、rng 可注入 → 完全可复现、上限兜底）
//       ③ 牌面文案（正面 / 背面 → 多释义 → 兜底文案）
//       ④ 点击状态机（select / cancel / replace / match / miss / ignore）
//       ⑤ 连击与统计（连击与最大连击 / 失误清零连击 / 用时文案 / 进度）
//       ⑥ 薄 UI（DOM 桩：棋盘渲染 / 局部打补丁不整页重渲染 / 金光·抖动 /
//          结算面板 / 换关 / 再玩一次 / 会话存取 / 卡组详情页入口横幅）
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

let tiles = [];
let statCells = [];
let innerSets = 0;
const resultPanel = mkEl('div');
const replayBtn = mkEl('button');
resultPanel.querySelector = (sel) => (sel === '[data-action="match-replay"]' ? replayBtn : null);
const announceEl = mkEl('div');
const progressBar = mkEl('div');
const progressFill = mkEl('i');
progressBar.querySelector = (sel) => (sel === '.progress-fill' ? progressFill : null);

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

function mkTileEl(id) {
  const el = mkEl('button');
  el.dataset.tile = id;
  return el;
}

function syncDom() {
  innerSets++;
  const s = matchMod.getMatchSession ? matchMod.getMatchSession() : null;
  tiles = s && s.tiles ? s.tiles.map((t) => mkTileEl(t.id)) : [];
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
  if (sel === '.match-tile') return tiles;
  if (sel === '.match-tile.is-wrong') return tiles.filter((t) => t.classList.contains('is-wrong'));
  if (sel === '[data-match]') return statCells.map((c) => c._value);
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

const session = () => matchMod.getMatchSession();
const storedSession = () => {
  const raw = mem[matchMod.SESSION_KEY];
  return raw ? JSON.parse(raw) : null;
};
const tileEl = (id) => tiles.find((t) => t.dataset.tile === id);
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

console.log('\n[解锁判定：通关 ≥ 3 关]');
const deck = seedDeck('配对测试', 80);
ok(matchMod.UNLOCK_LEVELS === 3, 'UNLOCK_LEVELS = 3');
ok(new Set(deck.cards.map((c) => c.level)).size === 4, '卡组就绪（80 张 / 4 关）');
ok(matchMod.passedCount(deck) === 0 && matchMod.unlockInfo(deck).unlocked === false, '一关未通关 → 未解锁');
ok(matchMod.unlockInfo(deck).left === 3 && matchMod.unlockInfo(deck).need === 3, '解锁进度：还差 3 关');
ok(matchMod.defaultLevel(deck) === null && matchMod.passedLevels(deck).length === 0, '没有已通关关卡 → 无默认开局关卡');

const d2 = passLevels(deck.id, [0, 1]);
ok(matchMod.passedCount(d2) === 2 && matchMod.unlockInfo(d2).unlocked === false, '通关 2 关仍未解锁');
ok(matchMod.unlockInfo(d2).left === 1, '还差 1 关');
ok(matchMod.defaultLevel(d2) === 1, '默认开局 = 最高的已通关关卡（索引 1）');
ok(matchMod.isPlayableLevel(d2, 1) === true && matchMod.isPlayableLevel(d2, 2) === false, '只能玩已通关的关卡');

const d3 = passLevels(deck.id, [2]);
ok(matchMod.unlockInfo(d3).unlocked === true, '通关 3 关 → 解锁');
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

/* ------------------------- 薄 UI：渲染 / 点击打补丁 ------------------------- */

console.log('\n[薄 UI：棋盘渲染]');
matchMod.clearMatchSession();
matchMod.renderMatch(ROOT, d3.id);
ok(ROOT._html.includes('class="view view-match"'), '渲染明牌配对页');
ok(tiles.length === 40, 'DOM 里 40 张牌（2N）');
ok(ROOT._html.includes('明牌配对 · 第 3 关'), '默认开局最高已通关关卡（第 3 关）');
ok(ROOT._html.includes('role="progressbar" aria-label="配对进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"'), '进度条 role=progressbar + aria-valuemin/max/now');
ok((ROOT._html.match(/data-action="match-pick"/g) || []).length === 40, '每张牌都是 match-pick 按钮（原生 button，键盘可达）');
ok(ROOT._html.includes('aria-pressed="false"'), '未选中的牌 aria-pressed=false');
ok(ROOT._html.includes('match-tile-word') && ROOT._html.includes('match-tile-def'), '词牌 / 义牌 class 区分（视觉可辨）');
ok(ROOT._html.includes('aria-label="单词「') && ROOT._html.includes('aria-label="释义「'), '牌面有中文 aria-label（读屏可懂）');
ok(ROOT._html.includes('role="group" aria-label="配对棋盘"'), '棋盘是 role=group + aria-label');
ok((ROOT._html.match(/data-action="match-level"/g) || []).length === 3, '关卡选择只列 3 个已通关关卡');
ok(ROOT._html.includes('class="match-lv is-active" data-action="match-level" data-level="2"'), '当前关卡 chip 高亮');
ok(ROOT._html.includes('id="match-result"') && ROOT._html.includes('hidden'), '结算面板初始隐藏');
ok(session().level === 2 && session().tiles.length === 40, '会话已建立（40 张牌）');
ok(!!storedSession() && storedSession().deckId === d3.id, '会话写入 sessionStorage（刷新不丢牌面）');
ok(
  ROOT._html.includes('<b data-match="time">0秒</b>') &&
    ROOT._html.includes('<b data-match="pairs">0/20</b>') &&
    ROOT._html.includes('<b data-match="misses">0</b>') &&
    ROOT._html.includes('<b data-match="combo">0</b>'),
  '统计区初值直接写在页面 HTML 上（用时 / 已配对 / 失误 / 连击）'
);

console.log('\n[薄 UI：点击 → 局部打补丁（不整页重渲染）]');
let S = session();
const wTile = S.tiles.find((t) => t.kind === 'word');
const dTile = S.tiles.find((t) => t.id === 'd-' + wTile.cardId);
const wrongDef = S.tiles.find((t) => t.kind === 'def' && t.cardId !== wTile.cardId);
const setsBefore = innerSets;
act('match-pick', { tile: wTile.id });
ok(session().selectedId === wTile.id, '点词牌 → 选中');
ok(tileEl(wTile.id).classList.contains('is-selected'), '选中态打上（is-selected）');
ok(tileEl(wTile.id).getAttribute('aria-pressed') === 'true', '选中态 aria-pressed=true');
ok(innerSets === setsBefore, '点击只打补丁，不写 innerHTML（不整页重渲染）');
act('match-pick', { tile: wTile.id });
ok(session().selectedId === null && tileEl(wTile.id).classList.contains('is-selected') === false, '再点同一张 → 取消选中');
act('match-pick', { tile: wTile.id });
act('match-pick', { tile: wrongDef.id });
ok(session().mistakes === 1 && session().combo === 0 && session().selectedId === null, '配对失败 → 失误 +1、连击清零、取消选中');
ok(tileEl(wTile.id).classList.contains('is-wrong') && tileEl(wrongDef.id).classList.contains('is-wrong'), '两张牌抖动（is-wrong）');
ok(statText('misses') === '1', '失误数打到页面上');
ok(session().matched.length === 0, '失败的组合不计入已配对');
act('match-pick', { tile: wTile.id });
act('match-pick', { tile: dTile.id });
ok(session().matched.length === 2 && session().combo === 1, '词 + 义（同一张卡）→ 配对成功');
ok(tileEl(wTile.id).classList.contains('is-matched') && tileEl(dTile.id).classList.contains('is-matched'), '两张牌金光（is-matched）');
ok(tileEl(wTile.id).disabled === true && tileEl(dTile.id).disabled === true, '已配对的牌不可再点（disabled）');
ok(tileEl(wTile.id).getAttribute('aria-pressed') === 'true', '已配对的牌 aria-pressed=true');
ok(statText('pairs') === '1/20' && statText('combo') === '1', '进度 / 连击已刷新');
ok(progressBar.getAttribute('aria-valuenow') === '5' && progressFill.style.width === '5%', '进度条 aria-valuenow / 填充宽度随配对更新');
act('match-pick', { tile: wTile.id });
ok(session().matched.length === 2 && session().combo === 1, '点已配对的牌无效（ignore）');
const focused = tiles.filter((t) => t.focusCount > 0);
ok(focused.length === 1 && focused[0].disabled === false, '配对后焦点交给下一张还能点的牌（键盘连玩）');
const w2 = session().tiles.find((t) => t.kind === 'word' && t.id !== wTile.id);
const wOther = 'w-' + wrongDef.cardId;
act('match-pick', { tile: w2.id });
act('match-pick', { tile: wOther });
ok(session().selectedId === wOther, '点同类另一张 → 改选（replace）');
ok(tileEl(w2.id).classList.contains('is-selected') === false, '旧选中取消高亮');
act('match-pick', { tile: wOther });
ok(session().selectedId === null, '再点同一张 → 取消选中（cancel）');

console.log('\n[薄 UI：完成 → 结算面板]');
if (session().selectedId) act('match-pick', { tile: session().selectedId });
const rest = session().tiles.filter((t) => !session().matched.includes(t.id) && t.kind === 'word');
for (const w of rest) {
  act('match-pick', { tile: w.id });
  act('match-pick', { tile: 'd-' + w.cardId });
}
const fin = session();
ok(matchMod.isDone(fin) === true && fin.endedAt != null, '全部配对完成（会话定格用时）');
ok(resultPanel.innerHTML.includes('全部配对完成'), '结算面板渲染「全部配对完成」');
ok(
  resultPanel.innerHTML.includes('用时') && resultPanel.innerHTML.includes('失误') && resultPanel.innerHTML.includes('最大连击'),
  '结算面板含 用时 / 失误 / 最大连击'
);
ok(resultPanel.hidden === false && resultPanel.classList.contains('show'), '结算面板显示（去掉 hidden）');
ok(replayBtn.focusCount >= 1, '焦点移到「再玩一次」（键盘可继续）');
ok(fin.mistakes === 1 && fin.maxCombo === 20, '本局成绩：失误 1 次、最大连击 20');
ok(statText('pairs') === '20/20' && statText('misses') === '1', '页面上进度 / 失误同步');

console.log('\n[薄 UI：换关 / 再玩一次 / 返回]');
const before = session();
act('match-replay');
ok(matchMod.isDone(session()) === false && session().matched.length === 0, '再玩一次 → 重新开局（清空进度）');
ok(session().level === 2 && session().tiles.length === 40, '重开保持同一关');
ok(session().tiles.map((t) => t.id).join() !== before.tiles.map((t) => t.id).join(), '重开会重新洗牌');
ok(tiles.length === 40, '重开后 DOM 重新铺 40 张牌');
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
act('match-pick', { tile: session().tiles.find((t) => t.kind === 'word').id });
const selId = session().selectedId;
matchMod.renderMatch(ROOT, d3.id); // 模拟主题切换等重渲染
ok(session().selectedId === selId, '重渲染沿用会话（选中态保留）');
ok(session().tiles.map((t) => t.id).join() === order1, '重渲染不重新洗牌');
ok(ROOT._html.includes('is-selected'), '重渲染后选中高亮恢复');
matchMod.clearMatchSession();
matchMod.renderMatch(ROOT, d3.id);
ok(!!session() && matchMod.isDone(session()) === false && session().matched.length === 0, '会话丢失 → 自动开新局');
ok(session().level === 2 && session().tiles.length === 40, '新局默认最高已通关关卡');

console.log('\n[入口横幅 / 未解锁兜底 / 卡组不存在]');
const small = seedDeck('两关卡组', 40);
passLevels(small.id, [0, 1]);
const d4 = store.getDeck(small.id);
ok(matchMod.unlockInfo(d4).unlocked === false, '两关卡组未解锁（需 3 关）');
matchMod.clearMatchSession();
matchMod.renderMatch(ROOT, d4.id);
ok(ROOT._html.includes('明牌配对尚未解锁') && !ROOT._html.includes('id="match-board"'), '未解锁 → 引导页（不出现棋盘）');
ok(ROOT._html.includes('还差 1 关'), '引导页写明还差几关');
ok(session() === null, '未解锁不建会话');
decks.renderDeck(ROOT, d4.id);
ok(!ROOT._html.includes('data-action="open-match"'), '未解锁的卡组没有入口横幅');
decks.renderDeck(ROOT, d3.id);
ok(ROOT._html.includes('class="match-banner glass" data-action="open-match"'), '已解锁的卡组显示入口横幅');
ok(/match-banner[\s\S]{0,700}可选 3 个已通关关卡/.test(ROOT._html), '横幅写明可玩的已通关关卡数');
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
ok(/v0\.5\.11/.test(appSrc), 'APP_VERSION 升到 v0.5.11');
ok(swSrc.includes("'./js/match.js'") && /VERSION = 'v1\.10\.1'/.test(swSrc), 'sw.js 预缓存 match.js 且 VERSION = v1.10.1');
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

console.log(`\n明牌配对结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

