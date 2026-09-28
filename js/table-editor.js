// ============================================================================
// table-editor.js — 可编辑表格页（#/editor）：在网页里按标准模版列录入词表
//
// 定位：导入环节的「网页内录入」入口 —— 不必先有文件，直接在浏览器里逐格填写、
//       从文件载入或粘贴，确认无误后一次导入为卡组（新建 / 追加）。
// 以模版为准：列固定为 CSV 模版列（单词 / 释义 / 例句 / 例句翻译 / 音标 / 标签），
//             与「下载 CSV 模版」「本地文件导入」同源（CSV_TEMPLATE_COLUMNS）。
// 复用：解析 / 校验 / 去重 / 写库 / 导入历史回滚全部复用 import-file.js 的既有函数，
//       本模块只负责「表格状态 + 编辑 UI」，保证与文件导入结果一致。
// ============================================================================

import * as store from './store.js';
import { on, toast, esc, navigate, confirmDialog } from './ui.js';
import {
  ACCEPT,
  CSV_TEMPLATE_COLUMNS,
  applyMapping,
  csvText,
  downloadCsvRows,
  importWordsToDeck,
  isHeaderRow,
  isSupportedFile,
  isXlsxFile,
  mapHeader,
  parseByFilename,
  parseCsv,
  readFileAsArrayBuffer,
  readFileAsText,
  showImportSuccess,
  validatePayload
} from './import-file.js';
import { parseXlsxRows } from './xlsx.js';
import { recordImport } from './import-history.js';

/* ------------------------------ 常量（模版为准） ------------------------------ */

/** 表格列名 = 标准 CSV 模版列（单词 / 释义 / 例句 / 例句翻译 / 音标 / 标签） */
export const TABLE_COLUMNS = CSV_TEMPLATE_COLUMNS;
/** 列 → 内部字段（顺序与 TABLE_COLUMNS 一一对应） */
export const TABLE_FIELDS = ['front', 'back', 'example', 'exampleZh', 'phonetic', 'tags'];
export const TABLE_COL_COUNT = TABLE_COLUMNS.length;
/** 逐列占位提示（示例写法，与 CSV 模版示例行一致） */
export const TABLE_COL_HINTS = ['word', '释义', 'Example sentence.', '例句翻译', '/ˈwɜːd/', '标签,逗号分隔'];
/** 草稿存储键（编辑中的表格自动保存在本机浏览器） */
export const TABLE_DRAFT_KEY = 'mycard-table-draft';
/** 表格行数上限（与导入上限同量级，避免把浏览器存爆） */
export const MAX_TABLE_ROWS = 5000;
export const TABLE_DEFAULT_DECK_NAME = '表格导入';
export const TABLE_CSV_FILENAME = 'Mycard-表格.csv';

/* ------------------------------ 纯函数内核 ------------------------------ */

/** 一行空行（列数与模版一致） */
export function blankRow() {
  return TABLE_FIELDS.map(() => '');
}

/** 任意二维数组 → 规整的表格（列数 = 模版列数，单元格一律转字符串） */
export function normalizeTable(rows) {
  const grid = Array.isArray(rows) ? rows : [];
  return grid.map((r) => {
    const out = blankRow();
    if (Array.isArray(r)) {
      for (let i = 0; i < TABLE_COL_COUNT; i++) out[i] = r[i] == null ? '' : String(r[i]);
    }
    return out;
  });
}

/** 去掉整行为空的行（导入 / 下载前清理） */
export function cleanRows(rows) {
  return normalizeTable(rows).filter((r) => r.some((c) => c.trim() !== ''));
}

/** 表格 → 词条数组（与文件导入同一套字段解析：front/back/example/exampleZh/phonetic/tags） */
export function tableToWords(rows) {
  return applyMapping(cleanRows(rows), TABLE_FIELDS);
}

