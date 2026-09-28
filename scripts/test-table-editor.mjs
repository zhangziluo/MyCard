#!/usr/bin/env node
// ============================================================================
// test-table-editor.mjs — 表格编辑页（#/editor）：模版列 / 纯函数内核 / 文件载入 / 导入链路
//   运行: node scripts/test-table-editor.mjs
// 覆盖：列与 CSV 模版一致 / 行增删移 / 单元格编辑 / 统计（缺单词·重复·可导入）/
//       CSV 导出（BOM · CRLF · 表头）/ 草稿存取 / 从 CSV·TSV·JSON 载入 /
//       与文件导入同链路的导入（新建 · 追加 · 去重 · 可撤销）/ 页面 HTML 与事件注册
// ============================================================================

import { installFakeIndexedDB } from './fake-idb.mjs';

/* ---------- 浏览器全局桩 ---------- */
const mem = {};
globalThis.localStorage = {
  getItem(k) {
    return k in mem ? mem[k] : null;
  },
  setItem(k, v) {
    mem[k] = String(v);
  },
  removeItem(k) {
    delete mem[k];
  },
  clear() {
    for (const k of Object.keys(mem)) delete mem[k];
  }
};
globalThis.sessionStorage = globalThis.localStorage;

function fakeEl(tag = 'div') {
  const classes = new Set();
  return {
    tagName: tag,
    innerHTML: '',
    value: '',
    dataset: {},
    style: {},
    className: '',
    textContent: '',
    children: [],
    parentNode: null,
    files: [],
    classList: {
      add(c) {
        classes.add(c);
      },
      remove(c) {
        classes.delete(c);
      },
      toggle(c) {
        classes.has(c) ? classes.delete(c) : classes.add(c);
      },
      contains(c) {
        return classes.has(c);
      }
    },
    appendChild(c) {
      this.children.push(c);
      if (c) c.parentNode = this;
      return c;
    },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      if (c) c.parentNode = null;
      return c;
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
    remove() {},
    focus() {},
    setAttribute() {},
    click() {
      this.clicked = true;
    }
  };
}

const body = fakeEl('body');
/** 稳定的 #view 元素：让页内 rerender() 有落点（与浏览器一致） */
const viewEl = fakeEl('section');
/** 统计条元素：验证「输入单元格 → 只刷新统计，不整页重渲染」 */
const statsEl = fakeEl('p');
viewEl.querySelector = (sel) => (sel === '.te-stats' ? statsEl : null);

globalThis.document = {
  body,
  documentElement: fakeEl('html'),
  addEventListener() {},
  removeEventListener() {},
  querySelector() {
    return null;
  },
  querySelectorAll() {
    return [];
  },
  getElementById(id) {
    return id === 'view' ? viewEl : fakeEl();
  },
  createElement(tag) {
    return fakeEl(tag);
  }
};
globalThis.window = { addEventListener() {}, dispatchEvent() {}, scrollTo() {} };
globalThis.location = { hash: '#/editor', href: '' };
globalThis.HashChangeEvent = class HashChangeEvent {
  constructor(t) {
    this.type = t;
  }
};
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

let pass = 0;
let fail = 0;
function ok(cond, msg, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + msg);
  } else {
    fail++;
    console.error('  ✗ ' + msg, extra === undefined ? '' : extra);
  }
}

/** 模拟 data-action 事件（走 ui.handleEvent 事件委托） */
async function fire(action, dataset = {}, type = 'click', value = undefined) {
  const ui = await import('../js/ui.js');
  const el = { dataset: { action, ...dataset }, classList: { add() {}, remove() {} } };
  if (value !== undefined) el.value = value;
  el.closest = () => el;
  ui.handleEvent({ type, target: { closest: () => el }, preventDefault() {} });
}
/** 文本文件桩（走 File.text() 分支） */
function makeFile(name, text) {
  return { name, size: text.length, text: async () => text };
}
const cellCount = (html) => (html.match(/class="te-cell"/g) || []).length;

installFakeIndexedDB();
const store = await import('../js/store.js');
const imp = await import('../js/import-file.js');
const hist = await import('../js/import-history.js');
const te = await import('../js/table-editor.js'); // 注册 te-* 动作

