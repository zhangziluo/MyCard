// ============================================================================
// add-words.js — 首页「添加单词/词表」：在线查词 → 预览 → 加入「我的生词」卡组
//
// 三种输入模式（自动判断）：
//   1) 单行一个词      → 在线查词典 → 预览卡片 → 「确认加入」
//   2) 多行每行一个词  → 批量查（≤1000，100ms 限速 + 进度）→ 来源预览 → 确认加入
//   3) 大段文本        → 分词去重 → 勾选候选 → 查词 → 确认加入
//
// 语种：按字符范围自动判断（ja / el / de / fr / en），日语走 Jisho，其余走 Free Dictionary。
// 缓存：IndexedDB `lookup` store，key = `${lang}_${word}`；批量查词前先查缓存。
// 落库：确认后写入现有卡组的「我的生词」（store.addWords → IndexedDB），
//       首义 → back，其余义 → extraBacks（因此新词天然支持「多义多选」题型）。
// ============================================================================

import * as idb from './idb.js';
import * as store from './store.js';
import { esc, on, toast, navigate } from './ui.js';

export const RATE_LIMIT_MS = 100;
export const MAX_BATCH = 1000;
export const ADD_PLACEHOLDER = '输入单词查释义，或粘贴词表（每行一个）...';

/* ------------------------------ 语种检测 ------------------------------ */

const LANG_CHARS = {
  han: /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/,
  kana: /[\u3040-\u30ff]/,
  greek: /[\u0370-\u03ff\u1f00-\u1fff]/,
  de: /[äöüßÄÖÜ]/,
  fr: /[àâäéèêëïîôöùûüÿçœæ]/i
};

/** 基于字符范围判断语种（无需外部库） */
export function detectLang(text) {
  const s = String(text || '');
  if (LANG_CHARS.han.test(s) || LANG_CHARS.kana.test(s)) return 'ja';
  if (LANG_CHARS.greek.test(s)) return 'el';
  if (LANG_CHARS.de.test(s)) return 'de';
  if (LANG_CHARS.fr.test(s)) return 'fr';
  return 'en';
}

/* ------------------------------ 输入分词 / 分类 ------------------------------ */