/** 词条数组 → 表格（从 JSON 词表载入用；标签用逗号拼回一列） */
export function wordsToTable(words) {
  return (words || []).map((w) => [
    String((w && w.front) ?? ''),
    String((w && w.back) ?? ''),
    String((w && w.example) ?? ''),
    String((w && w.exampleZh) ?? ''),
    String((w && w.phonetic) ?? ''),
    Array.isArray(w && w.tags) ? w.tags.join(',') : String((w && w.tags) ?? '')
  ]);
}

/** 表格统计（行数 / 已填 / 缺单词 / 重复 / 可导入条数 + 重复行下标） */
export function tableStats(rows) {
  const grid = normalizeTable(rows);
  const seen = new Map();
  const dupeRows = new Set();
  let filled = 0;
  let missing = 0;
  for (let i = 0; i < grid.length; i++) {
    const r = grid[i];
    if (!r.some((c) => c.trim() !== '')) continue;
    filled++;
    const front = r[0].trim();
    if (!front || front.length > 80) {
      missing++;
      continue;
    }
    const key = front.toLowerCase();
    if (seen.has(key)) {
      dupeRows.add(i);
      dupeRows.add(seen.get(key));
    } else {
      seen.set(key, i);
    }
  }
  return {
    total: grid.length,
    filled,
    missing,
    duplicates: dupeRows.size,
    importable: seen.size,
    dupeRows
  };
}

/** 修改一个单元格（返回新表格，便于测试与不可变更新） */
export function setCell(rows, row, col, value) {
  const grid = normalizeTable(rows);
  if (row < 0 || row >= grid.length || col < 0 || col >= TABLE_COL_COUNT) return grid;
  grid[row][col] = value == null ? '' : String(value);
  return grid;
}

/** 在 at（默认末尾）插入一行空行 */
export function addRow(rows, at = null) {
  const grid = normalizeTable(rows);
  const i = at == null ? grid.length : Math.max(0, Math.min(grid.length, Number(at) || 0));
  grid.splice(i, 0, blankRow());
  return grid;
}

/** 删除第 i 行 */
export function removeRow(rows, i) {
  const grid = normalizeTable(rows);
  if (i < 0 || i >= grid.length) return grid;
  grid.splice(i, 1);
  return grid;
}

/** 上移 / 下移（delta = -1 / +1），越界原样返回 */
export function moveRow(rows, i, delta) {
  const grid = normalizeTable(rows);
  const j = i + delta;
  if (i < 0 || i >= grid.length || j < 0 || j >= grid.length) return grid;
  const [row] = grid.splice(i, 1);
  grid.splice(j, 0, row);
  return grid;
}

/**
 * 任意二维数组 → 按模版列对齐（供「从文件载入」用）：
 * 识别到表头时按中英文别名对号（列顺序任意），否则按位置 front,back,example,exampleZh,phonetic,tags。
 */
export function alignToTemplate(grid) {
  const rows = (Array.isArray(grid) ? grid : []).filter((r) => Array.isArray(r));
  if (!rows.length) return [];
  let body = rows;
  let idx = TABLE_FIELDS.map((_, i) => i);
  if (isHeaderRow(rows[0])) {
    const map = mapHeader(rows[0]);
    if (map) {
      idx = TABLE_FIELDS.map((f) => (map[f] == null ? -1 : map[f]));
      body = rows.slice(1);
    }
  }
  return body.map((r) => {
    const out = blankRow();
    idx.forEach((src, i) => {
      out[i] = src >= 0 && r[src] != null ? String(r[src]) : '';
    });
    return out;
  });
}

/** 表格 → CSV 二维数组（表头 = 模版列名 + 已填数据行） */
export function tableCsvRows(rows) {
  return [TABLE_COLUMNS.slice(), ...cleanRows(rows)];
}

/** 表格 → CSV 文本（UTF-8 BOM + CRLF，与「下载 CSV 模版」同格式） */
export function tableCsvText(rows) {
  return csvText(tableCsvRows(rows));
}

