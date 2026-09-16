// ============================================================================
// export.js — 把卡组导出为「标准 txt（TSV）」与「Anki 卡包 .apkg」
//
// 设计：
//   - txt：UTF-8(带 BOM) 制表符分隔，一卡一行：
//          正面 \t 背面 \t 例句 \t 例句翻译 \t 音标 \t 标签(逗号)
//   - apkg：Anki 2.1 兼容的旧版卡包结构（ZIP 内含 collection.anki2 + media）。
//           SQLite 由内置的 sql.js（vendor/sql.js，WASM）生成：col/notes/cards/
//           revlog/graves + Basic 笔记模板；ZIP 由本文件内的最小写出器负责。
//   - 浏览器里首次导出时才懒加载 sql.js（不阻塞启动、离线可用）。
//
// 导出 API：downloadBlob / deckToTxt / deckToApkg / exportDeckTxt / exportDeckApkg
// ============================================================================

import * as store from './store.js';
import { on, toast } from './ui.js';

export const SQL_VENDOR_DIR = 'vendor/sql.js/';
export const SQL_VENDOR_JS = SQL_VENDOR_DIR + 'sql-wasm.js';
export const SQL_VENDOR_WASM = SQL_VENDOR_DIR + 'sql-wasm.wasm';
/** txt 列顺序（表头注释行，便于人读；Anki 导入时可忽略首行） */
export const TXT_COLUMNS = ['front', 'back', 'example', 'exampleZh', 'phonetic', 'tags'];

/* ------------------------------ 下载 ------------------------------ */

/** 触发浏览器下载；非浏览器环境返回 null（便于测试） */
export function downloadBlob(filename, data, mime = 'application/octet-stream') {
  const blob = data && typeof Blob !== 'undefined' && data instanceof Blob ? data : new Blob([data], { type: mime });
  if (
    typeof document === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function' ||
    typeof document.createElement !== 'function'
  ) {
    return null;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  if (document.body && document.body.appendChild) document.body.appendChild(a);
  if (typeof a.click === 'function') a.click();
  if (a.parentNode && a.parentNode.removeChild) a.parentNode.removeChild(a);
  setTimeout(() => {
    try {
      URL.revokeObjectURL(url);
    } catch (e) {}
  }, 1500);
  return { filename, size: blob.size, url };
}

/** 文件名安全化（去掉路径分隔符与首尾空白） */
export function safeFileName(name, fallback = 'mycard') {
  const s = String(name == null ? '' : name)
    .replace(/[\\/:*?"<>|\n\r\t]+/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return s || fallback;
}

/* ------------------------------ txt（TSV） ------------------------------ */

/** 单元格清洗：去制表符 / 换行（避免破坏 TSV 一行一卡） */
export function tsvCell(v) {
  return String(v == null ? '' : v)
    .replace(/[\t\r\n]+/g, ' ')
    .trim();
}

/** 卡片 → txt 行字段（顺序见 TXT_COLUMNS） */
export function cardToTxtRow(card) {
  return [
    tsvCell(card.front),
    tsvCell(card.back),
    tsvCell(card.example),
    tsvCell(card.exampleZh),
    tsvCell(card.phonetic),
    tsvCell((card.tags || []).join(','))
  ];
}

/**
 * 卡组 → 标准 txt（UTF-8 + BOM，制表符分隔；无正面的卡片不输出）
 * @param {object} deck
 * @param {{ header?: boolean }} opts header=true 时输出首行列名
 */
export function deckToTxt(deck, { header = true } = {}) {
  const rows = [];
  if (header) rows.push(TXT_COLUMNS.join('\t'));
  for (const c of (deck && deck.cards) || []) {
    const row = cardToTxtRow(c);
    if (!row[0]) continue; // 没有正面（单词）的卡片不导出
    rows.push(row.join('\t'));
  }
  return '\uFEFF' + rows.join('\r\n') + '\r\n';
}

/* ------------------------------ ZIP（STORED 无压缩） ------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** CRC-32（ZIP 必需） */
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const enc = (s) => new TextEncoder().encode(String(s));

/** 写小端整数 */
function u16(n) {
  return [n & 0xff, (n >>> 8) & 0xff];
}
function u32(n) {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

/** DOS 时间/日期（固定为 1980-01-01 00:00，保证可复现） */
const DOS_TIME = 0;
const DOS_DATE = 33; // 1980-01-01

/**
 * 最小 ZIP 写出器（仅 STORED，符合 PKZIP 规范；Anki / 系统解压均可打开）
 * @param {Array<{name:string, data:Uint8Array|string}>} entries
 * @returns {Uint8Array}
 */
export function zipStore(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc(e.name);
    const data = typeof e.data === 'string' ? enc(e.data) : e.data;
    const crc = crc32(data);

    const local = [
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0x0800), // UTF-8 文件名
      ...u16(0), // method = stored
      ...u16(DOS_TIME),
      ...u16(DOS_DATE),
      ...u32(crc),
      ...u32(data.length),
      ...u32(data.length),
      ...u16(nameBytes.length),
      ...u16(0)
    ];
    locals.push(new Uint8Array(local), nameBytes, data);

    centrals.push(
      new Uint8Array([
        ...u32(0x02014b50),
        ...u16(20),
        ...u16(20),
        ...u16(0x0800),
        ...u16(0),
        ...u16(DOS_TIME),
        ...u16(DOS_DATE),
        ...u32(crc),
        ...u32(data.length),
        ...u32(data.length),
        ...u16(nameBytes.length),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(offset),
        ...nameBytes
      ])
    );
    offset += local.length + nameBytes.length + data.length;
  }

  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = new Uint8Array([
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(centrals.length),
    ...u16(centrals.length),
    ...u32(cdSize),
    ...u32(offset),
    ...u16(0)
  ]);

  const parts = [...locals, ...centrals, eocd];
  const total = parts.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const b of parts) {
    out.set(b, p);
    p += b.length;
  }
  return out;
}

/* ------------------------------ Anki 卡包（.apkg） ------------------------------ */

/** Anki 2.1 的 collection.anki2 表结构（导入所需的全部表与索引） */
export const ANKI_SCHEMA = `
CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null,
  ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null,
  models text not null, decks text not null, dconf text not null, tags text not null);
CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null,
  usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null,
  flags integer not null, data text not null);
CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null,
  mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null,
  ivl integer not null, factor integer not null, reps integer not null, lapses integer not null,
  left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null);
CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null,
  ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_usn on notes (usn);
CREATE INDEX ix_cards_usn on cards (usn);
CREATE INDEX ix_cards_nid on cards (nid);
CREATE INDEX ix_cards_sched on cards (did, queue, due);
CREATE INDEX ix_revlog_usn on revlog (usn);
CREATE INDEX ix_revlog_cid on revlog (cid);
CREATE INDEX ix_notes_csum on notes (csum);
`;

/** Anki 字段是 HTML：转义 + 换行转 <br> */
export function ankiHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n+/g, '<br>');
}