const WORD_RE = /[0-9A-Za-z\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff'’-]+/g;

/** 大段文本 → 候选单词（按空格/标点切分、去重、过滤明显非单词的 token） */
export function tokenize(text) {
  const src = String(text || '').replace(/[’]/g, "'");
  const raw = src.match(WORD_RE) || [];
  const out = [];
  const seen = new Set();
  for (let t of raw) {
    t = t.replace(/^[-']+|[-']+$/g, '').trim();
    if (!t) continue;
    const isCjk = /[\u3400-\u9fff\u3040-\u30ff]/.test(t);
    if (!isCjk && t.length < 2) continue; // 丢弃孤立单字母
    if (t.length > 40) continue;
    if (/^\d+$/.test(t)) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** 判断一行是否「像个词/短语」（无句末标点、词数 ≤3、长度 ≤40） */
export function looksLikeWord(line) {
  const s = String(line || '').trim();
  if (!s || s.length > 40) return false;
  if (/[.!?;。！？；，、]/.test(s)) return false;
  const tokens = tokenize(s);
  return tokens.length === 1 || (tokens.length <= 3 && tokens.join('').length >= s.replace(/\s+/g, '').length - 2);
}

/**
 * 判断输入模式：
 *   single 单行一个词 / list 多行每行一个词（≤1000） / text 大段文本 / empty
 */
export function classifyInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return { mode: 'empty', items: [], text };
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 1) {
    return looksLikeWord(lines[0]) ? { mode: 'single', items: [lines[0]], text } : { mode: 'text', items: [], text };
  }
  if (lines.length <= MAX_BATCH && lines.every(looksLikeWord)) {
    return { mode: 'list', items: lines, text };
  }
  return { mode: 'text', items: [], text };
}

/* ------------------------------ 查词缓存（IndexedDB） ------------------------------ */

export function cacheKey(lang, word) {
  return `${lang}_${String(word || '').trim().toLowerCase()}`;
}

export async function getCached(lang, word) {
  try {
    const rec = await idb.get(idb.STORE_LOOKUP, cacheKey(lang, word));
    return rec && rec.card ? rec.card : null;
  } catch (e) {
    return null;
  }
}

export async function putCached(lang, word, card) {
  try {
    await idb.put(idb.STORE_LOOKUP, { key: cacheKey(lang, word), lang, word: String(word), card, at: Date.now() });
  } catch (e) {}
}

/* ------------------------------ 词典 API ------------------------------ */

export const freeDictUrl = (lang, word) =>
  `https://api.dictionaryapi.dev/api/v2/entries/${encodeURIComponent(lang)}/${encodeURIComponent(word)}`;
export const jishoUrl = (word) => `https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(word)}`;

/** Free Dictionary API 响应 → 卡片（纯函数） */
export function cardFromFreeDict(lang, word, payload) {
  const entry = Array.isArray(payload) ? payload[0] : null;
  if (!entry) return null;
  const senses = [];
  for (const m of entry.meanings || []) {
    const pos = String(m.partOfSpeech || '').trim();
    for (const d of m.definitions || []) {
      const gloss = String((d && d.definition) || '').trim();
      if (!gloss) continue;
      senses.push({ pos, gloss });
      if (senses.length >= 6) break;
    }
    if (senses.length >= 6) break;
  }
  if (!senses.length) return null;
  const phonetics = Array.isArray(entry.phonetics) ? entry.phonetics : [];
  const ipa = String(entry.phonetic || phonetics.map((p) => p && p.text).find(Boolean) || '').trim();
  let example = '';
  for (const m of entry.meanings || []) {
    for (const d of m.definitions || []) {
      if (d && d.example) {
        example = String(d.example).trim();
        break;
      }
    }
    if (example) break;
  }
  return { word: String(entry.word || word), ipa, senses, example, level: 'custom', src: 'online_lookup', lang, added_at: Date.now() };
}

/** Jisho API 响应 → 卡片（纯函数，日语） */
export function cardFromJisho(word, payload) {
  const row = payload && Array.isArray(payload.data) ? payload.data[0] : null;
  if (!row) return null;
  const jp = (row.japanese || [])[0] || {};
  const surfaced = String(jp.word || jp.reading || word).trim();
  const senses = [];
  for (const s of row.senses || []) {
    const gloss = (s && Array.isArray(s.english_definitions) ? s.english_definitions : []).join('; ').trim();
    if (!gloss) continue;
    const pos = (s.parts_of_speech || []).join(', ');
    senses.push({ pos, gloss });
    if (senses.length >= 6) break;
  }
  if (!senses.length) return null;
  return {
    word: surfaced || String(word),
    ipa: String(jp.reading || '').trim(),
    senses,
    example: '',
    level: 'custom',
    src: 'online_lookup',
    lang: 'ja',
    added_at: Date.now()
  };
}

/* ------------------------------ 查询（限速 / 重试） ------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 查一个词（先查缓存；失败自动重试一次）。
 * @returns {{ card:object|null, cached:boolean, notFound?:boolean, error?:string }}
 */
export async function lookupWord(lang, word, { useCache = true, fetchImpl = null, retries = 1 } = {}) {
  const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
  if (!doFetch) return { card: null, cached: false, error: 'no-fetch' };
  const code = lang || detectLang(word);
  if (useCache) {
    const hit = await getCached(code, word);
    if (hit) return { card: hit, cached: true };
  }
  const url = code === 'ja' ? jishoUrl(word) : freeDictUrl(code, word);
  let lastErr = 'error';
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await doFetch(url, { headers: { Accept: 'application/json' } });
      if (resp.status === 404) return { card: null, cached: false, notFound: true };
      if (!resp.ok) {
        lastErr = `HTTP ${resp.status}`;
      } else {
        const payload = await resp.json();
        const card = code === 'ja' ? cardFromJisho(word, payload) : cardFromFreeDict(code, word, payload);
        if (!card) return { card: null, cached: false, notFound: true };
        card.lang = code;
        await putCached(code, card.word, card);
        if (card.word !== word) await putCached(code, word, card); // 词形变化（日语的活用形等）也缓存
        return { card, cached: false };
      }
    } catch (e) {
      lastErr = String((e && e.message) || e);
    }
    if (attempt < retries) await sleep(RATE_LIMIT_MS); // 重试前同样限速
  }
  return { card: null, cached: false, error: lastErr };
}