/* ------------------------------ 草稿（本机自动保存） ------------------------------ */

export function loadDraft() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(TABLE_DRAFT_KEY) : null;
    const data = raw ? JSON.parse(raw) : null;
    return Array.isArray(data) ? normalizeTable(data) : [];
  } catch (e) {
    return [];
  }
}

export function saveDraft(rows) {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(TABLE_DRAFT_KEY, JSON.stringify(normalizeTable(rows).slice(0, MAX_TABLE_ROWS)));
    return true;
  } catch (e) {
    return false;
  }
}

export function clearDraft() {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(TABLE_DRAFT_KEY);
  } catch (e) {}
}

/* ------------------------------ 文件载入 ------------------------------ */

/**
 * 读取本地文件 → 按模版列对齐的表格行（CSV / TSV / TXT 走分隔符解析；XLSX 走 xlsx.js；JSON 走词库解析）。
 * 解析失败会抛出带原因的错误，由调用方 toast 展示。
 */
export async function tableRowsFromFile(file) {
  if (!file) throw new Error('没有选择文件');
  const name = String(file.name || '');
  if (isXlsxFile(name)) {
    return alignToTemplate(await parseXlsxRows(await readFileAsArrayBuffer(file)));
  }
  const text = await readFileAsText(file);
  const isJson = /\.json$/i.test(name) || /^\s*[[{]/.test(text);
  if (isJson) {
    const payload = validatePayload(parseByFilename(name, text));
    return wordsToTable(payload.words);
  }
  const grid = parseCsv(text, { delimiter: /\.tsv$/i.test(name) ? '\t' : null });
  return alignToTemplate(grid);
}

/* ------------------------------ 页面状态（模块级，重渲染保留） ------------------------------ */

let rows = [];
let target = '__new__'; // '__new__' 或已有牌组 id
let deckName = TABLE_DEFAULT_DECK_NAME;
let ready = false;
let saveTimer = null;

/** 首次进入编辑页：恢复草稿（没有草稿时给 3 行空行） */
function ensureState() {
  if (ready) return;
  ready = true;
  rows = loadDraft();
  if (!rows.length) rows = [blankRow(), blankRow(), blankRow()];
}

/** 待写草稿：编辑时防抖，避免每次按键都写 localStorage */
function saveDraftSoon() {
  if (saveTimer && typeof clearTimeout === 'function') clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveDraft(rows);
  }, 400);
}

/** 仅测试用：重置页面状态（不影响草稿） */
export function resetEditorState({ clear = true } = {}) {
  ready = false;
  rows = [];
  target = '__new__';
  deckName = TABLE_DEFAULT_DECK_NAME;
  if (clear) clearDraft();
}

/** 当前表格快照（只读副本，供导入 / 测试 / 调试查看） */
export function currentTableRows() {
  return normalizeTable(rows);
}

/* ------------------------------ HTML ------------------------------ */

function statsHtml() {
  const st = tableStats(rows);
  const parts = [
    `<span class="te-stat"><b>${st.filled}</b> 行已填</span>`,
    `<span class="te-stat te-stat-ok"><b>${st.importable}</b> 条可导入</span>`
  ];
  if (st.missing) parts.push(`<span class="te-stat te-stat-warn"><b>${st.missing}</b> 行缺少单词</span>`);
  if (st.duplicates) parts.push(`<span class="te-stat te-stat-warn"><b>${st.duplicates}</b> 行单词重复</span>`);
  parts.push(`<span class="te-stat">共 ${st.total} 行</span>`);
  return parts.join('<span class="te-sep">·</span>');
}

