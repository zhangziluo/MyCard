// ============================================================================
// test.js — 测试题模式（关卡通关判定）
// 规则：以本关全部卡片为题目，三种题型随机混合，每题均为 4 选 1：
//   word2def        单词选释义（题干 front → 选项 back）
//   def2word        释义选单词（题干 back → 选项 front）
//   sentence2word   句子选单词（题干 example 挖空 → 选项 front）
// 答错（机会用尽）时展示完整信息（front + back + example）。
// 通关条件：整关翻转记忆完成 + 测试正确率 ≥ 80% → deck.passedLevels 置位。
// ============================================================================

import * as store from './store.js';
import * as lv from './levels.js';
import * as ls from './levelstats.js';
import * as hw from './hardwords.js';
import * as cfg from './test-config.js';
import * as engine from './test-engine.js';
import * as engdefs from './engdefs.js';
import { esc, on, navigate, toast, openModal } from './ui.js';

const SESSION_KEY = 'mycard-test-session';

/** 每道题最大作答次数：答对自动跳下一题；前两次答错可重选，第三次答错也自动跳下一题 */
export const MAX_ATTEMPTS = 3;

let T = null; // { deckId, level, questions, pos, correct }
let LAST = null; // 最近一次测试上下文（结果页「再测一次」使用）
let advanceTimer = null; // 自动跳题定时器
let hl = 0; // 键盘高亮的选项下标（↑/↓ 移动，Enter 确认）
let hlOn = false; // 是否已启用键盘高亮
let speaking = null; // 正在播放的发音：{ el, word, token }
let speakToken = 0; // 播放令牌：停止 / 新播放后，旧 utterance 的回调失效

/** 把键盘高亮画到当前 DOM 上（不整页重渲染） */
function paintHighlight() {
  const opts = document.querySelectorAll ? document.querySelectorAll('.opt') : [];
  opts.forEach((el, i) => {
    if (el.classList) el.classList.toggle('opt-active', hlOn && i === hl);
  });
}

/** 填空题：聚焦输入框，并支持 Enter 直接提交 */
function attachFillInput() {
  const el = document.querySelector ? document.querySelector('.fill-field') : null;
  if (!el) return;
  if (el.addEventListener) {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.repeat) {
        e.preventDefault();
        submitFill();
      }
    });
  }
  if (el.focus) el.focus();
}

/** 听音辨意：进入题目时自动播放一次发音（未作答时） */
function attachListenAudio() {
  if (!T) return;
  const q = T.questions[T.pos];
  if (!q || q.type !== 'listen' || q.answered) return;
  const deck = store.getDeck(T.deckId);
  const card = deck ? deck.cards.find((c) => c.id === q.cardId) : null;
  if (card) speakWord(card.front);
}

function clearAdvanceTimer() {
  if (advanceTimer) {
    clearTimeout(advanceTimer);
    advanceTimer = null;
  }
}

function saveSession() {
  // 整卡组测试 / 错题专项：进度写入 localStorage（支持中途退出续做，两者互不覆盖）
  if (T && (T.mode === 'deck' || T.mode === 'wrong')) {
    const now = Date.now();
    T.elapsedMs = (T.elapsedMs || 0) + (T.lastTick ? now - T.lastTick : 0);
    T.lastTick = now;
    engine.saveProgress(T.deckId, T, T.mode);
    return;
  }
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(T));
  } catch (e) {}
}

function loadSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function clearSession() {
  clearAdvanceTimer();
  stopSpeaking(); // 离开测试页 / 重置：停止正在播放的发音
  if (T && (T.mode === 'deck' || T.mode === 'wrong')) engine.clearProgress(T.deckId, T.mode); // 结束/重开：清除续做进度
  T = null;
  hl = 0; // 重置键盘高亮（↑↓←→ / Enter）
  hlOn = false;
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch (e) {}
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 测试题型：word2def=单词选释义 / def2word=释义选单词 / sentence2word=句子选单词 / fill=填空 / listen=听音辨意 */
export { QUESTION_TYPES } from './test-config.js';

/** 当前环境是否支持语音合成（TTS） */
export function canSpeak() {
  return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
}

/** 朗读英文单词（听音辨意用）；环境不支持时返回 false，不抛错 */
export function speakWord(word) {
  const text = String(word == null ? '' : word).trim();
  if (!text || !canSpeak()) return false;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = 0.9;
    speechSynthesis.speak(u);
    return true;
  } catch (e) {
    return false;
  }
}

/** 当前是否有发音正在播放（可传入词，判断是否正是这个词） */
export function isSpeaking(word = null) {
  if (!speaking) return false;
  return word == null ? true : String(speaking.word) === String(word);
}

/** 停止当前发音并复原按钮状态；返回此前是否有发音在播放 */
export function stopSpeaking() {
  const cur = speaking;
  speaking = null;
  speakToken += 1; // 旧 utterance 的 onend / onerror 回调失效
  if (cur && cur.el && cur.el.classList) cur.el.classList.remove('speaking');
  if (canSpeak()) {
    try {
      speechSynthesis.cancel();
    } catch (e) {}
  }
  return !!cur;
}

/**
 * 朗读目标词（填空 🔊 按钮用）：
 *   中文 → zh-CN，英文 → en-US；rate 0.8（稍慢，便于听清拼写）。
 * 播放前先 cancel 旧词 → 同一时间只播放一个词。
 * 传入 el 时给按钮加 .speaking，播放结束 / 出错后自动复原。
 */
export function speakTargetWord(word, el = null, { rate = 0.8 } = {}) {
  const text = String(word == null ? '' : word).trim();
  if (!text || !canSpeak()) return false;
  stopSpeaking();
  const token = speakToken;
  const finish = () => {
    if (token !== speakToken) return; // 已被停止 / 被新播放取代
    speaking = null;
    if (el && el.classList) el.classList.remove('speaking');
  };
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = /[\u4e00-\u9fa5]/.test(text) ? 'zh-CN' : 'en-US';
    u.rate = rate;
    u.onend = finish;
    u.onerror = finish;
    speaking = { el, word: text, token };
    if (el && el.classList) el.classList.add('speaking');
    speechSynthesis.speak(u);
    return true;
  } catch (e) {
    speaking = null;
    if (el && el.classList) el.classList.remove('speaking');
    return false;
  }
}