/**
 * 批量查词：命中缓存直接使用；未命中的按 100ms 间隔请求（可注入 fetch 便于测试）。
 * @param {string[]} words
 * @returns {{ cards:object[], failed:string[], cached:number, fromNet:number }}
 */
export async function lookupBatch(words, { lang = null, onProgress = null, fetchImpl = null, gapMs = RATE_LIMIT_MS } = {}) {
  const list = [...new Set((words || []).map((w) => String(w || '').trim()).filter(Boolean))];
  const cards = [];
  const failed = [];
  let cached = 0;
  let fromNet = 0;
  let lastNet = 0;
  for (let i = 0; i < list.length; i++) {
    const word = list[i];
    const code = lang || detectLang(word);
    const hit = await getCached(code, word);
    if (hit) {
      cards.push(hit);
      cached += 1;
    } else {
      const wait = gapMs - (Date.now() - lastNet);
      if (lastNet && wait > 0) await sleep(wait); // 请求间隔 ≥ 100ms
      lastNet = Date.now();
      const res = await lookupWord(code, word, { useCache: false, fetchImpl });
      if (res.card) {
        cards.push(res.card);
        fromNet += 1;
      } else {
        failed.push(word);
      }
    }
    if (onProgress) onProgress({ done: i + 1, total: list.length, word, cached: !!hit });
  }
  return { cards, failed, cached, fromNet };
}

/* ------------------------------ 卡片 → 卡组条目 ------------------------------ */

/** spec 卡片 → 应用卡片字段：首义 → back，其余义 → extraBacks（支持多义多选） */
export function cardToDeckItem(card, lang = null) {
  const senses = (card && card.senses ? card.senses : []).filter((s) => s && s.gloss);
  const fmt = (s) => `${s.pos ? String(s.pos).replace(/\.$/, '') + '. ' : ''}${s.gloss}`.trim();
  const first = senses[0];
  return {
    front: String((card && card.word) || '').trim(),
    back: first ? fmt(first) : '',
    extraBacks: senses.slice(1).map(fmt),
    phonetic: String((card && (card.ipa || card.phonetic)) || ''),
    example: (card && card.example) || '',
    exampleZh: '',
    tags: lang ? [lang] : []
  };
}

/**
 * 把查词结果加入「我的生词」卡组（去重，不覆盖已有词）。
 * v0.5.9：面板上的「重复时合并释义」开关打开时（默认），已存在的词不跳过，
 *        而是把新释义 / 例句 / 标签合并进原卡片（原 back 仍是第一义，进度不动）。
 */
export function commitCards(cards, src = 'online_lookup') {
  const items = (cards || [])
    .filter(Boolean)
    .map((c) => Object.assign(cardToDeckItem(c, c.lang), { src }));
  return store.addWords(items, { src, merge: AW.merge });
}

/* ============================== 首页面板 UI ============================== */

const MERGE_PREF_KEY = 'mycard-aw-merge';

/** 「重复时合并释义」偏好（默认开）：老卡片里同一个词的多个释义会被合并，而不是直接跳过 */
export function loadMergePref() {
  try {
    const v = localStorage.getItem(MERGE_PREF_KEY);
    return v == null ? true : v === '1';
  } catch (e) {
    return true;
  }
}

export function saveMergePref(on_) {
  try {
    localStorage.setItem(MERGE_PREF_KEY, on_ ? '1' : '0');
  } catch (e) {}
}