function targetHtml() {
  const decks = store.getDb().decks.map((d) => ({ id: d.id, name: d.name, count: (d.cards || []).length }));
  const opts = decks
    .map(
      (d) =>
        `<option value="${esc(d.id)}"${target === d.id ? ' selected' : ''}>${esc(d.name)}（${d.count} 张）</option>`
    )
    .join('');
  return `<div class="te-target">
    <p class="fm-title">导入到卡组<span class="fm-hint">（新建 → 按难度自动编排关卡；追加 → 与已有卡片一起去重）</span></p>
    <div class="dt-row">
      <select class="dt-select" name="te-target" data-action="te-target" aria-label="目标卡组">
        <option value="__new__"${target === '__new__' ? ' selected' : ''}>＋ 新建卡组</option>
        ${opts}
      </select>
    </div>
    <div class="dt-row"><input class="dt-input" name="te-deck-name" data-action="te-deck-name" type="text"
      value="${esc(deckName)}" placeholder="新卡组名称" autocomplete="off" ${target === '__new__' ? '' : 'disabled'} /></div>
  </div>`;
}

function rowHtml(r, i, st) {
  const cells = TABLE_COLUMNS.map(
    (label, c) =>
      `<td class="te-cell-td"><input class="te-cell" type="text" data-action="te-cell" data-row="${i}" data-col="${c}"
        value="${esc(r[c])}" placeholder="${esc(TABLE_COL_HINTS[c] || '')}" title="${esc(r[c])}"
        aria-label="第 ${i + 1} 行 ${esc(label)}" autocomplete="off" spellcheck="false" /></td>`
  ).join('');
  const dup = st.dupeRows.has(i);
  const bad = rowNeedsFront(r);
  return `<tr class="te-row${dup ? ' te-dup' : ''}${bad ? ' te-bad' : ''}" data-row="${i}">
    <td class="te-idx">${i + 1}</td>
    ${cells}
    <td class="te-ops">
      <button class="te-op" data-action="te-move-up" data-row="${i}" title="上移" aria-label="上移第 ${i + 1} 行"${i === 0 ? ' disabled' : ''}>↑</button>
      <button class="te-op" data-action="te-move-down" data-row="${i}" title="下移" aria-label="下移第 ${i + 1} 行"${i === st.total - 1 ? ' disabled' : ''}>↓</button>
      <button class="te-op te-op-del" data-action="te-del-row" data-row="${i}" title="删除本行" aria-label="删除第 ${i + 1} 行">✕</button>
    </td>
  </tr>`;
}

/** 整行填了内容、但「单词」列缺失或超长（导入时会被跳过）→ 高亮提醒 */
function rowNeedsFront(r) {
  if (!r.some((c) => c.trim() !== '')) return false;
  const front = r[0].trim();
  return !front || front.length > 80;
}

function tableHtml() {
  const st = tableStats(rows);
  const head = TABLE_COLUMNS.map((c) => `<th scope="col">${esc(c)}</th>`).join('');
  return `<div class="te-table-wrap">
    <table class="te-table">
      <thead><tr><th class="te-idx" scope="col">#</th>${head}<th class="te-ops" scope="col">操作</th></tr></thead>
      <tbody>${rows.map((r, i) => rowHtml(r, i, st)).join('')}</tbody>
    </table>
  </div>`;
}

/** 表格编辑页整体 HTML（列以 CSV 模版为准） */
export function tableEditorHtml() {
  return `
  <div class="view table-editor-view">
    <section class="panel glass">
      <h2 class="screen-title">表格编辑</h2>
      <p class="panel-desc">按标准模版列「${TABLE_COLUMNS.map(esc).join(' / ')}」逐格填写，或从 CSV / TSV / XLSX / JSON 载入后继续编辑，确认无误再导入为卡组。编辑内容会自动保存在本机浏览器（草稿）。</p>
    </section>

    <section class="panel glass te-panel">
      <div class="te-tools">
        <button class="btn btn-primary" data-action="te-import-deck">导入为卡组</button>
        <button class="btn btn-ghost" data-action="te-load-file">从文件载入</button>
        <button class="btn btn-ghost" data-action="te-add-row">＋ 添加一行</button>
        <button class="btn btn-ghost" data-action="te-download">下载 CSV</button>
        <button class="btn btn-ghost" data-action="te-clear">清空表格</button>
      </div>
      <p class="te-stats">${statsHtml()}</p>
      ${targetHtml()}
    </section>

    <section class="panel glass te-panel">
      ${tableHtml()}
      <p class="csv-hint">提示：单词列必填（超长或为空的整行会被跳过）；标签列用逗号分隔（如「水果,基础」）；重复单词会标黄，导入时自动去重。手填的列顺序与「下载 CSV 模版」完全一致，导出的 CSV 可直接用首页导入。</p>
    </section>
  </div>`;
}