console.log('\n[列与标准 CSV 模版一致]');
{
  ok(
    te.TABLE_COLUMNS.join(',') === imp.CSV_TEMPLATE_COLUMNS.join(','),
    '表格列 = CSV 模版列（模版为准）',
    te.TABLE_COLUMNS
  );
  ok(te.TABLE_COLUMNS.join(',') === '单词,释义,例句,例句翻译,音标,标签', '列名与顺序', te.TABLE_COLUMNS.join(','));
  ok(te.TABLE_FIELDS.join(',') === 'front,back,example,exampleZh,phonetic,tags', '列 → 字段映射顺序');
  ok(te.TABLE_COL_COUNT === 6 && te.TABLE_COL_HINTS.length === 6, '列数 / 占位提示数 = 6');
  ok(te.TABLE_DRAFT_KEY === 'mycard-table-draft', '草稿存储键');
  ok(te.TABLE_DEFAULT_DECK_NAME === '表格导入' && /\.csv$/.test(te.TABLE_CSV_FILENAME), '默认卡组名 / 导出文件名');
  ok(te.TABLE_FIELDS.every((f) => imp.MAPPABLE_FIELDS.includes(f)), '所有字段均在 MAPPABLE_FIELDS 内（与文件导入可映射字段同源）');
}

console.log('\n[表格规整：列数 / 空值 / 整行空白]');
{
  const blank = te.blankRow();
  ok(blank.length === 6 && blank.every((c) => c === ''), 'blankRow 6 列空字符串');

  const norm = te.normalizeTable([['a', 'b'], 0, ['x', null, 3]]);
  ok(norm.length === 3, '保留行数');
  ok(norm[0].join('|') === 'a|b||||', '短行补空到 6 列', norm[0]);
  ok(norm[1].every((c) => c === ''), '非数组行 → 空行');
  ok(norm[2][0] === 'x' && norm[2][1] === '' && norm[2][2] === '3', 'null → 空串，数字 → 字符串', norm[2]);

  const grid = te.normalizeTable([]);
  ok(Array.isArray(grid) && grid.length === 0, '空输入不报错');
  ok(te.normalizeTable(null).length === 0, 'null 输入不报错');

  const cleaned = te.cleanRows([['a'], ['', '', ''], ['  ', ''], ['b'], ['', '只有释义']]);
  ok(cleaned.length === 3, '整行为空的行被剔除（保留只有释义的行）', cleaned.length);
}

console.log('\n[表格 → 词条（与文件导入同字段解析）]');
{
  const longFront = 'x'.repeat(81);
  const words = te.tableToWords([
    ['apple', '苹果', 'An apple.', '一个苹果。', '/ˈæpl/', '水果, 基础'],
    ['', '只有释义'],
    [longFront, '超长单词'],
    ['pear', '梨']
  ]);
  ok(words.length === 2, '丢弃「没有单词」与「单词超长」的行', words.map((w) => w.front));
  ok(words[0].front === 'apple' && words[0].back === '苹果', '前两列 → front / back', words[0]);
  ok(words[0].example === 'An apple.' && words[0].exampleZh === '一个苹果。', '例句 / 例句翻译透传');
  ok(words[0].phonetic === '/ˈæpl/', '音标透传');
  ok(words[0].tags.join('|') === '水果|基础', '标签按逗号切分去空格', words[0].tags);
  ok(words[1].front === 'pear' && words[1].example === undefined && words[1].tags === undefined, '空单元格不产生空字段', words[1]);
  ok(te.tableToWords([['', '']]).length === 0, '空表 → 0 条');

  const back = te.wordsToTable([{ front: 'a', back: 'b', tags: ['x', 'y'] }, { front: 'c' }]);
  ok(back.length === 2 && back[0].join('|') === 'a|b||||x,y', '词条 → 表格（标签拼回一列）', back[0]);
  ok(te.wordsToTable(null).length === 0, 'wordsToTable(null) 安全');
  ok(te.tableToWords(te.wordsToTable([{ front: 'a', back: 'b', tags: ['x', 'y'] }]))[0].tags.join('|') === 'x|y', '表格 ⇄ 词条 往返一致');
}