/** 规范化用户输入：去首尾空格、折叠连续空格、转小写（大小写与空格容错） */
export function normalizeAnswer(s) {
  return String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * 可接受的答案词形（全部小写）：原形 + 单复数 / 常见屈折，
 * 与 blankWord 的匹配形态保持一致，实现「单复数容错」。
 * 例：run → run / runs / runes / runed / rund / runing；study → study / studys / studies …
 */
export function wordForms(word) {
  const base = String(word || '').trim().toLowerCase();
  if (!base) return [];
  const forms = [base, base + 's', base + 'es', base + 'ed', base + 'd', base + 'ing'];
  if (/[^aeiou]y$/.test(base)) {
    const y = base.slice(0, -1);
    forms.push(y + 'ies', y + 'ied'); // study → studies / studied
  }
  if (/[^aeiouwxy][aeiou][^aeiouwxy]$/.test(base)) {
    const d = base + base.slice(-1); // run → runn
    forms.push(d + 'ed', d + 'ing'); // runned / running
  }
  return [...new Set(forms)];
}

/**
 * 重刷时的题型权重（每次微调）：
 *   retry <= 0 → 三种题型等权（首次测试）
 *   retry >= 1 → 按 (retry-1)%3 轮换侧重一种题型（该题型权重 ×2）
 * 返回的数组可直接作为 buildQuestions 的 types 参数（重复项即权重）。
 */
export function typesForRetry(retry = 0) {
  const types = enabledTypes();
  const r = Math.max(0, Math.floor(Number(retry) || 0));
  if (r <= 0) return [...types];
  const idx = (r - 1) % types.length;
  return types.flatMap((t, i) => (i === idx ? [t, t] : [t]));
}

/* --------------------------- 可选题型 / 释义来源 --------------------------- */

/** 当前已启用的题型（基础 5 种 + 配置里开启的可选题型） */
export function enabledTypes() {
  return cfg.enabledTypeIds(cfg.loadConfig().enabled);
}

/** 卡组内该词的中文释义（back + extraBacks，去空去重） */
export function cardChineseSenses(card) {
  const out = [];
  const seen = new Set();
  const pool = [card && card.back, ...((card && card.extraBacks) || [])];
  for (const raw of pool) {
    const t = String(raw ?? '').trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** 英英选择的释义（始终用 GCIDE 英文释义） */
export function engSenses(card, max = 4) {
  return card ? engdefs.senses(card.front, max) : [];
}

/**
 * 多义多选的释义集合（词典口径）：
 *  1) 优先**卡组内中文释义**（≥2 条）；
 *  2) 否则回退 **GCIDE 英文释义**（≥2 条）；
 *  3) 均不足 2 条 → null（该题不生成 multi_sense）
 */
export function multiSenseSet(card, max = 4) {
  const zh = cardChineseSenses(card);
  if (zh.length >= 2) return { kind: 'zh', list: zh.slice(0, max), all: zh };
  const en = engSenses(card, max);
  if (en.length >= 2) return { kind: 'en', list: en.slice(0, max), all: en };
  return null;
}

/** 英文释义池（GCIDE）：每张卡的释义入池，文本去重 */
export function buildEngPool(deck) {
  const byText = new Map();
  for (const c of deck.cards || []) {
    for (const t of engSenses(c, 4)) {
      if (!t || byText.has(t)) continue;
      byText.set(t, { id: c.id, text: t, word: String(c.front || '') });
    }
  }
  return [...byText.values()];
}

/** 中文释义池：每张卡的中文释义入池，文本去重 */
export function buildZhPool(deck) {
  const byText = new Map();
  for (const c of deck.cards || []) {
    for (const t of cardChineseSenses(c)) {
      if (!t || byText.has(t)) continue;
      byText.set(t, { id: c.id, text: t, word: String(c.front || '') });
    }
  }
  return [...byText.values()];
}

/** 从释义池抽 count 条干扰释义（排除自身卡片与给定文本） */
export function pickPoolDistractors(card, pool, count, bannedTexts = []) {
  const banned = new Set(bannedTexts.map((t) => String(t)));
  const usable = (pool || []).filter((e) => e && e.text && e.id !== card.id && !banned.has(e.text));
  return shuffle(usable).slice(0, Math.max(0, count));
}

/** 从单词池抽 count 个干扰单词（排除自身） */
export function pickWordTexts(card, wordPool, count) {
  return shuffle((wordPool || []).filter((e) => e && e.text && e.text !== String(card.front || ''))).slice(0, Math.max(0, count));
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 将例句中的目标单词挖空为 ____（支持常见屈折变化：-s/-es/-ed/-d/-ing、辅音+y → -ies）。
 * 例如 run→runs、play→playing、study→studies、word→words；找不到该词时原样返回。
 */
export function blankWord(example, word) {
  const src = String(example || '');
  const base = String(word || '').trim();
  if (!base || !src) return src;
  const forms = [base, base + 's', base + 'es', base + 'ed', base + 'd', base + 'ing'];
  if (/[^aeiou]y$/i.test(base)) forms.push(base.slice(0, -1) + 'ies');
  for (const form of forms) {
    const re = new RegExp('\\b' + escapeRegExp(form) + '\\b', 'i');
    if (re.test(src)) {
      return src.replace(new RegExp('\\b' + escapeRegExp(form) + '\\b', 'gi'), '____');
    }
  }
  return src; // 例句中未找到该词 → 原样返回（不生成句子题）
}

/**
 * 构建全卡组“干扰项池”：每张卡片的正面释义 + 多释义（extraBacks）都会入池，
 * 相同释义文本去重（保留首个并合并其易混组）。
 * 返回 [{ id, text, groups }]，id 为所属卡片的 id。
 */
export function buildOptionPool(deck) {
  const byText = new Map(); // text -> entry
  for (const c of deck.cards || []) {
    const groups = new Set(c.groups || []);
    const add = (text) => {
      if (!text) return;
      const existing = byText.get(text);
      if (existing) {
        groups.forEach((g) => existing.groups.add(g));
        return;
      }
      byText.set(text, { id: c.id, text, groups: new Set(groups) });
    };
    add(String(c.back || ''));
    for (const eb of c.extraBacks || []) add(String(eb));
  }
  return [...byText.values()].map((e) => ({ id: e.id, text: e.text, groups: [...e.groups] }));
}

/**
 * 为某张卡挑选 count 个干扰项（v0.2 规则）：
 *  1) 自身其它释义（extraBacks）最先占位 —— 与例句语境不匹配、最具迷惑性；
 *  2) 其次同易混组其它词的释义（优先 ≤ count）；
 *  3) 仍不足时用随机词/多释义兜底。
 * 仅排除主释义（card.back），自身多释义也会作为干扰项出现。
 * 返回 [{ id, text }]，text 互不重复。
 */
export function pickDistractors(card, pool, count = 3, hard = null) {
  const myGroups = new Set(card.groups || []);
  const answer = String(card.back || '');
  const ownTexts = [
    ...new Set(
      (card.extraBacks || []).map((t) => String(t)).filter((t) => t && t !== answer)
    )
  ];
  const banned = new Set([answer, ...ownTexts]);
  const usable = pool.filter((e) => e.text && !banned.has(e.text));
  const isSibling = (e) => (e.groups || []).some((g) => myGroups.has(g));
  const hardSet = hard instanceof Set ? hard : new Set(hard || []);
  // 困难词优先作为干扰项（提高其在测试中的出现概率）
  const hardFirst = (arr) => [...arr].sort((a, b) => Number(hardSet.has(b.id)) - Number(hardSet.has(a.id)));
  const sameGroup = hardFirst(shuffle(usable.filter(isSibling)));
  const rest = hardFirst(shuffle(usable.filter((e) => !isSibling(e))));
  const distractors = [
    ...ownTexts.map((t) => ({ id: card.id, text: t })),
    ...sameGroup,
    ...rest
  ];
  return distractors.slice(0, count);
}

/**
 * 构建全卡组“单词池”：每张卡片的正面单词（front）入池，同一文本去重（合并易混组）。
 * 返回 [{ id, text, groups }]，用于 def2word / sentence2word 的单词选项。
 */
export function buildWordPool(deck) {
  const byText = new Map(); // text -> entry
  for (const c of deck.cards || []) {
    const text = String(c.front || '').trim();
    if (!text) continue;
    const existing = byText.get(text);
    if (existing) {
      (c.groups || []).forEach((g) => existing.groups.add(g));
      continue;
    }
    byText.set(text, { id: c.id, text, groups: new Set(c.groups || []) });
  }
  return [...byText.values()].map((e) => ({ id: e.id, text: e.text, groups: [...e.groups] }));
}

/**
 * 为某张卡挑选 count 个“单词”干扰项（释义选单词 / 句子选单词用）：
 * 优先同易混组其它词的 front，不足时随机单词兜底；排除自身 front。
 * 返回 [{ id, text }]，text 互不重复。
 */
export function pickWordDistractors(card, pool, count = 3, hard = null) {
  const myGroups = new Set(card.groups || []);
  const answer = String(card.front || '');
  const usable = pool.filter((e) => e.text && e.text !== answer);
  const isSibling = (e) => (e.groups || []).some((g) => myGroups.has(g));
  const hardSet = hard instanceof Set ? hard : new Set(hard || []);
  const hardFirst = (arr) => [...arr].sort((a, b) => Number(hardSet.has(b.id)) - Number(hardSet.has(a.id)));
  const sameGroup = hardFirst(shuffle(usable.filter(isSibling)));
  const rest = hardFirst(shuffle(usable.filter((e) => !isSibling(e))));
  return [...sameGroup, ...rest].slice(0, count);
}

/**
 * 对一道题应用一次作答（纯逻辑，导出便于单测）。
 * 规则：最多 MAX_ATTEMPTS 次；
 *  - 选对 → 立即 resolved/correct；
 *  - 选错且未用完机会 → 记入 wrongPicks，留在本题（resolved=false）；
 *  - 第 MAX_ATTEMPTS 次仍错 → resolved=true、correct=false。
 * 返回 { resolved, correct }；对已 solved 的题调用不产生变化。
 */
export function applyAttempt(q, index) {
  if (!q || q.answered) return { resolved: !!q && q.answered, correct: !!q && q.correct };
  const opt = q.options[index];
  if (!opt) return { resolved: false, correct: false };
  q.attempts = (q.attempts || 0) + 1;
  q.lastPicked = index;
  if (opt.isCorrect) {
    q.answered = true;
    q.correct = true;
    return { resolved: true, correct: true };
  }
  if (q.attempts >= MAX_ATTEMPTS) {
    q.answered = true;
    q.correct = false;
    return { resolved: true, correct: false };
  }
  if (!Array.isArray(q.wrongPicks)) q.wrongPicks = [];
  q.wrongPicks.push(index);
  return { resolved: false, correct: false };
}

/**
 * 多选题（multi_sense）判题：全对才算对；漏选 / 多选 / 错选均算错。
 * 规则：勾选后点「提交」判分；最多 MAX_ATTEMPTS 次机会。
 *  - 未选中任何项 → 不判分（返回 resolved:false，等待选择）；
 *  - 完全正确 → resolved + correct；
 *  - 否则若机会用尽 → resolved + 错误（错题会进优先池）；否则清空所选、可重选。
 * 注意：多选不使用「选错即禁用」（否则会禁用正确项导致永远无法全对）。
 * @param {object} q 题目
 * @param {number[]} selected 已勾选的选项下标
 */
export function applyMulti(q, selected) {
  if (!q || q.answered) return { resolved: !!q && q.answered, correct: !!q && q.correct };
  const picked = [...new Set((selected || []).map(Number))].filter((i) => q.options[i]).sort((a, b) => a - b);
  if (!picked.length) return { resolved: false, correct: false };
  q.attempts = (q.attempts || 0) + 1;
  q.selected = picked;
  q.lastPicked = picked.slice();
  const correctIdx = q.options.map((o, i) => (o.isCorrect ? i : -1)).filter((i) => i >= 0);
  const exact = picked.length === correctIdx.length && picked.every((v, k) => v === correctIdx[k]);
  if (exact) {
    q.answered = true;
    q.correct = true;
    return { resolved: true, correct: true };
  }
  if (q.attempts >= MAX_ATTEMPTS) {
    q.answered = true;
    q.correct = false;
    return { resolved: true, correct: false };
  }
  q.selected = []; // 清空勾选，允许重新选择（不禁用任何选项）
  return { resolved: false, correct: false };
}

/**
 * 填空题判题（文本输入）：大小写、首尾/连续空格、单复数（常见屈折）均容错。
 * 规则同 applyAttempt：最多 MAX_ATTEMPTS 次；答对即 resolved；用尽机会仍未对 → resolved + 错误。
 */
export function applyFill(q, input) {
  if (!q || q.answered) return { resolved: !!q && q.answered, correct: !!q && q.correct };
  const val = normalizeAnswer(input);
  if (!val) return { resolved: false, correct: false }; // 空输入不判题
  q.attempts = (q.attempts || 0) + 1;
  q.lastInput = val;
  if ((q.accepts || []).includes(val)) {
    q.answered = true;
    q.correct = true;
    return { resolved: true, correct: true };
  }
  if (!Array.isArray(q.wrongInputs)) q.wrongInputs = [];
  q.wrongInputs.push(val);
  if (q.attempts >= MAX_ATTEMPTS) {
    q.answered = true;
    q.correct = false;
    return { resolved: true, correct: false };
  }
  return { resolved: false, correct: false };
}

/** 将 1 个正确项与若干干扰项打乱并编号，生成选项数组。 */
function buildOptions(correctText, distractorTexts) {
  return shuffle([
    { text: correctText, isCorrect: true },
    ...distractorTexts.map((text) => ({ text, isCorrect: false }))
  ]).map((o, i) => ({ ...o, key: i }));
}

/**
 * 生成一份测试：本关每张卡一题，题型（word2def / def2word / sentence2word）
 * 独立随机分配；每道题 1 个正确项 + 3 个干扰项（同易混组优先 → 随机兜底），
 * 选项顺序随机打乱。
 *  - word2def：正确项 card.back，释义池干扰项（含自身多释义/同组）
 *  - def2word / sentence2word：正确项 card.front，单词池干扰项
 * sentence2word 仅当例句确含可挖空的目标词时才会被选中。
 * 可注入 { types, random } 便于单测固定题型 / 随机源。
 */
/** 为某张卡决定题型（按卡片的可用性过滤：句子题需可挖空，英英/多义题需有释义） */
function pickQuestionType(card, types, random, canSentence) {
  const eligible = (types || []).filter((t) => {
    if (t === 'sentence2word') return canSentence;
    if (t === 'eng_eng') return engSenses(card, 1).length > 0;
    if (t === 'multi_sense') return !!multiSenseSet(card);
    return true;
  });
  const poolTypes = eligible.length ? eligible : ['word2def'];
  return poolTypes[Math.floor(random() * poolTypes.length)];
}

/** 依据卡片与题型构建单道题目；不可用（如缺少英文释义）时返回 null 由调用方回退 */
function buildOneQuestion(card, type, { defPool, wordPool, hard, random, engPool = [], zhPool = [] }) {
  const canSentence = !!(card.example && blankWord(card.example, card.front).includes('____'));
  const kind = type === 'sentence2word' && !canSentence ? 'word2def' : type;

  // 英英选择：题干=英文单词（子模式 A）或英文释义（子模式 B），选项同为英文释义/单词
  if (kind === 'eng_eng') {
    const senses = engSenses(card, 4);
    if (!senses.length) return null;
    const sub = random() < 0.5 ? 'word2def' : 'def2word'; // A：看词选义 / B：看义猜词
    const sense = senses[Math.floor(random() * senses.length)];
    if (sub === 'word2def') {
      const distractors = pickPoolDistractors(card, engPool, 3, senses).map((d) => d.text);
      if (!distractors.length) return null;
      return {
        cardId: card.id,
        type: 'eng_eng',
        sub,
        prompt: String(card.front || ''),
        promptSense: sense,
        options: buildOptions(sense, distractors),
        answered: false,
        correct: false,
        attempts: 0,
        wrongPicks: [],
        lastPicked: null
      };
    }
    const distractors = pickWordTexts(card, wordPool, 3).map((d) => d.text);
    if (!distractors.length) return null;
    return {
      cardId: card.id,
      type: 'eng_eng',
      sub,
      prompt: sense,
      promptSense: sense,
      options: buildOptions(String(card.front || ''), distractors),
      answered: false,
      correct: false,
      attempts: 0,
      wrongPicks: [],
      lastPicked: null
    };
  }

  // 多义多选：正确项 = 该词全部释义（中文优先，缺失回退 GCIDE 英文），另加 1 条其它词的干扰释义
  if (kind === 'multi_sense') {
    const set = multiSenseSet(card);
    if (!set) return null;
    const pool = set.kind === 'zh' ? zhPool : engPool;
    const distractors = pickPoolDistractors(card, pool, 1, set.list).map((d) => d.text);
    if (!distractors.length) return null;
    const options = shuffle([
      ...set.list.map((text) => ({ text, isCorrect: true })),
      ...distractors.map((text) => ({ text, isCorrect: false }))
    ]).map((o, i) => ({ ...o, key: i }));
    return {
      cardId: card.id,
      type: 'multi_sense',
      senseKind: set.kind,
      multi: true,
      prompt: String(card.front || ''),
      options,
      selected: [],
      answered: false,
      correct: false,
      attempts: 0,
      wrongPicks: [], // 多选不使用「已选错即禁用」，故恒为空
      lastPicked: null
    };
  }

  // 填空题：题干随机用「例句挖空」或「中文释义」，用户输入英文作答
  if (kind === 'fill') {
    const promptKind = canSentence && random() < 0.5 ? 'sentence' : 'meaning';
    return {
      cardId: card.id,
      type: 'fill',
      promptKind,
      prompt: promptKind === 'sentence' ? String(card.example || '') : String(card.back || ''),
      answer: String(card.front || ''),
      accepts: wordForms(card.front),
      answered: false,
      correct: false,
      attempts: 0,
      wrongInputs: [],
      lastInput: null,
      hintLevel: 0,
      draft: ''
    };
  }

  let options;
  if (kind === 'def2word' || kind === 'sentence2word') {
    // 释义/句子 → 单词：正确项为 front，干扰项为其它单词
    const distractors = pickWordDistractors(card, wordPool, 3, hard);
    options = buildOptions(String(card.front || ''), distractors.map((d) => d.text));
  } else {
    // word2def / listen：正确项为 back，干扰项为释义（自身多释义/同组/兜底）
    const distractors = pickDistractors(card, defPool, 3, hard);
    options = buildOptions(String(card.back || ''), distractors.map((d) => d.text));
  }

  return {
    cardId: card.id,
    type: kind,
    options,
    answered: false, // 本题是否已“解决”（答对 或 机会用尽）
    correct: false,
    attempts: 0,
    wrongPicks: [],
    lastPicked: null
  };
}

/** 构建单题并按需回退（英英/多义题数据不足时退回 word2def），保证每题一定有题 */
function buildQuestionSafe(card, type, ctx) {
  return buildOneQuestion(card, type, ctx) || buildOneQuestion(card, 'word2def', ctx);
}

export function buildQuestions(deck, levelIndex, { types = null, random = Math.random, hardIds = null } = {}) {
  const list = types && types.length ? types : enabledTypes();
  const levelCards = lv.cardsInLevel(deck, levelIndex);
  const hard = hardIds instanceof Set ? hardIds : new Set(hardIds || []);
  const defPool = buildOptionPool(deck); // 释义池（back + extraBacks）
  const wordPool = buildWordPool(deck); // 单词池（front）
  const engPool = buildEngPool(deck); // 英文释义池（GCIDE）
  const zhPool = buildZhPool(deck); // 中文释义池

  // 困难词：前置到序列前部，并额外多出一道题（提高其在测试中的出现概率）
  const ordered = [...levelCards].sort((a, b) => Number(hard.has(b.id)) - Number(hard.has(a.id)));
  const quizCards = [];
  for (const c of ordered) {
    quizCards.push(c);
    if (hard.has(c.id)) quizCards.push(c);
  }

  return quizCards.map((card) => {
    const canSentence = !!(card.example && blankWord(card.example, card.front).includes('____'));
    const type = pickQuestionType(card, list, random, canSentence);
    return buildQuestionSafe(card, type, { defPool, wordPool, hard, random, engPool, zhPool });
  });
}

/** 整卡组可配置测试：按「抽题计划」构建题目（计划由 test-engine.samplePlan 生成） */
export function buildQuestionsFromPlan(deck, plan, hardIds = null, random = Math.random) {
  const hard = hardIds instanceof Set ? hardIds : new Set(hardIds || []);
  const defPool = buildOptionPool(deck);
  const wordPool = buildWordPool(deck);
  const engPool = buildEngPool(deck);
  const zhPool = buildZhPool(deck);
  const byId = new Map((deck.cards || []).map((c) => [c.id, c]));
  const out = [];
  for (const item of plan || []) {
    const card = byId.get(item && item.cardId);
    if (!card) continue;
    out.push(buildQuestionSafe(card, item.type, { defPool, wordPool, hard, random, engPool, zhPool }));
  }
  return out;
}

function ensureSession(deckId, levelIndex) {
  const deck = store.getDeck(deckId);
  if (!deck) return null;
  const level = Number(levelIndex);
  const cards = lv.cardsInLevel(deck, level);
  if (!cards.length) return null;
  // 依据该关重刷次数微调题型比例（每次重新构建题目池 → 选项/干扰项重新随机）
  const retries = ls.getLevelStats(deckId, level).retries;
  return {
    deckId,
    level,
    questions: buildQuestions(deck, level, { types: typesForRetry(retries), hardIds: hw.hardSet(deckId) }),
    pos: 0,
    correct: 0
  };
}

function answeredCount() {
  return (T.questions || []).filter((q) => q.answered).length;
}

function isFinished() {
  return T && T.questions.length > 0 && answeredCount() >= T.questions.length;
}

function ratio() {
  return T.questions.length ? T.correct / T.questions.length : 0;
}

function isWrongPick(q, i) {
  return Array.isArray(q.wrongPicks) && q.wrongPicks.includes(i);
}

/** 多选题：该项是否已勾选 */
function isSelected(q, i) {
  return !!(q && Array.isArray(q.selected) && q.selected.includes(i));
}

function optionClass(q, opt, i) {
  const multi = q.type === 'multi_sense';
  if (!q.answered && multi) {
    const base = isSelected(q, i) ? 'opt-picked' : '';
    return isWrongPick(q, i) ? `${base} opt-wrong`.trim() : base;
  }
  if (isWrongPick(q, i)) return 'opt-wrong'; // 本轮已选错的选项（红色禁用）
  if (!q.answered) return '';
  if (opt.isCorrect) return 'opt-right'; // 揭示正确项
  return 'opt-dim';
}

function optionMark(q, opt, i) {
  const multi = q.type === 'multi_sense';
  if (opt.isCorrect && q.answered) return '<span class="opt-mark">✓</span>';
  if (multi && !q.answered && isSelected(q, i)) return '<span class="opt-mark opt-mark-pick">✓</span>';
  if (i === q.lastPicked && q.answered && !opt.isCorrect) return '<span class="opt-mark">✕</span>';
  return '';
}

function feedbackHtml(q) {
  const isFill = q.type === 'fill';
  const isMulti = q.type === 'multi_sense';
  let text = '';
  let cls = '';
  if (q.answered) {
    if (q.correct) {
      text = '回答正确，即将进入下一题…';
      cls = 'fb-ok';
    } else {
      text = isFill
        ? '机会已用尽，正确答案见下方，即将进入下一题…'
        : isMulti
          ? '机会已用尽，正确释义已标出，即将进入下一题…'
          : '机会已用尽，正确答案已标出，即将进入下一题…';
      cls = 'fb-bad';
    }
  } else if (q.attempts > 0) {
    const left = MAX_ATTEMPTS - q.attempts;
    text = isFill
      ? `答案不对，还可以再试 ${left} 次`
      : isMulti
        ? `全对才算通过，还可以再提交 ${left} 次`
        : `选错了，还可以再选 ${left} 次`;
    cls = 'fb-bad';
  }
  return text ? `<div class="quiz-feedback ${cls}">${text}</div>` : '';
}

/** 题型名（进度行「第 N 题」后的小标签） */
function typeName(type) {
  return {
    word2def: '选释义',
    def2word: '选单词',
    sentence2word: '句子选词',
    fill: '填空',
    listen: '听音辨意',
    eng_eng: '英英选择',
    multi_sense: '多义多选'
  }[type] || '选择';
}

/** 题干顶部小字提示 */
function questionTag(type, card, q) {
  switch (type) {
    case 'def2word':
      return '看释义，选择对应的单词';
    case 'sentence2word':
      return '根据例句意思，选出正确的单词';
    case 'fill':
      return q && q.promptKind === 'sentence' ? '根据例句，填入缺失的英文单词' : '根据中文释义，输入对应的英文单词';
    case 'listen':
      return '听发音，选择正确的释义';
    case 'eng_eng':
      return q && q.sub === 'def2word' ? '看英文释义，选择对应的单词' : '看单词，选择正确的英文释义';
    case 'multi_sense':
      return q && q.senseKind === 'zh' ? '多选：选出该词的全部中文释义' : '多选：选出该词的全部英文释义';
    default:
      return card.example ? '请选择与例句最匹配的释义' : '请选择正确释义';
  }
}

/** 听音辨意题干：播放按钮（环境不支持 TTS 时降级显示单词） */
function listenHtml(card) {
  const word = String(card.front || '');
  if (!canSpeak()) {
    return `<p class="q-prompt">${esc(word)}</p><p class="listen-note">当前环境不支持发音，已显示单词</p>`;
  }
  return `<button class="listen-play" type="button" data-action="listen-play">🔊 播放发音</button>`;
}

/** 挖空例句的 HTML（____ 高亮） */
function blankSentenceHtml(sentence, word) {
  const prompt = blankWord(sentence, word);
  return `<p class="q-prompt q-prompt-sent">${esc(prompt).split('____').join('<span class="q-blank">____</span>')}</p>`;
}

/** 题干主体：front 单词 / back 释义 / 挖空后的例句 / 填空题干 / 英英题 / 多义多选 */
function questionPromptHtml(type, card, q) {
  if (type === 'def2word') {
    return `<p class="q-prompt q-prompt-def">${esc(card.back)}</p>`;
  }
  if (type === 'sentence2word') {
    return blankSentenceHtml(card.example, card.front);
  }
  if (type === 'fill') {
    return q.promptKind === 'sentence'
      ? blankSentenceHtml(q.prompt, card.front)
      : `<p class="q-prompt q-prompt-def">${esc(q.prompt)}</p>`;
  }
  if (type === 'listen') {
    return listenHtml(card);
  }
  if (type === 'eng_eng') {
    // 子模式 B：题干 = 英文释义（看义猜词）；子模式 A：题干 = 单词（看词选义）
    return q.sub === 'def2word'
      ? `<p class="q-prompt q-prompt-def q-prompt-eng">${esc(q.prompt)}</p>`
      : `<p class="q-prompt">${esc(card.front)}</p>`;
  }
  return `<p class="q-prompt">${esc(card.front)}</p>`;
}

/** 答错（机会用尽）后展示的完整信息卡：front + back + example（+ 例句翻译） */
function fullInfoHtml(card) {
  return `
  <div class="quiz-full-info">
    <div class="fi-row"><span class="fi-label">单词</span><span class="fi-val">${esc(card.front)}</span></div>
    <div class="fi-row"><span class="fi-label">释义</span><span class="fi-val">${esc(card.back)}</span></div>
    ${card.example ? `<div class="fi-row"><span class="fi-label">例句</span><span class="fi-val fi-ex">${esc(card.example)}</span></div>` : ''}
    ${card.exampleZh ? `<div class="fi-row"><span class="fi-label">翻译</span><span class="fi-val fi-ex">${esc(card.exampleZh)}</span></div>` : ''}
  </div>`;
}

/** 选择题选项区 + 键盘提示；多义多选为「勾选 + 提交」模式 */
function optionsHtml(q) {
  if (q.type === 'multi_sense') {
    const picked = Array.isArray(q.selected) ? q.selected.length : 0;
    return `
      <div class="q-options q-options-multi">
        ${q.options.map((opt, i) => `
          <button class="opt opt-multi ${optionClass(q, opt, i)}" data-action="test-pick" data-i="${i}"
            ${q.answered ? 'disabled' : ''} aria-pressed="${isSelected(q, i) ? 'true' : 'false'}">
            <span class="opt-key">${String.fromCharCode(65 + i)}</span>
            <span class="opt-text">${esc(opt.text)}</span>
            ${optionMark(q, opt, i)}
          </button>`).join('')}
      </div>
      <div class="multi-actions">
        <button class="btn btn-primary btn-block" data-action="test-multi-submit" ${!q.answered && picked ? '' : 'disabled'}>
          提交（已选 ${picked} 项 · 全对才算通过）
        </button>
      </div>
      <p class="quiz-kbd-hint"><span class="hint-kb">键盘 A–E / 1–5 勾选 · Enter 提交</span></p>`;
  }
  return `
      <div class="q-options">
        ${q.options.map((opt, i) => `
          <button class="opt ${optionClass(q, opt, i)}" data-action="test-pick" data-i="${i}"
            ${q.answered || isWrongPick(q, i) ? 'disabled' : ''}>
            <span class="opt-key">${String.fromCharCode(65 + i)}</span>
            <span class="opt-text">${esc(opt.text)}</span>
            ${optionMark(q, opt, i)}
          </button>`).join('')}
      </div>
      <p class="quiz-kbd-hint"><span class="hint-kb">键盘 A–D / 1–4 选择 · ↑↓←→ 移动 · Enter / 空格 确认与跳题</span></p>`;
}

/** 填空题已揭示的字母数 = max(手动提示, 答错次数)，最多到「词长-1」（不揭开末位） */
function fillRevealCount(q) {
  const word = String(q.answer || '').trim();
  if (!word) return 0;
  const want = Math.max(Number(q.hintLevel) || 0, Number(q.attempts) || 0);
  if (want <= 0) return 0;
  return Math.max(1, Math.min(want, Math.max(1, word.length - 1)));
}

/** 填空题「首字母提示」：显示已揭示的字母 + 圆点掩码（不直接给出答案） */
function fillHintHtml(q) {
  if (q.type !== 'fill' || q.answered) return '';
  const word = String(q.answer || '').trim();
  const reveal = fillRevealCount(q);
  if (!word || !reveal) return '';
  const shown = word.slice(0, reveal);
  const mask = '•'.repeat(Math.max(0, word.length - shown.length));
  return `<p class="fill-hint">提示：<b>${esc(shown)}</b><span class="fill-mask">${mask}</span>（共 ${word.length} 个字母）</p>`;
}

/**
 * 填空题发音控件：
 *   支持 TTS → 🔊 按钮（点击播放 / 播放中再点停止 / 结束自动复原）；
 *   不支持 → 降级为音标 chip（卡片有 phonetic 字段就显示音标，否则显示单词本身）。
 */
function fillAudioHtml(q, card) {
  const word = String(q.answer || (card && card.front) || '').trim();
  if (!word) return '';
  if (canSpeak()) {
    return '<button class="fill-speak" type="button" data-action="fill-speak" aria-label="播放发音" title="播放发音">🔊</button>';
  }
  const ipa = card && card.phonetic ? String(card.phonetic) : '';
  return `<span class="fill-ipa" title="当前环境不支持发音">${esc(ipa || word)}</span>`;
}

/** 填空题输入区：输入框 + 🔊 发音 + 提交 + 「提示」按钮 */
function fillInputHtml(q, card) {
  const word = String(q.answer || '').trim();
  const reveal = fillRevealCount(q);
  const maxReveal = word ? Math.max(1, word.length - 1) : 0;
  const canHint = !q.answered && word.length > 1 && reveal < maxReveal;
  return `
      ${fillHintHtml(q)}
      <div class="fill-input">
        <input class="fill-field" type="text" name="fill" placeholder="输入英文单词…" value="${esc(q.draft || '')}"
          autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="latin"
          ${q.answered ? 'disabled' : ''}>
        ${fillAudioHtml(q, card)}
        <button class="btn btn-primary" data-action="test-fill-submit" ${q.answered ? 'disabled' : ''}>提交</button>
      </div>
      ${canHint ? '<p class="fill-tip-row"><button class="btn-link" data-action="test-fill-hint">💡 首字母提示</button></p>' : ''}
      <p class="quiz-kbd-hint"><span class="hint-kb">输入后按 Enter 或点「提交」（大小写 / 空格 / 单复数均容错）</span></p>`;
}

function questionHtml() {
  const q = T.questions[T.pos];
  const deck = store.getDeck(T.deckId);
  const card = deck ? deck.cards.find((c) => c.id === q.cardId) : null;
  if (!card) return '';
  const type = q.type || 'word2def';
  const done = answeredCount();
  return `
    <div class="quiz">
      <div class="quiz-head">
        <span>第 ${T.pos + 1} / ${T.questions.length} 题 · ${typeName(type)}</span>
        <span class="quiz-score">已答对 ${T.correct} / ${done}</span>
      </div>
      <div class="progress-track"><i class="progress-fill" style="width:${Math.round((done / T.questions.length) * 100)}%"></i></div>
      <div class="q-card glass${q.multi ? ' q-card-multi' : ''}">
        <div class="q-card-head">
          ${q.multi ? '<span class="multi-badge">多选</span>' : ''}
          <span class="q-tag">${questionTag(type, card, q)}</span>
        </div>
        ${questionPromptHtml(type, card, q)}
        ${type === 'word2def' && card.example ? `<p class="q-ex">${esc(card.example)}</p>` : ''}
      </div>
      ${feedbackHtml(q)}
      ${q.answered && !q.correct ? fullInfoHtml(card) : ''}
      ${type === 'fill' ? fillInputHtml(q, card) : optionsHtml(q)}
    </div>`;
}
function resultHtml() {
  const deck = store.getDeck(T.deckId);
  const correct = T.correct;
  const total = T.questions.length;
  const pct = Math.round(ratio() * 100);
  const passed = pct >= Math.round(lv.PASS_RATIO * 100) && correct >= Math.ceil(lv.PASS_RATIO * total);
  const passedText = passed
    ? '恭喜通关！本关测试达到 80% 正确率，下一关已解锁。'
    : `还差一点点，正确率达到 80% 即可通关（还差 ${Math.max(1, Math.ceil(total * lv.PASS_RATIO) - correct)} 题）。`;
  const statClass = passed ? 'stat-good' : 'stat-bad';
  const st = ls.getLevelStats(T.deckId, T.level);
  return `
  <div class="review-done result">
    <div class="done-icon ${statClass}">${passed ? iconOk() : iconNo()}</div>
    <h2>${passed ? '关卡通关！' : '继续加油'}</h2>
    <p class="done-sub">正确 ${correct} / ${total} · 正确率 ${pct}%</p>
    <p class="done-text">${passedText}</p>
    <div class="done-stats">
      <span class="stat ${statClass}">${pct}%</span>
      <span class="stat">历史最佳 ${st.best != null ? st.best + '%' : '—'}</span>
      ${st.retries ? `<span class="stat">已刷 ${st.retries} 次</span>` : ''}
    </div>
    <div class="result-actions">
      ${passed ? `<button class="btn btn-primary btn-lg" data-action="test-back" data-id="${T.deckId}">返回卡组</button>` : ''}
      ${!passed ? `<button class="btn btn-primary btn-lg" data-action="test-again">再测一次</button>` : ''}
      ${!passed ? `<button class="btn btn-ghost btn-lg" data-action="test-back" data-id="${T.deckId}">返回卡组</button>` : ''}
      ${passed ? `<button class="btn btn-ghost btn-lg" data-action="test-again">再测一次</button>` : ''}
    </div>
  </div>`;
}

function iconOk() {
  return '<svg viewBox="0 0 24 24" width="46" height="46" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="m9 12 2 2 4-4"/></svg>';
}
function iconNo() {
  return '<svg viewBox="0 0 24 24" width="46" height="46" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 9 6 6M15 9l-6 6"/></svg>';
}

function advance(container) {
  if (!T) return;
  clearAdvanceTimer();
  stopSpeaking(); // 进入下一题：停止上一题的发音，避免声音串题
  T.pos += 1;
  hl = 0;
  hlOn = false; // 进入新题：重置键盘高亮
  saveSession();
  if (container) renderTest(container, T.deckId, T.level, { kind: T.mode });
}

function scheduleAdvance(container, resolvedCorrect) {
  clearAdvanceTimer();
  const delay = resolvedCorrect ? 850 : 1500; // 答对快跳；机会用尽多留时间看答案
  advanceTimer = setTimeout(() => {
    advanceTimer = null;
    advance(container);
  }, delay);
}

export function renderTest(root, deckId, levelIndex, { renderResolved = false, kind = null } = {}) {
  // 无 level → 整卡组可配置测试 / 错题专项
  if (levelIndex == null) return renderDeckTest(root, deckId, { renderResolved, kind });
  const wanted = { deckId, level: Number(levelIndex) };
  LAST = { ...wanted };
  const existing = loadSession();
  if (existing && existing.deckId === wanted.deckId && existing.level === wanted.level && existing.questions.length) {
    T = existing;
  } else {
    T = ensureSession(wanted.deckId, wanted.level);
    hl = 0;
    hlOn = false; // 新会话：重置键盘高亮
    if (T) saveSession();
  }
  const deck = store.getDeck(deckId);
  if (!deck || !T) {
    root.innerHTML = `<div class="view"><div class="empty glass"><h3>${deck ? '本关没有可测试的卡片' : '卡组不存在'}</h3><a class="btn btn-primary" href="#/deck/${esc(deckId)}">返回卡组</a></div></div>`;
    return;
  }

  if (isFinished() && !renderResolved) {
    // 全部答完：记录成绩并判定通关
    const pct = Math.round(ratio() * 100);
    const passPct = Math.round(lv.PASS_RATIO * 100);
    const wasPassed = lv.isLevelPassed(deck, T.level);
    if (pct >= passPct) {
      // 通关即视为学完本关（跳过翻面时自动补齐已学），不重置已有复习进度
      store.markLevelLearned(deckId, T.level);
      if (!wasPassed) {
        store.markLevelPassed(deckId, T.level);
        toast('🎉 关卡通关，下一关已解锁！', 'good');
      }
    }
    ls.recordScore(deckId, T.level, pct); // 记录历史最佳正确率
    const html = resultHtml(); // 需在清除会话前生成
    clearSession();
    root.innerHTML = `<div class="view">${html}</div>`;
    return;
  }

  // 当前题已解决（如刷新恢复的中途状态）→ 直接推进，不重复展示
  // （renderResolved=true 时表示刚作答完成，需要展示“对/错”反馈再自动跳题）
  const cur = T.questions[T.pos];
  if (cur && cur.answered && !renderResolved) {
    advance(root);
    return;
  }
  root.innerHTML = `<div class="view">${questionHtml()}</div>`;
  paintHighlight();
  attachFillInput();
  attachListenAudio();
}

/* ------------------------ 整卡组可配置测试（20~150 题） ------------------------ */

/** 卡组可用词数（有 front 的卡片） */
function deckWordCount(deck) {
  return (deck && deck.cards ? deck.cards : []).filter((c) => c.front).length;
}

/** 重渲染配置页 */
function rerenderConfig(deckId) {
  const root = document.getElementById('view');
  if (root) renderDeckTestConfig(root, deckId);
}

/** 配置页：预设档位 + 滑块（20~150，步长 10）+ 开始测试（含「继续上次测试」弹窗） */
export function renderDeckTestConfig(root, deckId) {
  const deck = store.getDeck(deckId);
  if (!deck) {
    root.innerHTML = `<div class="view"><div class="empty glass"><h3>卡组不存在</h3><a class="btn btn-primary" href="#/home">返回首页</a></div></div>`;
    return;
  }
  const words = deckWordCount(deck);
  const enabled = words >= cfg.MIN_QUESTIONS;
  const conf = cfg.loadConfig();
  const count = enabled ? conf.count : cfg.DEFAULT_QUESTIONS;
  const prio = engine.priorityCount(deckId);
  const prog = engine.loadProgress(deckId);
  const gap = Math.max(1, Math.floor(count / Math.max(1, words)));

  const presetBtns = cfg.PRESETS.map((p) => {
    const on = p.count === count;
    return `<button class="btn ${on ? 'btn-primary' : 'btn-ghost'}" data-action="deck-test-preset" data-id="${esc(deckId)}" data-count="${p.count}" ${enabled ? '' : 'disabled'}>${p.label} · ${p.count} 题</button>`;
  }).join('');

  const weightRows = cfg.QUESTION_TYPES.map(
    (t) => `
    <div class="weight-row">
      <span class="weight-name">${esc(cfg.TYPE_LABELS[t] || t)}</span>
      <input id="wt-input-${t}" class="test-range weight-range" type="range" min="0" max="100" step="5" value="${conf.weights[t]}" data-action="deck-test-weight" data-type="${t}" data-id="${esc(deckId)}" aria-label="${esc(cfg.TYPE_LABELS[t] || t)} 比例">
      <b id="wt-val-${t}">${conf.weights[t]}%</b>
    </div>`
  ).join('');

  // 可选题型（默认关闭）：开关 + 说明 + 启用后的第 6/7 个滑块
  const optionalRows = cfg.OPTIONAL_TYPES.map((o) => {
    const on = !!conf.enabled[o.id];
    const w = conf.weights[o.id] || 0;
    return `
    <div class="weight-item${on ? ' is-on' : ''}">
      <div class="weight-row">
        <span class="weight-name">${esc(o.label)}</span>
        <label class="weight-toggle">
          <input type="checkbox" data-action="deck-test-type-toggle" data-type="${o.id}" data-id="${esc(deckId)}" ${on ? 'checked' : ''}>
          <span>${on ? '已启用' : '启用'}</span>
        </label>
        <b id="wt-val-${o.id}">${on ? w + '%' : '—'}</b>
      </div>
      ${on ? `<input id="wt-input-${o.id}" class="test-range weight-range" type="range" min="0" max="100" step="5" value="${w}" data-action="deck-test-weight" data-type="${o.id}" data-id="${esc(deckId)}" aria-label="${esc(o.label)} 比例">` : ''}
      <p class="weight-desc">${esc(o.desc)}</p>
    </div>`;
  }).join('');

  const weightTotal = cfg.ALL_TYPES.reduce((s, t) => s + (conf.weights[t] || 0), 0);
  const weightEditor = `
    <details class="weight-box" open>
      <summary>题型比例（合计 <b id="wt-total">${weightTotal}%</b>）</summary>
      ${weightRows}
      <div class="weight-optional">
        <p class="weight-section-title">进阶题型（默认关闭，等比分配）</p>
        ${optionalRows}
      </div>
      <div class="weight-foot"><button class="btn-link" data-action="deck-test-weight-reset" data-id="${esc(deckId)}">恢复默认（已启用题型等比平分）</button></div>
      <p class="hint">拖动任一题型，其余已启用题型按当前比例自动分摊，合计始终保持 100%；启用可选题型后会与其余题型等比平分（如 6 种各约 1/6 ≈ 16.7%）。</p>
    </details>`;

  root.innerHTML = `
    <div class="view">
      <div class="section-head">
        <h2 class="screen-title">整卡组测试</h2>
        <span class="sub-note">${esc(deck.name)} · ${words} 词</span>
      </div>
      ${
        enabled
          ? `<section class="panel glass">
              <h3 class="panel-title">题数</h3>
              <div class="preset-row">${presetBtns}</div>
              <div class="test-count-row">
                <input id="deck-test-range" class="test-range" type="range" min="${cfg.MIN_QUESTIONS}" max="${cfg.MAX_QUESTIONS}" step="${cfg.STEP_QUESTIONS}" value="${count}" data-action="deck-test-count" data-id="${esc(deckId)}" aria-label="题数">
                <b id="deck-test-count-val">${count}</b>
              </div>
              <p class="hint">范围 ${cfg.MIN_QUESTIONS}~${cfg.MAX_QUESTIONS} 题（步长 ${cfg.STEP_QUESTIONS}）。题数超过卡组词数时自动循环出题：每个词至少出现一次、同词间隔 ≥ ${gap} 题、且优先换题型。</p>
              <div class="tag-row">${weightEditor}</div>
              ${prio ? `<p class="hint">优先池：${prio} 道错题将优先占用约 50% 配额</p>` : ''}
              <button class="btn btn-test btn-lg btn-block" data-action="deck-test-start" data-id="${esc(deckId)}" data-count="${count}">开始测试 · ${count} 题</button>
              <p class="hint">通关线：正确率 ≥ ${Math.round(cfg.PASS_RATIO * 100)}%</p>
            </section>`
          : `<section class="panel glass">
              <h3 class="panel-title">暂不可用</h3>
              <p class="panel-desc">至少需要 ${cfg.MIN_QUESTIONS} 个词才能开始测试（当前 ${words} 个）。</p>
              <div class="preset-row">${presetBtns}</div>
              <div class="test-count-row">
                <input class="test-range" type="range" min="${cfg.MIN_QUESTIONS}" max="${cfg.MAX_QUESTIONS}" step="${cfg.STEP_QUESTIONS}" value="${count}" disabled aria-label="题数（不可用）">
                <b>${count}</b>
              </div>
              <button class="btn btn-disabled btn-block" disabled>至少需要 ${cfg.MIN_QUESTIONS} 个词才能开始测试</button>
            </section>`
      }
    </div>`;

  // 有未完成进度 → 弹窗询问（常规测试 / 错题专项可分别继续）
  const progWrong = engine.loadProgress(deckId, 'wrong');
  const hasNormal = !!(prog && Array.isArray(prog.questions) && prog.questions.length);
  const hasWrong = !!(progWrong && Array.isArray(progWrong.questions) && progWrong.questions.length);
  if (enabled && (hasNormal || hasWrong)) {
    const line = (label, p) => `<p class="confirm-text">· ${label}：已完成 ${p.questions.filter((q) => q.answered).length} / ${p.questions.length} 题</p>`;
    const body = (hasNormal ? line('常规测试', prog) : '') + (hasWrong ? line('错题专项', progWrong) : '');
    const actions = [];
    if (hasWrong) {
      actions.push({ label: '继续错题专项', cls: 'btn-ghost', onClick: () => resumeDeckTest(deckId, 'wrong') });
    }
    if (hasNormal) {
      actions.push({ label: '继续上次测试', cls: 'btn-primary', onClick: () => resumeDeckTest(deckId, 'deck') });
    }
    actions.push({
      label: '重新开始',
      cls: 'btn-ghost',
      onClick: () => {
        engine.clearProgress(deckId, 'deck');
        engine.clearProgress(deckId, 'wrong');
        rerenderConfig(deckId);
      }
    });
    openModal({ title: '有未完成的测试', body, actions });
  }
}

/** 从断点继续（kind: 'deck' 常规测试 / 'wrong' 错题专项） */
export function resumeDeckTest(deckId, kind = 'deck') {
  const root = document.getElementById('view');
  if (!root) return;
  const useKind = kind === 'wrong' ? 'wrong' : 'deck';
  const prog = engine.loadProgress(deckId, useKind);
  if (!prog || !Array.isArray(prog.questions) || !prog.questions.length) {
    renderDeckTestConfig(root, deckId);
    return;
  }
  T = prog;
  T.mode = useKind;
  T.lastTick = Date.now();
  saveSession();
  renderTest(root, deckId, null, { kind: useKind });
}

/** 开始一次整卡组测试（按配置抽题；onlyWrong 时只练优先池里的错题） */
export function startDeckTest(deckId, count, { onlyWrong = false } = {}) {
  const root = document.getElementById('view');
  if (!root) return;
  const deck = store.getDeck(deckId);
  if (!deck) return;
  const conf = cfg.loadConfig();
  let pool = deck;
  let n;
  if (onlyWrong) {
    const prio = engine.getPriorityIds(deckId);
    const cards = deck.cards.filter((c) => c.front && prio.has(c.id));
    if (!cards.length) {
      toast('暂无错题，先做一次测试吧', 'warn');
      return;
    }
    pool = { ...deck, cards };
    n = cards.length; // 错题专项：每道错题各出一次
  } else {
    n = cfg.clampCount(count == null ? conf.count : count);
  }
  const plan = engine.samplePlan(pool, {
    count: n,
    weights: conf.weights,
    enabled: conf.enabled, // 可选题型（英英选择 / 多义多选）启用后才参与抽题
    priorityIds: onlyWrong ? new Set() : engine.getPriorityIds(deckId)
  });
  const questions = buildQuestionsFromPlan(deck, plan, hw.hardSet(deckId));
  if (!questions.length) {
    toast('没有可测试的卡片', 'warn');
    return;
  }
  const now = Date.now();
  T = {
    deckId,
    mode: onlyWrong ? 'wrong' : 'deck',
    level: null,
    count: questions.length,
    questions,
    pos: 0,
    correct: 0,
    startedAt: now,
    lastTick: now,
    elapsedMs: 0
  };
  LAST = { deckId, level: null, count: questions.length };
  saveSession();
  renderTest(root, deckId, null, { kind: T.mode });
}

/** 整卡组测试 / 错题专项：渲染当前题 / 结算 */
function renderDeckTest(root, deckId, { renderResolved = false, kind = null } = {}) {
  const deck = store.getDeck(deckId);
  if (!deck || !deck.cards.length) {
    root.innerHTML = `<div class="view"><div class="empty glass"><h3>卡组不存在</h3><a class="btn btn-primary" href="#/home">返回首页</a></div></div>`;
    return;
  }
  const useKind = kind === 'wrong' ? 'wrong' : 'deck';
  const prog = engine.loadProgress(deckId, useKind);
  if (!prog || !Array.isArray(prog.questions) || !prog.questions.length) {
    renderDeckTestConfig(root, deckId);
    return;
  }
  T = prog;
  LAST = { deckId, level: null, count: prog.count };
  saveSession(); // 刷新计时
  if (isFinished() && !renderResolved) {
    finishDeckTest(root);
    return;
  }
  const cur = T.questions[T.pos];
  if (cur && cur.answered && !renderResolved) {
    advance(root);
    return;
  }
  root.innerHTML = `<div class="view">${questionHtml()}</div>`;
  paintHighlight();
  attachFillInput();
  attachListenAudio();
}

/** 结算：统计成绩、错题入优先池、清进度、渲染结果页 */
function finishDeckTest(root) {
  const deck = store.getDeck(T.deckId);
  const sum = engine.summarize(T.questions);
  const elapsedMs = (T.elapsedMs || 0) + (T.lastTick ? Date.now() - T.lastTick : 0);
  if (sum.wrongIds.length) engine.recordWrong(T.deckId, sum.wrongIds); // 错题 → 优先池
  const html = deckResultHtml(deck, sum, elapsedMs);
  engine.clearProgress(T.deckId, T.mode);
  T = null;
  root.innerHTML = `<div class="view">${html}</div>`;
}

/** 整卡组测试结果页：正确率 / 对错数 / 通关状态 / 用时 / 错题列表 */
function deckResultHtml(deck, sum, elapsedMs) {
  const mins = Math.floor(elapsedMs / 60000);
  const secs = Math.round((elapsedMs % 60000) / 1000);
  const timeText = mins ? `${mins} 分 ${secs} 秒` : `${secs} 秒`;
  const wrongCards = sum.wrongIds.map((id) => deck.cards.find((c) => c.id === id)).filter(Boolean);
  const isWrongRun = !!(T && T.mode === 'wrong');
  const againAction = isWrongRun ? 'deck-test-wrong' : 'deck-test-again';
  const titlePrefix = isWrongRun ? '错题专项 · ' : '';
  const wrongList = wrongCards.length
    ? `<div class="deck-wrong-list">
        <p class="sub-note">错题 ${wrongCards.length} 道（已加入优先池，下一轮优先复习）</p>
        ${wrongCards
          .slice(0, 20)
          .map((c) => `<div class="deck-wrong-item"><b>${esc(c.front)}</b><span>${esc(c.back)}</span></div>`)
          .join('')}
        ${wrongCards.length > 20 ? `<p class="hint">…等共 ${wrongCards.length} 道</p>` : ''}
      </div>`
    : '';
  return `
  <div class="review-done result">
    <div class="done-icon ${sum.passed ? 'stat-good' : 'stat-bad'}">${sum.passed ? iconOk() : iconNo()}</div>
    <h2>${sum.passed ? '通关！' : '再练一次'}</h2>
    <p class="done-sub">${titlePrefix}${esc(deck.name)} · 正确 ${sum.correct} / ${sum.total} · 正确率 ${sum.pct}%</p>
    <div class="done-stats">
      <span class="stat ${sum.passed ? 'stat-good' : 'stat-bad'}">${sum.pct}%</span>
      <span class="stat">对 ${sum.correct}</span>
      <span class="stat">错 ${sum.wrong}</span>
      <span class="stat">用时 ${timeText}</span>
      <span class="stat">${sum.passed ? '已通关' : `未达标（≥${Math.round(cfg.PASS_RATIO * 100)}%）`}</span>
    </div>
    ${wrongList}
    <div class="result-actions">
      ${engine.priorityCount(deck.id) ? `<button class="btn btn-ghost btn-lg" data-action="deck-test-wrong" data-id="${esc(deck.id)}">错题专项再练 · ${engine.priorityCount(deck.id)} 题</button>` : ''}
      <button class="btn btn-primary btn-lg" data-action="${againAction}" data-id="${esc(deck.id)}" data-count="${T ? T.count : 0}">再练一次</button>
      <button class="btn btn-ghost btn-lg" data-action="test-back" data-id="${esc(deck.id)}">返回卡组</button>
    </div>
  </div>`;
}

/* ------------------------------ Actions ------------------------------ */

/** 选择第 i 个选项（点击 / 键盘共用）；返回是否生效 */
function pickOption(i) {
  if (!T) return false;
  const q = T.questions[T.pos];
  if (!q) return false;
  if (q.type === 'multi_sense') return toggleMultiOption(i);
  if (q.answered || !q.options[i] || isWrongPick(q, i)) return false;
  const res = applyAttempt(q, i);
  if (res.correct) T.correct += 1;
  saveSession();
  const container = document.getElementById('view');
  if (!container) return false;
  if (res.resolved) {
    // 先展示本次作答反馈（答对绿 / 机会用尽标出答案），稍后自动跳题
    renderTest(container, T.deckId, T.level, { renderResolved: true, kind: T.mode });
    scheduleAdvance(container, res.correct);
  } else {
    // 答错且有剩余机会：重渲染本题（错误选项禁用 + 提示剩余次数）
    renderTest(container, T.deckId, T.level, { kind: T.mode });
  }
  return true;
}

/** 多义多选：勾选 / 取消勾选一项（不立即判分） */
function toggleMultiOption(i) {
  if (!T) return false;
  const q = T.questions[T.pos];
  if (!q || q.type !== 'multi_sense' || q.answered || !q.options[i]) return false;
  const sel = new Set(Array.isArray(q.selected) ? q.selected : []);
  if (sel.has(i)) sel.delete(i);
  else sel.add(i);
  q.selected = [...sel].sort((a, b) => a - b);
  saveSession();
  const container = document.getElementById('view');
  if (container) renderTest(container, T.deckId, T.level, { kind: T.mode });
  return true;
}

/** 多义多选：提交判分（全对才算对；机会用尽则记为错题） */
function submitMulti() {
  if (!T) return false;
  const q = T.questions[T.pos];
  if (!q || q.type !== 'multi_sense' || q.answered) return false;
  const res = applyMulti(q, q.selected || []);
  if (res.resolved && res.correct) T.correct += 1;
  saveSession();
  const container = document.getElementById('view');
  if (!container) return false;
  if (res.resolved) {
    renderTest(container, T.deckId, T.level, { renderResolved: true, kind: T.mode });
    scheduleAdvance(container, res.correct);
  } else {
    renderTest(container, T.deckId, T.level, { kind: T.mode });
  }
  return true;
}

on('test-pick', (el) => {
  pickOption(Number(el.dataset.i));
});

on('test-multi-submit', () => {
  submitMulti();
});

/** 提交填空题答案（读取输入框 → 判题 → 反馈/跳题） */
function submitFill() {
  if (!T) return false;
  const q = T.questions[T.pos];
  if (!q || q.type !== 'fill' || q.answered) return false;
  const el = document.querySelector ? document.querySelector('.fill-field') : null;
  const val = el ? el.value : '';
  if (!normalizeAnswer(val)) return false; // 空输入不判题
  const res = applyFill(q, val);
  q.draft = ''; // 作答后清空草稿，避免下次渲染回填
  if (res.correct) T.correct += 1;
  saveSession();
  const container = document.getElementById('view');
  if (!container) return false;
  if (res.resolved) {
    // 先展示本次作答反馈，稍后自动跳题（Enter/空格 可立即跳）
    renderTest(container, T.deckId, T.level, { renderResolved: true, kind: T.mode });
    scheduleAdvance(container, res.correct);
  } else {
    // 答错且还有机会：重渲染本题（保留提示）
    renderTest(container, T.deckId, T.level, { kind: T.mode });
  }
  return true;
}

on('test-fill-submit', () => submitFill());

/** 填空 🔊 发音：点击播放 → 播放中再点停止 → 结束后自动复原 */
on('fill-speak', (el) => {
  if (!T) return;
  const q = T.questions[T.pos];
  if (!q) return;
  const word = String(q.answer || '').trim();
  if (!word) return;
  if (isSpeaking(word)) {
    stopSpeaking(); // 播放中再点 → 停止朗读
    return;
  }
  speakTargetWord(word, el); // 播放新词前会先 cancel 旧词
});

/** 听音辨意：点击播放 / 重播发音 */
on('listen-play', () => {
  if (!T) return;
  const q = T.questions[T.pos];
  if (!q) return;
  const deck = store.getDeck(T.deckId);
  const card = deck ? deck.cards.find((c) => c.id === q.cardId) : null;
  if (card) speakWord(card.front);
});

/** 填空「提示」按钮：多揭示一个字母（不消耗作答机会，并保留已输入内容） */
on('test-fill-hint', () => {
  if (!T) return;
  const q = T.questions[T.pos];
  if (!q || q.type !== 'fill' || q.answered) return;
  const el = document.querySelector ? document.querySelector('.fill-field') : null;
  q.draft = el ? el.value : ''; // 保留已输入内容
  const word = String(q.answer || '').trim();
  const maxReveal = Math.max(1, word.length - 1);
  q.hintLevel = Math.min((Number(q.hintLevel) || 0) + 1, maxReveal);
  saveSession();
  const container = document.getElementById('view');
  if (container) renderTest(container, T.deckId, T.level);
});

/** 键盘按键 → 选项下标：A/B/C/D 或 1/2/3/4（其它键返回 null） */
export function keyToOptionIndex(evt) {
  const k = String((evt && evt.key) || '').toLowerCase();
  const letter = ['a', 'b', 'c', 'd', 'e'].indexOf(k);
  if (letter >= 0) return letter;
  const num = ['1', '2', '3', '4', '5'].indexOf(k);
  return num >= 0 ? num : null;
}

/** 确认键：Enter 或 空格（未作答=确认高亮项；已作答=跳到下一题） */
export function isConfirmKey(evt) {
  return evt.key === 'Enter' || evt.key === ' ' || evt.key === 'Spacebar' || evt.code === 'Space';
}

/* 桌面端键盘作答：A–D / 1–4 直接选择；↑↓←→ 移动高亮；Enter/空格 确认；作答后 Enter/空格 立即跳题 */
function onKeydown(e) {
  if (e.repeat) return;
  if (!T) return; // 无测试
  const body = document.body;
  if (body && body.classList && body.classList.contains('modal-open')) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const q = T.questions[T.pos];
  if (!q) return;
  const confirm = isConfirmKey(e);

  // 已作答（正在展示对/错反馈）：Enter / 空格 立即进入下一题，跳过自动跳题等待
  if (q.answered) {
    if (confirm) {
      e.preventDefault();
      const container = document.getElementById('view');
      if (container) advance(container);
    }
    return;
  }
  if (isFinished()) return;

  // 焦点在按钮上时把 Enter/空格 交还浏览器（即激活该按钮）
  const onButton = t && (t.tagName === 'BUTTON' || (t.dataset && t.dataset.action));
  if (onButton && confirm) return;

  // 填空题等无选项题型：不做 A–D / 方向键操作（Enter 在输入框内提交）
  if (!Array.isArray(q.options) || !q.options.length) return;

  // 多义多选：Enter / 空格 = 提交；A–E / 1–5 = 勾选或取消勾选
  if (q.type === 'multi_sense') {
    if (confirm) {
      e.preventDefault();
      submitMulti();
      return;
    }
    const mi = keyToOptionIndex(e);
    if (mi == null) return;
    e.preventDefault();
    hlOn = false;
    toggleMultiOption(mi);
    return;
  }

  if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'ArrowRight') {
    e.preventDefault();
    const n = q.options.length || 1;
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
    hlOn = true;
    hl = (hl + step + n) % n;
    paintHighlight();
    return;
  }
  if (confirm) {
    if (!hlOn) return;
    e.preventDefault();
    pickOption(hl);
    return;
  }

  const idx = keyToOptionIndex(e);
  if (idx == null) return;
  e.preventDefault();
  hlOn = false; // 用字母/数字作答时取消方向键高亮
  pickOption(idx);
}
document.addEventListener('keydown', onKeydown);

on('test-again', (el) => {
  if (!LAST || LAST.level == null) return; // 整卡组测试请用 deck-test-again
  const { deckId, level } = LAST;
  ls.bumpRetries(deckId, level); // 「再测一次」计入重刷次数，并微调下次题型比例
  clearSession();
  const container = el.closest('#view') || document.getElementById('view');
  if (container) renderTest(container, deckId, level);
});

/* ------------------------ 整卡组测试动作 ------------------------ */

on('deck-test-preset', (el) => {
  cfg.saveConfig({ count: Number(el.dataset.count) });
  rerenderConfig(el.dataset.id);
});

on(
  'deck-test-count',
  (el) => {
    const v = Number(el.value);
    const out = document.getElementById('deck-test-count-val');
    if (out) out.textContent = String(v);
    const start = document.querySelector ? document.querySelector('[data-action="deck-test-start"]') : null;
    if (start) {
      start.dataset.count = String(v);
      start.textContent = `开始测试 · ${v} 题`;
    }
    cfg.saveConfig({ count: v });
  },
  'input'
);

on('deck-test-start', (el) => startDeckTest(el.dataset.id, Number(el.dataset.count)));

on('deck-test-again', (el) => startDeckTest(el.dataset.id, Number(el.dataset.count)));

/* 错题专项再练：只抽优先池里的错题 */
on('deck-test-wrong', (el) => startDeckTest(el.dataset.id, null, { onlyWrong: true }));

/* 题型比例：恢复默认（已启用题型等比平分；默认 5 种 → 各 20%） */
on('deck-test-weight-reset', (el) => {
  const conf = cfg.loadConfig();
  const next = cfg.resetDefaults(conf.enabled);
  cfg.saveConfig({ weights: next.weights, enabled: next.enabled });
  rerenderConfig(el.dataset.id);
});

/* 启用 / 停用可选题型（英英选择 / 多义多选）：启用后与其余题型等比平分 */
on('deck-test-type-toggle', (el) => {
  const conf = cfg.loadConfig();
  const next = cfg.setTypeEnabled(conf.weights, conf.enabled, el.dataset.type, !!el.checked);
  cfg.saveConfig({ weights: next.weights, enabled: next.enabled });
  rerenderConfig(el.dataset.id);
});

/* 题型比例滑块：调一项，其余**已启用**题型按比例自动分摊（合计 100%） */
on(
  'deck-test-weight',
  (el) => {
    const conf = cfg.loadConfig();
    const weights = cfg.adjustWeights(conf.weights, el.dataset.type, Number(el.value), conf.enabled);
    cfg.saveConfig({ weights });
    cfg.enabledTypeIds(conf.enabled).forEach((t) => {
      const lab = document.getElementById('wt-val-' + t);
      if (lab) lab.textContent = weights[t] + '%';
      if (t !== el.dataset.type) {
        const inp = document.getElementById('wt-input-' + t);
        if (inp) inp.value = String(weights[t]);
      }
    });
    const tot = document.getElementById('wt-total');
    if (tot) tot.textContent = cfg.ALL_TYPES.reduce((s, t) => s + (weights[t] || 0), 0) + '%';
  },
  'input'
);

on('test-back', (el) => {
  const deckId = (T && T.deckId) || (LAST && LAST.deckId) || (el.dataset && el.dataset.id) || '';
  clearSession();
  if (deckId) navigate(`#/deck/${deckId}`);
});

/** 离开测试页：仅释放内存会话；整卡组进度保留（用于「继续上次测试」） */
export function clearTestSession() {
  clearAdvanceTimer();
  stopSpeaking(); // 停止正在播放的发音
  T = null;
  hl = 0;
  hlOn = false;
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch (e) {}
}