/** 渲染表格编辑页（app.js 路由 #/editor 调用） */
export function renderTableEditor(root) {
  ensureState();
  if (!root) return;
  root.innerHTML = tableEditorHtml();
}

/** 首页「在网页里填表格」入口（导入栏） */
export function tableEditorLinkHtml() {
  return `<button class="btn-link" data-action="open-table-editor" title="在网页里用可编辑表格填写词表，再导入为卡组">在网页里填表格</button>`;
}

/* ------------------------------ 重渲染 ------------------------------ */

function viewEl() {
  try {
    return typeof document !== 'undefined' && document.getElementById ? document.getElementById('view') : null;
  } catch (e) {
    return null;
  }
}

/** 重新渲染编辑页（保留 rows / target / deckName 状态） */
function rerender() {
  const el = viewEl();
  if (el) renderTableEditor(el);
}

/** 只刷新统计与行状态（单元格输入时用，避免光标丢失） */
function refreshStats() {
  const el = viewEl();
  if (!el || typeof el.querySelector !== 'function') return;
  const host = el.querySelector('.te-stats');
  if (host) host.innerHTML = statsHtml();
}

/* ------------------------------ 交互逻辑 ------------------------------ */

/** 读取 data-row 下标 */
function rowIndex(el, fallback = -1) {
  const i = el && el.dataset ? Number(el.dataset.row) : NaN;
  return Number.isInteger(i) ? i : fallback;
}

/** 提交导入：表格 → 词条 → 与文件导入完全一致的链路（校验 / 去重 / 写库 / 历史） */
export async function importTableToDeck() {
  const words = tableToWords(rows);
  if (!words.length) {
    toast('表格里还没有可导入的内容：每行至少要填「单词」列', 'warn');
    return null;
  }
  const name = String(deckName || '').trim() || TABLE_DEFAULT_DECK_NAME;
  const addToExisting = target && target !== '__new__';
  if (addToExisting && !store.getDeck(target)) {
    toast('目标卡组已不存在，请重新选择', 'warn');
    return null;
  }
  try {
    const res = importWordsToDeck(words, {
      deckId: addToExisting ? target : '',
      deckName: name,
      src: 'table_editor',
      fileName: '表格编辑'
    });
    const entry = await recordImport([res]);
    res.historyId = entry.id;
    showImportSuccess(res);
    return res;
  } catch (e) {
    console.error('[mycard] 表格导入失败', e);
    toast(`导入失败：${(e && e.message) || e}`, 'error');
    return null;
  }
}

/** 选择本地文件（CSV / TSV / TXT / XLSX / JSON）并载入表格 */
export function openTableFilePicker({ onFile = null } = {}) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = ACCEPT;
  input.multiple = false;
  input.style.display = 'none';
  if (document.body && document.body.appendChild) document.body.appendChild(input);
  const cleanup = () => {
    if (input.parentNode && input.parentNode.removeChild) input.parentNode.removeChild(input);
  };
  input.onchange = () => {
    const files = input.files ? Array.from(input.files) : [];
    cleanup();
    if (files.length && onFile) onFile(files[0]);
  };
  if (typeof input.click === 'function') input.click();
  return input;
}