console.log('\n[统计：已填 / 缺单词 / 重复 / 可导入]');
{
  const longFront = 'x'.repeat(81);
  const st = te.tableStats([
    ['apple', '苹果'],
    ['pear', '梨'],
    ['Apple', '重复（大小写不同也算）'],
    ['', '缺单词'],
    ['', '', ''],
    [longFront, '超长'],
    ['grape', '葡萄']
  ]);
  ok(st.total === 7, '总行数 7');
  ok(st.filled === 6, '已填 6（整行空白不计）', st.filled);
  ok(st.missing === 2, '缺单词 2（空 / 超长）', st.missing);
  ok(st.duplicates === 2 || st.dupeRows.size === 2, '重复行 2（apple / Apple 都标黄）', [...st.dupeRows]);
  ok(st.dupeRows.has(0) && st.dupeRows.has(2), '重复行下标正确（首行也标记）');
  ok(st.importable === 3, '去重后可导入 3 条', st.importable);

  const empty = te.tableStats([te.blankRow(), te.blankRow()]);
  ok(empty.filled === 0 && empty.importable === 0 && empty.dupeRows.size === 0, '全空表统计为 0');
}

console.log('\n[行操作：加 / 删 / 上下移 / 改单元格]');
{
  const rows = [
    ['a', '1'],
    ['b', '2'],
    ['c', '3']
  ];
  const added = te.addRow(rows);
  ok(added.length === 4 && added[3].every((c) => c === ''), '末尾加一行空行', added.length);
  ok(rows.length === 3, 'addRow 不修改原表格（返回新表）');
  const inserted = te.addRow(rows, 1);
  ok(inserted.length === 4 && inserted[1].every((c) => c === '') && inserted[2][0] === 'b', '在指定位置插入');
  ok(te.addRow(rows, 99).length === 4, '越界位置收敛到末尾');

  const removed = te.removeRow(rows, 1);
  ok(removed.length === 2 && removed[0][0] === 'a' && removed[1][0] === 'c', '删除第 2 行', removed.map((r) => r[0]));
  ok(te.removeRow(rows, 9).length === 3 && te.removeRow(rows, -1).length === 3, '越界删除原样返回');

  const up = te.moveRow(rows, 2, -1);
  ok(up.map((r) => r[0]).join('') === 'acb', '上移第 3 行', up.map((r) => r[0]));
  const down = te.moveRow(rows, 0, 1);
  ok(down.map((r) => r[0]).join('') === 'bac', '下移第 1 行', down.map((r) => r[0]));
  ok(te.moveRow(rows, 0, -1).map((r) => r[0]).join('') === 'abc', '首行上移 = 原样');
  ok(te.moveRow(rows, 2, 1).map((r) => r[0]).join('') === 'abc', '末行下移 = 原样');

  const edited = te.setCell(rows, 1, 0, 'B');
  ok(edited[1][0] === 'B' && rows[1][0] === 'b', 'setCell 返回新表且不改原表');
  ok(te.setCell(rows, 1, 0, null)[1][0] === '', 'null → 空串');
  ok(JSON.stringify(te.setCell(rows, 9, 0, 'x')) === JSON.stringify(te.normalizeTable(rows)), '越界行原样返回');
  ok(JSON.stringify(te.setCell(rows, 0, 9, 'x')) === JSON.stringify(te.normalizeTable(rows)), '越界列原样返回');
}

