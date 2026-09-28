// ============================================================================
// import-file.js — 从本地文件导入词库（CSV / TSV / JSON / XLSX）
//
// 设计：
//   - 零依赖（不引入 papaparse / Dexie / 构建工具），纯 ES Module + FileReader
//   - 选择 / 拖入文件 → 先弹「导入预览」（前 10 行表格 + 自动识别分隔符）→ 确认导入
//   - 解析出的词表交给既有存储层 store.seedBuiltinDeck()：
//     自动完成「难度分层 + 错峰排列」编排并写入 IndexedDB
//   - source=null → 每次都新建卡组（同一文件可重复导入，互不覆盖）
//
// 支持的文件：
//   1) JSON：词库文件格式 {name?, description?, tags?, levelSize?, words:[...]}
//            或纯单词数组 [{front|word, back|meaning, example, exampleZh, phonetic, tags}]
//   2) CSV/TSV：可带表头（中英文均可），列顺序不限；无表头时按 front,back,example,... 位置解析
//   3) XLSX：Excel 工作簿（多工作表可选；公式 / 合并单元格见 xlsx.js），走同一套字段映射
//
// 导出：解析 / 预览 / 校验等纯函数（便于单测）+ 打开预览 / 导入 + 首页按钮与拖拽区
// ============================================================================

import * as store from './store.js';
import * as revlog from './revlog.js';
import { on, toast, navigate, esc, openModal, readForm } from './ui.js';
import { parseXlsxRows, openXlsx } from './xlsx.js';
import { recordImport, undoImport } from './import-history.js';

export const ACCEPT =
  '.json,.csv,.tsv,.txt,.xlsx,application/json,text/csv,text/plain,text/tab-separated-values,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const MAX_WORDS = 50000;
export const DEFAULT_DECK_NAME = '导入词库';

/* ------------------------------ CSV 解析 ------------------------------ */

/** 嗅探分隔符（取前几行中出现次数最多者，默认逗号） */
export function detectDelimiter(text) {
  const head = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).slice(0, 5).join('\n');
  let best = ',';
  let bestN = 0;
  for (const c of [',', '\t', ';']) {
    const n = head.split(c).length - 1;
    if (n > bestN) {
      bestN = n;
      best = c;
    }
  }
  return best;
}

/**
 * 解析 CSV/TSV 文本 → 二维数组（RFC4180 兼容：引号包裹、引号内逗号/换行、"" 转义）。
 * 自动去 BOM、忽略 CRLF/CR 差异、丢弃整行为空的记录。
 */
export function parseCsv(text, { delimiter = null } = {}) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  if (!src.trim()) return [];
  const d = delimiter || detectDelimiter(src);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++; // 转义引号
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === d) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  rows.push(row);
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
}

/* ------------------------------ 表头识别 ------------------------------ */

/** 归一化字段名：小写 + 去掉空格/下划线/连字符/括号 */
export function normalizeKey(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_\-（）()\[\]【】"']/g, '');
}

/** 常见表头别名 → 内部字段 */
export const FIELD_ALIASES = {
  front: ['front', 'word', 'term', 'headword', 'spelling', '单词', '生词', '词汇', '正面', '词'],
  back: ['back', 'meaning', 'meaningzh', 'definition', 'gloss', 'translation', '释义', '解释', '背面', '翻译', '中文', '意思'],
  example: ['example', 'sentence', 'eg', '例句', '例'],
  exampleZh: ['examplezh', 'sentencezh', '例句翻译', '例句中文', '例句释义'],
  phonetic: ['phonetic', 'ipa', 'pronunciation', 'pron', '音标', '发音'],
  tags: ['tags', 'tag', 'label', '标签', '分类']
};

/** 表头行 → { front: 列号, back: 列号, ... }；定位不到 front 列返回 null */
export function mapHeader(row) {
  const map = {};
  (row || []).forEach((cell, i) => {
    const k = normalizeKey(cell);
    if (!k) return;
    for (const field of Object.keys(FIELD_ALIASES)) {
      if (map[field] != null) continue;
      if (FIELD_ALIASES[field].some((a) => normalizeKey(a) === k)) map[field] = i;
    }
  });
  return map.front != null ? map : null;
}

/** 判断首行是否为表头（需能定位 front 列 + 至少还有一个已知列，避免把数据行当表头） */
export function isHeaderRow(row) {
  const map = mapHeader(row);
  if (!map || (row || []).length < 2) return false;
  return map.back != null || map.example != null || map.phonetic != null || map.tags != null;
}

function pick(row, i) {
  return i == null || i < 0 ? undefined : row[i];
}

/** 二维数组 → 词条数组（有表头按列名，无表头按位置 front,back,example,exampleZh,phonetic,tags） */
export function rowsToWords(rows, { hasHeader = null } = {}) {
  const grid = (rows || []).filter((r) => Array.isArray(r) && r.length);
  if (!grid.length) return [];
  const header = hasHeader == null ? isHeaderRow(grid[0]) : !!hasHeader;
  const idx = (header ? mapHeader(grid[0]) : null) || { front: 0, back: 1, example: 2, exampleZh: 3, phonetic: 4, tags: 5 };
  const body = header ? grid.slice(1) : grid;
  const words = [];
  for (const r of body) {
    const front = String(pick(r, idx.front) ?? '').trim();
    if (!front || front.length > 80) continue;
    const w = { front, back: String(pick(r, idx.back) ?? '').trim() };
    const ex = pick(r, idx.example);
    if (ex) w.example = String(ex).trim();
    const ez = pick(r, idx.exampleZh);
    if (ez) w.exampleZh = String(ez).trim();
    const ph = pick(r, idx.phonetic);
    if (ph) w.phonetic = String(ph).trim();
    const tg = pick(r, idx.tags);
    if (tg) {
      const tags = String(tg).split(/[,，;；|/、\s]+/).map((s) => s.trim()).filter(Boolean);
      if (tags.length) w.tags = tags;
    }
    words.push(w);
  }
  return words;
}

/* ------------------------------ JSON 解析 ------------------------------ */

/**
 * 从词条对象提取「复习进度」字段（JSON 完整导出会带上；兼容 reps / ivl / ef / last_review 简写）。
 * 只做透传，具体校验/钳制由 store.pickScheduling 负责。
 */
export function pickSchedFields(w) {
  const out = {};
  const take = (key, ...aliases) => {
    for (const a of [key, ...aliases]) {
      if (w[a] !== undefined && w[a] !== null) {
        out[key] = w[a];
        return;
      }
    }
  };
  take('state');
  take('repetitions', 'reps');
  take('interval', 'ivl');
  take('easeFactor', 'ef');
  take('due');
  take('lastReview', 'last_review');
  return out;
}

/**
 * 从词条对象提取「复习日志」（JSON 完整导出会带上 `reviewLog`，兼容 `revlog`）。
 * 校验 / 截断由 revlog.pickReviewLog 负责（单卡上限 MAX_IMPORT_LOG 条）。
 */
export function pickLogFields(w) {
  return revlog.pickReviewLog(w);
}

