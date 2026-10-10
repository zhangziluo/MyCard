// ============================================================================
// crossword.js — 填字游戏（v0.6.0，路由 #/crossword/{deckId}）
//
// 解锁：卡组「已通关关卡」≥ UNLOCK_LEVELS（1）时，卡组详情页出现入口横幅。
// 词源：默认取「最高已通关关卡」的卡片；也可切到「整卡组」——按每局词数（6/8/10/12）
//       随机抽词，**完全由当前词库生成**（「换一批」即重新抽词 + 重新排版）。
// 玩法：把抽到的单词横竖交叉排进棋盘（释义作线索），玩家读线索 → 逐格填字母：
//         · 「检查」→ 填错的格标红抖动（空着的格提示还剩几格）；
//         · 「提示一字母」→ 随机补一个还没填对的格（计入提示次数，并标为「已提示」）；
//         · 「显示本词」→ 把当前线索一次填全；
//         · 全部字母正确 → 结算「用时 / 提示次数 / 线索数」+ 换一批 / 重新开始。
//
// 分工（与 js/match.js 同一约定，见 memory-bank/systemPatterns.md 第 20 条）：
//   · 纯函数内核：抽词 / 交叉排版（canPlace 规则）/ 线索编号 / 逐格状态机 / 统计
//     （随机源 rng 可注入 → 单测完全可复现，不依赖 DOM）
//   · 薄 UI：把内核状态画成 DOM，把输入喂回内核；**输入只局部打补丁**（不整页重渲染，
//     否则会丢焦点 / 丢光标 / 丢输入法候选框）
//
// 会话：sessionStorage（key mycard-crossword-session，关掉标签页即清空）；
//       路由切换时由 app.js 调 clearCrosswordSession() 清场。
// ============================================================================

import * as store from './store.js';
import * as lv from './levels.js';
import * as kb from './keyboard.js'; // v0.7.0 移动端英文字母键盘
import { esc, on, icon, navigate, announce, toast } from './ui.js';

/** 解锁所需「已通关关卡」数（含）——通关 1 关即可玩（与明牌配对同门槛） */
export const UNLOCK_LEVELS = 1;

/** 单词有效长度范围（纯字母；太短无法交叉、太长会把棋盘撑爆） */
export const MIN_LEN = 2;
export const MAX_LEN = 12;

/** 每局词数档位（「根据当前词库自定义生成」的粒度） */
export const SIZES = [6, 8, 10, 12];

/** 每局默认词数 */
export const DEFAULT_SIZE = 8;

/**
 * 棋盘格子尺寸范围（px），由 cellSize() 按行列数 + 视口收敛。
 * 触屏下限高得多（30px）：手指点得准、字母看得清；棋盘放不下就由
 * `.cw-board-wrap` 横向滚动，并把当前焦点格自动滚进视野（不再把格子压成 18px）。
 */
export const MIN_CELL = 24;
export const TOUCH_MIN_CELL = 30;
export const MAX_CELL = 40;

/** 底部字母键盘展开时，棋盘可用高度（视口比例）—— 触屏比桌面更少 */
export const TOUCH_HEIGHT_RATIO = 0.4;
export const DESKTOP_HEIGHT_RATIO = 0.52;

/** 棋盘外层横向留白（px）：触屏窄屏，留白更小 */
export const TOUCH_H_PAD = 34;
export const DESKTOP_H_PAD = 72;

/** 移动端视口宽度阈值（未显式给 touch 时，按此推断是否触屏布局） */
export const TOUCH_VIEWPORT_WIDTH = 600;

export const SESSION_KEY = 'mycard-crossword-session';

/* ---------------------------- 解锁 / 可选词源 ---------------------------- */

/** 已通关的关卡索引（升序）——填字游戏只开放「已通关」的关卡作为词源 */
export function passedLevels(deck, levels = lv.deckLevels(deck)) {
  const states = lv.levelStates(deck, levels);
  return levels.filter((l) => states[l.index] === 'passed').map((l) => l.index);
}

export function passedCount(deck, levels = lv.deckLevels(deck)) {
  return passedLevels(deck, levels).length;
}

/** 解锁状态：{ passed, need, unlocked, left } */
export function unlockInfo(deck) {
  const passed = passedCount(deck);
  return {
    passed,
    need: UNLOCK_LEVELS,
    unlocked: passed >= UNLOCK_LEVELS,
    left: Math.max(0, UNLOCK_LEVELS - passed)
  };
}

/** 默认词源：最高的已通关关卡（没有已通关关卡时退回「整卡组」） */
export function defaultSource(deck) {
  const list = passedLevels(deck);
  if (list.length) return { kind: 'level', level: list[list.length - 1] };
  return { kind: 'deck', level: null };
}

/** 该关卡是否可作词源（必须已通关） */
export function isPlayableLevel(deck, level) {
  return passedLevels(deck).includes(Number(level));
}

/** 词源是否仍然有效（关卡可能被重排 / 已通关状态可能被重置） */
export function isValidSource(deck, source) {
  if (!source || source.kind !== 'level') return true; // 「整卡组」永远有效
  return isPlayableLevel(deck, source.level);
}

/** 取词源的卡片列表 */
export function sourceCards(deck, source) {
  if (source && source.kind === 'level') return lv.cardsInLevel(deck, Number(source.level) || 0);
  return (deck && deck.cards) || [];
}

/** 词源文案（头部提示用） */
export function sourceLabel(source) {
  if (source && source.kind === 'level') return `第 ${Number(source.level) + 1} 关`;
  return '整卡组';
}

/* ------------------------------ 小工具 ------------------------------ */

/** 正整数兜底（入参容错） */
export function posInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/** 每局词数收敛到 SIZES（非法值 → DEFAULT_SIZE） */
export function clampSize(n) {
  const v = posInt(n, DEFAULT_SIZE);
  return SIZES.includes(v) ? v : DEFAULT_SIZE;
}

/** 格子坐标 key（负数行 / 列靠排版阶段允许，归一化后都 ≥0） */
export function cellKey(row, col) {
  return `${row},${col}`;
}

export function parseKey(key) {
  const parts = String(key == null ? '' : key).split(',');
  return [Number(parts[0]) || 0, Number(parts[1]) || 0];
}