/** 纯文本（用于 sfld：Anki 的排序 / 查重字段） */
export function plainText(text) {
  return String(text == null ? '' : text)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Anki 标签：不能含空格 / 引号 */
export function ankiTag(t) {
  return String(t == null ? '' : t)
    .replace(/["']/g, '')
    .replace(/\s+/g, '_')
    .trim();
}

/** 卡片 → Anki 两个字段（Front / Back） */
export function cardToAnkiFields(card) {
  const front = ankiHtml(card.front) + (card.phonetic ? `<br><span style="color:#7c8399">${ankiHtml(card.phonetic)}</span>` : '');
  const backParts = [ankiHtml(card.back)];
  for (const extra of card.extraBacks || []) if (extra) backParts.push(ankiHtml(extra));
  if (card.example || card.exampleZh) {
    backParts.push(
      `<div style="margin-top:8px;color:#666;font-style:italic">${ankiHtml(card.example)}${
        card.exampleZh ? `<br>${ankiHtml(card.exampleZh)}` : ''
      }</div>`
    );
  }
  return [front, backParts.join('<br>')];
}

/** SHA-1（用于 notes.csum；无 crypto 时返回空串） */
export async function sha1Hex(text) {
  const data = new TextEncoder().encode(String(text == null ? '' : text));
  if (typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.digest === 'function') {
    try {
      const buf = await crypto.subtle.digest('SHA-1', data);
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {}
  }
  return '';
}

/** 随机 guid（Anki 只需唯一字符串） */
export function ankiGuid() {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let s = '';
  for (const b of bytes) s += b.toString(36).padStart(2, '0');
  return s.slice(0, 10);
}

/** Anki 的「当天 4 点」时间戳（秒）：day rollover 基准 */
export function ankiCreationTime(now = Date.now()) {
  const d = new Date(now);
  d.setHours(4, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/** Basic 笔记模板（models JSON） */
export function basicModel(mid, deckId, now) {
  return {
    [mid]: {
      id: mid,
      name: 'Basic',
      type: 0,
      mod: Math.floor(now / 1000),
      usn: 0,
      sortf: 0,
      did: deckId,
      tmpls: [
        {
          name: 'Card 1',
          ord: 0,
          qfmt: '{{Front}}',
          afmt: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}',
          bqfmt: '',
          bafmt: '',
          did: null,
          bfont: '',
          bsize: 0
        }
      ],
      flds: [
        { name: 'Front', ord: 0, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] },
        { name: 'Back', ord: 1, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] }
      ],
      css: '.card { font-family: arial; font-size: 20px; text-align: center; color: #171a2b; background-color: #f4f5fa; }',
      latexPre:
        '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n',
      latexPost: '\\end{document}',
      req: [[0, 'all', [0]]],
      tags: [],
      vers: []
    }
  };
}

/** decks JSON（卡组名沿用应用里的名称） */
export function decksJson(deckId, name, now) {
  return {
    [deckId]: {
      id: deckId,
      name: name || 'Mycard',
      mod: Math.floor(now / 1000),
      usn: 0,
      desc: '',
      dyn: 0,
      collapsed: false,
      browserCollapsed: false,
      newToday: [0, 0],
      revToday: [0, 0],
      lrnToday: [0, 0],
      timeToday: [0, 0],
      conf: 1,
      extConf: {},
      maxTaken: 0
    }
  };
}

/** dconf JSON（Anki 默认卡组配置） */
export function dconfJson(now) {
  return {
    1: {
      id: 1,
      name: 'Default',
      mod: Math.floor(now / 1000),
      usn: 0,
      maxTaken: 60,
      autoplay: true,
      timer: 0,
      replayq: true,
      lapse: { delays: [10], leechFails: 8, leechAction: 1, minInt: 1, mult: 0 },
      rev: { perDay: 200, ease4: 1.3, maxIvl: 36500, hardFactor: 1.2, fuzz: 0.05, minSpace: 1, ivlFct: 1, bury: false },
      new: { perDay: 20, delays: [1, 10], ints: [1, 4, 7], initialFactor: 2500, order: 1, bury: false, separate: true }
    }
  };
}

/** col.conf（Anki 全局配置，最小可用集合） */
export function colConfJson(mid, deckId) {
  return {
    nextPos: 1,
    estTimes: true,
    activeDecks: [deckId],
    sortType: 'noteFld',
    timeLim: 0,
    sortBackwards: false,
    addToCur: true,
    curDeck: deckId,
    newBury: true,
    newSpread: 0,
    dueCounts: true,
    curModel: String(mid),
    collapseTime: 1200
  };
}

/* ------------------------------ 生成 collection.anki2 / .apkg ------------------------------ */

/** 用 sql.js 生成 collection.anki2 字节（Anki 2.1 可导入） */
export async function buildCollection(deck, { SQL, deckName, now = Date.now() } = {}) {
  if (!SQL || typeof SQL.Database !== 'function') throw new Error('sql.js 未就绪');
  const cards = ((deck && deck.cards) || []).filter((c) => String(c.front || '').trim());
  const name = safeFileName(deckName || (deck && deck.name) || 'Mycard', 'Mycard');
  const secs = Math.floor(now / 1000);
  const mid = 1650000000000 + (now % 100000000);
  const deckId = 1;

  const db = new SQL.Database();
  db.run(ANKI_SCHEMA);
  db.run('INSERT INTO col VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [
    1,
    ankiCreationTime(now),
    secs,
    secs,
    11, // schema version（Anki 2.1）
    0,
    0,
    0,
    JSON.stringify(colConfJson(mid, deckId)),
    JSON.stringify(basicModel(mid, deckId, now)),
    JSON.stringify(decksJson(deckId, name, now)),
    JSON.stringify(dconfJson(now)),
    '{}'
  ]);

  const base = now;
  db.run('BEGIN');
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    const [front, back] = cardToAnkiFields(c);
    const sfld = plainText(c.front) || `note ${i + 1}`;
    const hex = await sha1Hex(sfld);
    const csum = hex ? parseInt(hex.slice(0, 8), 16) : 0;
    const tags = (c.tags || []).map(ankiTag).filter(Boolean);
    const noteId = base + i;
    const cardId = base + 100000 + i;
    db.run('INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)', [
      noteId,
      ankiGuid(),
      mid,
      secs,
      0,
      tags.length ? ' ' + tags.join(' ') + ' ' : '',
      `${front}\u001f${back}`,
      sfld,
      csum,
      0,
      ''
    ]);
    db.run('INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [
      cardId,
      noteId,
      deckId,
      0,
      secs,
      0,
      0, // type：新卡
      0, // queue：新卡
      i + 1, // due：新卡顺序
      0,
      2500,
      0,
      0,
      0,
      0,
      0,
      0,
      ''
    ]);
  }
  db.run('COMMIT');

  const bytes = db.export(); // Uint8Array
  if (typeof db.close === 'function') db.close();
  return bytes;
}

