// ============================================================================
// export.js — 把卡组导出为「标准 txt（TSV）」「CSV（带表头）」「Markdown」
//             「JSON（完整，含复习进度）」与「Anki 卡包 .apkg」
//
// 设计：
//   - txt：UTF-8(带 BOM) 制表符分隔，一卡一行：
//          正面 \t 背面 \t 例句 \t 例句翻译 \t 音标 \t 标签(逗号)
//   - csv：UTF-8(带 BOM) 逗号分隔（RFC 4180：含 , " 换行的字段用双引号包裹、
//          内部 " 加倍），首行为列名，行尾 CRLF（Excel / 表格工具友好）
//   - md：Markdown 表格（首行 # 卡组名 + 表头 + |---|---| 分隔行），
//          单元格内 | 转义为 \|、换行转 <br>
//   - apkg：Anki 2.1 兼容的旧版卡包结构（ZIP 内含 collection.anki2 + media + meta）。
//           SQLite 由内置的 sql.js（vendor/sql.js，WASM）生成：col/notes/cards/
//           revlog/graves + Basic 笔记模板；ZIP 由本文件内的最小写出器负责。
//           `meta` 为新版 Anki（≥2.1.50）要求的 PackageMetadata protobuf：
//           version = LEGACY_1(1)，与 collection.anki2 + schema v11 自洽；
//           新版 Anki 读到 meta 不再报错，老版 Anki 忽略该条目仍读 collection.anki2。
//   - json：内容 + 复习进度 + 卡组元信息（与导入侧 parseImportJson 结构兼容，
//           可「导出 → 导入」无损往返；见 deckToJson）
//   - 复习进度：txt/csv/md 为「词表」不含调度；apkg 的 cards 表按 cardToAnkiSched
//           映射 state/repetitions/interval/easeFactor/due（Anki 侧可直接续学）
//   - 浏览器里首次导出时才懒加载 sql.js（不阻塞启动、离线可用）。
//
// 导出 API：downloadBlob / deckToTxt / deckToCsv / deckToMarkdown / deckToJson /
//           deckToApkg / cardToAnkiSched /
//           exportDeckTxt / exportDeckCsv / exportDeckMarkdown / exportDeckJson / exportDeckApkg
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

/** 卡片 → 6 个原始字段（顺序见 TXT_COLUMNS；txt / CSV / Markdown 共用） */
export function cardFields(card) {
  return [
    card.front,
    card.back,
    card.example,
    card.exampleZh,
    card.phonetic,
    (card.tags || []).join(',')
  ];
}

/** 单元格清洗：去制表符 / 换行（避免破坏 TSV 一行一卡） */
export function tsvCell(v) {
  return String(v == null ? '' : v)
    .replace(/[\t\r\n]+/g, ' ')
    .trim();
}

/** 卡片 → txt 行字段（顺序见 TXT_COLUMNS） */
export function cardToTxtRow(card) {
  return cardFields(card).map(tsvCell);
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

/* ------------------------------ CSV（RFC 4180，带表头） ------------------------------ */

/** CSV 单元格转义：含 , " 换行时用双引号包裹，内部 " 加倍为 "" */
export function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** 卡片 → CSV 行字段（顺序见 TXT_COLUMNS） */
export function cardToCsvRow(card) {
  return cardFields(card).map(csvCell);
}

/**
 * 卡组 → CSV（UTF-8 + BOM，逗号分隔，CRLF 行尾；无正面的卡片不输出）
 * @param {object} deck
 * @param {{ header?: boolean }} opts header=true 时输出首行列名
 */
export function deckToCsv(deck, { header = true } = {}) {
  const rows = [];
  if (header) rows.push(TXT_COLUMNS.join(','));
  for (const c of (deck && deck.cards) || []) {
    const row = cardToCsvRow(c);
    if (!row[0]) continue; // 没有正面（单词）的卡片不导出
    rows.push(row.join(','));
  }
  return '\uFEFF' + rows.join('\r\n') + '\r\n';
}

/* ------------------------------ Markdown（表格） ------------------------------ */

/** Markdown 单元格转义：| 转义为 \|、换行转 <br>、制表符转空格、去首尾空白 */
export function mdCell(v) {
  return String(v == null ? '' : v)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\t+/g, ' ')
    .replace(/\r?\n+/g, '<br>')
    .trim();
}