/** Fisher-Yates 洗牌（随机源可注入 → 单测用 LCG 完全复现） */
export function shuffle(list, rng = Math.random) {
  const a = [...(list || [])];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ------------------------------ 词条 ------------------------------ */

/** 线索文字：背面 → 第一条其它释义 → 兜底文案（换行压成空格，便于单行展示） */
export function clueText(card) {
  const c = card || {};
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const back = clean(c.back);
  if (back) return back;
  const extra = Array.isArray(c.extraBacks) ? clean(c.extraBacks[0]) : '';
  return extra || '（无释义）';
}

/** 单词只保留字母并转大写（`ice cream` → `ICECREAM`）；供棋盘逐格填写 */
export function sanitizeAnswer(front) {
  return String(front == null ? '' : front)
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
}

/** 由卡片生成词条；正面不是「可填词的纯字母」或长度越界 → null */
export function entryFromCard(card, maxLen = MAX_LEN) {
  if (!card || card.id == null) return null;
  const display = String(card.front || '').trim();
  if (!display) return null;
  const answer = sanitizeAnswer(display);
  if (answer.length < MIN_LEN) return null;
  if (answer.length > posInt(maxLen, MAX_LEN)) return null;
  return { cardId: card.id, answer, display, clue: clueText(card) };
}

/** 候选词条：过滤不可填词的卡片，并按「答案」去重（同词只留第一张） */
export function candidateEntries(cards, maxLen = MAX_LEN) {
  const seen = new Set();
  const out = [];
  for (const card of Array.isArray(cards) ? cards : []) {
    const entry = entryFromCard(card, maxLen);
    if (!entry || seen.has(entry.answer)) continue;
    seen.add(entry.answer);
    out.push(entry);
  }
  return out;
}

/* ---------------------------- 交叉排版（内核） ---------------------------- */

/** 词条按方向占用的格子坐标（dir: 'across' 横向 / 'down' 纵向） */
export function cellsOf(word, row, col, dir) {
  const len = posInt(word && word.length, 0);
  const out = [];
  for (let i = 0; i < len; i++) {
    out.push(dir === 'across' ? { row, col: col + i } : { row: row + i, col });
  }
  return out;
}

/** 当前棋盘外框（无格子时返回空框 → 首次落子从 (0,0) 开始） */
export function gridBounds(grid) {
  let minR = Infinity;
  let maxR = -Infinity;
  let minC = Infinity;
  let maxC = -Infinity;
  for (const k of grid.keys()) {
    const [r, c] = parseKey(k);
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
    if (c < minC) minC = c;
    if (c > maxC) maxC = c;
  }
  return { minR, maxR, minC, maxC };
}

function expandedBounds(b, row, col, len, dir) {
  const endR = dir === 'down' ? row + len - 1 : row;
  const endC = dir === 'across' ? col + len - 1 : col;
  return {
    minR: Math.min(b.minR, row),
    maxR: Math.max(b.maxR, endR),
    minC: Math.min(b.minC, col),
    maxC: Math.max(b.maxC, endC)
  };
}

/**
 * 能否把 answer 以 (row,col) 为起点、按 dir 放上棋盘？返回 { ok, cross }（cross = 交叉字母数）。
 * 规则（标准填字排版）：
 *   1. 已有字母的格子必须与答案同字母 —— 否则冲突；
 *   2. 同一格不能叠加两条**同向**单词（避免自我重叠）；
 *   3. 空格子（非交叉点）的**垂直方向**邻居必须为空 —— 否则会额外拼出一个 2 字母以上的词；
 *   4. 词首之前 / 词尾之后必须为空 —— 否则会与旁边的词连成长词。
 */
export function canPlace(grid, answer, row, col, dir) {
  const word = String(answer || '').toUpperCase();
  if (!word) return { ok: false, cross: 0 };
  const across = dir === 'across';
  const dr = across ? 0 : 1;
  const dc = across ? 1 : 0;
  const pr = across ? 1 : 0;
  const pc = across ? 0 : 1;
  let cross = 0;
  for (let i = 0; i < word.length; i++) {
    const r = row + dr * i;
    const c = col + dc * i;
    const cell = grid.get(cellKey(r, c));
    if (cell) {
      if (cell.letter !== word[i]) return { ok: false, cross: 0 };
      if (across ? cell.across : cell.down) return { ok: false, cross: 0 }; // 同向重叠
      cross++;
    } else if (grid.has(cellKey(r + pr, c + pc)) || grid.has(cellKey(r - pr, c - pc))) {
      return { ok: false, cross: 0 }; // 垂直相邻有字母 → 会拼出多余单词
    }
  }
  if (grid.has(cellKey(row - dr, col - dc))) return { ok: false, cross: 0 };
  if (grid.has(cellKey(row + dr * word.length, col + dc * word.length))) return { ok: false, cross: 0 };
  return { ok: true, cross };
}

/** 把词条写进棋盘（交叉格沿用已有字母，只补方向标记） */
export function placeWord(grid, entry, row, col, dir) {
  const across = dir === 'across';
  const answer = String(entry.answer || '');
  for (let i = 0; i < answer.length; i++) {
    const r = across ? row : row + i;
    const c = across ? col + i : col;
    const k = cellKey(r, c);
    const cell = grid.get(k) || { letter: answer[i], across: false, down: false };
    cell.letter = answer[i];
    if (across) cell.across = true;
    else cell.down = true;
    grid.set(k, cell);
  }
  return grid;
}

/**
 * 为新词条找最佳落点：与已有字母交叉，且尽量让外框紧凑。
 * 评分 = 交叉数 × 10000 − 外框面积（交叉优先，其次紧凑）；同分保留先遍历到的（可复现）。
 */
export function findPlacement(grid, entry) {
  if (!grid || !grid.size || !entry || !entry.answer) return null;
  const bounds = gridBounds(grid);
  let best = null;
  for (const [k, cell] of grid) {
    const [r, c] = parseKey(k);
    for (let i = 0; i < entry.answer.length; i++) {
      if (entry.answer[i] !== cell.letter) continue;
      for (const dir of ['across', 'down']) {
        const row = dir === 'down' ? r - i : r;
        const col = dir === 'across' ? c - i : c;
        const res = canPlace(grid, entry.answer, row, col, dir);
        if (!res.ok || res.cross < 1) continue;
        const box = expandedBounds(bounds, row, col, entry.answer.length, dir);
        const area = (box.maxR - box.minR + 1) * (box.maxC - box.minC + 1);
        const score = res.cross * 10000 - area;
        if (!best || score > best.score) best = { row, col, dir, cross: res.cross, score, area };
      }
    }
  }
  return best;
}


/**
 * 生成一盘填字棋盘（纯函数）。
 * @param {Array} cards 当前词库（卡组 / 某一关的卡片）
 * @param {{ size?: number, rng?: () => number, maxLen?: number }} opts
 * @returns 棋盘对象（见 buildBoard；凑不出词 → rows/cols = 0、cells/words 为空）
 */
export function generateCrossword(cards, opts = {}) {
  const size = clampSize(opts.size);
  const maxLen = posInt(opts.maxLen, MAX_LEN);
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const entries = candidateEntries(cards, maxLen);
  const picked = byLenDesc(shuffle(entries, rng)).slice(0, size);
  const grid = new Map();
  const placed = [];
  if (picked.length) {
    const first = picked[0];
    placeWord(grid, first, 0, 0, 'across'); // 最长的词横着打底
    placed.push({ ...first, dir: 'across', row: 0, col: 0 });
    for (const entry of picked.slice(1)) {
      const spot = findPlacement(grid, entry);
      if (!spot) continue; // 交叉不上就跳过（宁可少几个词，也不要断开的棋盘）
      placeWord(grid, entry, spot.row, spot.col, spot.dir);
      placed.push({ ...entry, dir: spot.dir, row: spot.row, col: spot.col });
    }
  }
  return buildBoard(grid, placed, { candidates: entries.length, picked: picked.length, size });
}

/**
 * 由「格子表 + 已落词条」生成棋盘：
 * 归一化坐标（左上角 (0,0)）→ 逐行扫描编号（起始格才编号，横竖同时起始时共用一个号）→
 * 建立格子索引（每格记录所属的横向 / 纵向线索 id）。
 * cells 按行优先排列；words 按「编号升序，同号横向在前」排列。
 */
export function buildBoard(grid, placed, meta = {}) {
  const size = clampSize(meta.size);
  const empty = {
    rows: 0,
    cols: 0,
    cells: [],
    words: [],
    used: 0,
    candidates: Number(meta.candidates) || 0,
    unplaced: Number(meta.picked) || 0,
    size
  };
  if (!grid || !grid.size) return empty;

  const b = gridBounds(grid);
  const rows = b.maxR - b.minR + 1;
  const cols = b.maxC - b.minC + 1;

  const raw = (placed || []).map((p) => ({ ...p, row: p.row - b.minR, col: p.col - b.minC }));

  // 编号：逐行扫描，凡「一条横向词的起点」或「一条纵向词的起点」就给下一个序号
  const numbers = new Map();
  let num = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const src = grid.get(cellKey(r + b.minR, c + b.minC));
      if (!src) continue;
      const startsAcross = src.across && !grid.has(cellKey(r + b.minR, c - 1 + b.minC));
      const startsDown = src.down && !grid.has(cellKey(r - 1 + b.minR, c + b.minC));
      if (startsAcross || startsDown) {
        num += 1;
        numbers.set(cellKey(r, c), num);
      }
    }
  }

  for (const w of raw) w.num = numbers.get(cellKey(w.row, w.col)) ?? null;
  raw.sort((a, z) => a.num - z.num || (a.dir === z.dir ? 0 : a.dir === 'across' ? -1 : 1));
  const words = raw.map((w, i) => ({ ...w, id: i, len: w.answer.length }));

  const cellByKey = new Map();
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const src = grid.get(cellKey(r + b.minR, c + b.minC));
      if (!src) continue;
      const cell = {
        row: r,
        col: c,
        letter: src.letter,
        num: numbers.get(cellKey(r, c)) ?? null,
        acrossId: null,
        downId: null
      };
      cellByKey.set(cellKey(r, c), cell);
      cells.push(cell);
    }
  }
  for (const w of words) {
    for (const pos of cellsOf(w.answer, w.row, w.col, w.dir)) {
      const cell = cellByKey.get(cellKey(pos.row, pos.col));
      if (!cell) continue;
      if (w.dir === 'across') cell.acrossId = w.id;
      else cell.downId = w.id;
    }
  }

  return {
    rows,
    cols,
    cells,
    words,
    used: words.length,
    candidates: Number(meta.candidates) || 0,
    unplaced: Math.max(0, (Number(meta.picked) || 0) - words.length),
    size
  };
}