console.log('\n[对齐模版：无表头按位置 / 有表头按别名（任意顺序）]');
{
  const plain = te.alignToTemplate([['apple', '苹果'], ['pear', '梨']]);
  ok(plain.length === 2 && plain[0][0] === 'apple' && plain[0][1] === '苹果' && plain[0][5] === '', '无表头按位置映射', plain[0]);

  const mapped = te.alignToTemplate([
    ['音标', '单词', '标签', '释义'],
    ['/ˈæpl/', 'apple', '水果', '苹果']
  ]);
  ok(mapped.length === 1, '表头行不进入数据');
  ok(mapped[0][0] === 'apple' && mapped[0][1] === '苹果', '乱序表头按别名对号（front / back）', mapped[0]);
  ok(mapped[0][4] === '/ˈæpl/' && mapped[0][5] === '水果', '音标 / 标签对号正确', mapped[0]);
  ok(mapped[0][2] === '' && mapped[0][3] === '', '未出现的列留空');

  const en = te.alignToTemplate([['word', 'meaning', 'ipa'], ['hello', '你好', '/h/']]);
  ok(en[0][0] === 'hello' && en[0][1] === '你好' && en[0][4] === '/h/', '英文表头同样对号', en[0]);

  const noHeaderCols = te.alignToTemplate([['我', '是', '表头', '但认不出'], ['a', 'b']]);
  ok(noHeaderCols.length === 2, '认不出 front 的表头 → 当作数据行', noHeaderCols.length);
  ok(te.alignToTemplate([]).length === 0 && te.alignToTemplate(null).length === 0, '空输入安全');
}

console.log('\n[导出 CSV（与「下载 CSV 模版」同格式，可直接回导）]');
{
  const rows = [['apple', '苹果', '', '', '', '水果,基础'], ['', '', ''], ['pear', '梨']];
  const csvRows = te.tableCsvRows(rows);
  ok(csvRows.length === 3, '表头 + 2 个已填行（空行不导出）', csvRows.length);
  ok(csvRows[0].join(',') === imp.CSV_TEMPLATE_COLUMNS.join(','), '首行 = 模版列名');

  const text = te.tableCsvText(rows);
  ok(text.charCodeAt(0) === 0xfeff, '带 UTF-8 BOM（Excel 中文不乱码）');
  ok(text.endsWith('\r\n'), 'CRLF 行尾');
  const lines = text.slice(1).replace(/\r\n$/, '').split('\r\n');
  ok(lines.length === 3 && lines[0] === '单词,释义,例句,例句翻译,音标,标签', '首行为标准列名', lines[0]);
  ok(lines[1] === 'apple,苹果,,,,"水果,基础"', '含逗号的标签被引号包裹', lines[1]);

  // 回导：导出的 CSV 再走一次真实解析 + 表头对号
  const parsed = imp.parseCsv(text);
  ok(imp.isHeaderRow(parsed[0]) === true, '导出的 CSV 首行被识别为表头');
  const back = imp.rowsToWords(parsed);
  ok(back.length === 2 && back[0].front === 'apple' && back[0].tags.join('|') === '水果|基础', '导出的 CSV 可被首页导入解析', back[0]);
  ok(te.tableCsvText([te.blankRow()]).slice(1).replace(/\r\n$/, '') === '单词,释义,例句,例句翻译,音标,标签', '空表仅导出表头');
}

console.log('\n[草稿：本机自动保存 / 恢复]');
{
  te.clearDraft();
  ok(te.loadDraft().length === 0, '无草稿 → 空');

  ok(te.saveDraft([['apple', '苹果'], ['pear', '梨']]) === true, 'saveDraft 返回成功');
  const draft = te.loadDraft();
  ok(draft.length === 2 && draft[0][0] === 'apple' && draft[0].length === 6, '草稿按 6 列规整后取回', draft[0]);
  ok(String(mem[te.TABLE_DRAFT_KEY]).includes('"apple"'), '草稿写入 localStorage（JSON）');

  te.clearDraft();
  ok(te.loadDraft().length === 0, 'clearDraft 清空草稿');

  mem[te.TABLE_DRAFT_KEY] = '{不是 JSON';
  ok(te.loadDraft().length === 0, '草稿损坏 → 空表兜底（不抛错）');
  mem[te.TABLE_DRAFT_KEY] = '{"a":1}';
  ok(te.loadDraft().length === 0, '草稿不是数组 → 空表兜底');
  delete mem[te.TABLE_DRAFT_KEY];
}