/** 把文件内容载入表格（覆盖前会先确认，避免误丢手填内容） */
export async function loadFileIntoTable(file) {
  if (!file) return null;
  const filename = String(file.name || '');
  if (!isSupportedFile(filename)) {
    toast('仅支持 CSV / TSV / TXT / XLSX / JSON 文件', 'warn');
    return null;
  }
  let loaded = [];
  try {
    loaded = await tableRowsFromFile(file);
  } catch (e) {
    toast(`载入失败：${(e && e.message) || e}`, 'error');
    return null;
  }
  if (!loaded.length) {
    toast('没有从文件里解析到有效行', 'warn');
    return null;
  }
  const st = tableStats(rows);
  if (st.filled) {
    const ok = await confirmDialog(`载入会覆盖当前表格（已填 ${st.filled} 行），是否继续？`, { title: '载入文件' });
    if (!ok) return null;
  }
  rows = loaded.slice(0, MAX_TABLE_ROWS);
  saveDraft(rows);
  rerender();
  toast(`已载入 ${tableStats(rows).filled} 行：${filename}`, 'good');
  return rows;
}

/* ------------------------------ 事件注册 ------------------------------ */

/** 首页入口 → 跳到表格编辑页 */
on('open-table-editor', () => navigate('#/editor'));

/** 单元格输入：只更新状态与统计，不整页重渲染（保住光标） */
on(
  'te-cell',
  (el) => {
    if (!el || !el.dataset) return;
    rows = setCell(rows, rowIndex(el), Number(el.dataset.col), el.value);
    refreshStats();
    saveDraftSoon();
  },
  'input'
);

/** 目标卡组切换：新建 ⇄ 追加 */
on(
  'te-target',
  (el) => {
    target = (el && el.value) || '__new__';
    saveDraftSoon();
    rerender();
  },
  'change'
);

/** 新卡组名称输入 */
on(
  'te-deck-name',
  (el) => {
    deckName = (el && el.value) || '';
    saveDraftSoon();
  },
  'input'
);

/** ＋ 添加一行 */
on('te-add-row', () => {
  if (rows.length >= MAX_TABLE_ROWS) {
    toast(`最多 ${MAX_TABLE_ROWS} 行，先导入或清空一部分吧`, 'warn');
    return;
  }
  rows = addRow(rows);
  saveDraftSoon();
  rerender();
});

/** 上移 / 下移 */
on('te-move-up', (el) => {
  rows = moveRow(rows, rowIndex(el), -1);
  saveDraftSoon();
  rerender();
});
on('te-move-down', (el) => {
  rows = moveRow(rows, rowIndex(el), 1);
  saveDraftSoon();
  rerender();
});

/** 删除本行（至少保留一行，避免空表格没法继续填） */
on('te-del-row', (el) => {
  rows = removeRow(rows, rowIndex(el));
  if (!rows.length) rows = [blankRow()];
  saveDraftSoon();
  rerender();
});

/** 清空表格（含草稿） */
on('te-clear', async () => {
  const st = tableStats(rows);
  if (!st.filled) {
    toast('表格已经是空的', 'info');
    return;
  }
  const ok = await confirmDialog('确定清空表格吗？未导入的内容会一并删除。', { title: '清空表格', danger: true });
  if (!ok) return;
  rows = [blankRow(), blankRow(), blankRow()];
  clearDraft();
  rerender();
  toast('已清空表格');
});

/** 下载 CSV（表头 = 模版列名，可直接用首页导入） */
on('te-download', () => {
  const st = tableStats(rows);
  if (!st.filled) {
    toast('表格还是空的，先填一行再下载吧', 'warn');
    return null;
  }
  return downloadCsvRows(TABLE_CSV_FILENAME, tableCsvRows(rows));
});

/** 从文件载入 */
on('te-load-file', () => openTableFilePicker({ onFile: loadFileIntoTable }));

/** 导入为卡组 */
on('te-import-deck', () => importTableToDeck());