/** 按答案长度降序（sort 稳定 → 等长词保持洗牌后的顺序，保证可复现又有变化） */
function byLenDesc(list) {
  return [...list].sort((a, b) => b.answer.length - a.answer.length);
}


/* ---------------------------- 逐格状态机（内核） ---------------------------- */

/** 棋盘格子索引：`r,c` → 格子（含答案字母 / 所属线索） */
export function cellMap(board) {
  const m = new Map();
  for (const cell of (board && board.cells) || []) m.set(cellKey(cell.row, cell.col), cell);
  return m;
}

/** 按 id 取线索 */
export function wordById(board, wordId) {
  const id = Number(wordId);
  return ((board && board.words) || []).find((w) => w.id === id) || null;
}

/** 一条线索占用的格子（含答案字母），可传入已建好的索引避免重复构建 */
export function wordCells(board, wordId, map = cellMap(board)) {
  const w = wordById(board, wordId);
  if (!w) return [];
  const out = [];
  for (const pos of cellsOf(w.answer, w.row, w.col, w.dir)) {
    const cell = map.get(cellKey(pos.row, pos.col));
    if (cell) out.push(cell);
  }
  return out;
}

/** 某格所属的线索：优先当前方向，其次另一方向 */
export function wordAt(state, row, col, dir = (state && state.dir) || 'across') {
  const board = (state && state.board) || {};
  const cell = cellMap(board).get(cellKey(row, col));
  if (!cell) return null;
  const prefer = dir === 'down' ? cell.downId : cell.acrossId;
  const other = dir === 'down' ? cell.acrossId : cell.downId;
  return wordById(board, prefer != null ? prefer : other);
}

/** 新对局（同一盘棋盘可以重开多次） */
export function newGame(board, opts = {}) {
  const first = (board && board.words && board.words[0]) || null;
  return {
    deckId: opts.deckId || '',
    source: opts.source || { kind: 'deck', level: null },
    size: clampSize(opts.size != null ? opts.size : board && board.size),
    board,
    letters: {},
    wrong: [],
    revealed: [],
    selected: first ? first.id : null,
    dir: first ? first.dir : 'across',
    hints: 0,
    startedAt: Number.isFinite(opts.now) ? opts.now : Date.now(),
    endedAt: null,
    solved: false
  };
}

/** 只保留 A–Z（非法输入 → 空串） */
export function normalizeLetter(ch) {
  const s = String(ch == null ? '' : ch).toUpperCase().replace(/[^A-Z]/g, '');
  return s ? s[s.length - 1] : '';
}

/** 全部填对 → 定格用时；否则清掉结束时间（改错一格就重新计时） */
export function finalize(state, now = Date.now()) {
  const p = progress(state);
  if (p.done) return { ...state, solved: true, endedAt: state.endedAt || now };
  return { ...state, solved: false, endedAt: null };
}

/** 写 / 清一格（不修改入参，便于单测） */
export function setLetter(state, row, col, ch) {
  const map = cellMap(state.board);
  const key = cellKey(row, col);
  if (!map.has(key)) return state;
  const letter = normalizeLetter(ch);
  const letters = { ...(state.letters || {}) };
  if (letter) letters[key] = letter;
  else delete letters[key];
  const wrong = (state.wrong || []).filter((k) => k !== key);
  const revealed = (state.revealed || []).filter((k) => k !== key); // 玩家改过就不再算「已提示」
  return finalize({ ...state, letters, wrong, revealed }, Date.now());
}

/** 提示 / 答案填入一格（保留「已提示」标记） */
export function revealCell(state, row, col) {
  const cell = cellMap(state.board).get(cellKey(row, col));
  if (!cell) return state;
  const key = cellKey(row, col);
  const letters = { ...(state.letters || {}), [key]: cell.letter };
  const revealed = Array.from(new Set([...(state.revealed || []), key]));
  const wrong = (state.wrong || []).filter((k) => k !== key);
  return finalize({ ...state, letters, revealed, wrong }, Date.now());
}

/** 一条线索的填写情况：{ id, len, filled, correct, done, state } */
export function wordProgress(state, wordId, map = cellMap(state.board)) {
  const cells = wordCells(state.board, wordId, map);
  const letters = (state && state.letters) || {};
  let filled = 0;
  let correct = 0;
  for (const cell of cells) {
    const v = letters[cellKey(cell.row, cell.col)];
    if (v) filled++;
    if (v === cell.letter) correct++;
  }
  const len = cells.length;
  const done = len > 0 && correct === len;
  return { id: Number(wordId), len, filled, correct, done, state: done ? 'correct' : filled ? 'partial' : 'empty' };
}