console.log('\n[从文件载入：CSV / TSV / JSON]');
{
  const csv = await te.tableRowsFromFile(
    makeFile('my.csv', '单词,音标,释义\napple,/ˈæpl/,苹果\npear,/peə/,梨\n')
  );
  ok(csv.length === 2, 'CSV：解析出 2 行', csv.length);
  ok(csv[0][0] === 'apple' && csv[0][1] === '苹果' && csv[0][4] === '/ˈæpl/', 'CSV：表头乱序也按别名对号', csv[0]);
  ok(csv[1][0] === 'pear' && csv[1][1] === '梨', 'CSV：第 2 行正确', csv[1]);

  const csvNoHeader = await te.tableRowsFromFile(makeFile('plain.csv', 'apple,苹果\npear,梨\n'));
  ok(csvNoHeader.length === 2 && csvNoHeader[0][1] === '苹果', 'CSV：无表头按位置映射', csvNoHeader[0]);

  const tsv = await te.tableRowsFromFile(makeFile('my.tsv', 'apple\t苹果\npear\t梨\n'));
  ok(tsv.length === 2 && tsv[1][1] === '梨', 'TSV：按制表符解析', tsv[1]);

  const json = await te.tableRowsFromFile(
    makeFile('deck.json', JSON.stringify({ name: '甲组', words: [{ front: 'a', back: 'b', tags: ['x', 'y'] }] }))
  );
  ok(json.length === 1 && json[0][0] === 'a' && json[0][1] === 'b' && json[0][5] === 'x,y', 'JSON：词条 → 表格', json[0]);

  const extJson = await te.tableRowsFromFile(
    makeFile('words.txt', JSON.stringify({ words: [{ front: 'z', back: '乙', example: 'Zed.' }] }))
  );
  ok(extJson.length === 1 && extJson[0][2] === 'Zed.', '按内容识别 JSON（扩展名非 .json）', extJson[0]);

  let err = null;
  try {
    await te.tableRowsFromFile(makeFile('empty.json', JSON.stringify({ words: [] })));
  } catch (e) {
    err = e;
  }
  ok(!!err && /没有解析到有效词条/.test(String(err.message)), '空 JSON → 抛错（由页面 toast 提示）', err && err.message);

  err = null;
  try {
    await te.tableRowsFromFile(null);
  } catch (e) {
    err = e;
  }
  ok(!!err, '未选文件 → 抛错');
}

console.log('\n[页面 HTML（#/editor 的渲染产物）]');
{
  te.resetEditorState();
  te.renderTableEditor(viewEl);
  const html = viewEl.innerHTML;
  ok(html.includes('class="view table-editor-view"'), '页面根容器');
  ok(html.includes('class="te-table"'), '可编辑表格');
  ok(html.includes('class="te-stats"'), '统计条');
  ok(html.includes('class="te-tools"'), '工具栏');
  ok(html.includes('class="te-target"'), '目标卡组选择');
  for (const col of te.TABLE_COLUMNS) ok(html.includes(`<th scope="col">${col}</th>`), `表头列「${col}」`);
  ok(cellCount(html) === 18, '默认 3 行 × 6 列 = 18 个可编辑单元格', cellCount(html));
  ok(html.includes('value="表格导入"'), '默认新卡组名「表格导入」');
  ok(html.includes('＋ 新建卡组'), '默认目标 = 新建卡组');
  for (const a of ['te-import-deck', 'te-load-file', 'te-add-row', 'te-download', 'te-clear']) {
    ok(html.includes(`data-action="${a}"`), `工具栏按钮 ${a}`);
  }
  ok((html.match(/data-action="te-cell"/g) || []).length === 18, '每个单元格带 te-cell action');
  ok(html.includes('data-action="te-move-up"') && html.includes('data-action="te-move-down"') && html.includes('te-op-del'), '行内 上移 / 下移 / 删除 按钮');
  ok(html.includes('行已填') && html.includes('条可导入') && html.includes('共 3 行'), '统计条含 已填 / 可导入 / 总行数');
  ok(html.includes('class="csv-hint"'), '表下提示文案');
  ok(te.renderTableEditor(null) === undefined, 'root 为空时不报错');

  const link = te.tableEditorLinkHtml();
  ok(link.includes('data-action="open-table-editor"') && link.includes('在网页里填表格'), '首页入口按钮 HTML');
}

