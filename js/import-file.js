// ============================================================================
// import-file.js — 从本地文件导入词库（CSV / JSON）
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
//
// 导出：解析 / 预览 / 校验等纯函数（便于单测）+ 打开预览 / 导入 + 首页按钮与拖拽区
// ============================================================================

import * as store from './store.js';
import { on, toast, navigate, esc, openModal, readForm } from './ui.js';

export const ACCEPT = '.json,.csv,.tsv,.txt,application/json,text/csv,text/plain,text/tab-separated-values';
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
 * 导入本地文件为新建卡组（source=null → 每次都新建，不做来源去重）。
 * @returns {{ deck:object, name:string, words:number, duplicates:number, truncated:boolean }}
 */
export async function importDeckFromFile(file, { source = null } = {}) {
  if (!file) throw new Error('没有选择文件');
  const text = await readFileAsText(file);
  const parsed = validatePayload(parseByFilename(file.name, text));
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

/** 预览元信息（文件名 / 分隔符 / 行列数 / 表头识别情况） */
export function previewMetaHtml(preview, filename = '') {
  const bits = [];
  if (preview.kind === 'csv') bits.push(`分隔符：${delimiterLabel(preview.delimiter)}`);
  bits.push(`共 ${preview.totalRows} 行 × ${preview.cols} 列`);
  bits.push(preview.kind === 'json' ? 'JSON 词库' : preview.header ? '已识别表头（首行为列名）' : '未识别表头（列名用「列 1…」）');
  const shown = Math.min(PREVIEW_ROWS, preview.totalRows);
  return (
    `<p class="csv-meta">${esc(filename)}${filename ? ' · ' : ''}${esc(bits.join(' · '))}</p>` +
    `<p class="csv-hint">仅预览前 ${shown} 行；确认后将整份文件导入为<b>新卡组</b>（按难度编排关卡）。</p>`
  );
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

/** 读取预览弹窗里的映射表与目标牌组选择 */
export function readPreviewInputs(overlay, preview) {
  const form = overlay && typeof overlay.querySelectorAll === 'function' ? readForm(overlay) : {};
  const cols = Math.max(1, (preview && preview.cols) || 1);
  const mapping = Array.from({ length: cols }, (_, i) => form[`col-${i}`] || 'ignore');
  const target = form.target || '__new__';
  const deckName = String(form.newDeckName || '').trim();
  return { mapping, target, deckName };
}

/* ------------------------------ 首页入口 ------------------------------ */

/** 首页「导入词库」按钮（CSV / JSON） */
export function importFileButtonHtml() {
  return `<button class="icon-btn glass" data-action="import-file" aria-label="导入词库文件（CSV / JSON）" title="导入词库文件（CSV / JSON）"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M4 16v2.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V16"/></svg></button>`;
}

/** 打开系统文件选择器（动态创建 input，不污染 index.html） */
export function openFilePicker() {
  if (typeof document === 'undefined' || !document.createElement) return null;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = ACCEPT;
  input.style.display = 'none';
  if (document.body && document.body.appendChild) document.body.appendChild(input);

  const cleanup = () => {
    if (input.parentNode && input.parentNode.removeChild) input.parentNode.removeChild(input);
  };

  input.onchange = () => {
    const file = input.files && input.files[0];
    cleanup();
    if (!file) return;
    openImportPreview(file); // 先预览，确认后再导入
  };

  input.click();
  return input;
}

/**
 * 打开「导入预览」弹窗：前 10 行表格 + 自动识别分隔符 + 行列统计。
 * 点「确认导入」才真正写入卡组（复用 importDeckFromFile）。
 */
export async function openImportPreview(file) {
  if (!file) {
    toast('没有选择文件', 'warn');
    return null;
  }
  let text = '';
  try {
    text = await readFileAsText(file);
  } catch (e) {
    toast(`读取失败：${(e && e.message) || e}`, 'error');
    return null;
  }
  let preview = null;
  try {
    preview = buildPreview(file.name, text);
  } catch (e) {
    toast(`解析失败：${(e && e.message) || e}`, 'error');
    return null;
  }
  if (!preview.totalRows) {
    toast('解析不出有效数据行，请检查文件内容', 'warn');
    return null;
  }

  const overlay = openModal({
    title: '导入预览',
    wide: true,
    body:
      previewMetaHtml(preview, file.name) +
      previewTableHtml(preview) +
      (preview.kind === 'csv' ? fieldMapHtml(preview) : '') +
      targetDeckHtml(file, {
        decks: store.getDb().decks.map((d) => ({ id: d.id, name: d.name, count: (d.cards || []).length })),
        defaultName: deckNameFromFile(file.name)
      }),
    actions: [
      {
        label: '确认导入',
        cls: 'btn-primary',
        onClick: () => {
          const inputs = readPreviewInputs(overlay, preview);
          if (preview.kind === 'csv') {
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
  return overlay;
}

/**
 * 预览弹窗 → 按映射与目标牌组导入（完整解析，不只前 10 行）。
 * @param {File} file
 * @param {{mapping?:string[], target?:string, deckName?:string}} inputs
 * @returns {Promise<{deck:object, deckId:string, name:string, added:number, skipped:number, duplicates:number, existing:boolean}>}
 */
export async function runMappedImport(file, inputs = {}) {
  if (!file) return null;
  toast(`正在导入「${file.name}」…`);
  try {
    const res = await importMapped(file, {
      mapping: inputs.mapping || null,
      deckId: inputs.target && inputs.target !== '__new__' ? inputs.target : '',
      deckName: inputs.deckName || ''
    });
    showImportSuccess(res);
    return res;
  } catch (e) {
    console.error(e);
    toast(`导入失败：${(e && e.message) || e}`, 'error');
    return null;
  }
}

/**
 * 导入本地文件到目标牌组（CSV 按映射取列；JSON 走既有解析）。
 * - 指定 deckId：追加进已有牌组（跳过已存在的单词）并重拆关卡
 * - 指定 deckName：新建牌组（难度分层 + 错峰编排）
 */
export async function importMapped(file, { mapping = null, deckId = '', deckName = '', src = 'batch_import' } = {}) {
  if (!file) throw new Error('没有选择文件');
  const text = await readFileAsText(file);
  const isJson = /\.json$/i.test(String(file.name || '')) || /^\s*[[{]/.test(text);
  let words = [];
  let duplicates = 0;
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
  return commitWords(words, { deckId, deckName, src, duplicates, file });
}

/** 写入目标牌组（已有牌组 → 追加去重；否则新建） */
function commitWords(words, { deckId, deckName, src, duplicates, file }) {
  if (deckId) {
    const deck = store.getDeck(deckId);
    if (!deck) throw new Error('目标牌组不存在');
    const existing = new Set(deck.cards.map((c) => String(c.front || '').toLowerCase()));
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
    const after = store.getDeck(deck.id);
    return { deck: after, deckId: deck.id, name: after.name, added: fresh.length, skipped, duplicates, existing: true };
  }
  const name = String(deckName || deckNameFromFile(file && file.name)).trim() || DEFAULT_DECK_NAME;
  const payload = validatePayload({ name, description: '', tags: ['导入'], words });
  const deck = store.seedBuiltinDeck(payload, {
    demo: false,
    source: null,
    meta: { name: payload.name, tags: payload.tags, lang: 'en' }
  });
  if (!deck) throw new Error('导入失败：没有可写入的词条');
  return { deck, deckId: deck.id, name: deck.name, added: deck.cards.length, skipped: 0, duplicates: payload.duplicates, existing: false };
}

/** 导入成功提示（共导入 X 张卡片到牌组「YYY」） */
export function importSuccessHtml(res) {
  const extra = [
    res.skipped ? `跳过牌组内已存在 ${res.skipped} 张` : '',
    res.duplicates ? `跳过文件内重复 ${res.duplicates} 张` : ''
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
  return openModal({
    title: '导入完成',
    body: importSuccessHtml(res),
    actions: [
      {
        label: '去学习',
        cls: 'btn-primary',
        onClick: () => {
          setTimeout(() => navigate(`#/deck/${res.deckId}`), 120);
          return true;
        }
      },
      { label: '关闭', cls: 'btn-ghost' }
    ]
  });
}

/* ------------------------------ 拖拽区域 ------------------------------ */

/** 文件名是否为支持的类型（CSV / TSV / JSON / TXT） */
export function isSupportedFile(name) {
  return /\.(csv|tsv|json|txt)$/i.test(String(name || ''));
}

/** 首页拖拽区（拖入即预览；点击等同「导入」按钮） */
export function dropzoneHtml() {
  return `<div class="dropzone" data-dropzone="file-import" data-action="import-file" role="button" tabindex="0"
    aria-label="拖入 CSV / JSON 文件导入词库">
    <span class="dropzone-icon"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
      stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/>
      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg></span>
    <span class="dropzone-text"><b>拖入 CSV / JSON 文件</b> 即可预览并导入为新卡组<em>（也可点击这里选择文件）</em></span>
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
      const file = files && files.length ? files[0] : null;
      if (!file) {
        toast('没有读取到文件，请重试', 'warn');
        return;
      }
      if (!isSupportedFile(file.name)) {
        toast('仅支持 CSV / TSV / JSON / TXT 文件', 'warn');
        return;
      }
      openImportPreview(file);
    });
    bound += 1;
  });
  return bound;
}

on('import-file', () => {
  openFilePicker();
});