/** 整盘进度（单遍遍历格子，线索复用同一个索引） */
export function progress(state) {
  const board = (state && state.board) || {};
  const cells = board.cells || [];
  const words = board.words || [];
  const letters = (state && state.letters) || {};
  const map = cellMap(board);
  let filled = 0;
  let correct = 0;
  for (const cell of cells) {
    const v = letters[cellKey(cell.row, cell.col)];
    if (!v) continue;
    filled++;
    if (v === cell.letter) correct++;
  }
  let wordsFilled = 0;
  let wordsSolved = 0;
  for (const w of words) {
    const wp = wordProgress(state, w.id, map);
    if (wp.len && wp.filled === wp.len) wordsFilled++;
    if (wp.done) wordsSolved++;
  }
  const total = cells.length;
  return {
    total,
    filled,
    correct,
    empty: total - filled,
    words: words.length,
    wordsFilled,
    wordsSolved,
    percent: total ? Math.round((correct / total) * 100) : 0,
    done: total > 0 && correct === total
  };
}


export function isSolved(state) {
  return progress(state).done;
}

/** 检查：标出填错的格；返回 { state, wrong, empty, solved } */
export function checkAll(state) {
  const letters = (state && state.letters) || {};
  const wrong = [];
  for (const cell of (state.board && state.board.cells) || []) {
    const v = letters[cellKey(cell.row, cell.col)];
    if (v && v !== cell.letter) wrong.push(cellKey(cell.row, cell.col));
  }
  const p = progress(state);
  const next = finalize({ ...state, wrong }, Date.now());
  return { state: next, wrong, empty: p.empty, solved: next.solved };
}

/** 提示一字母：在「还没填对」的格里随机补一个（计入提示次数） */
export function hintCell(state, rng = Math.random) {
  const letters = (state && state.letters) || {};
  const pool = ((state.board && state.board.cells) || []).filter(
    (cell) => letters[cellKey(cell.row, cell.col)] !== cell.letter
  );
  if (!pool.length) return { state, cell: null };
  const idx = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
  const pick = pool[idx];
  const next = revealCell(state, pick.row, pick.col);
  return { state: { ...next, hints: (state.hints || 0) + 1 }, cell: { row: pick.row, col: pick.col } };
}

/** 显示整条线索的答案（每个新填的格计 1 次提示） */
export function revealWord(state, wordId) {
  const cells = wordCells(state.board, wordId);
  if (!cells.length) return { state, count: 0 };
  const letters = (state && state.letters) || {};
  let next = state;
  let count = 0;
  for (const cell of cells) {
    if (letters[cellKey(cell.row, cell.col)] === cell.letter) continue;
    next = revealCell(next, cell.row, cell.col);
    count++;
  }
  if (!count) return { state: next, count: 0 };
  return { state: { ...next, hints: (next.hints || 0) + count }, count };
}

/** 对局统计：{ elapsedMs, hints, solved } */
export function playStats(state, now = Date.now()) {
  const start = (state && state.startedAt) || now;
  const end = (state && state.endedAt) || now;
  return {
    elapsedMs: Math.max(0, end - start),
    hints: (state && state.hints) || 0,
    solved: !!(state && state.solved)
  };
}

/** 用时文案：`45秒` / `1分05秒` / `2分30秒`（与 js/match.js 同一约定） */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return mm ? `${mm}分${String(ss).padStart(2, '0')}秒` : `${ss}秒`;
}

/** 棋盘格子尺寸（px）：按行列数 + 视口收敛，常见棋盘不横向溢出、也不至于太小 */
/**
 * 棋盘格子尺寸（px）：按行列数 + 视口收敛。
 * 触屏（`viewport.touch === true`，缺省按「视口宽 ≤ TOUCH_VIEWPORT_WIDTH」推断）：
 *   · 下限 TOUCH_MIN_CELL = 30px（手指可点、字母可读），横向放不下就让棋盘滚动；
 *   · 可用高度按 40% 视口算（底部还压着字母键盘与线索区）。
 * 桌面：下限 MIN_CELL = 24px、可用高度 52%，尽量整盘塞进一屏。
 */
export function cellSize(cols, rows, viewport = {}) {
  const vw = Number(viewport.width) > 0 ? Number(viewport.width) : 360;
  const vh = Number(viewport.height) > 0 ? Number(viewport.height) : 640;
  const touch = viewport.touch == null ? vw <= TOUCH_VIEWPORT_WIDTH : !!viewport.touch;
  const minCell = touch ? TOUCH_MIN_CELL : MIN_CELL;
  const pad = touch ? TOUCH_H_PAD : DESKTOP_H_PAD;
  const ratio = touch ? TOUCH_HEIGHT_RATIO : DESKTOP_HEIGHT_RATIO;
  const byWidth = Math.floor((Math.min(vw, 760) - pad) / Math.max(1, posInt(cols, 1)));
  const byHeight = Math.floor((Math.min(vh, 900) * ratio) / Math.max(1, posInt(rows, 1)));
  return Math.max(minCell, Math.min(MAX_CELL, byWidth, byHeight));
}


/* ------------------------------- 会话存取 ------------------------------- */

let S = null; // 当前会话
let clock = null; // 用时计时器
let keysBound = false; // 键盘 / 焦点监听只绑一次（视图重渲染不重复绑定）
let flashTimer = null; // 「检查通过」的高亮清除定时器

function saveSession() {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(S));
  } catch (e) {}
}

/** 读会话（完整性守门：损坏 / 越界的会话直接丢弃 → 重新开局） */
function loadSession(deckId) {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    const s = raw ? JSON.parse(raw) : null;
    if (!s || s.deckId !== deckId) return null;
    if (!s.board || !Array.isArray(s.board.cells) || !s.board.cells.length) return null;
    if (!Array.isArray(s.board.words) || !s.board.words.length) return null;
    const known = new Set(s.board.cells.map((c) => cellKey(c.row, c.col)));
    if (!s.letters || typeof s.letters !== 'object') s.letters = {};
    for (const k of Object.keys(s.letters)) if (!known.has(k)) delete s.letters[k];
    s.wrong = Array.isArray(s.wrong) ? s.wrong.filter((k) => known.has(k)) : [];
    s.revealed = Array.isArray(s.revealed) ? s.revealed.filter((k) => known.has(k)) : [];
    if (s.selected != null && !wordById(s.board, s.selected)) s.selected = null;
    if (s.dir !== 'down') s.dir = 'across';
    return finalize(s);
  } catch (e) {
    return null;
  }
}

function stopClock() {
  if (clock) {
    clearInterval(clock);
    clock = null;
  }
}

function startClock() {
  stopClock();
  if (typeof setInterval !== 'function') return;
  clock = setInterval(() => {
    if (!S || S.solved) return;
    paintStatus();
  }, 1000);
  if (clock && typeof clock.unref === 'function') clock.unref();
}