const AW = {
  mode: 'empty', // empty | single | list | text
  busy: false,
  merge: loadMergePref(), // 重复词：true 合并释义 / false 跳过
  candidates: [], // text 模式候选词
  selected: new Set(), // 已勾选的候选
  cards: [], // 查到的卡片
  failed: [], // 未查到的词
  cached: 0,
  fromNet: 0,
  progress: null // { done, total, word }
};

/** 等待被「在线补查 / 整理生词本」填入查词框的词（面板渲染时一次性消费） */
let pendingPrefill = null;

/**
 * 预填查词框（生词本整理页的「在线补查」用）。
 * 面板已经渲染 → 直接写入；尚未渲染（例如先调用再跳转 #/home）→ 暂存，等 addWordsPanelHtml() 消费。
 * @returns {number} 实际填入的词数
 */
export function prefillInput(words, { merge = true } = {}) {
  const list = (words || [])
    .map((w) => String(w == null ? '' : w).trim())
    .filter(Boolean)
    .filter((w, i, arr) => arr.indexOf(w) === i);
  if (!list.length) return 0;
  pendingPrefill = { words: list, merge: !!merge };
  AW.mode = 'empty';
  applyPrefill();
  return list.length;
}

/** 把暂存的预填词写入已渲染的查词框（返回是否已消费） */
function applyPrefill() {
  if (!pendingPrefill) return false;
  const ta = byId('add-words-input');
  if (!ta) return false; // 面板还没渲染：留给 addWordsPanelHtml() 消费
  ta.value = pendingPrefill.words.join('\n');
  AW.merge = pendingPrefill.merge;
  const box = byId('aw-merge-box');
  if (box) box.checked = AW.merge;
  pendingPrefill = null;
  resetPanel(false); // 清掉上一次的预览（保留刚写入的输入）
  return true;
}

export function addWordsPanelHtml() {
  // 生词本整理页「在线补查」预填：把待查词直接渲染进输入框（一次性消费）
  const pre = pendingPrefill;
  pendingPrefill = null;
  if (pre) AW.merge = pre.merge;
  const preValue = pre && pre.words.length ? esc(pre.words.join('\n')) : '';
  return `
  <section class="add-words glass" id="add-words">
    <div class="add-words-head">
      <h2 class="screen-title">添加单词</h2>
      <span class="sub-note">在线查词 · 加入「${esc(store.USER_DECK_NAME)}」</span>
    </div>
    <textarea id="add-words-input" class="add-words-input" rows="3" placeholder="${esc(ADD_PLACEHOLDER)}"
      spellcheck="false" autocomplete="off" autocapitalize="off">${preValue}</textarea>
    <div class="add-words-bar">
      <span class="aw-hint" id="aw-hint">${esc(HINT_TEXT)}</span>
      <label class="aw-merge" title="已存在的词不跳过：把新释义合并进原卡片（旧释义仍在，学习进度不变）">
        <input type="checkbox" id="aw-merge-box" data-action="aw-merge"${AW.merge ? ' checked' : ''}>
        <span>重复时合并释义</span>
      </label>
      <button class="btn btn-primary" data-action="aw-submit" id="aw-submit">添加</button>
    </div>
    <div class="preview-area" id="aw-preview">${previewHtml()}</div>
  </section>`;
}

const HINT_TEXT = '支持：单个单词 / 每行一个词（≤1000）/ 大段文本自动分词';