/** 单词对象数组 → 规范化词条（兼容 front/word/term、back/meaning/definition 等写法） */
export function normalizeWordObjects(list) {
  return (list || [])
    .map((w) => {
      if (!w || typeof w !== 'object') return null;
      const front = String(w.front ?? w.word ?? w.term ?? '').trim();
      if (!front) return null;
      const out = {
        front,
        back: String(w.back ?? w.meaning ?? w.meaningZh ?? w.definition ?? w.translation ?? '').trim()
      };
      const ex = w.example ?? w.sentence;
      if (ex) out.example = String(ex);
      const ez = w.exampleZh ?? w.example_zh;
      if (ez) out.exampleZh = String(ez);
      const ph = w.phonetic ?? w.ipa;
      if (ph) out.phonetic = String(ph);
      if (Array.isArray(w.tags) && w.tags.length) out.tags = w.tags.map(String);
      else if (typeof w.tags === 'string' && w.tags.trim()) out.tags = w.tags.split(/[,，;；|/、\s]+/).filter(Boolean);
      if (Array.isArray(w.extraBacks) && w.extraBacks.length) out.extraBacks = w.extraBacks.map(String);
      if (Array.isArray(w.groups) && w.groups.length) out.groups = w.groups.map(String);
      Object.assign(out, pickSchedFields(w)); // 复习进度随导入保留（由 store 校验）
      const logs = revlog.pickReviewLog(w); // 复习日志随导入保留（落库后按 front 挂到卡片上）
      if (logs.length) out.reviewLog = logs;
      return out;
    })
    .filter(Boolean);
}

/** JSON 文本 → payload（兼容词库文件对象格式与纯单词数组） */
export function parseImportJson(text) {
  let data;
  try {
    data = JSON.parse(String(text || ''));
  } catch (e) {
    throw new Error('JSON 解析失败：' + ((e && e.message) || e));
  }
  if (Array.isArray(data)) {
    return { name: DEFAULT_DECK_NAME, description: '', tags: ['导入'], words: normalizeWordObjects(data) };
  }
  if (data && typeof data === 'object') {
    const list = Array.isArray(data.words) ? data.words : Array.isArray(data.cards) ? data.cards : null;
    if (!list) throw new Error('JSON 里找不到 words / cards 数组');
    const payload = {
      name: String(data.name || DEFAULT_DECK_NAME),
      description: String(data.description || ''),
      tags: Array.isArray(data.tags) && data.tags.length ? data.tags.map(String) : ['导入'],
      words: normalizeWordObjects(list)
    };
    if (data.levelSize != null) payload.levelSize = data.levelSize;
    return payload;
  }
  throw new Error('JSON 格式不支持（需要对象或数组）');
}

/* ------------------------------ 校验 / payload ------------------------------ */

/** 按单词去重（大小写不敏感，保留首次出现） */
export function dedupeWords(words) {
  const seen = new Set();
  const out = [];
  let duplicates = 0;
  for (const w of words || []) {
    const key = String((w && w.front) || '').trim().toLowerCase();
    if (!key) continue;
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    out.push(w);
  }
  return { words: out, duplicates };
}

/** 校验并整理 payload：必须有至少 1 条含 front 的词条，并去重 */
export function validatePayload(payload) {
  const raw = (payload && Array.isArray(payload.words) ? payload.words : []).filter((w) => w && String(w.front || '').trim());
  if (!raw.length) throw new Error('没有解析到有效词条（每行至少要有「单词」列）');
  const { words, duplicates } = dedupeWords(raw);
  const res = {
    name: String((payload && payload.name) || DEFAULT_DECK_NAME),
    description: String((payload && payload.description) || ''),
    tags: Array.isArray(payload && payload.tags) && payload.tags.length ? payload.tags.map(String) : ['导入'],
    words: words.slice(0, MAX_WORDS),
    duplicates,
    truncated: words.length > MAX_WORDS
  };
  if (payload && payload.levelSize != null) res.levelSize = payload.levelSize;
  return res;
}

/** 文件名 → 卡组名（去路径与扩展名） */
export function deckNameFromFile(filename) {
  const f = String(filename || '')
    .replace(/^.*[\\/]/, '')
    .replace(/\.[^.]+$/, '')
    .trim();
  return f || DEFAULT_DECK_NAME;
}

/** 按文件名/内容选择解析器 */
export function parseByFilename(filename, text) {
  const isJson = /\.json$/i.test(String(filename || ''));
  if (isJson || /^\s*[[{]/.test(String(text || ''))) {
    const payload = parseImportJson(text);
    if (!payload.name || payload.name === DEFAULT_DECK_NAME) payload.name = deckNameFromFile(filename);
    return payload;
  }
  const rows = parseCsv(text, { delimiter: /\.tsv$/i.test(String(filename || '')) ? '\t' : null });
  return { name: deckNameFromFile(filename), description: '', tags: ['导入'], words: rowsToWords(rows) };
}

/* ------------------------------ 读取文件 / 导入 ------------------------------ */

/** 读取为 ArrayBuffer（xlsx 需要二进制） */
export function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    if (file && typeof file.arrayBuffer === 'function') {
      file.arrayBuffer().then(resolve, reject);
      return;
    }
    if (typeof FileReader === 'undefined') {
      reject(new Error('当前环境不支持读取本地文件'));
      return;
    }
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject((fr.error && fr.error.message) || new Error('文件读取失败'));
    fr.readAsArrayBuffer(file);
  });
}

export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    if (file && typeof file.text === 'function') {
      file.text().then(resolve, reject); // 现代浏览器的 File.text()
      return;
    }
    if (typeof FileReader === 'undefined') {
      reject(new Error('当前环境不支持读取本地文件'));
      return;
    }
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject((fr.error && fr.error.message) || new Error('文件读取失败'));
    fr.readAsText(file, 'utf-8');
  });
}

/**
 * 文件 → payload（xlsx 走二进制解析 + 默认映射；其余按文件名/内容选解析器）。
 * 供 importDeckFromFile 使用（不带自定义映射的「整份文件导入」路径）。
 */
export async function payloadFromFile(file) {
  if (isXlsxFile(file.name)) {
    const rows = await parseXlsxRows(await readFileAsArrayBuffer(file));
    const body = rows.length && isHeaderRow(rows[0]) ? rows.slice(1) : rows;
    return {
      name: deckNameFromFile(file.name),
      description: '',
      tags: ['导入'],
      words: applyMapping(body, defaultMapping(rowsPreview(rows)))
    };
  }
  return parseByFilename(file.name, await readFileAsText(file));
}

/**
 * 导入本地文件为新建卡组（source=null → 每次都新建，不做来源去重）。
 * @returns {{ deck:object, name:string, words:number, duplicates:number, truncated:boolean }}
 */
export async function importDeckFromFile(file, { source = null } = {}) {
  if (!file) throw new Error('没有选择文件');
  const parsed = validatePayload(await payloadFromFile(file));
  const meta = { name: parsed.name, description: parsed.description, tags: parsed.tags, levelSize: parsed.levelSize, lang: parsed.lang || 'en' };
  const deck = store.seedBuiltinDeck(parsed, { demo: false, source, meta });
  if (!deck) throw new Error('导入失败：没有可写入的词条');
  return { deck, name: deck.name, words: deck.cards.length, duplicates: parsed.duplicates, truncated: parsed.truncated };
}

/* ------------------------------ 导入预览（前 10 行表格） ------------------------------ */

export const PREVIEW_ROWS = 10;

/** 分隔符 → 可读文案 */
export function delimiterLabel(d) {
  if (d === '\t') return '制表符 Tab';
  if (d === ';') return '分号 ;';
  if (d === ',') return '逗号 ,';
  return `「${d}」`;
}

/**
 * CSV 文本 → 预览数据（只取前 limit 行，另统计总行 / 列数）。
 * @returns {{ kind:'csv', delimiter:string, header:string[]|null, rows:string[][], cols:number, totalRows:number }}
 */