/** 清空会话与所有定时器（路由切换 / 重置数据 / 离开棋局调用） */
export function clearCrosswordSession() {
  stopClock();
  kb.closeKeyboard(); // 离开填字页 / 重置：收起底部字母键盘
  if (flashTimer) {
    clearTimeout(flashTimer);
    flashTimer = null;
  }
  S = null;
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch (e) {}
}

/** 读取当前会话（供测试 / 页面自查，页面本身不依赖它） */
export function getCrosswordSession() {
  return S;
}

/* ------------------------------- DOM 小工具 ------------------------------- */

function byId(id) {
  return typeof document !== 'undefined' && document.getElementById ? document.getElementById(id) : null;
}

function rootView() {
  return byId('view');
}

function all(sel) {
  const root = rootView();
  return root && root.querySelectorAll ? Array.from(root.querySelectorAll(sel)) : [];
}

/** 只改 class，不整页重渲染（保住焦点 / 光标 / 输入法候选框） */
function setClass(el, cls, want) {
  if (!el || !el.classList) return;
  if (el.classList.toggle) el.classList.toggle(cls, !!want);
  else if (want) el.classList.add(cls);
  else el.classList.remove(cls);
}

function setText(el, text) {
  if (el) el.textContent = text;
}

function viewport() {
  const w = typeof window !== 'undefined' ? Number(window.innerWidth) : 0;
  const h = typeof window !== 'undefined' ? Number(window.innerHeight) : 0;
  return { width: w || 360, height: h || 640 };
}

/* ------------------------------- 文案 ------------------------------- */

/** 状态行：`已完成 3/8 条线索 · 已填 26/48 格` */
export function statusText(state, p = progress(state)) {
  if (!p.total) return '这个来源暂时凑不出填字棋盘';
  if (p.done) return `全部填对 · 用时 ${formatDuration(playStats(state).elapsedMs)}`;
  return `已完成 ${p.wordsSolved}/${p.words} 条线索 · 已填 ${p.filled}/${p.total} 格`;
}

function statCellHtml(key, label, value) {
  return `<div class="cw-stat"><b id="cw-${key}">${esc(value)}</b><span>${esc(label)}</span></div>`;
}

function cellAriaLabel(cell, value) {
  return `第 ${cell.row + 1} 行第 ${cell.col + 1} 列${cell.num ? `，第 ${cell.num} 号线索` : ''}${
    value ? `，已填 ${value}` : '，空格'
  }`;
}


/* ------------------------------- 渲染 ------------------------------- */

/** 一个答题格（原生 input：Tab / 输入法 / 移动端键盘都能直接用） */
function cellHtml(cell, state) {
  const key = cellKey(cell.row, cell.col);
  const value = (state.letters || {})[key] || '';
  const cls = ['cw-cell'];
  if (state.revealed && state.revealed.includes(key)) cls.push('is-revealed');
  return `
    <div class="${cls.join(' ')}" data-cell="${key}">
      ${cell.num ? `<span class="cw-num" aria-hidden="true">${cell.num}</span>` : ''}
      <input class="cw-input" type="text" data-action="cw-type" data-cell="${key}" value="${esc(value)}"
        maxlength="1" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false"
        inputmode="${kb.inputMode()}" aria-label="${esc(cellAriaLabel(cell, value))}" />
    </div>`;
}

/** 棋盘外框：非字母格填空白块（保持方格对齐） */
function boardGridHtml(state) {
  const board = state.board || {};
  const map = cellMap(board);
  const out = [];
  for (let r = 0; r < board.rows; r++) {
    for (let c = 0; c < board.cols; c++) {
      const cell = map.get(cellKey(r, c));
      out.push(cell ? cellHtml(cell, state) : '<div class="cw-cell cw-block" aria-hidden="true"></div>');
    }
  }
  return out.join('');
}

/** 一条线索（点它 → 选中 + 焦点落到该线索第一个空格） */
function clueItemHtml(state, w) {
  const prog = wordProgress(state, w.id);
  const active = state.selected === w.id;
  const cls = ['cw-clue', `is-${prog.state}`, active ? 'is-active' : ''].filter(Boolean).join(' ');
  const kind = w.dir === 'across' ? '横向' : '纵向';
  return `<li>
    <button type="button" class="${cls}" data-action="cw-clue" data-word="${w.id}"
      aria-pressed="${active ? 'true' : 'false'}" aria-label="${kind} ${w.num}：${esc(w.clue)}">
      <b>${w.num}</b><span>${esc(w.clue)}</span>
    </button>
  </li>`;
}

function clueListHtml(state, dir) {
  const words = ((state.board && state.board.words) || []).filter((w) => w.dir === dir);
  if (!words.length) return '';
  return `<section class="cw-clues-col glass">
    <h3 class="cw-clues-title">${dir === 'across' ? '横向' : '纵向'}</h3>
    <ul class="cw-clue-list">${words.map((w) => clueItemHtml(state, w)).join('')}</ul>
  </section>`;
}

/** 词源 chips：整卡组 + 每个已通关关卡（「根据当前词库自定义生成」的入口之一） */
function sourceChipsHtml(deck, source) {
  const levels = passedLevels(deck);
  const deckActive = !source || source.kind !== 'level';
  const deckChip = `<button type="button" class="cw-chip${deckActive ? ' is-active' : ''}" data-action="cw-source"
    data-kind="deck" aria-pressed="${deckActive ? 'true' : 'false'}">整卡组</button>`;
  const lvChips = levels
    .map((i) => {
      const active = !deckActive && Number(source.level) === i;
      return `<button type="button" class="cw-chip${active ? ' is-active' : ''}" data-action="cw-source"
        data-kind="level" data-level="${i}" aria-pressed="${active ? 'true' : 'false'}">第 ${i + 1} 关</button>`;
    })
    .join('');
  return `<div class="cw-chips" role="group" aria-label="选择词源">${deckChip}${lvChips}</div>`;
}

/** 每局词数 chips */
function sizeChipsHtml(size) {
  const chips = SIZES.map(
    (n) =>
      `<button type="button" class="cw-chip${n === size ? ' is-active' : ''}" data-action="cw-size"
        data-size="${n}" aria-pressed="${n === size ? 'true' : 'false'}">${n} 词</button>`
  ).join('');
  return `<div class="cw-chips" role="group" aria-label="选择每局词数">${chips}</div>`;
}

/** 结算面板（未完成时由外层 hidden） */
function resultHtml(state) {
  const p = progress(state);
  const st = playStats(state);
  return `
    <div class="cw-done">
      <div class="cw-done-icon" aria-hidden="true">${icon('check', 30)}</div>
      <h3>填字完成</h3>
      <div class="cw-final">
        <div><b>${formatDuration(st.elapsedMs)}</b><span>用时</span></div>
        <div><b>${st.hints}</b><span>提示次数</span></div>
        <div><b>${p.wordsSolved}/${p.words}</b><span>线索</span></div>
      </div>
      <div class="cw-done-actions">
        <button class="btn btn-primary" data-action="cw-new">${icon('layers', 16)} 换一批</button>
        <button class="btn btn-ghost" data-action="cw-reset">${icon('refresh', 16)} 重新开始</button>
        <button class="btn btn-ghost" data-action="cw-back">返回卡组</button>
      </div>
    </div>`;
}