/** 懒加载 sql.js（浏览器：注入官方 UMD 构建；测试可用 __setSqlJs 注入） */
let sqlJsPromise = null;

function injectScript(src) {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
      reject(new Error('当前环境无法加载 sql.js'));
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve(true);
    s.onerror = () => reject(new Error('加载失败：' + src));
    const host = document.head || document.body;
    if (host && host.appendChild) host.appendChild(s);
    else reject(new Error('无 document.head/body'));
  });
}

export async function ensureSqlJs({ vendorDir = SQL_VENDOR_DIR } = {}) {
  if (sqlJsPromise) return sqlJsPromise;
  sqlJsPromise = (async () => {
    const g = typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : {};
    if (typeof g.initSqlJs !== 'function') await injectScript(vendorDir + 'sql-wasm.js');
    if (typeof g.initSqlJs !== 'function') throw new Error('sql.js 未加载成功（vendor/sql.js）');
    return g.initSqlJs({ locateFile: (f) => vendorDir + f });
  })();
  sqlJsPromise.catch(() => {
    sqlJsPromise = null; // 失败允许重试
  });
  return sqlJsPromise;
}

/** 测试 / 特殊环境注入已初始化的 sql.js 模块 */
export function __setSqlJs(SQL) {
  sqlJsPromise = SQL ? Promise.resolve(SQL) : null;
  return sqlJsPromise;
}