export function csvPreview(text, { limit = PREVIEW_ROWS } = {}) {
  const all = parseCsv(text);
  const headerRow = all.length && isHeaderRow(all[0]) ? all[0] : null;
  const body = headerRow ? all.slice(1) : all;
  const cols = all.reduce((m, r) => Math.max(m, r.length), 0);
  return {
    kind: 'csv',
    delimiter: detectDelimiter(text),
    header: headerRow,
    rows: body.slice(0, limit),
    cols,
    totalRows: body.length
  };
}

/**
 * 二维字符串表 → 预览数据（xlsx 解析结果复用；与 csvPreview 同构，可走同一套字段映射/导入）
 * @param {string[][]} rows
 * @param {{ limit?:number, sheet?:string, notices?:object }} [opts] sheet=工作表名；notices=公式/合并统计
 * @returns {{ kind:'xlsx', delimiter:null, header:string[]|null, rows:string[][], cols:number,
 *             totalRows:number, sheet:string, notices:object|null }}
 */
export function rowsPreview(rows, { limit = PREVIEW_ROWS, sheet = '', notices = null } = {}) {
  const all = (Array.isArray(rows) ? rows : []).map((r) =>
    Array.isArray(r) ? r.map((v) => String(v == null ? '' : v)) : []
  );
  const headerRow = all.length && isHeaderRow(all[0]) ? all[0] : null;
  const body = headerRow ? all.slice(1) : all;
  const cols = all.reduce((m, r) => Math.max(m, r.length), 0);
  return {
    kind: 'xlsx',
    delimiter: null,
    header: headerRow,
    rows: body.slice(0, limit),
    cols,
    totalRows: body.length,
    sheet: sheet || '',
    notices: notices || null
  };
}

/**
 * 已打开的 workbook → 某张工作表的预览数据（弹窗里切换工作表时复用）。
 * @param {{ sheets:Array, read:Function }} wb openXlsx 的返回值
 * @param {number|string} which 工作表序号或名称
 * @param {{ limit?:number }} [opts]
 */
export function xlsxWorkbookPreview(wb, which = 0, { limit = PREVIEW_ROWS } = {}) {
  const detail = wb.read(which);
  const idx = typeof which === 'number' ? which : (wb.sheets || []).findIndex((s) => s.name === String(which));
  const info = (wb.sheets || [])[idx] || {};
  return rowsPreview(detail.rows, { limit, sheet: info.name || '', notices: detail.notices });
}

/** 预览是否「逐列映射」型（CSV / xlsx 共用同一套字段映射与导入逻辑） */
export function isTabular(preview) {
  return !!preview && (preview.kind === 'csv' || preview.kind === 'xlsx');
}

/** JSON 文本 → 预览数据（前 limit 条，两列：单词 / 释义） */
export function jsonPreview(text, { limit = PREVIEW_ROWS } = {}) {
  const payload = parseImportJson(text);
  const words = Array.isArray(payload.words) ? payload.words : [];
  return {
    kind: 'json',
    delimiter: null,
    header: ['单词 front', '释义 back'],
    rows: words.slice(0, limit).map((w) => [String(w.front ?? ''), String(w.back ?? '')]),
    cols: 2,
    totalRows: words.length,
    name: payload.name || ''
  };
}