/** 棋盘页整页 HTML（仅在开局 / 换词源 / 换词数 / 重开等低频时刻生成） */
export function crosswordHtml(deck, state) {
  const board = state.board || { cells: [], words: [] };
  const p = progress(state);
  const st = playStats(state);
  const source = state.source || defaultSource(deck);
  const hasBoard = !!(board.cells && board.cells.length);
  const touch = kb.isTouchDevice();
  const size = cellSize(board.cols, board.rows, { ...viewport(), touch });

  const body = hasBoard
    ? `
      <div class="cw-board-wrap glass">
        <div class="cw-board" style="--cw-cols:${board.cols};--cw-cell:${size}px" role="group" aria-label="填字棋盘">
          ${boardGridHtml(state)}
        </div>
      </div>
      <div class="cw-clues">
        ${clueListHtml(state, 'across')}
        ${clueListHtml(state, 'down')}
      </div>
      <div class="cw-actions">
        <button class="btn btn-primary" data-action="cw-check">${icon('check', 16)} 检查</button>
        <button class="btn btn-ghost" data-action="cw-hint">${icon('search', 16)} 提示一字母</button>
        <button class="btn btn-ghost" data-action="cw-reveal">显示本词</button>
        <button class="btn btn-ghost" data-action="cw-reset">${icon('refresh', 16)} 重新开始</button>
        <button class="btn btn-ghost" data-action="cw-new">${icon('layers', 16)} 换一批</button>
      </div>`
    : `<div class="empty glass">
        <div class="empty-icon" aria-hidden="true">${icon('grid', 28)}</div>
        <h3>这个来源凑不出填字棋盘</h3>
        <p>需要「纯字母且长度 2–${MAX_LEN}」的单词。换个词源或增加卡片后再试。</p>
      </div>`;

  return `
    <div class="view view-crossword">
      <div class="cw-head glass">
        <div class="cw-title-row">
          <h2 class="screen-title">填字游戏 · ${esc(sourceLabel(source))}</h2>
          <span class="sub-note">读释义 → 逐格拼出单词</span>
        </div>
        <div class="cw-status" id="cw-status">${esc(statusText(state, p))}</div>
        <div class="cw-stats">
          ${statCellHtml('words', '线索', `${p.wordsSolved}/${p.words}`)}
          ${statCellHtml('time', '用时', formatDuration(st.elapsedMs))}
          ${statCellHtml('hints', '提示', String(st.hints))}
          ${statCellHtml('empty', '空格', String(p.empty))}
        </div>
        <div class="progress-track" id="cw-progress" role="progressbar" aria-label="填字进度"
          aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p.percent}"><i class="progress-fill" style="width:${p.percent}%"></i></div>
        ${hasBoard ? `<span class="hint">已用 ${board.used}/${board.candidates} 个可用单词交叉排版${board.unplaced ? `（${board.unplaced} 个交叉不上已跳过）` : ''}</span>` : ''}
        ${sourceChipsHtml(deck, source)}
        ${sizeChipsHtml(state.size)}
      </div>
      ${body}
      <div class="cw-result" id="cw-result" hidden></div>
    </div>`;
}

function lockedHtml(deck, info) {
  return `
    <div class="view view-crossword">
      <div class="empty glass">
        <div class="empty-icon" aria-hidden="true">${icon('lock', 30)}</div>
        <h3>填字游戏还没解锁</h3>
        <p>「${esc(deck.name)}」还差 ${info.left} 关通关（已通关 ${info.passed}/${info.need}）。通关任意 1 关后，就能用它的单词拼填字棋盘。</p>
        <a class="btn btn-primary" href="#/deck/${esc(deck.id)}">返回卡组</a>
      </div>
    </div>`;
}

function notFoundHtml() {
  return `<div class="view"><div class="empty glass"><h3>卡组不存在</h3><a class="btn btn-primary" href="#/home">返回首页</a></div></div>`;
}


/* --------------------------- 局部打补丁（不整页重渲染） --------------------------- */

/** 当前选中线索覆盖的格子 key 集合 */
function activeKeys(state) {
  const w = wordById(state.board, state.selected);
  return new Set(wordCells(state.board, w ? w.id : -1).map((c) => cellKey(c.row, c.col)));
}

function paintCells() {
  if (!S) return;
  const letters = S.letters || {};
  const wrong = new Set(S.wrong || []);
  const revealed = new Set(S.revealed || []);
  const active = activeKeys(S);
  const map = cellMap(S.board);
  for (const el of all('.cw-input')) {
    const key = el.dataset && el.dataset.cell;
    if (!key) continue;
    const want = letters[key] || '';
    if ('value' in el && el.value !== want) el.value = want;
    setClass(el, 'is-active', active.has(key));
    setClass(el, 'is-wrong', wrong.has(key));
    setClass(el, 'is-revealed', revealed.has(key));
    const cell = map.get(key);
    if (cell && el.setAttribute) el.setAttribute('aria-label', cellAriaLabel(cell, want));
  }
  for (const el of all('.cw-cell')) {
    const key = el.dataset && el.dataset.cell;
    if (!key) continue;
    setClass(el, 'is-active', active.has(key));
    setClass(el, 'is-revealed', revealed.has(key));
  }
}