/** 卡组 → .apkg 字节（ZIP：collection.anki2 + media） */
export async function deckToApkg(deck, opts = {}) {
  const SQL = opts.SQL || (await ensureSqlJs(opts));
  const collection = await buildCollection(deck, { ...opts, SQL });
  return zipStore([
    { name: 'collection.anki2', data: collection },
    { name: 'media', data: '{}' }
  ]);
}

/* ------------------------------ 导出入口 ------------------------------ */

/** 导出卡组为 txt 并触发下载 */
export function exportDeckTxt(deckId) {
  const deck = store.getDeck(deckId);
  if (!deck) {
    toast('卡组不存在', 'error');
    return null;
  }
  const n = (deck.cards || []).length;
  if (!n) {
    toast('这个卡组还没有卡片', 'warn');
    return null;
  }
  const text = deckToTxt(deck);
  const filename = safeFileName(deck.name, 'mycard') + '.txt';
  const res = downloadBlob(filename, text, 'text/tab-separated-values;charset=utf-8');
  toast(`已导出 ${n} 张卡片 → ${filename}`, 'good');
  return { filename, text, size: res ? res.size : text.length };
}

/** 导出卡组为 Anki 卡包（.apkg）并触发下载 */
export async function exportDeckApkg(deckId) {
  const deck = store.getDeck(deckId);
  if (!deck) {
    toast('卡组不存在', 'error');
    return null;
  }
  const n = (deck.cards || []).length;
  if (!n) {
    toast('这个卡组还没有卡片', 'warn');
    return null;
  }
  toast(`正在打包「${deck.name}」（${n} 张）…`);
  try {
    const bytes = await deckToApkg(deck);
    const filename = safeFileName(deck.name, 'mycard') + '.apkg';
    const res = downloadBlob(filename, bytes, 'application/octet-stream');
    toast(`已导出 Anki 卡包 ${filename}（${n} 张）`, 'good');
    return { filename, bytes, size: res ? res.size : bytes.length };
  } catch (e) {
    console.error(e);
    toast(`导出失败：${(e && e.message) || e}`, 'error');
    return null;
  }
}

on('export-txt', (el) => {
  exportDeckTxt(el.dataset && el.dataset.id);
});

on('export-apkg', (el) => {
  exportDeckApkg(el.dataset && el.dataset.id);
});