/** 按文件名 / 内容选择预览方式（JSON 兼容无扩展名的情况） */
export function buildPreview(filename, text, { limit = PREVIEW_ROWS } = {}) {
  const isJson = /\.json$/i.test(String(filename || '')) || /^\s*[[{]/.test(String(text || ''));
  return isJson ? jsonPreview(text, { limit }) : csvPreview(text, { limit });
}

/** 预览表格 HTML：优先用文件首行作列名，否则显示「列 1 / 列 2 …」 */
export function previewTableHtml(preview) {
  const cols = Math.max(1, preview.cols || 1);
  const names = Array.from({ length: cols }, (_, i) =>
    preview.header && preview.header[i] != null ? String(preview.header[i]) : `列 ${i + 1}`
  );
  const head = `<tr><th class="csv-idx">#</th>${names.map((n) => `<th>${esc(n)}</th>`).join('')}</tr>`;
  const body = (preview.rows || [])
    .map(
      (r, i) =>
        `<tr><td class="csv-idx">${i + 1}</td>${Array.from({ length: cols }, (_, c) => `<td>${esc(r[c] ?? '')}</td>`).join('')}</tr>`
    )
    .join('');
  return `<div class="csv-table-wrap"><table class="csv-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

/** 公式 / 合并单元格统计 → 可读提示（没有内容时返回空串） */
export function xlsxNoticesText(notices) {
  if (!notices) return '';
  const bits = [];
  if (notices.evaluated) bits.push(`已计算 ${notices.evaluated} 个公式`);
  if (notices.unsupported) bits.push(`${notices.unsupported} 个公式用 Excel 缓存值`);
  if (notices.mergedCells) bits.push(`合并单元格补全 ${notices.mergedCells} 格`);
  return bits.join(' · ');
}

/** 预览元信息（文件名 / 分隔符 / 行列数 / 表头识别情况 / xlsx 工作表与公式提示） */
export function previewMetaHtml(preview, filename = '') {
  const bits = [];
  if (preview.kind === 'csv') bits.push(`分隔符：${delimiterLabel(preview.delimiter)}`);
  bits.push(`共 ${preview.totalRows} 行 × ${preview.cols} 列`);
  bits.push(
    preview.kind === 'json'
      ? 'JSON 词库'
      : preview.kind === 'xlsx'
        ? preview.sheet
          ? `Excel 工作表「${preview.sheet}」`
          : 'Excel 工作表（取第一个 sheet）'
        : preview.header
          ? '已识别表头（首行为列名）'
          : '未识别表头（列名用「列 1…」）'
  );
  const extra = preview.kind === 'xlsx' ? xlsxNoticesText(preview.notices) : '';
  if (extra) bits.push(extra);
  const shown = Math.min(PREVIEW_ROWS, preview.totalRows);
  return (
    `<p class="csv-meta">${esc(filename)}${filename ? ' · ' : ''}${esc(bits.join(' · '))}</p>` +
    `<p class="csv-hint">仅预览前 ${shown} 行；确认后将整份文件导入为<b>新卡组</b>（按难度编排关卡）。</p>`
  );
}

/**
 * 工作表下拉（多张表时才渲染；隐藏表标注「隐藏」）。
 * @param {Array<{index:number,name:string,hidden:boolean}>} sheets
 * @param {number} selected 选中的工作表序号
 */
export function sheetPickerHtml(sheets, selected = 0) {
  const list = Array.isArray(sheets) ? sheets : [];
  if (list.length < 2) return '';
  const opts = list
    .map(
      (s, i) =>
        `<option value="${i}"${i === selected ? ' selected' : ''}>${esc(s.name || `Sheet${i + 1}`)}${s.hidden ? '（隐藏）' : ''}</option>`
    )
    .join('');
  return (
    `<div class="field-map-row"><label class="fm-col" for="import-sheet">工作表</label>` +
    `<select id="import-sheet" name="sheet" class="fm-select">${opts}</select>` +
    `<span class="fm-hint">共 ${list.length} 张表</span></div>`
  );
}

/** 绑定工作表下拉：切换后回调（用于重渲染预览区） */
export function bindSheetPicker(overlay, onChange) {
  const sel = overlay && typeof overlay.querySelector === 'function' ? overlay.querySelector('#import-sheet') : null;
  if (!sel || typeof sel.addEventListener !== 'function') return false;
  sel.addEventListener('change', () => {
    if (typeof onChange === 'function') onChange(Number(sel.value) || 0);
  });
  return true;
}


/* ------------------------------ 字段映射 / 目标牌组 ------------------------------ */

/** 可映射的语义字段（顺序即下拉展示顺序） */
export const COLUMN_FIELDS = [
  { value: 'ignore', label: '忽略' },
  { value: 'front', label: '正面（单词）· 必选' },
  { value: 'back', label: '背面（释义）· 必选' },
  { value: 'example', label: '例句 · 可选' },
  { value: 'exampleZh', label: '例句翻译 · 可选' },
  { value: 'phonetic', label: '音标 · 可选' },
  { value: 'tags', label: '标签（逗号分隔）· 可选' }
];
export const MAPPABLE_FIELDS = ['front', 'back', 'example', 'exampleZh', 'phonetic', 'tags'];

/**
 * 默认字段映射（长度 = 列数）：识别到表头时按表头别名对号，
 * 否则第一列 = 正面、第二列 = 背面、其余忽略。
 * @returns {string[]} 每列对应的字段名（或 'ignore'）
 */
export function defaultMapping(preview) {
  const cols = Math.max(1, (preview && preview.cols) || 1);
  const out = Array.from({ length: cols }, () => 'ignore');
  const header = preview && Array.isArray(preview.header) ? preview.header : null;
  if (header && header.length) {
    const map = mapHeader(header);
    if (map) {
      for (const f of Object.keys(map)) {
        const idx = map[f];
        if (idx >= 0 && idx < cols && MAPPABLE_FIELDS.includes(f) && !out.includes(f)) out[idx] = f;
      }
    }
  }
  if (!out.includes('front')) out[0] = 'front';
  if (!out.includes('back')) {
    const frontAt = out.indexOf('front');
    const i = out.findIndex((v, idx) => v === 'ignore' && idx !== frontAt);
    if (i >= 0) out[i] = 'back';
  }
  return out;
}

/** 校验映射：正面 / 背面各恰好一列 */
export function validateMapping(mapping) {
  const used = (mapping || []).filter((f) => f && f !== 'ignore');
  const nFront = used.filter((f) => f === 'front').length;
  const nBack = used.filter((f) => f === 'back').length;
  if (!nFront) return { ok: false, error: '请把某一列映射为「正面（单词）」' };
  if (nFront > 1) return { ok: false, error: '「正面（单词）」只能映射一列' };
  if (!nBack) return { ok: false, error: '请把某一列映射为「背面（释义）」' };
  if (nBack > 1) return { ok: false, error: '「背面（释义）」只能映射一列' };
  return { ok: true };
}

/** 按映射把二维数组转成词条（front 为空 / 超长的行丢弃；tags 按逗号切分去空格） */
export function applyMapping(rows, mapping) {
  const grid = (rows || []).filter((r) => Array.isArray(r) && r.length);
  const idx = {};
  (mapping || []).forEach((f, i) => {
    if (f && f !== 'ignore' && idx[f] == null) idx[f] = i;
  });
  const words = [];
  for (const r of grid) {
    const front = idx.front != null ? String(r[idx.front] ?? '').trim() : '';
    if (!front || front.length > 80) continue;
    const w = { front, back: idx.back != null ? String(r[idx.back] ?? '').trim() : '' };
    const take = (key) => (idx[key] != null && r[idx[key]] != null ? String(r[idx[key]]).trim() : '');
    const ex = take('example');
    if (ex) w.example = ex;
    const ez = take('exampleZh');
    if (ez) w.exampleZh = ez;
    const ph = take('phonetic');
    if (ph) w.phonetic = ph;
    const tg = take('tags');
    if (tg) {
      const tags = tg.split(/[,，;；|/、\s]+/).map((s) => s.trim()).filter(Boolean);
      if (tags.length) w.tags = tags;
    }
    words.push(w);
  }
  return words;
}

/** 字段映射 UI（每列一个下拉，默认值见 defaultMapping） */
export function fieldMapHtml(preview) {
  const mapping = defaultMapping(preview);
  const cols = mapping.length;
  const first = (preview && preview.rows && preview.rows[0]) || [];
  const rows = Array.from({ length: cols }, (_, i) => {
    const raw = preview && preview.header && preview.header[i] != null ? String(preview.header[i]).trim() : '';
    const name = raw || `列 ${i + 1}`;
    const opts = COLUMN_FIELDS.map(
      (f) => `<option value="${f.value}"${f.value === mapping[i] ? ' selected' : ''}>${esc(f.label)}</option>`
    ).join('');
    const sample = String(first[i] ?? '').slice(0, 20);
    return `<div class="field-map-row">
      <span class="fm-col" title="${esc(name)}">${esc(name)}</span>
      <select class="fm-select" name="col-${i}" data-field-col="${i}" aria-label="第 ${i + 1} 列的映射字段">${opts}</select>
      <span class="fm-sample" title="${esc(String(first[i] ?? ''))}">${esc(sample)}</span>
    </div>`;
  }).join('');
  return `<div class="field-map">
    <p class="fm-title">字段映射<span class="fm-hint">（默认第一列 = 正面，第二列 = 背面，其余忽略）</span></p>
    <div class="fm-cols">${rows}</div>
  </div>`;
}

/** 目标牌组 UI（已有牌组下拉 + 新建牌组名） */
export function targetDeckHtml(file, { decks = [], defaultName = '' } = {}) {
  const opts = decks
    .map((d) => `<option value="${esc(d.id)}">${esc(d.name)}（${d.count == null ? 0 : d.count} 张）</option>`)
    .join('');
  return `<div class="deck-target">
    <p class="fm-title">目标牌组<span class="fm-hint">（选已有牌组 → 追加并重拆关卡；新建 → 按难度自动编排）</span></p>
    <div class="dt-row">
      <select class="dt-select" name="target" id="dt-target" aria-label="目标牌组">
        <option value="__new__" selected>＋ 新建牌组</option>
        ${opts}
      </select>
    </div>
    <div class="dt-row"><input class="dt-input" name="newDeckName" id="dt-name" type="text" value="${esc(defaultName)}" placeholder="新牌组名称" autocomplete="off" /></div>
  </div>`;
}

/** 目标牌组下拉切换：选已有牌组时隐藏「新牌组名」输入 */
export function bindTargetToggle(overlay) {
  if (!overlay || typeof overlay.querySelector !== 'function') return false;
  const sel = overlay.querySelector('#dt-target');
  const input = overlay.querySelector('#dt-name');
  if (!sel || !input || typeof sel.addEventListener !== 'function') return false;
  const sync = () => {
    const isNew = String(sel.value || '__new__') === '__new__';
    if (input.style) input.style.display = isNew ? '' : 'none';
    input.disabled = !isNew;
  };
  sel.addEventListener('change', sync);
  sync();
  return true;
}

/** 读取预览弹窗里的映射表、目标牌组选择与工作表选择 */
export function readPreviewInputs(overlay, preview) {
  const form = overlay && typeof overlay.querySelectorAll === 'function' ? readForm(overlay) : {};
  const cols = Math.max(1, (preview && preview.cols) || 1);
  const mapping = Array.from({ length: cols }, (_, i) => form[`col-${i}`] || 'ignore');
  const target = form.target || '__new__';
  const deckName = String(form.newDeckName || '').trim();
  const sheet = Number.isInteger(Number(form.sheet)) && String(form.sheet || '').trim() !== '' ? Number(form.sheet) : 0;
  return { mapping, target, deckName, sheet };
}

/* ------------------------------ 首页入口 ------------------------------ */

/* ------------------------------ 标准 CSV 模版 ------------------------------ */

/** 标准 CSV 模版的列（均为 FIELD_ALIASES 中的中文规范名，导入时自动对号） */
export const CSV_TEMPLATE_COLUMNS = ['单词', '释义', '例句', '例句翻译', '音标', '标签'];
/**
 * 模版示例行（**导入前请删除**）——演示列含义：
 * 音标带斜杠、标签用逗号分隔（因此该项在 CSV 中会被引号包裹）。
 */
export const CSV_TEMPLATE_EXAMPLE = ['apple', '苹果', 'This is an apple.', '这是一个苹果。', '/ˈæpl/', '水果,基础'];
/**
 * 多行示例（演示常见的「不整齐」情形，**导入前请删除**）：
 *   - bank：多义词（释义用「；」分隔多个义项）、无例句 / 无音标（对应列留空即可）
 *   - note：例句含逗号 → 该格自动被引号包裹（CSV 转义示例）
 *   - pear：只填必填的「单词 / 释义」两列，可选列全空
 */
export const CSV_TEMPLATE_EXAMPLES = [
  CSV_TEMPLATE_EXAMPLE,
  ['bank', '银行；河岸', '', '', '', '金融,地理'],
  ['note', '笔记；便条', 'Take notes, please.', '请做笔记。', '', '学习,基础'],
  ['pear', '梨', '', '', '', '']
];
/** 模版文件名 */
export const CSV_TEMPLATE_FILENAME = 'Mycard-CSV模版.csv';
/**
 * 模版变体（下载前可选）：仅表头 / 表头 + 1 行示例（默认，与旧版一致）/ 表头 + 多行示例。
 * `label` 用于弹窗选项展示，`note` 说明适用场景。
 */
export const CSV_TEMPLATE_VARIANTS = [
  { value: 'head', label: '仅表头', note: '不带示例行 —— 下载后可直接开始填写' },
  { value: 'single', label: '表头 + 1 行示例', note: '与旧版一致：apple 的完整示例（导入前请删除示例行）' },
  { value: 'multi', label: '表头 + 多行示例', note: '额外演示多义词、无例句、无音标、例句含逗号、只填必填列' }
];

/** CSV 单元格转义（含 , " 换行时用双引号包裹，内部 " 加倍） */
function csvQuote(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** 二维数组 → CSV 文本（UTF-8 BOM + CRLF 行尾，Excel 友好；供模版与表格编辑页共用） */
export function csvText(rows) {
  return '\uFEFF' + (rows || []).map((r) => (r || []).map(csvQuote).join(',')).join('\r\n') + '\r\n';
}

/** 变体名 → 示例行数组（head 不带示例；未知变体按 single 处理） */
export function csvTemplateExampleRows(variant = 'single') {
  if (variant === 'head') return [];
  if (variant === 'multi') return CSV_TEMPLATE_EXAMPLES.map((r) => r.slice());
  return [CSV_TEMPLATE_EXAMPLE.slice()];
}

/** CSV 模版二维数组（表头 + 按变体附带的示例行），供模版下载与预览复用 */
export function csvTemplateRows({ variant = 'single' } = {}) {
  return [CSV_TEMPLATE_COLUMNS.slice(), ...csvTemplateExampleRows(variant)];
}

/** 标准 CSV 模版文本（UTF-8 BOM + 表头 + 示例行；CRLF 行尾，Excel 友好）；默认 1 行示例 */
export function csvTemplateText({ variant = 'single' } = {}) {
  return csvText(csvTemplateRows({ variant }));
}

/** 触发浏览器下载文本文件；非浏览器环境返回 null（便于测试） */
function downloadTextFile(filename, text, mime = 'text/csv;charset=utf-8') {
  if (
    typeof document === 'undefined' ||
    typeof Blob === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function' ||
    typeof document.createElement !== 'function'
  ) {
    return null;
  }
  const blob = new Blob([text], { type: mime });
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

/** 下载标准 CSV 模版（默认含 1 行示例；variant = head / single / multi） */
export function downloadCsvTemplate({ variant = 'single' } = {}) {
  const text = csvTemplateText({ variant });
  const res = downloadTextFile(CSV_TEMPLATE_FILENAME, text);
  const tip = variant === 'head' ? '（仅表头，不含示例行）' : `（含 ${
    csvTemplateExampleRows(variant).length
  } 行示例，导入前请删除）`;
  toast(
    res ? `已下载模版 ${CSV_TEMPLATE_FILENAME}${tip}` : '当前环境不支持下载，请手动新建 CSV',
    res ? 'good' : 'warn'
  );
  return { filename: CSV_TEMPLATE_FILENAME, text, size: res ? res.size : text.length, variant };
}

/**
 * 「下载 CSV 模版」弹窗 HTML（纯函数，便于测试）：
 * 说明标准列 + 变体选择（仅表头 / 1 行示例 / 多行示例）以及各自适用场景。
 */
export function csvTemplateDialogHtml() {
  const opts = CSV_TEMPLATE_VARIANTS.map(
    (v) => `<option value="${esc(v.value)}"${v.value === 'single' ? ' selected' : ''}>${esc(v.label)}</option>`
  ).join('');
  const notes = CSV_TEMPLATE_VARIANTS.map((v) => `<li><b>${esc(v.label)}</b>：${esc(v.note)}</li>`).join('');
  return (
    `<p class="csv-hint">标准列：${CSV_TEMPLATE_COLUMNS.map(esc).join(' / ')}（列名会自动对号，顺序不限）</p>` +
    `<div class="dt-row"><select class="dt-select" name="variant" aria-label="模版示例行">${opts}</select></div>` +
    `<ul class="tpl-notes">${notes}</ul>` +
    `<p class="csv-hint">示例行只是「怎么填」的演示，导入时按真实行解析 —— 记得先删掉示例行。</p>`
  );
}

/** 打开「下载 CSV 模版」弹窗（先选变体，再下载） */
export function openCsvTemplateDialog() {
  const overlay = openModal({
    title: '下载 CSV 模版',
    body: csvTemplateDialogHtml(),
    actions: [
      { label: '取消', cls: 'btn-ghost' },
      {
        label: '下载',
        cls: 'btn-primary',
        onClick: () => {
          const picked = readForm(overlay).variant;
          downloadCsvTemplate({ variant: picked || 'single' });
        }
      }
    ]
  });
  return overlay;
}

/** 下载任意二维数组为 CSV（表格编辑页「下载 CSV」用） */
export function downloadCsvRows(filename, rows) {
  const text = csvText(rows);
  const res = downloadTextFile(String(filename || 'Mycard.csv'), text);
  toast(res ? `已下载 ${String(filename || 'Mycard.csv')}` : '当前环境不支持下载，请手动复制表格', res ? 'good' : 'warn');
  return { filename: String(filename || 'Mycard.csv'), text, size: res ? res.size : text.length };
}

/** 首页「下载 CSV 模版」链接（点击后先选示例行变体） */
export function csvTemplateButtonHtml() {
  return `<button class="btn-link" data-action="download-csv-template" title="下载标准 CSV 模版（可选仅表头 / 1 行示例 / 多行示例）">下载 CSV 模版</button>`;
}

/* ------------------------------ 标准 JSON 模版 ------------------------------ */

/** JSON 模版文件名 */
export const JSON_TEMPLATE_FILENAME = 'Mycard-JSON模版.json';
/**
 * JSON 模版内容（下载后可直接用首页「导入词库」导入）：
 * 顶层 `{ name, description, tags, levelSize, words: [...] }`；词条字段 front / back 必填，
 * example / exampleZh / phonetic / tags / extraBacks（多义词的其他释义）可选。
 * 第二条只填必填项，说明可选字段可以整块省略。
 */
export const JSON_TEMPLATE_SAMPLE = {
  name: '我的词库',
  description: 'JSON 模版：第一条为完整示例，第二条只填必填的单词 / 释义',
  tags: ['导入'],
  levelSize: 20,
  words: [
    {
      front: 'apple',
      back: '苹果',
      example: 'This is an apple.',
      exampleZh: '这是一个苹果。',
      phonetic: '/ˈæpl/',
      tags: ['水果', '基础'],
      extraBacks: ['苹果树']
    },
    { front: 'pear', back: '梨' }
  ]
};

/** JSON 模版文本（2 空格缩进 + 末尾换行，便于手工编辑） */
export function jsonTemplateText() {
  return JSON.stringify(JSON_TEMPLATE_SAMPLE, null, 2) + '\n';
}

/** 下载标准 JSON 模版 */
export function downloadJsonTemplate() {
  const text = jsonTemplateText();
  const res = downloadTextFile(JSON_TEMPLATE_FILENAME, text, 'application/json;charset=utf-8');
  toast(
    res ? `已下载模版 ${JSON_TEMPLATE_FILENAME}（改完即可用首页「导入词库」导入）` : '当前环境不支持下载，请手动新建 JSON',
    res ? 'good' : 'warn'
  );
  return { filename: JSON_TEMPLATE_FILENAME, text, size: res ? res.size : text.length };
}

/** 首页「下载 JSON 模版」链接 */
export function jsonTemplateButtonHtml() {
  return `<button class="btn-link" data-action="download-json-template" title="下载标准 JSON 模版（含 1 个完整示例 + 1 个最简示例，可直接导入）">下载 JSON 模版</button>`;
}

/** 首页「导入词库」按钮（CSV / TSV / JSON / XLSX，可多选批量导入） */
export function importFileButtonHtml() {
  const tip = '导入词库文件（CSV / TSV / JSON / XLSX，可多选）';
  return `<button class="icon-btn glass" data-action="import-file" aria-label="${tip}" title="${tip}"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M4 16v2.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V16"/></svg></button>`;
}

/** 打开系统文件选择器（动态创建 input，不污染 index.html） */
export function openFilePicker({ multiple = true } = {}) {
  if (typeof document === 'undefined' || !document.createElement) return null;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = ACCEPT;
  input.multiple = !!multiple; // 支持多文件批量导入
  input.style.display = 'none';
  if (document.body && document.body.appendChild) document.body.appendChild(input);

  const cleanup = () => {
    if (input.parentNode && input.parentNode.removeChild) input.parentNode.removeChild(input);
  };

  input.onchange = () => {
    const files = input.files ? Array.from(input.files) : [];
    cleanup();
    if (!files.length) return;
    if (files.length === 1) openImportPreview(files[0]); // 单文件：先预览（可改映射）
    else openBatchImport(files); // 多文件：每个文件各建一个卡组
  };

  input.click();
  return input;
}

/**
 * 打开「导入预览」弹窗：前 10 行表格 + 自动识别分隔符 + 行列统计。
 * xlsx 会列出全部工作表（可切换预览，多表时顶部落「工作表」下拉）。
 * 点「确认导入」才真正写入卡组（复用 importMapped）。
 */
export async function openImportPreview(file) {
  if (!file) {
    toast('没有选择文件', 'warn');
    return null;
  }
  const isXlsx = isXlsxFile(file.name);
  let wb = null;
  const state = { preview: null };
  try {
    if (isXlsx) wb = await openXlsx(await readFileAsArrayBuffer(file));
    state.preview = isXlsx ? xlsxWorkbookPreview(wb, 0) : buildPreview(file.name, await readFileAsText(file));
  } catch (e) {
    toast(`解析失败：${(e && e.message) || e}`, 'error');
    return null;
  }
  if (!state.preview.totalRows) {
    toast('解析不出有效数据行，请检查文件内容', 'warn');
    return null;
  }
  const previewHtml = () => {
    const p = state.preview;
    return previewMetaHtml(p, file.name) + previewTableHtml(p) + (isTabular(p) ? fieldMapHtml(p) : '');
  };

  const overlay = openModal({
    title: '导入预览',
    wide: true,
    body:
      (wb ? sheetPickerHtml(wb.sheets, 0) : '') +
      `<div id="import-preview-body">${previewHtml()}</div>` +
      targetDeckHtml(file, {
        decks: store.getDb().decks.map((d) => ({ id: d.id, name: d.name, count: (d.cards || []).length })),
        defaultName: deckNameFromFile(file.name)
      }),
    actions: [
      {
        label: '确认导入',
        cls: 'btn-primary',
        onClick: () => {
          const inputs = readPreviewInputs(overlay, state.preview);
          if (isTabular(state.preview)) {
            const check = validateMapping(inputs.mapping);
            if (!check.ok) {
              toast(check.error, 'warn');
              return false; // 校验失败 → 保持弹窗，便于用户改映射
            }
          }
          if (inputs.target === '__new__' && !inputs.deckName) {
            toast('请填写新牌组名称', 'warn');
            return false;
          }
          runMappedImport(file, inputs); // 异步导入，完成后弹成功提示
          return true; // 关闭预览弹窗
        }
      },
      { label: '取消', cls: 'btn-ghost' }
    ]
  });
  bindTargetToggle(overlay);
  // 切换工作表 → 只重渲染「元信息 + 表格 + 字段映射」（目标牌组区不动）
  bindSheetPicker(overlay, (index) => {
    try {
      state.preview = xlsxWorkbookPreview(wb, index);
    } catch (e) {
      toast(`读取工作表失败：${(e && e.message) || e}`, 'error');
      return;
    }
    const box = typeof overlay.querySelector === 'function' ? overlay.querySelector('#import-preview-body') : null;
    if (box) box.innerHTML = previewHtml();
  });
  return overlay;
}

/**
 * 预览弹窗 → 按映射与目标牌组导入（完整解析，不只前 10 行）。
 * @param {File} file
 * @param {{mapping?:string[], target?:string, deckName?:string, sheet?:number}} inputs
 * @returns {Promise<{deck:object, deckId:string, name:string, added:number, skipped:number, duplicates:number, existing:boolean}>}
 */
export async function runMappedImport(file, inputs = {}) {
  if (!file) return null;
  toast(`正在导入「${file.name}」…`);
  try {
    const res = await importMapped(file, {
      mapping: inputs.mapping || null,
      deckId: inputs.target && inputs.target !== '__new__' ? inputs.target : '',
      deckName: inputs.deckName || '',
      sheet: inputs.sheet || 0
    });
    const entry = await recordImport([res]);
    res.historyId = entry.id;
    showImportSuccess(res);
    return res;
  } catch (e) {
    console.error(e);
    toast(`导入失败：${(e && e.message) || e}`, 'error');
    return null;
  }
}

/**
 * 导入本地文件到目标牌组（CSV 按映射取列；JSON 走既有解析；xlsx 可选工作表）。
 * - 指定 deckId：追加进已有牌组（跳过已存在的单词）并重拆关卡
 * - 指定 deckName：新建牌组（难度分层 + 错峰编排）
 * @param {{ mapping?:string[]|null, deckId?:string, deckName?:string, src?:string, sheet?:number|string }} [opts]
 *        sheet：xlsx 的工作表序号 / 名称（默认第一张）
 */
export async function importMapped(file, { mapping = null, deckId = '', deckName = '', src = 'batch_import', sheet = 0 } = {}) {
  if (!file) throw new Error('没有选择文件');
  let words = [];
  let duplicates = 0;
  if (isXlsxFile(file.name)) {
    // xlsx：解析指定工作表（默认第一张）→ 与 CSV 同样按「逐列映射」取数据
    const rows = await parseXlsxRows(await readFileAsArrayBuffer(file), { sheet });
    const map = Array.isArray(mapping) && mapping.length ? mapping : defaultMapping(rowsPreview(rows));
    const check = validateMapping(map);
    if (!check.ok) throw new Error(check.error);
    const body = rows.length && isHeaderRow(rows[0]) ? rows.slice(1) : rows;
    const deduped = dedupeWords(applyMapping(body, map));
    words = deduped.words.slice(0, MAX_WORDS);
    duplicates = deduped.duplicates;
    if (!words.length) throw new Error('没有解析到有效词条（请检查字段映射）');
  } else {
    const text = await readFileAsText(file);
    const isJson = /\.json$/i.test(String(file.name || '')) || /^\s*[[{]/.test(text);
    if (isJson) {
      const payload = validatePayload(parseByFilename(file.name, text));
      words = payload.words;
      duplicates = payload.duplicates;
      if (!deckName) deckName = payload.name;
    } else {
      const map = Array.isArray(mapping) && mapping.length ? mapping : defaultMapping(csvPreview(text));
      const check = validateMapping(map);
      if (!check.ok) throw new Error(check.error);
      const rows = parseCsv(text);
      // 与预览保持一致：识别到表头时，表头行不计入数据
      const body = rows.length && isHeaderRow(rows[0]) ? rows.slice(1) : rows;
      const deduped = dedupeWords(applyMapping(body, map));
      words = deduped.words.slice(0, MAX_WORDS);
      duplicates = deduped.duplicates;
      if (!words.length) throw new Error('没有解析到有效词条（请检查字段映射）');
    }
  }
  return commitWords(words, { deckId, deckName, src, duplicates, file });
}

/**
 * 收集词条携带的复习日志（key = 单词小写；用于落库后按 front 挂到卡片上）。
 * 说明：落库会重排关卡（顺序 / id 都会变），因此不能用「下标」对应，只能按 front 匹配。
 */
function collectReviewLogs(words) {
  const map = new Map();
  for (const w of words || []) {
    const logs = revlog.pickReviewLog(w);
    if (!logs.length) continue;
    const key = String((w && w.front) || '').trim().toLowerCase();
    if (key) map.set(key, [...(map.get(key) || []), ...logs]);
  }
  return map;
}

/** 把词条携带的复习日志写到对应卡片（返回写入条数） */
function attachReviewLogs(deck, logsByFront) {
  if (!deck || !logsByFront.size) return 0;
  const entries = [];
  for (const c of deck.cards || []) {
    const logs = logsByFront.get(String(c.front || '').trim().toLowerCase());
    if (!logs || !logs.length) continue;
    // 落库后卡片 id 是新生成的 → 重新归属（同步刷新日志主键，避免跨卡重号）
    for (const e of logs) entries.push(revlog.reattach(e, c.id));
  }
  return entries.length ? store.importRevlogs(deck.id, entries) : 0;
}

/** 写入目标牌组（已有牌组 → 追加去重；否则新建） */
function commitWords(words, { deckId, deckName, src, duplicates, file }) {
  const fileName = (file && file.name) || '';
  const logsByFront = collectReviewLogs(words);
  if (deckId) {
    const deck = store.getDeck(deckId);
    if (!deck) throw new Error('目标牌组不存在');
    const existing = new Set(deck.cards.map((c) => String(c.front || '').toLowerCase()));
    const before = new Set(deck.cards.map((c) => c.id));
    const fresh = [];
    let skipped = 0;
    for (const w of words) {
      const key = String(w.front).toLowerCase();
      if (existing.has(key)) {
        skipped++;
        continue;
      }
      existing.add(key);
      fresh.push(Object.assign({}, w, { src, addedAt: Date.now() }));
    }
    if (fresh.length) store.addManyCards(deck.id, fresh); // 单事务整批写入 + 重新拆分关卡
    let after = store.getDeck(deck.id);
    const logsWritten = attachReviewLogs(after, logsByFront); // JSON 回导：复习日志随卡片恢复
    // 追加导入：记录实际新增的卡片 id（供「导入回滚」精确撤销）
    const addedCardIds = after.cards.filter((c) => !before.has(c.id)).map((c) => c.id);
    return {
      deck: after,
      deckId: deck.id,
      name: after.name,
      added: fresh.length,
      skipped,
      duplicates,
      existing: true,
      mode: 'append',
      addedCardIds,
      logsWritten,
      fileName
    };
  }
  const name = String(deckName || deckNameFromFile(file && file.name)).trim() || DEFAULT_DECK_NAME;
  const payload = validatePayload({ name, description: '', tags: ['导入'], words });
  const deck = store.seedBuiltinDeck(payload, {
    demo: false,
    source: null,
    meta: { name: payload.name, tags: payload.tags, lang: 'en' }
  });
  if (!deck) throw new Error('导入失败：没有可写入的词条');
  return {
    deck,
    deckId: deck.id,
    name: deck.name,
    added: deck.cards.length,
    skipped: 0,
    // words 可能已被调用方去重过，此时 payload.duplicates 为 0 → 合并调用方传入的重复条数
    duplicates: payload.duplicates || duplicates || 0,
    existing: false,
    mode: 'new',
    addedCardIds: deck.cards.map((c) => c.id),
    logsWritten: attachReviewLogs(deck, logsByFront),
    fileName
  };
}

/**
 * 直接把「已解析好的词条数组」写入目标牌组。
 * 供「表格编辑」页复用与文件导入完全一致的链路：validatePayload（校验 + 去重 + 上限）
 *  → commitWords（已有牌组追加去重 / 新建牌组难度编排）→ 返回同样的结果结构（可记导入历史 / 撤销）。
 * @param {Array} words 词条数组 [{ front, back, example?, exampleZh?, phonetic?, tags? }]
 * @param {{deckId?:string, deckName?:string, src?:string, fileName?:string}} opts
 */
export function importWordsToDeck(words, { deckId = '', deckName = '', src = 'table_editor', fileName = '' } = {}) {
  const payload = validatePayload({
    name: String(deckName || '').trim() || DEFAULT_DECK_NAME,
    description: '',
    tags: ['导入'],
    words
  });
  return commitWords(payload.words, {
    deckId,
    deckName: payload.name,
    src,
    duplicates: payload.duplicates,
    file: { name: fileName || '表格编辑' }
  });
}

/** 导入成功提示（共导入 X 张卡片到牌组「YYY」） */
export function importSuccessHtml(res) {
  const extra = [
    res.skipped ? `跳过牌组内已存在 ${res.skipped} 张` : '',
    res.duplicates ? `跳过文件内重复 ${res.duplicates} 张` : '',
    res.logsWritten ? `恢复复习日志 ${res.logsWritten} 条` : ''
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    `<p class="import-ok">共导入 <b>${res.added}</b> 张卡片到牌组「<b>${esc(res.name)}</b>」` +
    `${res.existing ? '（追加）' : '（新建）'}</p>` +
    (extra ? `<p class="csv-hint">${esc(extra)}</p>` : '') +
    `<p class="csv-hint">牌组现有 ${(res.deck && res.deck.cards ? res.deck.cards.length : 0)} 张卡片。</p>`
  );
}

/** 导入完成弹窗：提示 + 「去学习」（跳转到该牌组） */
export function showImportSuccess(res) {
  const actions = [
    {
      label: '去学习',
      cls: 'btn-primary',
      onClick: () => {
        setTimeout(() => navigate(`#/deck/${res.deckId}`), 120);
        return true;
      }
    }
  ];
  if (res.historyId) {
    actions.push({
      label: '撤销导入',
      cls: 'btn-ghost',
      onClick: async () => {
        const r = await undoImport(res.historyId);
        toast(r.ok ? '已撤销本次导入' : `撤销失败：${r.error || '未知错误'}`, r.ok ? undefined : 'error');
        if (r.ok) navigate('#/home');
        return true;
      }
    });
  }
  actions.push({ label: '关闭', cls: 'btn-ghost' });
  return openModal({ title: '导入完成', body: importSuccessHtml(res), actions });
}

/* ------------------------------ 多文件批量导入 ------------------------------ */

function fileRowHtml(name, note) {
  return `<div class="history-item glass"><div class="history-main"><b>${esc(name)}</b><span class="csv-meta">${esc(note)}</span></div></div>`;
}

/** 批量导入确认弹窗（每个文件 → 各自新建一个卡组） */
export function openBatchImport(files) {
  const all = Array.from(files || []).filter(Boolean);
  const list = all.filter((f) => isSupportedFile(f.name));
  const bad = all.filter((f) => !isSupportedFile(f.name));
  if (!list.length) {
    toast('没有可导入的文件（支持 CSV / TSV / JSON / XLSX）', 'warn');
    return null;
  }
  return openModal({
    title: `批量导入（${list.length} 个文件）`,
    wide: true,
    body:
      '<p class="csv-hint">将<b>每个文件新建为一个卡组</b>，按表头 / 位置自动映射字段（如需逐列调整，请单独导入该文件）。</p>' +
      `<div class="history-list">${list
        .map((f) => fileRowHtml(f.name, `${Math.max(0, Math.round((f.size || 0) / 1024))} KB`))
        .join('')}${bad.map((f) => fileRowHtml(f.name, '已跳过：不支持的文件类型')).join('')}</div>`,
    actions: [
      {
        label: '开始导入',
        cls: 'btn-primary',
        onClick: () => {
          runBatchImport(list);
          return true;
        }
      },
      { label: '取消', cls: 'btn-ghost' }
    ]
  });
}

/**
 * 执行批量导入：每个文件新建一个卡组；记录历史（可整批撤销）。
 * @returns {Promise<{done:object[], failed:{name:string,error:string}[], historyId:string|null}>}
 */
export async function runBatchImport(files) {
  const list = Array.from(files || []).filter(Boolean);
  toast(`正在导入 ${list.length} 个文件…`);
  const done = [];
  const failed = [];
  for (const f of list) {
    try {
      const res = await importMapped(f, { deckName: deckNameFromFile(f.name) });
      done.push(res);
    } catch (e) {
      failed.push({ name: f.name, error: (e && e.message) || String(e) });
    }
  }
  const historyId = done.length ? (await recordImport(done)).id : null;
  showBatchSuccess(done, failed, historyId);
  return { done, failed, historyId };
}

/** 批量导入结果 HTML */
export function batchSuccessHtml(done, failed) {
  const ok = (done || [])
    .map((r) => fileRowHtml(r.name, `导入 ${r.added} 张${r.duplicates ? ` · 跳过文件内重复 ${r.duplicates} 张` : ''}`))
    .join('');
  const bad = (failed || []).map((f) => fileRowHtml(f.name, `失败：${f.error}`)).join('');
  return (
    `<p class="import-ok">成功导入 <b>${(done || []).length}</b> 个卡组` +
    `${(failed || []).length ? `，<b>${failed.length}</b> 个失败` : ''}。</p>` +
    `<div class="history-list">${ok}${bad}</div>`
  );
}

/** 批量导入完成弹窗（含「撤销整批导入」） */
export function showBatchSuccess(done, failed, historyId) {
  const actions = [
    {
      label: '去首页',
      cls: 'btn-primary',
      onClick: () => {
        setTimeout(() => navigate('#/home'), 120);
        return true;
      }
    }
  ];
  if (historyId) {
    actions.push({
      label: '撤销整批导入',
      cls: 'btn-ghost',
      onClick: async () => {
        const r = await undoImport(historyId);
        toast(r.ok ? `已撤销整批导入（${r.undone} 个卡组）` : `撤销失败：${r.error || '未知错误'}`, r.ok ? undefined : 'error');
        if (r.ok) navigate('#/home');
        return true;
      }
    });
  }
  actions.push({ label: '关闭', cls: 'btn-ghost' });
  return openModal({ title: '批量导入完成', wide: true, body: batchSuccessHtml(done, failed), actions });
}

/* ------------------------------ 拖拽区域 ------------------------------ */

/** 文件名是否为 .xlsx（Excel 工作簿，走二进制解析） */
export function isXlsxFile(name) {
  return /\.xlsx$/i.test(String(name || ''));
}

/** 文件名是否为支持的类型（CSV / TSV / JSON / TXT / XLSX） */
export function isSupportedFile(name) {
  return /\.(csv|tsv|json|txt|xlsx)$/i.test(String(name || ''));
}

/** 首页拖拽区（拖入即预览；点击等同「导入」按钮） */
export function dropzoneHtml() {
  return `<div class="dropzone" data-dropzone="file-import" data-action="import-file" role="button" tabindex="0"
    aria-label="拖入 CSV / TSV / JSON / XLSX 文件导入词库（支持多个）">
    <span class="dropzone-icon"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
      stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/>
      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg></span>
    <span class="dropzone-text"><b>拖入 CSV / TSV / JSON / XLSX 文件</b> 即可预览并导入为新卡组<em>（可拖入多个文件批量导入，也可点击这里选择）</em></span>
  </div>`;
}

/**
 * 绑定拖拽区事件（渲染后调用）。drop 后走 openImportPreview（与点选文件一致）。
 * @returns {number} 绑定的拖拽区数量
 */
export function bindDropzone(root) {
  const zones = root && typeof root.querySelectorAll === 'function' ? root.querySelectorAll('[data-dropzone]') : [];
  let bound = 0;
  const list = zones && typeof zones.forEach === 'function' ? zones : Array.from(zones || []);
  list.forEach((zone) => {
    if (!zone || typeof zone.addEventListener !== 'function') return;
    const setDrag = (on) => {
      if (!zone.classList) return;
      if (on) zone.classList.add('is-drag');
      else zone.classList.remove('is-drag');
    };
    zone.addEventListener('dragover', (e) => {
      if (e && e.preventDefault) e.preventDefault();
      setDrag(true);
    });
    zone.addEventListener('dragleave', () => setDrag(false));
    zone.addEventListener('drop', (e) => {
      if (e && e.preventDefault) e.preventDefault();
      setDrag(false);
      const files = e && e.dataTransfer ? e.dataTransfer.files : null;
      const list2 = files ? Array.from(files) : [];
      if (!list2.length) {
        toast('没有读取到文件，请重试', 'warn');
        return;
      }
      const valid = list2.filter((f) => isSupportedFile(f.name));
      if (!valid.length) {
        toast('仅支持 CSV / TSV / JSON / TXT / XLSX 文件', 'warn');
        return;
      }
      if (valid.length === 1) openImportPreview(valid[0]);
      else openBatchImport(valid); // 拖入多个文件 → 批量导入
    });
    bound += 1;
  });
  return bound;
}

on('import-file', () => {
  openFilePicker();
});

/* 下载标准 CSV 模版（首页导入栏 → 先选「示例行变体」） */
on('download-csv-template', () => {
  openCsvTemplateDialog();
});

/* 下载标准 JSON 模版（首页导入栏） */
on('download-json-template', () => {
  downloadJsonTemplate();
});