function paintClues() {
  if (!S) return;
  const map = cellMap(S.board);
  for (const el of all('.cw-clue')) {
    const id = Number(el.dataset && el.dataset.word);
    if (!wordById(S.board, id)) continue;
    const prog = wordProgress(S, id, map);
    const active = S.selected === id;
    setClass(el, 'is-active', active);
    setClass(el, 'is-empty', prog.state === 'empty');
    setClass(el, 'is-partial', prog.state === 'partial');
    setClass(el, 'is-correct', prog.state === 'correct');
    if (el.setAttribute) el.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
}

function paintStatus() {
  if (!S) return;
  const p = progress(S);
  const st = playStats(S);
  setText(byId('cw-status'), statusText(S, p));
  setText(byId('cw-words'), `${p.wordsSolved}/${p.words}`);
  setText(byId('cw-time'), formatDuration(st.elapsedMs));
  setText(byId('cw-hints'), String(st.hints));
  setText(byId('cw-empty'), String(p.empty));
  const bar = byId('cw-progress');
  if (bar && bar.setAttribute) bar.setAttribute('aria-valuenow', String(p.percent));
  const fill = bar && bar.querySelector ? bar.querySelector('.progress-fill') : null;
  if (fill && fill.style) fill.style.width = p.percent + '%';
}

function paintAll() {
  paintCells();
  paintClues();
  paintStatus();
}

/** 结算：停表、填入完成面板、播报成绩并把焦点交给「换一批」 */
function finishGame() {
  if (!S) return;
  stopClock();
  kb.closeKeyboard(); // 已完成：收起字母键盘，腾出屏幕看结算
  paintAll();
  const panel = byId('cw-result');
  if (panel) {
    if (panel.innerHTML !== undefined) panel.innerHTML = resultHtml(S);
    panel.hidden = false;
    setClass(panel, 'show', true);
    const btn = panel.querySelector ? panel.querySelector('[data-action="cw-new"]') : null;
    if (btn && btn.focus) {
      try {
        btn.focus();
      } catch (e) {}
    }
  }
  const st = playStats(S);
  announce(`填字完成，用时 ${formatDuration(st.elapsedMs)}，提示 ${st.hints} 次`);
}


/* ------------------------------ 焦点 / 键盘 ------------------------------ */

function inputEl(key) {
  return all('.cw-input').find((el) => el.dataset && el.dataset.cell === key) || null;
}

/** 焦点落到某格；并把它滚进视野（移动端键盘展开时棋盘可能横向 / 纵向溢出） */
function focusCell(cell) {
  if (!cell) return;
  const el = inputEl(cellKey(cell.row, cell.col));
  if (!el || !el.focus) return;
  try {
    el.focus();
  } catch (e) {}
  revealEl(el);
}

/** 把元素滚进最近的可视区域（老浏览器 / 测试桩没有 scrollIntoView 时安全跳过） */
function revealEl(el) {
  if (!el || typeof el.scrollIntoView !== 'function') return;
  try {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  } catch (e) {
    try {
      el.scrollIntoView();
    } catch (e2) {}
  }
}

/** 线索里第一个「还没填对」的格（都填对了 → 第一个格） */
export function firstOpenCell(state, wordId) {
  const cells = wordCells(state.board, wordId);
  const letters = (state && state.letters) || {};
  return cells.find((c) => letters[cellKey(c.row, c.col)] !== c.letter) || cells[0] || null;
}

/** 选中一条线索（可选把焦点落到它的第一个空格） */
function selectWord(wordId, opts = {}) {
  if (!S) return;
  const w = wordById(S.board, wordId);
  if (!w) return;
  S = { ...S, selected: w.id, dir: w.dir };
  saveSession();
  paintCells();
  paintClues();
  if (opts.focus) focusCell(firstOpenCell(S, w.id));
}

/** 输入一个字母后跳到本线索的下一个空格（没有空格就跳下一格） */
function advance(row, col) {
  const w = wordAt(S, row, col);
  if (!w) return;
  const cells = wordCells(S.board, w.id);
  const idx = cells.findIndex((c) => c.row === row && c.col === col);
  if (idx < 0) return;
  const letters = S.letters || {};
  let target = null;
  for (let i = idx + 1; i < cells.length; i++) {
    if (!letters[cellKey(cells[i].row, cells[i].col)]) {
      target = cells[i];
      break;
    }
  }
  if (!target && idx + 1 < cells.length) target = cells[idx + 1];
  if (target) focusCell(target);
}

/** 方向键 / 退格 / 删除 / 空格（棋盘 ≤ 144 格，线性找格足够快） */
/** 清掉某一格（Delete / 退格在有字母时） */
function clearCellAt(el) {
  const key = el && el.dataset && el.dataset.cell;
  if (!S || !key) return;
  const [row, col] = parseKey(key);
  S = setLetter(S, row, col, '');
  saveSession();
  paintAll();
}

/** 退格：有字母就清掉它；空格上退格 → 回到本线索上一格并清掉它 */
function backspaceAt(el) {
  const key = el && el.dataset && el.dataset.cell;
  if (!S || !key) return;
  if (String(el.value || '')) {
    clearCellAt(el);
    return;
  }
  const [row, col] = parseKey(key);
  const w = wordAt(S, row, col);
  const cells = w ? wordCells(S.board, w.id) : [];
  const idx = cells.findIndex((c) => c.row === row && c.col === col);
  const prev = idx > 0 ? cells[idx - 1] : null;
  if (!prev) return;
  S = setLetter(S, prev.row, prev.col, '');
  saveSession();
  paintAll();
  focusCell(prev);
}

/* --------------------------- 屏幕字母键盘（移动端） --------------------------- */

/** 字母键盘要写进哪一格：优先当前聚焦格（且该格确实在棋盘上），否则当前线索的第一个空格 */
function keyboardTarget() {
  if (!S || !S.board) return null;
  const map = cellMap(S.board);
  const d = typeof document !== 'undefined' ? document : null;
  const active = d && d.activeElement;
  if (
    active &&
    active.dataset &&
    active.dataset.cell &&
    map.has(active.dataset.cell) &&
    active.classList &&
    typeof active.classList.contains === 'function' &&
    active.classList.contains('cw-input')
  ) {
    return active;
  }
  const w = wordById(S.board, S.selected);
  const cell = w ? firstOpenCell(S, w.id) : null;
  return cell ? inputEl(cellKey(cell.row, cell.col)) : null;
}

/** 屏幕键盘敲一个字母：与物理键盘走同一条处理链路（只打补丁、自动推进） */
function keyboardType(ch) {
  const el = keyboardTarget();
  if (!el) return;
  if ('value' in el) el.value = String(ch || '');
  applyTypedLetter(el);
}

/** 屏幕键盘退格：等价于按 Backspace */
function keyboardBackspace() {
  const el = keyboardTarget();
  if (el) backspaceAt(el);
}

/**
 * 触屏设备进入填字页时接上字母键盘（`inputmode="none"` 抑制系统输入法）。
 * 非触屏 / 已完成 / 棋盘为空 → 彻底关闭；触屏但用户已手动收起 → 保持隐藏但**保留配置**
 * （页面上的「⌨ 字母键盘」按钮可再唤出；这一步在每次重渲染都会走到，所以不能清配置）。
 */
function attachCrosswordKeyboard() {
  if (!S || !S.board || !S.board.cells.length || S.solved) {
    kb.closeKeyboard();
    return;
  }
  if (kb.shouldAutoOpen()) {
    kb.openKeyboard({ inputs: '.cw-input', onKey: keyboardType, onBackspace: keyboardBackspace });
    return;
  }
  if (kb.isTouchDevice() && kb.keyboardConfig()) {
    kb.hideKeyboard(); // 尊重「收起」；配置仍在 → 「⌨ 字母键盘」按钮可再唤出
    return;
  }
  kb.closeKeyboard();
}

function onKeyDown(evt) {
  const el = evt && evt.target;
  if (!S || !el || !el.classList || typeof el.classList.contains !== 'function') return;
  if (!el.classList.contains('cw-input')) return;
  const key = el.dataset && el.dataset.cell;
  if (!key) return;
  const [row, col] = parseKey(key);
  const k = evt.key;

  if (k === 'Backspace' || k === 'Delete') {
    if (evt.preventDefault) evt.preventDefault();
    if (k === 'Backspace') backspaceAt(el);
    else clearCellAt(el);
    return;
  }
  if (k === ' ') {
    if (evt.preventDefault) evt.preventDefault(); // 空格不滚动页面（也不是字母）
    return;
  }
  const move = {
    ArrowLeft: [0, -1, 'across'],
    ArrowRight: [0, 1, 'across'],
    ArrowUp: [-1, 0, 'down'],
    ArrowDown: [1, 0, 'down']
  }[k];
  if (!move) return;
  if (evt.preventDefault) evt.preventDefault();
  const [dr, dc, dir] = move;
  if (S.dir !== dir) {
    S = { ...S, dir };
    saveSession();
  }
  const map = cellMap(S.board);
  let r = row + dr;
  let c = col + dc;
  while (r >= 0 && c >= 0 && r < S.board.rows && c < S.board.cols) {
    const cell = map.get(cellKey(r, c));
    if (cell) {
      focusCell(cell); // 焦点变化会触发 onFocusIn → 按新方向选中所属线索
      return;
    }
    r += dr;
    c += dc;
  }
}

/** 焦点进入某格 → 按当前方向自动选中所属线索（点格子 / Tab / 方向键都会走到这里） */
function onFocusIn(evt) {
  const el = evt && evt.target;
  if (!S || !el || !el.classList || typeof el.classList.contains !== 'function') return;
  if (!el.classList.contains('cw-input')) return;
  const key = el.dataset && el.dataset.cell;
  if (!key) return;
  const [row, col] = parseKey(key);
  const w = wordAt(S, row, col);
  if (!w) return;
  if (S.selected === w.id && S.dir === w.dir) return;
  S = { ...S, selected: w.id, dir: w.dir };
  saveSession();
  paintCells();
  paintClues();
}

/** 键盘 / 焦点监听只绑一次（视图重渲染不重复绑定） */
function bindKeysOnce() {
  if (keysBound) return;
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  keysBound = true;
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('focusin', onFocusIn, true);
}

/* ------------------------------ 开局 / 路由 ------------------------------ */

/** 开一局（可注入 rng 便于单测复现排版） */
export function startGame(deck, source, size, rng = Math.random) {
  const cards = sourceCards(deck, source);
  const board = generateCrossword(cards, { size, rng });
  S = newGame(board, { deckId: deck.id, source, size: clampSize(size), now: Date.now() });
  saveSession();
  if (!S.solved) startClock();
  return S;
}

/** 页面入口（由 app.js 的 render() 调用：#/crossword/{deckId}） */
export function renderCrossword(root, deckId) {
  bindKeysOnce();
  const deck = store.getDeck(deckId);
  if (!deck) {
    clearCrosswordSession();
    root.innerHTML = notFoundHtml();
    return;
  }
  const info = unlockInfo(deck);
  if (!info.unlocked) {
    clearCrosswordSession();
    root.innerHTML = lockedHtml(deck, info);
    return;
  }

  // 沿用未完成的会话（重渲染不重新抽词 / 不重新排版）；词源失效则重新开局
  let s = S && S.deckId === deckId ? S : loadSession(deckId);
  if (!s || !isValidSource(deck, s.source)) s = startGame(deck, defaultSource(deck), DEFAULT_SIZE);
  S = s;

  attachCrosswordKeyboard(); // 先定键盘状态 → 生成的 inputmode 就是最终值
  root.innerHTML = crosswordHtml(deck, S);
  kb.syncInputs(); // DOM 已就绪：把 inputmode 同步到这一批输入框
  if (S.solved) finishGame();
  else startClock();
}


/* ------------------------------- 事件（Action 委托） ------------------------------- */

/** 同一词源 / 词数换一批新题（重新抽词 + 重新排版） */
function regenerate(deck, source, size) {
  if (!deck) return;
  startGame(deck, source, size);
  renderCrossword(rootView(), deck.id);
}

/**
 * 处理「某一格被输入了内容」——物理键盘的 input 事件与屏幕字母键盘共用这条路。
 * 写入内核 → 跳到本线索下一个空格（只打补丁，不整页重渲染）。
 */
function applyTypedLetter(el) {
  if (!S || !el || !el.dataset) return;
  const key = el.dataset.cell;
  if (!key) return;
  const letter = normalizeLetter(el.value);
  if (!letter) {
    if ('value' in el) el.value = '';
    return;
  }
  if (el.value !== letter) el.value = letter;
  const [row, col] = parseKey(key);
  S = setLetter(S, row, col, letter);
  saveSession();
  paintCells();
  paintClues();
  paintStatus();
  if (S.solved) {
    finishGame();
    return;
  }
  advance(row, col);
}

on('cw-type', (el) => applyTypedLetter(el), 'input');

/* 点线索：选中它并把焦点落到第一个空格 */
on('cw-clue', (el) => {
  if (!S || !el || !el.dataset) return;
  selectWord(Number(el.dataset.word), { focus: true });
});

/* 检查：标出填错的格 */
on('cw-check', () => {
  if (!S) return;
  const out = checkAll(S);
  S = out.state;
  saveSession();
  paintAll();
  if (S.solved) {
    finishGame();
    return;
  }
  if (out.empty) toast(`还有 ${out.empty} 格没填`);
  else if (out.wrong.length) toast(`${out.wrong.length} 格填错了`);
  else toast('目前都对，继续！');
});

/* 提示一字母 */
on('cw-hint', () => {
  if (!S) return;
  const out = hintCell(S);
  if (!out.cell) {
    toast('已经全部填对了');
    return;
  }
  S = out.state;
  saveSession();
  paintAll();
  if (S.solved) finishGame();
  else focusCell(out.cell);
});

/* 显示本词：把当前线索一次填全 */
on('cw-reveal', () => {
  if (!S || S.selected == null) return;
  const out = revealWord(S, S.selected);
  if (!out.count) {
    toast('这条线索已经填好了');
    return;
  }
  S = out.state;
  saveSession();
  paintAll();
  if (S.solved) finishGame();
});

/* 重新开始：同一盘棋盘清空重填 */
on('cw-reset', () => {
  if (!S) return;
  const deck = store.getDeck(S.deckId);
  const board = S.board;
  const { source, size } = S;
  S = newGame(board, { deckId: S.deckId, source, size, now: Date.now() });
  saveSession();
  if (deck) renderCrossword(rootView(), deck.id);
  announce('已清空棋盘，重新开始');
});

/* 换一批：同词源 / 同词数重新抽词排版 */
on('cw-new', () => {
  if (!S) return;
  regenerate(store.getDeck(S.deckId), S.source, S.size);
});

/* 换词源：整卡组 / 某个已通关关卡 */
on('cw-source', (el) => {
  if (!S || !el || !el.dataset) return;
  const deck = store.getDeck(S.deckId);
  if (!deck) return;
  const kind = el.dataset.kind === 'level' ? 'level' : 'deck';
  const source = kind === 'level' ? { kind, level: Number(el.dataset.level) } : { kind: 'deck', level: null };
  if (!isValidSource(deck, source)) return;
  if (S.source && S.source.kind === source.kind && S.source.level === source.level) return;
  regenerate(deck, source, S.size);
});

/* 换每局词数 */
on('cw-size', (el) => {
  if (!S || !el || !el.dataset) return;
  const deck = store.getDeck(S.deckId);
  if (!deck) return;
  const size = Number(el.dataset.size);
  if (clampSize(size) === S.size) return;
  regenerate(deck, S.source, size);
});

/* 返回卡组（路由变化会清空会话） */
on('cw-back', () => {
  const deckId = (S && S.deckId) || '';
  clearCrosswordSession();
  navigate(deckId ? `#/deck/${deckId}` : '#/home');
});