console.log('\n[事件委托：单元格 / 行操作 / 目标卡组]');
{
  te.resetEditorState();
  te.renderTableEditor(viewEl);

  await fire('te-cell', { row: '0', col: '0' }, 'input', 'apple');
  await fire('te-cell', { row: '0', col: '1' }, 'input', '苹果');
  ok(te.currentTableRows()[0][0] === 'apple' && te.currentTableRows()[0][1] === '苹果', '输入单元格写入状态');
  ok(statsEl.innerHTML.includes('<b>1</b> 行已填'), '统计条即时刷新', statsEl.innerHTML);
  ok(cellCount(viewEl.innerHTML) === 18, '只刷统计不重建表格（保住光标）');
  ok(viewEl.innerHTML.includes('<b>0</b> 行已填'), '未重建的整页 HTML 仍是旧快照（证明没整页重渲染）');

  await fire('te-add-row');
  ok(te.currentTableRows().length === 4 && cellCount(viewEl.innerHTML) === 24, '＋ 添加一行 → 4 行 × 6 列', cellCount(viewEl.innerHTML));
  ok(viewEl.innerHTML.includes('共 4 行'), '重渲染后统计含总行数');

  await fire('te-deck-name', {}, 'input', '  我的词表  ');
  await fire('te-add-row');
  ok(viewEl.innerHTML.includes('我的词表'), '卡组名输入被记住（重渲染保留）');

  await fire('te-move-down', { row: '0' });
  ok(te.currentTableRows()[1][0] === 'apple' && te.currentTableRows()[1][1] === '苹果', '下移：整行跟随');
  ok(te.currentTableRows()[0].every((c) => c === ''), '下移：空行让位到首行');
  await fire('te-move-up', { row: '1' });
  ok(te.currentTableRows()[0][0] === 'apple', '上移还原');

  const n = te.currentTableRows().length;
  await fire('te-del-row', { row: String(n - 1) });
  ok(te.currentTableRows().length === n - 1, '删除末行');
  for (let i = 0; i < 9; i++) await fire('te-del-row', { row: '0' });
  ok(te.currentTableRows().length === 1, '反复删除 → 至少保留 1 行');

  await fire('te-cell', { row: '0', col: '0' }, 'input', '');
  ok(te.currentTableRows()[0].every((c) => c === ''), '清空最后一个单元格');
  await fire('te-clear');
  ok(te.currentTableRows().length === 1, '空表格点「清空」→ 只提示，不动数据');
  await fire('te-download');
  ok(true, '空表格点「下载 CSV」→ 只提示，不抛错');

  const picker = te.openTableFilePicker();
  ok(picker && picker.type === 'file' && picker.multiple === false && picker.accept.includes('.csv'), '文件选择器（单文件 · 支持 CSV/TSV/XLSX/JSON）', picker && picker.accept);
  ok(picker.parentNode === body, '选择器挂到 body 上（触发浏览器文件框）', picker.parentNode === body);

  // 首页入口动作 → 跳转 #/editor
  globalThis.location.hash = '#/home';
  await fire('open-table-editor');
  ok(globalThis.location.hash === '#/editor', '首页入口 → 跳转 #/editor', globalThis.location.hash);
}