function previewHtml() {
  if (AW.busy) {
    const p = AW.progress || { done: 0, total: 0 };
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    return `<div class="aw-progress">
      <div class="progress-track"><i class="progress-fill" style="width:${pct}%"></i></div>
      <p class="aw-progress-text">已处理 ${p.done}/${p.total}${p.word ? ' · ' + esc(p.word) : ''}</p>
    </div>`;
  }
  if (AW.mode === 'text' && AW.candidates.length) {
    return `<div class="aw-tokens">
      <p class="aw-section">识别到 ${AW.candidates.length} 个候选词，勾选后点「查词」：</p>
      <div class="aw-token-list">${AW.candidates
        .map(
          (w) =>
            `<button class="aw-token${AW.selected.has(w) ? ' is-on' : ''}" data-action="aw-token" data-word="${esc(w)}"
               aria-pressed="${AW.selected.has(w) ? 'true' : 'false'}">${esc(w)}</button>`
        )
        .join('')}</div>
      <div class="aw-row">
        <button class="btn-link" data-action="aw-select-all">全选</button>
        <button class="btn-link" data-action="aw-select-none">全不选</button>
        <button class="btn btn-primary" data-action="aw-lookup-selected">查词（已选 ${AW.selected.size}）</button>
      </div>
    </div>`;
  }
  if (AW.cards.length) {
    const src = AW.mode === 'list' ? 'batch_import' : 'online_lookup';
    const msg = [`查到 ${AW.cards.length} 个词`];
    if (AW.cached) msg.push(`缓存命中 ${AW.cached}`);
    if (AW.fromNet) msg.push(`在线查询 ${AW.fromNet}`);
    return `<div class="aw-preview">
      <p class="aw-section">${esc(msg.join(' · '))}：</p>
      <ul class="aw-card-list">${AW.cards
        .map(
          (c) => `<li class="aw-card">
          <div class="aw-card-top"><b>${esc(c.word)}</b>${c.ipa ? `<span class="aw-ipa">${esc(c.ipa)}</span>` : ''}</div>
          <div class="aw-card-body">${(c.senses || [])
            .map((s) => `<span class="aw-sense">${esc(`${s.pos ? String(s.pos).replace(/\.$/, '') + '. ' : ''}${s.gloss}`)}</span>`)
            .join('')}</div>
        </li>`
        )
        .join('')}</ul>
      ${failedHtml()}
      <div class="aw-row">
        <button class="btn btn-primary btn-block" data-action="aw-confirm" data-src="${src}">确认加入「${esc(store.USER_DECK_NAME)}」</button>
      </div>
    </div>`;
  }
  return failedHtml();
}

function failedHtml() {
  if (!AW.failed.length) return '';
  return `<p class="aw-failed">未查到 ${AW.failed.length} 个词：${esc(AW.failed.slice(0, 20).join(', '))}${AW.failed.length > 20 ? ' …' : ''}</p>`;
}

/* ------------------------------ 交互流程 ------------------------------ */

function byId(id) {
  return typeof document !== 'undefined' && document.getElementById ? document.getElementById(id) : null;
}

function renderPreview() {
  const box = byId('aw-preview');
  if (box) box.innerHTML = previewHtml();
  const hint = byId('aw-hint');
  if (hint) hint.textContent = HINT_TEXT;
}

/** 复位面板（可选清空输入框） */
export function resetPanel(clearInput = true) {
  AW.mode = 'empty';
  AW.busy = false;
  AW.candidates = [];
  AW.selected = new Set();
  AW.cards = [];
  AW.failed = [];
  AW.cached = 0;
  AW.fromNet = 0;
  AW.progress = null;
  if (clearInput) {
    const ta = byId('add-words-input');
    if (ta) ta.value = '';
  }
  renderPreview();
}

/** 面板状态快照（测试用） */
export function getPanelState() {
  return { mode: AW.mode, busy: AW.busy, merge: !!AW.merge, candidates: [...AW.candidates], selected: [...AW.selected], cards: [...AW.cards], failed: [...AW.failed] };
}

export function isBusy() {
  return AW.busy;
}

/** 点「添加」：自动判断模式并分发（单词语 / 词表 / 大段文本） */
export async function submitInput(opts = {}) {
  if (AW.busy) {
    toast('正在查询中，请稍候…', 'warn');
    return { mode: 'busy' };
  }
  const ta = byId('add-words-input');
  const text = ta ? String(ta.value || '') : '';
  const info = classifyInput(text);
  AW.cards = [];
  AW.failed = [];
  AW.cached = 0;
  AW.fromNet = 0;
  AW.progress = null;
  if (info.mode === 'empty') {
    toast('请输入单词或词表', 'warn');
    return { mode: 'empty' };
  }
  if (info.mode === 'text') {
    const cands = tokenize(text);
    if (!cands.length) {
      toast('没识别出候选词，请检查输入', 'warn');
      renderPreview();
      return { mode: 'text', candidates: 0 };
    }
    AW.mode = 'text';
    AW.candidates = cands;
    AW.selected = new Set(cands.slice(0, 50)); // 默认勾选前 50 个，减少手动操作
    renderPreview();
    return { mode: 'text', candidates: cands.length };
  }
  return runLookup(info.mode === 'single' ? [info.items[0]] : info.items, opts);
}