/** 卡片 → Markdown 行字段（顺序见 TXT_COLUMNS） */
export function cardToMdRow(card) {
  return cardFields(card).map(mdCell);
}

/**
 * 卡组 → Markdown（# 卡组名 + 表格；无正面的卡片不输出）
 * @param {object} deck
 * @param {{ header?: boolean, title?: boolean }} opts header=表头行；title=首行标题
 */
export function deckToMarkdown(deck, { header = true, title = true } = {}) {
  const lines = [];
  if (title) {
    const name = String((deck && deck.name) || 'Mycard')
      .replace(/[\r\n\t]+/g, ' ')
      .trim();
    lines.push('# ' + (name || 'Mycard'), '');
  }
  if (header) {
    lines.push('| ' + TXT_COLUMNS.join(' | ') + ' |');
    lines.push('| ' + TXT_COLUMNS.map(() => '---').join(' | ') + ' |');
  }
  for (const c of (deck && deck.cards) || []) {
    const row = cardToMdRow(c);
    if (!row[0]) continue; // 没有正面（单词）的卡片不导出
    lines.push('| ' + row.join(' | ') + ' |');
  }
  return lines.join('\n') + '\n';
}

/* ------------------------------ JSON（完整导出，含复习进度） ------------------------------ */

/**
 * 卡组 → JSON 文本（内容 + 复习进度 + 卡组元信息）。
 * 结构与导入侧 `parseImportJson` 兼容（`{ name, description, tags, levelSize, cards:[…] }`），
 * 因此可「导出 → 导入」无损往返：复习状态、多释义、易混分组一并保留。
 * @param {object} deck
 * @param {{ pretty?: boolean }} opts pretty=true 输出缩进
 */