console.log('\n[导入为卡组：新建（校验 / 去重 / 历史）]');
{
  await hist.clearHistory();
  te.resetEditorState();
  te.renderTableEditor(viewEl);

  const fill = [
    ['0', 'apple', '苹果', 'An apple.', '一个苹果。', '/ˈæpl/', '水果,基础'],
    ['1', 'Apple', '大小写重复'],
    ['2', 'pear', '梨']
  ];
  for (const [row, ...cells] of fill) {
    for (let col = 0; col < cells.length; col++) await fire('te-cell', { row, col: String(col) }, 'input', cells[col]);
  }
  const st = te.tableStats(te.currentTableRows());
  ok(st.filled === 3 && st.duplicates === 2 && st.importable === 2, '统计：3 行已填 / 2 行重复 / 2 条可导入', { filled: st.filled, dup: st.duplicates, imp: st.importable });

  const decksBefore = store.getDb().decks.length;
  const res = await te.importTableToDeck();
  ok(!!res, '导入返回结果');
  ok(res.mode === 'new' && res.existing === false, '默认「新建卡组」', res && res.mode);
  ok(res.name === '表格导入', '卡组名 = 表格默认名', res && res.name);
  ok(res.added === 2 && res.duplicates === 1, '2 张入库 + 1 张文件内重复被去掉', res && { added: res.added, duplicates: res.duplicates });
  ok(res.addedCardIds.length === 2, '记录新增卡片 id（供精确回滚）');
  ok(imp.importSuccessHtml(res).includes('跳过文件内重复 1 张'), '成功弹窗会说明跳过重复（与文件导入同文案）');
  ok(store.getDb().decks.length === decksBefore + 1, '卡组数 +1');
  ok(!!res.historyId && (await hist.undoableIds()).has(res.historyId), '写入导入历史（与文件导入一致，可撤销）');
  ok((await hist.listImports()).length === 1, '历史里 1 条导入记录');

  const deck = store.getDeck(res.deckId);
  ok(deck.cards.length === 2, '卡组内 2 张卡片', deck.cards.map((c) => c.front));
  const apple = deck.cards.find((c) => c.front === 'apple');
  ok(!!apple && apple.back === '苹果' && apple.example === 'An apple.' && apple.phonetic === '/ˈæpl/', '卡片字段完整（释义 / 例句 / 音标）', apple);
  ok(apple.tags.join('|') === '水果|基础', '标签写入卡片', apple.tags);
  ok(deck.cards.every((c) => c.level === 0 && c.levelPassed !== true), '新建卡组：全部从第 1 关开始');
  ok(deck.source === null && deck.demo === false, 'source=null / 非示范（与文件导入一致）', { source: deck.source, demo: deck.demo });

  // 撤销导入 → 卡组消失（与文件导入共用 import-history）
  const undo = await hist.undoImport(res.historyId);
  ok(undo.ok && !store.getDeck(res.deckId), '撤销导入 → 新建卡组被移除', undo);
}

console.log('\n[导入为卡组：追加到已有卡组（跳过已存在 / 精确回滚）]');
{
  await hist.clearHistory();
  const host = store.createDeck({ name: '已有卡组' });
  store.addManyCards(host.id, [{ front: 'apple', back: '旧苹果' }]);

  // 复用上一节的表格：把第 3 行改成新词，切目标为已有卡组
  await fire('te-cell', { row: '2', col: '0' }, 'input', 'grape');
  await fire('te-cell', { row: '2', col: '1' }, 'input', '葡萄');
  await fire('te-target', {}, 'change', host.id);
  ok(viewEl.innerHTML.includes(`value="${host.id}"`) && viewEl.innerHTML.includes('已有卡组（1 张）'), '目标切到已有卡组（下拉选中）', host.id);

  const res = await te.importTableToDeck();
  ok(!!res && res.mode === 'append' && res.existing === true, '追加模式', res && res.mode);
  ok(res.added === 1 && res.skipped === 1, '只新增 1 张（apple 已存在被跳过）', res && { added: res.added, skipped: res.skipped });
  ok(res.duplicates === 1, '表内重复（Apple）同样去重', res && res.duplicates);

  const after = store.getDeck(host.id);
  ok(after.cards.length === 2, '追加后卡组 2 张', after.cards.map((c) => c.front));
  ok(after.cards.find((c) => c.front === 'apple').back === '旧苹果', '原有卡片不被覆盖');
  ok(!!after.cards.find((c) => c.front === 'grape'), '新词已写入');

  const undo = await hist.undoImport(res.historyId);
  ok(undo.ok && store.getDeck(host.id).cards.length === 1, '撤销只移除本次新增的卡', undo);
  ok(store.getDeck(host.id).cards[0].front === 'apple', '原卡片保留');

  // 目标卡组被删除 → 提示重选（不抛错）
  const gone = store.createDeck({ name: '马上删除' });
  await fire('te-target', {}, 'change', gone.id);
  store.deleteDeck(gone.id);
  const res3 = await te.importTableToDeck();
  ok(res3 === null, '目标卡组已不存在 → 返回 null（toast 提示重选）');

  // 空表格导入 → 直接拒绝
  te.resetEditorState();
  te.renderTableEditor(viewEl);
  ok((await te.importTableToDeck()) === null, '空表格导入 → 返回 null');

  await hist.clearHistory();
}

console.log(`\n表格编辑结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);