/** 逐个查词（含进度与限速），结果写入面板状态 */
export async function runLookup(words, opts = {}) {
  const list = (words || []).slice(0, MAX_BATCH);
  if (!list.length) return { cards: [], failed: [], cached: 0, fromNet: 0 };
  AW.mode = list.length > 1 ? 'list' : 'single';
  AW.busy = true;
  AW.progress = { done: 0, total: list.length };
  AW.cards = [];
  AW.failed = [];
  renderPreview();
  let res;
  try {
    res = await lookupBatch(list, {
      ...opts,
      onProgress: (p) => {
        AW.progress = p;
        renderPreview();
      }
    });
  } finally {
    AW.busy = false;
    AW.progress = null;
  }
  AW.cards = res.cards;
  AW.failed = res.failed;
  AW.cached = res.cached;
  AW.fromNet = res.fromNet;
  if (res.cards.length) {
    const extra = res.failed.length ? `，${res.failed.length} 个未查到` : '';
    toast(res.fromNet ? `已查到 ${res.cards.length} 个词${extra}` : `已查到 ${res.cards.length} 个词（全部来自缓存）${extra}`, 'good');
  } else {
    toast('没有查到释义，请检查拼写或网络', 'error');
  }
  renderPreview();
  return res;
}

/** 确认加入「我的生词」卡组 */
export function confirmAdd(src = 'online_lookup') {
  if (!AW.cards.length) return null;
  const res = commitCards(AW.cards, src);
  const merged = res.merged || 0;
  if (res.added || merged) {
    const parts = [`新增 ${res.added} 个`];
    if (merged) parts.push(`合并释义 ${merged} 个`);
    if (res.skipped) parts.push(`跳过重复 ${res.skipped} 个`);
    toast(`已更新「${store.USER_DECK_NAME}」：${parts.join(' · ')}`, 'good');
  } else {
    toast(`这些词都已在「${store.USER_DECK_NAME}」中，已跳过 ${res.skipped} 个`, 'warn');
  }
  resetPanel(true);
  navigate('#/home'); // 重新渲染首页：生词卡组会出现在列表中
  return res;
}

/* ------------------------------ 事件注册 ------------------------------ */

on('aw-submit', () => {
  submitInput();
});

// 「重复时合并释义」开关（记忆到本机，下次打开保持）
on(
  'aw-merge',
  (el) => {
    AW.merge = !!(el && el.checked);
    saveMergePref(AW.merge);
    toast(AW.merge ? '重复词将合并释义进原卡片（进度不变）' : '重复词将直接跳过', 'info');
  },
  'change'
);

/** 面板状态里的合并开关（测试用） */
export function isMergeEnabled() {
  return !!AW.merge;
}

/** 暂存的预填词（测试用，不消费状态） */
export function peekPendingPrefill() {
  return pendingPrefill ? { words: [...pendingPrefill.words], merge: pendingPrefill.merge } : null;
}

on('aw-token', (btn) => {
  const w = btn && btn.dataset ? btn.dataset.word : '';
  if (!w) return;
  if (AW.selected.has(w)) AW.selected.delete(w);
  else AW.selected.add(w);
  renderPreview();
});

on('aw-select-all', () => {
  AW.selected = new Set(AW.candidates);
  renderPreview();
});

on('aw-select-none', () => {
  AW.selected = new Set();
  renderPreview();
});

on('aw-lookup-selected', () => {
  runLookup([...AW.selected]);
});

on('aw-confirm', (btn) => {
  confirmAdd((btn && btn.dataset && btn.dataset.src) || 'online_lookup');
});