export function deckToJson(deck, { pretty = true } = {}) {
  const d = deck || {};
  const cards = (d.cards || [])
    .filter((c) => String(c.front || '').trim())
    .map((c, i) => ({
      front: c.front,
      back: c.back ?? '',
      example: c.example ?? '',
      exampleZh: c.exampleZh ?? '',
      phonetic: c.phonetic ?? '',
      tags: Array.isArray(c.tags) ? c.tags : [],
      extraBacks: Array.isArray(c.extraBacks) ? c.extraBacks : [],
      groups: Array.isArray(c.groups) ? c.groups : [],
      level: Number.isInteger(c.level) && c.level >= 0 ? c.level : i,
      // 复习进度（导入时由 store.pickScheduling 校验；缺省 = 新卡）
      state: c.state || 'new',
      repetitions: Number(c.repetitions) || 0,
      interval: Number(c.interval) || 0,
      easeFactor: Number.isFinite(c.easeFactor) ? c.easeFactor : 2.5,
      due: Number(c.due) || 0,
      lastReview: c.lastReview ?? null
    }));
  const payload = {
    formatVersion: 1,
    name: d.name || 'Mycard',
    description: d.description || '',
    tags: Array.isArray(d.tags) ? d.tags : [],
    levelSize: Number.isInteger(d.cardsPerLevel) ? d.cardsPerLevel : null,
    cards
  };
  return JSON.stringify(payload, null, pretty ? 2 : 0);
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

/**
 * Anki 卡包 `meta`（PackageMetadata protobuf）的 version 枚举。
 * 见 Anki proto/anki/import_export.proto：
 *   LEGACY_1(1)=collection.anki2 ｜ LEGACY_2(2)=collection.anki21 ｜
 *   LATEST(3)=collection.anki21b + zstd + MediaEntry 媒体映射
 * 本项目保持 collection.anki2 + schema v11，故用 LEGACY_1；version=0(UNKNOWN)
 * 会被新版 Anki 判为「包太新」而拒绝，因此不能省略/置 0。
 */
export const ANKI_META_VERSION = { LEGACY_1: 1, LEGACY_2: 2, LATEST: 3 };

/**
 * 把 PackageMetadata{ version } 编码为 protobuf 字节。
 * 该消息仅一个字段：version = 1（varint，wire type 0）。
 * @param {number} version 见 ANKI_META_VERSION
 * @returns {Uint8Array}
 */
export function encodePackageMetadata(version = ANKI_META_VERSION.LEGACY_1) {
  const v = Math.max(0, Math.floor(Number(version) || 0));
  const out = [0x08]; // tag = (field 1 << 3) | wire-type 0
  let n = v;
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n & 0x7f);
  return new Uint8Array(out);
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

/* ------------------------------ Anki 调度映射（复习进度） ------------------------------ */

export const ANKI_DAY_MS = 86400000;

/**
 * 卡片 → Anki `cards` 表的调度列（type/queue/due/ivl/factor/reps）。
 * 把 Mycard 的 state / repetitions / interval(天) / easeFactor / due(毫秒时间戳)
 * 映射为 Anki 2.1 调度字段；`due` 用「相对集合创建日的天数」近似（Anki 本身即日粒度）。
 * @param {object} card        卡片
 * @param {number} position    新卡在队列中的位置（1 起）
 * @param {number} now         当前时间戳（毫秒）
 * @param {number} todayNumber 今天相对 crt 的日数（通常为 0，见 buildCollection）
 */
export function cardToAnkiSched(card, position, now = Date.now(), todayNumber = 0) {
  const c = card || {};
  const ef = Number.isFinite(c.easeFactor) ? c.easeFactor : 2.5;
  const factor = Math.max(1300, Math.min(3000, Math.round(ef * 1000)));
  if (c.state === 'review' && c.lastReview != null) {
    const ivl = Math.max(1, Math.round(Number(c.interval) || 0)); // Anki 复习间隔为整天
    const daysUntil = Math.max(0, Math.round((Number(c.due) - now) / ANKI_DAY_MS) || 0);
    return {
      type: 2, // review
      queue: 2, // review（到期）
      due: todayNumber + daysUntil,
      ivl,
      factor,
      reps: Math.max(0, Math.round(Number(c.repetitions) || 0))
    };
  }
  if (c.state === 'learning') {
    return { type: 1, queue: 1, due: todayNumber, ivl: 0, factor, reps: 0 };
  }
  // 新卡：沿用 Anki 惯例（due = 队列位置、factor = 2500）
  return { type: 0, queue: 0, due: position, ivl: 0, factor: 2500, reps: 0 };
}

/* ------------------------------ 生成 collection.anki2 / .apkg ------------------------------ */

/** 用 sql.js 生成 collection.anki2 字节（Anki 2.1 可导入，含复习进度） */
export async function buildCollection(deck, { SQL, deckName, now = Date.now() } = {}) {
  if (!SQL || typeof SQL.Database !== 'function') throw new Error('sql.js 未就绪');
  const cards = ((deck && deck.cards) || []).filter((c) => String(c.front || '').trim());
  const name = safeFileName(deckName || (deck && deck.name) || 'Mycard', 'Mycard');
  const secs = Math.floor(now / 1000);
  const crt = ankiCreationTime(now); // 秒（含「凌晨 4 点」日切）
  // 今天相对 crt 的日数（Anki 的 due 是日序号；新建集合通常为 0）
  const todayNumber = Math.max(0, Math.floor((now - crt * 1000) / ANKI_DAY_MS));
  const mid = 1650000000000 + (now % 100000000);
  const deckId = 1;

  const db = new SQL.Database();
  db.run(ANKI_SCHEMA);
  db.run('INSERT INTO col VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [
    1,
    crt,
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
    const sched = cardToAnkiSched(c, i + 1, now, todayNumber);
    db.run('INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [
      cardId,
      noteId,
      deckId,
      0, // ord
      secs, // mod
      0, // usn
      sched.type, // type：0 新卡 / 1 学习 / 2 复习
      sched.queue, // queue：0 新 / 1 学习 / 2 复习
      sched.due, // due：新卡=队列位置；学习=今天；复习=今天 + 剩余天数
      sched.ivl, // ivl：复习间隔（天）
      sched.factor, // factor：easeFactor × 1000
      sched.reps, // reps：成功回忆次数
      0, // lapses
      0, // left
      0, // odue
      0, // odid
      0, // flags
      '' // data
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

/** 卡组 → .apkg 字节（ZIP：collection.anki2 + media + meta） */
export async function deckToApkg(deck, opts = {}) {
  const SQL = opts.SQL || (await ensureSqlJs(opts));
  const collection = await buildCollection(deck, { ...opts, SQL });
  return zipStore([
    { name: 'collection.anki2', data: collection },
    { name: 'media', data: '{}' },
    // 新版 Anki（≥2.1.50）读取的 PackageMetadata protobuf；LEGACY_1 与
    // collection.anki2 + schema v11 自洽，老版本 Anki 会忽略此条目
    { name: 'meta', data: encodePackageMetadata(opts.metaVersion || ANKI_META_VERSION.LEGACY_1) }
  ]);
}

/* ------------------------------ 导出入口 ------------------------------ */

/** 导出前校验：卡组不存在 / 无卡片时提示并返回 null */
function resolveExportDeck(deckId) {
  const deck = store.getDeck(deckId);
  if (!deck) {
    toast('卡组不存在', 'error');
    return null;
  }
  if (!(deck.cards || []).length) {
    toast('这个卡组还没有卡片', 'warn');
    return null;
  }
  return deck;
}

/** 文本类导出（txt / csv / md）共用：生成内容 → 下载 → 提示 */
function exportDeckText(deckId, build, ext, mime) {
  const deck = resolveExportDeck(deckId);
  if (!deck) return null;
  const n = (deck.cards || []).length;
  const text = build(deck);
  const filename = safeFileName(deck.name, 'mycard') + ext;
  const res = downloadBlob(filename, text, mime);
  toast(`已导出 ${n} 张卡片 → ${filename}`, 'good');
  return { filename, text, size: res ? res.size : text.length };
}

/** 导出卡组为 txt（TSV）并触发下载 */
export function exportDeckTxt(deckId) {
  return exportDeckText(deckId, deckToTxt, '.txt', 'text/tab-separated-values;charset=utf-8');
}

/** 导出卡组为 CSV（带表头）并触发下载 */
export function exportDeckCsv(deckId) {
  return exportDeckText(deckId, deckToCsv, '.csv', 'text/csv;charset=utf-8');
}

/** 导出卡组为 Markdown（表格）并触发下载 */
export function exportDeckMarkdown(deckId) {
  return exportDeckText(deckId, deckToMarkdown, '.md', 'text/markdown;charset=utf-8');
}

/** 导出卡组为 JSON（含复习进度，可无损回导）并触发下载 */
export function exportDeckJson(deckId) {
  return exportDeckText(deckId, deckToJson, '.json', 'application/json;charset=utf-8');
}

/** 导出卡组为 Anki 卡包（.apkg）并触发下载 */
export async function exportDeckApkg(deckId) {
  const deck = resolveExportDeck(deckId);
  if (!deck) return null;
  const n = (deck.cards || []).length;
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

on('export-csv', (el) => {
  exportDeckCsv(el.dataset && el.dataset.id);
});

on('export-md', (el) => {
  exportDeckMarkdown(el.dataset && el.dataset.id);
});

on('export-json', (el) => {
  exportDeckJson(el.dataset && el.dataset.id);
});

on('export-apkg', (el) => {
  exportDeckApkg(el.dataset && el.dataset.id);
});
