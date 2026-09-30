#!/usr/bin/env node
// ============================================================================
// test-import-file.mjs — 本地文件导入词库（CSV / JSON）测试
//   运行: node scripts/test-import-file.mjs
// 覆盖：CSV 解析（引号/转义/分隔符/BOM/CRLF）/ 表头识别（中英文/乱序/无表头）/
//       JSON 解析（对象格式 + 数组）/ 校验去重 / FileReader 读取 /
//       CSV 预览 / 字段映射 / 目标牌组 / 端到端导入 / 首页按钮与文件选择器
// ============================================================================

import { installFakeIndexedDB } from './fake-idb.mjs';

/* ---------- 浏览器全局桩 ---------- */
const mem = {};
const storage = {
  getItem(k) { return k in mem ? mem[k] : null; },
  setItem(k, v) { mem[k] = String(v); },
  removeItem(k) { delete mem[k]; }
};
globalThis.localStorage = storage;
globalThis.sessionStorage = storage;

function fakeEl(tag = 'div') {
  const classes = new Set();
  return {
    tagName: tag, innerHTML: '', value: '', dataset: {}, style: {}, className: '', textContent: '',
    children: [], parentNode: null, files: [],
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      toggle(c) { classes.has(c) ? classes.delete(c) : classes.add(c); },
      contains(c) { return classes.has(c); }
    },
    appendChild(c) { this.children.push(c); if (c) c.parentNode = this; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); if (c) c.parentNode = null; return c; },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, remove() {}, focus() {}, setAttribute() {}, click() { this.clicked = true; }
  };
}
const body = fakeEl('body');
globalThis.document = {
  body,
  documentElement: fakeEl('html'),
  addEventListener() {}, removeEventListener() {},
  querySelector() { return null; }, querySelectorAll() { return []; },
  getElementById() { return fakeEl(); },
  createElement(tag) { return fakeEl(tag); }
};
globalThis.window = { addEventListener() {}, dispatchEvent() {}, scrollTo() {} };
globalThis.location = { hash: '#/home', href: '' };
globalThis.HashChangeEvent = class HashChangeEvent { constructor(t) { this.type = t; } };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

/** FileReader 桩 */
globalThis.FileReader = class FakeFileReader {
  readAsText(file) {
    this.result = String((file && file.__text) || '');
    if (this.onload) this.onload();
  }
};
function makeFile(name, text) {
  return { name, size: text.length, __text: text };
}
/** 二进制文件桩（xlsx 走 file.arrayBuffer()） */
function makeBinFile(name, bytes) {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return { name, size: bytes.length, arrayBuffer: async () => buf };
}
/** 等一个宏任务（预览是异步读取 → 打开弹窗） */
const tick = () => new Promise((r) => setTimeout(r, 0));
/** body 中当前打开的弹窗数量 */
const modalCount = () => body.children.filter((c) => c && c.className === 'modal-overlay').length;

installFakeIndexedDB();
const store = await import('../js/store.js');
const imp = await import('../js/import-file.js');
const ex = await import('../js/export.js'); // 复用 ZIP 写出器拼测试用 .xlsx

/** 列号 → Excel 列名（0 → A，26 → AA） */
function colName(i) {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
/** XML 文本转义（内联字符串用） */
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

/**
 * 用「共享字符串 + STORED ZIP」拼一个最小 xlsx（不含 workbook.xml，走 sheet1.xml 回退）。
 * @param {string[][]} rows
 */
function xlsxBytes(rows) {
  const idx = new Map();
  const items = [];
  const si = (v) => {
    const s = String(v);
    if (!idx.has(s)) {
      idx.set(s, items.length);
      items.push(`<si><t>${xmlEsc(s)}</t></si>`);
    }
    return idx.get(s);
  };
  const sheetRows = rows
    .map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => `<c r="${colName(ci)}${ri + 1}" t="s"><v>${si(v)}</v></c>`).join('')}</row>`)
    .join('');
  return ex.zipStore([
    { name: 'xl/sharedStrings.xml', data: `<?xml version="1.0"?><sst>${items.join('')}</sst>` },
    { name: 'xl/worksheets/sheet1.xml', data: `<?xml version="1.0"?><worksheet><sheetData>${sheetRows}</sheetData></worksheet>` }
  ]);
}

/**
 * 多工作表 xlsx（workbook.xml + rels + 两张表：词表 / 备份；内联字符串）。
 */
function xlsxMultiBytes() {
  const sheetXml = (rows) =>
    `<?xml version="1.0"?><worksheet><sheetData>${rows
      .map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => `<c r="${colName(ci)}${ri + 1}" t="inlineStr"><is><t>${xmlEsc(v)}</t></is></c>`).join('')}</row>`)
      .join('')}</sheetData></worksheet>`;
  const workbook =
    `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
    `<sheet name="词表" sheetId="1" r:id="rId1"/><sheet name="备份" sheetId="2" r:id="rId2"/></sheets></workbook>`;
  const rels =
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="x/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`;
  return ex.zipStore([
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml([['单词', '释义'], ['apple', '苹果'], ['book', '书']]) },
    { name: 'xl/worksheets/sheet2.xml', data: sheetXml([['单词', '释义'], ['cat', '猫']]) }
  ]);
}

let pass = 0;
let fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

console.log('\n[CSV 解析]');
{
  const rows = imp.parseCsv('word,meaning\napple,苹果\nbook,书\n');
  ok(rows.length === 3, '基础 CSV 解析出行数 3', rows.length);
  ok(rows[0].join('|') === 'word|meaning', '首行为表头');
  ok(rows[1][1] === '苹果', '第二列内容正确');

  const quoted = imp.parseCsv('front,back\n"give up","放弃, 认输"\n"say ""hi""","打招呼"\n');
  ok(quoted[1][1] === '放弃, 认输', '引号内的逗号不会被切分', quoted[1][1]);
  ok(quoted[2][0] === 'say "hi"', '"" 转义为单个引号', quoted[2][0]);

  const boms = imp.parseCsv('\uFEFFword,meaning\r\napple,苹果\r\n');
  ok(boms[0][0] === 'word', '去除 BOM（首格不带 \\uFEFF）', boms[0][0]);
  ok(boms.length === 2, 'CRLF 换行解析正确', boms.length);

  const multiline = imp.parseCsv('front,back\n"a\nb",x\n');
  ok(multiline.length === 2 && multiline[1][0].includes('\n'), '引号内的换行被保留为一个字段');

  const empty = imp.parseCsv('a,b\n\nc,d\n\ne,f\n');
  ok(empty.length === 3, '跳过空行（保留 3 行数据）', empty.length);
  ok(imp.parseCsv('a,b\n\n\n')[1] === undefined, '末尾空白行被丢弃');
  ok(imp.parseCsv('').length === 0, '空文本 → 空数组');
  ok(imp.parseCsv('   \n  \n').length === 0, '纯空白文本 → 空数组');

  ok(imp.detectDelimiter('a,b,c') === ',', '嗅探逗号分隔');
  ok(imp.detectDelimiter('a\tb\tc') === '\t', '嗅探制表符分隔');
  ok(imp.detectDelimiter('a;b;c') === ';', '嗅探分号分隔');
  ok(imp.parseCsv('word\tmeaning\napple\t苹果')[1][1] === '苹果', 'TSV 自动按制表符切分');
  ok(imp.parseCsv('word|meaning', { delimiter: '|' })[0][1] === 'meaning', '可显式指定分隔符');
}

console.log('\n[表头识别与列映射]');
{
  const en = imp.parseCsv('word,meaning,phonetic,tags\napple,苹果,ˈæpl,fruit\n');
  const w1 = imp.rowsToWords(en);
  ok(w1.length === 1 && w1[0].front === 'apple', '英文表头 → front');
  ok(w1[0].back === '苹果' && w1[0].phonetic === 'ˈæpl', '英文表头 → back/phonetic', w1[0]);
  ok(w1[0].tags.join(',') === 'fruit', 'tags 逗号分隔解析', w1[0].tags);

  const zh = imp.parseCsv('单词,释义,例句,例句翻译\napple,苹果,An apple a day.,一天一苹果。\n');
  const w2 = imp.rowsToWords(zh);
  ok(w2[0].front === 'apple' && w2[0].back === '苹果', '中文表头 → front/back');
  ok(w2[0].example === 'An apple a day.' && w2[0].exampleZh === '一天一苹果。', '中文表头 → 例句/例句翻译');

  const reorder = imp.parseCsv('meaning,word\na book,book\n');
  const w3 = imp.rowsToWords(reorder);
  ok(w3[0].front === 'book' && w3[0].back === 'a book', '列顺序不限（按表头定位）');

  const noHeader = imp.parseCsv('apple,苹果,An apple.\nbook,书,\n');
  ok(imp.isHeaderRow(noHeader[0]) === false, '无表头数据行不会被误判为表头');
  const w4 = imp.rowsToWords(noHeader);
  ok(w4.length === 2 && w4[0].front === 'apple' && w4[0].back === '苹果', '无表头时按位置解析');
  ok(w4[1].front === 'book' && w4[1].example === undefined, '空列不产生多余字段');

  ok(imp.isHeaderRow(imp.parseCsv('word,meaning')[0]) === true, '两列且都命中别名 → 判定为表头');
  ok(imp.isHeaderRow(imp.parseCsv('word')[0]) === false, '只有一列 → 不判定为表头');
  ok(imp.mapHeader(imp.parseCsv('单词,释义')[0]).front === 0, 'mapHeader 返回列号');
  ok(imp.mapHeader(imp.parseCsv('x,y')[0]) === null, '无法定位 front 列 → null');
  ok(imp.normalizeKey(' ExampleZH ') === 'examplezh', '字段名归一化（小写去空格）');
}

console.log('\n[JSON 解析]');
{
  const sample = JSON.stringify({
    name: '示例词库',
    description: '示例描述',
    tags: ['英语', '示例'],
    levelSize: 20,
    words: [{ front: 'abruptly', back: 'adv. 突然地', example: 'He left abruptly.', exampleZh: '他突然离开。' }]
  });
  const p1 = imp.parseImportJson(sample);
  ok(p1.name === '示例词库' && p1.tags.join(',') === '英语,示例', '词库文件格式：名称/标签', p1.name);
  ok(p1.levelSize === 20, '保留 levelSize');
  ok(p1.words[0].front === 'abruptly' && p1.words[0].exampleZh === '他突然离开。', '词条字段完整');

  const arr = imp.parseImportJson('[{"word":"apple","meaning":"苹果","ipa":"ˈæpl"}]');
  ok(arr.words[0].front === 'apple' && arr.words[0].back === '苹果', '数组格式 + word/meaning 别名', arr.words[0]);
  ok(arr.words[0].phonetic === 'ˈæpl', 'ipa 别名 → phonetic');

  const cards = imp.parseImportJson('{"cards":[{"front":"a","back":"b"}]}');
  ok(cards.words.length === 1 && cards.words[0].front === 'a', '兼容 cards 数组');

  const messy = imp.parseImportJson('{"words":[{"front":"x","back":"y","tags":"a, b"},null,{"back":"无front"}]}');
  ok(messy.words.length === 1, '过滤 null 与缺少 front 的条目', messy.words.length);
  ok(messy.words[0].tags.join(',') === 'a,b', '字符串 tags 自动切分', messy.words[0].tags);

  let e1 = null;
  try { imp.parseImportJson('{bad json'); } catch (e) { e1 = e; }
  ok(!!e1 && /JSON 解析失败/.test(e1.message), '非法 JSON → 明确报错', e1 && e1.message);
  let e2 = null;
  try { imp.parseImportJson('{"foo":1}'); } catch (e) { e2 = e; }
  ok(!!e2 && /words \/ cards/.test(e2.message), '缺少 words/cards → 明确报错', e2 && e2.message);
  let e3 = null;
  try { imp.parseImportJson('"just a string"'); } catch (e) { e3 = e; }
  ok(!!e3, '不支持的 JSON 顶层类型 → 报错');
}

console.log('\n[校验 / 去重 / payload]');
{
  const v = imp.validatePayload({ name: 'T', words: [{ front: 'a', back: '1' }, { front: 'A', back: '2' }, { front: 'b', back: '3' }] });
  ok(v.words.length === 2, '按单词去重（大小写不敏感）', v.words.length);
  ok(v.duplicates === 1, '记录重复条数', v.duplicates);
  ok(v.words[0].back === '1', '保留首次出现');
  ok(v.tags.join(',') === '导入', '默认标签「导入」');
  let e1 = null;
  try { imp.validatePayload({ words: [] }); } catch (e) { e1 = e; }
  ok(!!e1 && /有效词条/.test(e1.message), '空词表 → 报错', e1 && e1.message);
  let e2 = null;
  try { imp.validatePayload({ words: [{ back: '没有front' }] }); } catch (e) { e2 = e; }
  ok(!!e2, '全部缺少 front → 报错');

  ok(imp.deckNameFromFile('path/to/我的词表.json') === '我的词表', '文件名 → 卡组名（去路径与扩展名）');
  ok(imp.deckNameFromFile('我的词表.csv') === '我的词表', '中文文件名');
  ok(imp.deckNameFromFile('') === imp.DEFAULT_DECK_NAME, '空文件名 → 默认名');

  const byCsv = imp.parseByFilename('高中词汇.csv', 'word,meaning\napple,苹果\n');
  ok(byCsv.name === '高中词汇' && byCsv.words.length === 1, 'CSV 以文件名作为卡组名');
  const byJson = imp.parseByFilename('whatever.json', '{"words":[{"front":"a","back":"b"}]}');
  ok(byJson.name === 'whatever', 'JSON 无 name 时用文件名兜底', byJson.name);
  const sniff = imp.parseByFilename('mystery.txt', '{"name":"X","words":[{"front":"a"}]}');
  ok(sniff.name === 'X', '按内容嗅探 JSON（扩展名不匹配）', sniff.name);
}

console.log('\n[读取文件]');
{
  const text = await imp.readFileAsText(makeFile('a.csv', 'word,meaning\napple,苹果'));
  ok(text.includes('apple'), 'FileReader 路径可读取');
  const viaText = await imp.readFileAsText({ name: 'b.csv', text: async () => 'hello' });
  ok(viaText === 'hello', '优先使用 File.text()');
  let e = null;
  try { await imp.readFileAsText(null); } catch (err) { e = err; }
  ok(e === null, 'null 文件名走 FileReader 回退（不抛错）', e && e.message);
}

console.log('\n[端到端导入：CSV]');
await store.init();
{
  const csv = 'word,meaning,phonetic\napple,苹果,ˈæpl\nbook,书,bʊk\nbook,重复,bʊk\n';
  const res = await imp.importDeckFromFile(makeFile('我的词表.csv', csv));
  ok(res.name === '我的词表', '卡组名来自文件名', res.name);
  ok(res.words === 2, '导入 2 个词（重复已跳过）', res.words);
  ok(res.duplicates === 1, '报告跳过重复 1 条', res.duplicates);
  const deck = store.getDeck(res.deck.id);
  ok(deck.cards.length === 2 && deck.source === null && deck.demo === false, '落库：source=null / 非示范');
  ok(deck.cards.every((c) => c.front && c.back), '每张卡都有正面与释义');
  ok(new Set(deck.cards.map((c) => c.level)).size >= 1, '已按难度编排关卡');
  ok(deck.tags.includes('导入'), '标签含「导入」', deck.tags);
  ok(deck.cards.find((c) => c.front === 'apple').phonetic === 'ˈæpl', '音标写入卡片');

  const again = await imp.importDeckFromFile(makeFile('我的词表.csv', csv));
  ok(again.deck.id !== res.deck.id, '同一文件可再次导入（每次新建卡组，不做来源去重）');

  let e = null;
  try { await imp.importDeckFromFile(makeFile('empty.csv', 'word,meaning\n')); } catch (err) { e = err; }
  ok(!!e && /有效词条/.test(e.message), '空词表文件 → 抛错', e && e.message);
  let e2 = null;
  try { await imp.importDeckFromFile(null); } catch (err) { e2 = err; }
  ok(!!e2 && /没有选择文件/.test(e2.message), '未选择文件 → 抛错', e2 && e2.message);
}

console.log('\n[端到端导入：大词表（5000 行）]');
{
  const before = store.getDb().decks.length;
  const big = 'word,meaning\n' + Array.from({ length: 5000 }, (_, i) => `word${i},释义${i}`).join('\n') + '\n';
  const res = await imp.importDeckFromFile(makeFile('大词表.csv', big));
  ok(res.name === '大词表', '卡组名来自文件名', res.name);
  ok(res.words === 5000, '导入 5000 个词', res.words);
  const deck = store.getDeck(res.deck.id);
  ok(deck.cards.length === 5000 && store.getDb().decks.length === before + 1, '新增 1 个卡组 / 5000 张卡片');
  const levels = [...new Set(deck.cards.map((c) => c.level))];
  ok(levels.length > 15, '关卡数 > 15（会触发分页）', levels.length);
  ok(levels.every((v, i) => v === i), '关卡索引从 0 连续');
  const sizes = levels.map((i) => deck.cards.filter((c) => c.level === i).length);
  ok(sizes.every((n) => n >= 15 && n <= 30), '每关 15–30 张', [Math.min(...sizes), Math.max(...sizes)]);
  ok(deck.cards.length === new Set(deck.cards.map((c) => c.front)).size, '导入后单词不重复');
}

console.log('\n[CSV / JSON 预览（前 10 行表格）]');
{
  ok(imp.PREVIEW_ROWS === 10, '预览行数常量 = 10');
  ok(imp.delimiterLabel(',') === '逗号 ,' && imp.delimiterLabel('\t') === '制表符 Tab' && imp.delimiterLabel(';') === '分号 ;', '分隔符可读文案');

  const csv15 = 'word,meaning\n' + Array.from({ length: 15 }, (_, i) => `w${i},释义${i}`).join('\n') + '\n';
  const p1 = imp.csvPreview(csv15);
  ok(p1.kind === 'csv' && p1.delimiter === ',', '识别逗号分隔');
  ok(String(p1.header) === 'word,meaning', '首行被识别为表头', p1.header);
  ok(p1.rows.length === 10, '只取前 10 行用于预览', p1.rows.length);
  ok(p1.totalRows === 15 && p1.cols === 2, '统计总行数 / 列数', [p1.totalRows, p1.cols]);
  ok(p1.rows[0][0] === 'w0' && p1.rows[0][1] === '释义0', '预览行内容正确');

  const p2 = imp.csvPreview('alpha,阿尔法\nbeta,贝塔\n');
  ok(p2.header === null, '无表头 → header 为 null');
  ok(p2.totalRows === 2 && p2.rows.length === 2, '无表头时数据行全部计数');

  ok(imp.csvPreview('单词\t释义\nalpha\t阿尔法\n').delimiter === '\t', '制表符自动识别');
  ok(imp.csvPreview('word;meaning\nalpha;阿尔法\n').delimiter === ';', '分号自动识别');

  const j = imp.jsonPreview(JSON.stringify({ name: 'X', words: [{ front: 'a', back: '甲' }, { front: 'b', back: '乙' }] }));
  ok(j.kind === 'json' && j.totalRows === 2, 'JSON 预览统计词条数');
  ok(j.header.join('|') === '单词 front|释义 back', 'JSON 预览表头');
  ok(j.rows[0][0] === 'a' && j.rows[0][1] === '甲', 'JSON 预览行内容');
  ok(
    imp.buildPreview('x.json', '{"words":[{"front":"a"}]}').kind === 'json' && imp.buildPreview('x.csv', 'a,b').kind === 'csv',
    'buildPreview 按扩展名分流'
  );
  ok(imp.buildPreview('mystery.txt', '{"words":[{"front":"a"}]}').kind === 'json', '按内容嗅探 JSON');

  const table = imp.previewTableHtml(p1);
  ok(table.includes('class="csv-table"'), '渲染表格元素');
  ok(table.includes('<th class="csv-idx" scope="col">#</th>'), '含行号列（表头带 scope=col）');
  ok(table.includes('<th scope="col">word</th>') && table.includes('<th scope="col">meaning</th>'), '表头使用文件首行做列名（可被读屏识别为列头）');
  ok((table.match(/<tr>/g) || []).length === 11, '渲染 1 行表头 + 10 行数据', (table.match(/<tr>/g) || []).length);

  const tableNoHeader = imp.previewTableHtml(p2);
  ok(tableNoHeader.includes('<th scope="col">列 1</th>') && tableNoHeader.includes('<th scope="col">列 2</th>'), '无表头时列名用「列 1 / 列 2」');

  const escaped = imp.previewTableHtml(imp.csvPreview('word,meaning\n<script>x</script>,<b>y</b>\n'));
  ok(escaped.includes('&lt;script&gt;') && !escaped.includes('<script>'), '单元格内容做 HTML 转义');

  const meta = imp.previewMetaHtml(p1, 'my.csv');
  ok(meta.includes('my.csv') && meta.includes('分隔符：逗号'), '元信息含文件名与分隔符');
  ok(meta.includes('共 15 行 × 2 列'), '元信息含行列统计');
  ok(meta.includes('已识别表头'), '元信息标注表头识别结果');
  ok(imp.previewMetaHtml(p2, 'x.csv').includes('未识别表头（列名用「列 1…」）'), '无表头时标注列名回退');
  ok(imp.previewMetaHtml(j, 'x.json').includes('JSON 词库'), 'JSON 预览标注类型');
}

console.log('\n[预览弹窗 + 确认导入闭环]');
{
  const before = modalCount();
  const csv = 'word,meaning\napple,苹果\nbook,书\n';
  const overlay = await imp.openImportPreview(makeFile('mini.csv', csv));
  ok(!!overlay && overlay.className === 'modal-overlay', '打开预览弹窗');
  ok(modalCount() === before + 1, '弹窗已挂到 body');
  const html = String(overlay.innerHTML);
  ok(html.includes('导入预览') && html.includes('csv-table'), '弹窗含标题与预览表格');
  ok(html.includes('apple') && html.includes('苹果'), '弹窗展示前 10 行数据');
  ok(html.includes('确认导入') && html.includes('取消'), '弹窗含「确认导入 / 取消」按钮');
  ok(html.includes('modal-wide'), '宽版弹窗（表格可横向滚动）');
  ok(html.includes('字段映射') && html.includes('name="col-0"'), '弹窗含字段映射区（每列下拉）');
  ok(html.includes('目标牌组') && html.includes('name="target"') && html.includes('name="newDeckName"'), '弹窗含目标牌组选择（已有/新建）');

  ok((await imp.openImportPreview(makeFile('empty.csv', 'word,meaning\n'))) === null, '无数据行 → 不打开弹窗');
  ok((await imp.openImportPreview(null)) === null, '未选择文件 → 不打开弹窗');

  const decksBefore = store.getDb().decks.length;
  const res = await imp.runMappedImport(makeFile('mini.csv', csv), { target: '__new__', deckName: 'mini' });
  ok(!!res && res.added === 2, '确认导入写入 2 个词', res && res.added);
  ok(store.getDb().decks.length === decksBefore + 1, '确认导入后新增卡组');
  ok(store.getDb().decks[0].name === 'mini', '卡组名取自文件名', store.getDb().decks[0].name);
}

console.log('\n[首页入口 / 文件选择器]');
{
  const html = imp.importFileButtonHtml();
  ok(html.includes('data-action="import-file"'), '按钮带 import-file action');
  ok(html.includes('<svg') && html.includes('icon-btn'), '按钮为图标按钮');

  const input = imp.openFilePicker();
  ok(!!input && input.type === 'file', '创建 file input');
  ok(input.accept.includes('.csv') && input.accept.includes('.json'), 'accept 含 .csv/.json', input.accept);
  ok(input.clicked === true, '自动触发点击');
  ok(body.children.includes(input), 'input 已挂到 body');

  const before = store.getDb().decks.length;
  const beforeModals = modalCount();
  input.files = [makeFile('picker.csv', 'word,meaning\nhello,你好\n')];
  input.onchange();
  await tick();
  ok(store.getDb().decks.length === before, '选择文件后【不直接导入】（先预览）');
  ok(modalCount() === beforeModals + 1, '点选文件后弹出预览弹窗');
  ok(body.children.includes(input) === false, '选择后移除临时 input');

  const res = await imp.runMappedImport(makeFile('picker.csv', 'word,meaning\nhello,你好\n'), {
    target: '__new__',
    deckName: 'picker'
  });
  ok(!!res && res.name === 'picker', '确认导入后新建卡组', res && res.name);
  ok(store.getDb().decks[0].name === 'picker', '新卡组名为 picker', store.getDb().decks[0].name);
}

console.log('\n[字段映射]');
{
  ok(imp.COLUMN_FIELDS.map((f) => f.value).join(',') === 'ignore,front,back,example,exampleZh,phonetic,tags', '下拉选项：忽略/正面/背面/例句/例句翻译/音标/标签');
  ok(imp.COLUMN_FIELDS.some((f) => f.label.includes('正面（单词）') && f.label.includes('必选')), '正面标注「必选」');
  ok(imp.COLUMN_FIELDS.some((f) => f.label.includes('标签（逗号分隔）')), '标签标注逗号分隔');

  const noHeader = imp.csvPreview('apple,苹果,extra\nbook,书,x\n');
  ok(JSON.stringify(imp.defaultMapping(noHeader)) === '["front","back","ignore"]', '无表头默认映射 = 正面/背面/忽略', imp.defaultMapping(noHeader));
  const withHeader = imp.csvPreview('meaning,word,标签\n苹果,apple,fruit\n');
  ok(JSON.stringify(imp.defaultMapping(withHeader)) === '["back","front","tags"]', '有表头按表头别名对号', imp.defaultMapping(withHeader));

  ok(imp.validateMapping(['front', 'back']).ok === true, '合法映射通过校验');
  ok(imp.validateMapping(['ignore', 'back']).ok === false, '缺少正面 → 报错', imp.validateMapping(['ignore', 'back']).error);
  ok(imp.validateMapping(['front', 'ignore']).ok === false, '缺少背面 → 报错');
  ok(imp.validateMapping(['front', 'back', 'front']).ok === false, '正面映射多列 → 报错');
  ok(imp.validateMapping(['front', 'back', 'back']).ok === false, '背面映射多列 → 报错');

  const rows = imp.parseCsv('apple,苹果,An apple.,一天一苹果。,ˈæpl,"fruit, red"\nbook,书,,,,\n,空正面,x\n');
  const words = imp.applyMapping(rows, ['front', 'back', 'example', 'exampleZh', 'phonetic', 'tags', 'ignore']);
  ok(words.length === 2, '空正面的行被丢弃', words.length);
  ok(words[0].front === 'apple' && words[0].back === '苹果', '正面 / 背面取映射列');
  ok(words[0].example === 'An apple.' && words[0].exampleZh === '一天一苹果。', '例句与例句翻译就位');
  ok(words[0].phonetic === 'ˈæpl', '音标就位');
  ok(words[0].tags.join(',') === 'fruit,red', '标签按逗号切分并 trim', words[0].tags);
  ok(!('example' in words[1]) && !('tags' in words[1]), '空列不产生多余字段');
  ok(imp.applyMapping(rows, ['front', 'back', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore'])[0].tags === undefined, '忽略列不写入');

  const html = imp.fieldMapHtml(imp.csvPreview('word,meaning,note\na,甲,备注\n'));
  ok((html.match(/<select/g) || []).length === 3, '每列一个下拉（3 列 3 个）', (html.match(/<select/g) || []).length);
  ok(html.includes('name="col-0"') && html.includes('name="col-2"'), '下拉按列命名（col-i）');
  ok(html.includes('<option value="front" selected>'), '第一列默认选中正面');
  ok(html.includes('字段映射'), '含「字段映射」标题');
  ok(html.includes('note'), '有表头时列名用表头');
}

console.log('\n[目标牌组与完整导入]');
{
  const decks = store.getDb().decks.map((d) => ({ id: d.id, name: d.name, count: (d.cards || []).length }));
  const dt = imp.targetDeckHtml(makeFile('words.csv', ''), { decks, defaultName: '我的新词库' });
  ok(dt.includes('目标牌组'), '含「目标牌组」区域');
  ok(dt.includes('name="target"'), '含牌组下拉');
  ok(dt.includes('value="__new__" selected'), '默认「＋ 新建牌组」');
  ok(dt.includes('name="newDeckName"') && dt.includes('value="我的新词库"'), '含新牌组名输入（默认文件名）');
  ok(dt.includes(`value="${decks[0].id}"`), '列出已有牌组');

  const handlers = {};
  const sel = { value: '__new__', addEventListener: (t, fn) => { handlers[t] = fn; } };
  const input = { value: '', style: {}, disabled: false };
  const overlay = { querySelector: (s) => (s === '#dt-target' ? sel : s === '#dt-name' ? input : null) };
  ok(imp.bindTargetToggle(overlay) === true, '绑定目标牌组下拉');
  ok(input.disabled === false && input.style.display === '', '默认新建 → 名称输入可用');
  sel.value = decks[0].id;
  handlers.change();
  ok(input.disabled === true && input.style.display === 'none', '选已有牌组 → 隐藏名称输入');
  sel.value = '__new__';
  handlers.change();
  ok(input.disabled === false, '切回新建 → 恢复名称输入');
  ok(imp.bindTargetToggle({}) === false, '无下拉时安全返回 false');

  const fields = [
    { name: 'col-0', type: 'select-one', value: 'front' },
    { name: 'col-1', type: 'select-one', value: 'back' },
    { name: 'target', type: 'select-one', value: '__new__' },
    { name: 'newDeckName', type: 'text', value: ' 词表X ' }
  ];
  const fakeOverlay = { querySelectorAll: (s) => (s === '[name]' ? fields : []) };
  const inputs = imp.readPreviewInputs(fakeOverlay, { cols: 2 });
  ok(JSON.stringify(inputs.mapping) === '["front","back"]', '读出每列映射');
  ok(inputs.target === '__new__' && inputs.deckName === '词表X', '读出目标牌组与名称（trim）');
  ok(imp.readPreviewInputs(null, { cols: 2 }).mapping.join(',') === 'ignore,ignore', '无弹窗时映射回退为忽略');
}

console.log('\n[完整导入：新建 / 追加 / 500 行]');
{
  const before = store.getDb().decks.length;
  const res = await imp.importMapped(makeFile('词表.csv', 'word,meaning,tags\napple,苹果,fruit\nbook,书,book\n'), {
    mapping: ['front', 'back', 'tags'],
    deckName: '词表导入'
  });
  ok(res.existing === false && res.added === 2, '新建牌组导入 2 张', res.added);
  ok(res.deck.name === '词表导入' && store.getDb().decks.length === before + 1, '按输入名新建牌组');
  ok(res.deck.cards[0].tags.length === 1, '标签写入卡片');
  ok(res.deck.cards.every((c) => c.front !== 'word'), '表头行不会被当作卡片导入', res.deck.cards.map((c) => c.front));

  const target = store.getDb().decks[0];
  const beforeCount = store.getDeck(target.id).cards.length;
  const res2 = await imp.importMapped(makeFile('more.csv', 'word,meaning\napple,重复的苹果\ncherry,樱桃\n'), {
    mapping: ['front', 'back'],
    deckId: target.id
  });
  ok(res2.existing === true && res2.added === 1 && res2.skipped === 1, '追加导入：新增 1 / 跳过已存在 1', [res2.added, res2.skipped]);
  ok(store.getDeck(target.id).cards.length === beforeCount + 1, '已有牌组卡片数 +1');
  ok(store.getDeck(target.id).cards.every((c) => c.level != null), '追加后重新分配关卡');

  const big = 'word,meaning\n' + Array.from({ length: 500 }, (_, i) => `bulk${i},释义${i}`).join('\n') + '\n';
  const res3 = await imp.importMapped(makeFile('bulk.csv', big), { mapping: ['front', 'back'], deckName: '批量500' });
  ok(res3.added === 500, '导入 500 行 CSV', res3.added);
  const saved = store.getDeck(res3.deckId);
  ok(saved.cards.length === 500, '牌组中有 500 张卡片', saved.cards.length);
  ok(
    saved.cards.every((c) => c.front && c.back && c.id && c.createdAt && c.state === 'new' && c.easeFactor === 2.5 && c.interval === 0 && c.repetitions === 0),
    '卡片字段与学习默认值正确'
  );
  ok(new Set(saved.cards.map((c) => c.level)).size > 1, '500 张已拆分为多个关卡');
  await store.flushPending();
  ok(store.storageInfo().cards >= 500, '卡片已写入存储（IndexedDB）', store.storageInfo().cards);

  let e1 = null;
  try {
    await imp.importMapped(makeFile('x.csv', 'a,b\n1,2\n'), { mapping: ['ignore', 'ignore'], deckName: 'X' });
  } catch (e) { e1 = e; }
  ok(!!e1 && /正面/.test(e1.message), '非法映射 → 抛错', e1 && e1.message);
  let e2 = null;
  try {
    await imp.importMapped(makeFile('x.csv', 'word,meaning\na,b\n'), { mapping: ['front', 'back'], deckId: 'not-exist' });
  } catch (e) { e2 = e; }
  ok(!!e2 && /不存在/.test(e2.message), '牌组不存在 → 抛错', e2 && e2.message);
}

console.log('\n[导入成功提示]');
{
  const html = imp.importSuccessHtml({ added: 500, name: '批量500', skipped: 3, duplicates: 2, deck: { cards: new Array(500) }, existing: false });
  ok(/共导入 <b>500<\/b> 张卡片到牌组「<b>批量500<\/b>」/.test(html), '成功文案「共导入 X 张卡片到牌组 YYY」', html.slice(0, 60));
  ok(html.includes('（新建）'), '标注新建');
  ok(html.includes('跳过牌组内已存在 3 张') && html.includes('跳过文件内重复 2 张'), '统计跳过数量');
  ok(imp.importSuccessHtml({ added: 1, name: 'A', deck: { cards: [1] }, existing: true }).includes('（追加）'), '追加导入标注「追加」');

  const overlay = imp.showImportSuccess({ added: 2, name: 'X', skipped: 0, duplicates: 0, deck: { cards: [1, 2] }, deckId: 'd1', existing: false });
  ok(!!overlay && overlay.className === 'modal-overlay', '弹出「导入完成」弹窗');
  const h = String(overlay.innerHTML);
  ok(h.includes('导入完成') && h.includes('去学习'), '弹窗含标题与「去学习」按钮');
  ok(h.includes('共导入'), '弹窗含成功文案');
}

console.log('\n[拖拽导入]');
{
  const html = imp.dropzoneHtml();
  ok(html.includes('data-dropzone'), '拖拽区带 data-dropzone 标记');
  ok(html.includes('data-action="import-file"'), '拖拽区可点击（复用 import-file action）');
  ok(html.includes('拖入 CSV / TSV / JSON / XLSX 文件'), '拖拽区含提示文案');

  const handlers = {};
  const classes = new Set();
  const zone = {
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    addEventListener(type, fn) { handlers[type] = fn; }
  };
  const root = { querySelectorAll: (sel) => (sel === '[data-dropzone]' ? [zone] : []) };
  ok(imp.bindDropzone(root) === 1, '绑定 1 个拖拽区');
  ok(
    typeof handlers.dragover === 'function' && typeof handlers.dragleave === 'function' && typeof handlers.drop === 'function',
    '挂上 dragover / dragleave / drop 监听'
  );

  let prevented = 0;
  handlers.dragover({ preventDefault: () => { prevented++; } });
  ok(prevented === 1, 'dragover 阻止默认行为');
  ok(classes.has('is-drag'), '拖入时高亮 is-drag');
  handlers.dragleave();
  ok(!classes.has('is-drag'), '拖出后取消高亮');

  const beforeModals = modalCount();
  handlers.drop({ preventDefault: () => { prevented++; }, dataTransfer: { files: [] } });
  ok(prevented === 2, 'drop 阻止默认行为（浏览器不会直接打开文件）');
  await tick();
  ok(modalCount() === beforeModals, '空拖放不打开预览');

  handlers.drop({ preventDefault() {}, dataTransfer: { files: [makeFile('photo.png', 'binary')] } });
  await tick();
  ok(modalCount() === beforeModals, '不支持的文件类型不打开预览');
  ok(imp.isSupportedFile('a.csv') && imp.isSupportedFile('B.TSV') && imp.isSupportedFile('c.json') && imp.isSupportedFile('d.txt'), '识别支持的扩展名');
  ok(!imp.isSupportedFile('a.pdf') && !imp.isSupportedFile('a.png') && !imp.isSupportedFile(''), '拒绝不支持的扩展名');

  handlers.drop({ preventDefault() {}, dataTransfer: { files: [makeFile('drop.csv', '单词,释义\nalpha,阿尔法\n')] } });
  await tick();
  ok(modalCount() === beforeModals + 1, '拖入文件后弹出预览弹窗');
  const overlay = body.children.filter((c) => c && c.className === 'modal-overlay').pop();
  ok(String(overlay.innerHTML).includes('csv-table'), '拖入后弹出的是预览表格');
  ok(String(overlay.innerHTML).includes('阿尔法'), '拖入的 CSV 数据进入预览');
  ok(String(overlay.innerHTML).includes('<th scope="col">单词</th>'), '中文表头被识别为列名');

  ok(imp.bindDropzone({}) === 0, '无拖拽区时安全返回 0');
}

console.log('\n[导入 JSON：复习进度还原]');
{
  const json = JSON.stringify({
    formatVersion: 1,
    name: '进度词库',
    description: '带复习进度',
    tags: ['进度'],
    cards: [
      { front: 'alpha', back: '甲', extraBacks: ['甲2'], state: 'review', repetitions: 6, interval: 21, easeFactor: 2.8, due: 1800000000000, lastReview: 1700000000000 },
      { front: 'beta', back: '乙', state: 'learning', repetitions: 0, interval: 0.0069, easeFactor: 2.3, due: 1700000600000, lastReview: 1700000000000 },
      { front: 'gamma', back: '丙' }
    ]
  });
  const res = await imp.importDeckFromFile(makeFile('进度词库.json', json));
  const deck = store.getDeck(res.deck.id);
  const by = (f) => deck.cards.find((c) => c.front === f);
  ok(deck.cards.length === 3, '导入 3 张', deck.cards.length);

  const a = by('alpha');
  ok(a.state === 'review' && a.repetitions === 6 && a.interval === 21 && a.easeFactor === 2.8, '复习卡进度还原', a);
  ok(a.due === 1800000000000 && a.lastReview === 1700000000000, 'due / lastReview 还原', [a.due, a.lastReview]);
  ok(a.extraBacks.join(',') === '甲2', '多释义一并还原', a.extraBacks);

  const b = by('beta');
  ok(b.state === 'learning' && b.easeFactor === 2.3 && b.lastReview === 1700000000000, '学习卡状态还原', b);

  const g = by('gamma');
  ok(g.state === 'new' && g.repetitions === 0 && g.interval === 0 && g.easeFactor === 2.5 && g.lastReview === null, '无进度的词条保持新卡', g);
}

console.log('\n[导入 JSON：进度字段简写与非法值]');
{
  const alias = JSON.stringify({
    name: '别名',
    cards: [{ front: 'delta', back: '丁', state: 'review', reps: 3, ivl: 5, ef: 2.2, due: 1900000000000, last_review: 1750000000000 }]
  });
  const r2 = await imp.importDeckFromFile(makeFile('别名.json', alias));
  const d2 = store.getDeck(r2.deck.id).cards[0];
  ok(d2.repetitions === 3 && d2.interval === 5 && d2.easeFactor === 2.2, 'reps / ivl / ef 简写被识别', d2);
  ok(d2.due === 1900000000000 && d2.lastReview === 1750000000000, 'last_review 简写被识别', [d2.due, d2.lastReview]);

  const bad = JSON.stringify({
    name: '脏数据',
    cards: [{ front: 'epsilon', back: '戊', state: 'nope', repetitions: 'x', interval: -3, easeFactor: 'bad', due: -1, lastReview: 'oops' }]
  });
  const r3 = await imp.importDeckFromFile(makeFile('脏数据.json', bad));
  const d3 = store.getDeck(r3.deck.id).cards[0];
  ok(d3.state === 'new' && d3.easeFactor === 2.5 && d3.lastReview === null, '非法进度回退新卡默认', d3);
  ok(d3.repetitions === 0 && d3.interval === 0 && d3.due === 0, '非法数值被钳制为 0', d3);
  ok(!!d3.id && d3.front === 'epsilon', '卡片仍正常写入', d3.front);
}

console.log('\n[导入 JSON：复习日志还原（reviewLog / revlog）]');
{
  const json = JSON.stringify({
    formatVersion: 2,
    name: '带日志词库',
    cards: [
      {
        front: 'zeta',
        back: 'ζ',
        state: 'review',
        repetitions: 2,
        interval: 6,
        easeFactor: 2.6,
        due: 1800000000000,
        lastReview: 1700000005000,
        reviewLog: [
          { cardId: 'old-id', ts: 1700000000000, ease: 3, type: 0, ivl: 1, lastIvl: 0, factor: 2500, time: 4200 },
          { cardId: 'old-id', ts: 1700000005000, ease: 1, type: 2, ivl: 0.0069, lastIvl: 1, factor: 2300, time: 900 }
        ]
      },
      { front: 'eta', back: 'η', revlog: [{ ts: 1700000001000, ease: 2, type: 1, ivl: 3, lastIvl: 1, factor: 2500, time: 100 }] },
      { front: 'theta', back: 'θ', reviewLog: [{ ts: 0, ease: 3 }, { ts: 1700000002000, ease: 9 }] }
    ]
  });
  const res = await imp.importMapped(makeFile('带日志词库.json', json), { deckName: '带日志词库', src: 'batch_import' });
  const deck = store.getDeck(res.deck.id);
  ok(res.logsWritten === 4, '导入结果带 logsWritten = 4（2+1+1）', res.logsWritten);
  ok(String(imp.importSuccessHtml(res)).includes('恢复复习日志 4 条'), '成功提示显示恢复的日志条数');

  const z = deck.cards.find((c) => c.front === 'zeta');
  const logs = await store.revlogsOfCard(deck.id, z.id);
  ok(logs.length === 2, 'zeta 恢复 2 条日志', logs.length);
  ok(logs[0].cardId === z.id && logs[0].id === `1700000000000-${z.id}`, '日志重新归属到新卡片 id（主键同步刷新）', logs[0].id);
  ok(logs[0].ease === 3 && logs[0].time === 4200, '日志档位 / 停留时长保留', logs[0]);
  ok(logs[1].type === 2 && Math.abs(logs[1].ivl - 0.0069) < 1e-4, '重学条目 type / 步长（天）保留', logs[1]);

  const e = deck.cards.find((c) => c.front === 'eta');
  ok((await store.revlogsOfCard(deck.id, e.id)).length === 1, 'revlog 字段名同样被识别');
  const t = deck.cards.find((c) => c.front === 'theta');
  ok((await store.revlogsOfCard(deck.id, t.id)).length === 1, '非法条目（ts=0）被丢弃，合法条目保留（ease 越界→3）', (await store.revlogsOfCard(deck.id, t.id)).length);
  const st = await store.revlogStats(deck.id);
  ok(st.total === 4 && st.lapses === 1, '卡组汇总：4 条 / 1 次遗忘', st);

  // 追加导入：日志同样写入已有牌组
  const add = JSON.stringify({ name: '追加', cards: [{ front: 'iota', back: 'ι', reviewLog: [{ ts: 1700000003000, ease: 4, type: 1, ivl: 9, lastIvl: 3, factor: 2600, time: 700 }] }] });
  const res2 = await imp.importMapped(makeFile('追加.json', add), { deckId: deck.id, src: 'batch_import' });
  ok(res2.existing === true && res2.logsWritten === 1, '追加导入写入 1 条日志', res2.logsWritten);
  const io = store.getDeck(deck.id).cards.find((c) => c.front === 'iota');
  ok((await store.revlogsOfCard(deck.id, io.id)).length === 1, '新卡带上日志');
  ok((await store.revlogStats(deck.id)).total === 5, '卡组日志共 5 条');

  // 无日志的 JSON 不受影响
  const plain = JSON.stringify({ name: '无日志', cards: [{ front: 'kappa', back: 'κ' }] });
  const res3 = await imp.importMapped(makeFile('无日志.json', plain), { deckName: '无日志', src: 'batch_import' });
  ok(!res3.logsWritten, '无日志时不产生 logsWritten', res3.logsWritten);
  ok((await store.revlogStats(res3.deck.id)).total === 0, '新卡组无日志');
}


{
  const bytes = xlsxBytes([
    ['单词', '释义', '音标'],
    ['apple', '苹果', 'ˈæpl'],
    ['book', '书', 'bʊk'],
    ['apple', '重复', 'x']
  ]);
  ok(imp.isXlsxFile('a.xlsx') === true && imp.isXlsxFile('a.csv') === false, 'isXlsxFile 判定');
  ok(imp.isSupportedFile('a.xlsx') === true && imp.ACCEPT.includes('.xlsx'), 'isSupportedFile / ACCEPT 含 xlsx');

  const xl = await import('../js/xlsx.js');
  const rows = await xl.parseXlsxRows(bytes);
  ok(rows.length === 4 && rows[1].join('|') === 'apple|苹果|ˈæpl', 'xlsx 解析出全部行', rows.length);

  const pv = imp.rowsPreview(rows);
  ok(pv.kind === 'xlsx' && pv.header.join('|') === '单词|释义|音标', '预览识别中文表头', pv.header);
  ok(pv.totalRows === 3 && pv.cols === 3, '预览行列统计（表头不计入）', [pv.totalRows, pv.cols]);
  ok(imp.isTabular(pv) === true, 'xlsx 走逐列映射');
  ok(imp.defaultMapping(pv).join(',') === 'front,back,phonetic', '按中文表头自动对号', imp.defaultMapping(pv));
  ok(imp.previewMetaHtml(pv, 'x.xlsx').includes('Excel 工作表'), '预览元信息标注 Excel 工作表');
  ok(imp.fieldMapHtml(pv).includes('正面'), 'xlsx 也渲染字段映射下拉');

  const res = await imp.importDeckFromFile(makeBinFile('我的 Excel 词表.xlsx', bytes));
  ok(res.name === '我的 Excel 词表' && res.words === 2 && res.duplicates === 1, '端到端导入（apple 重复 → 去重后 2 词）', res);
  const deck = store.getDeck(res.deck.id);
  ok(deck.cards.find((c) => c.front === 'apple').back === '苹果', 'xlsx 数据写入正确');
  ok(deck.cards.find((c) => c.front === 'book').phonetic === 'bʊk', '音标列写入正确');

  const mapped = await imp.importMapped(makeBinFile('映射.xlsx', bytes), {
    mapping: ['back', 'front', 'ignore'],
    deckName: '反着映射'
  });
  ok(mapped.name === '反着映射' && mapped.added === 3, 'importMapped 支持自定义映射', mapped);
  ok(store.getDeck(mapped.deckId).cards.find((c) => c.front === '苹果').back === 'apple', '按自定义映射取列');

  body.children.length = 0;
  await imp.openImportPreview(makeBinFile('预览.xlsx', bytes));
  await tick();
  const overlay = body.children.filter((c) => c && c.className === 'modal-overlay').pop();
  const html = overlay ? String(overlay.innerHTML) : '';
  ok(html.includes('导入预览') && html.includes('Excel 工作表'), '预览弹窗打开并标注 Excel');
  ok(html.includes('单词') && html.includes('苹果'), '预览表格含数据');
  ok(html.includes('field-map'), '预览含字段映射区');
  body.children.length = 0;
console.log('\n[导入 XLSX：多工作表 / 公式提示]');
{
  const bytes = xlsxMultiBytes();
  const xl = await import('../js/xlsx.js');
  const wb = await xl.openXlsx(bytes);
  ok(wb.sheets.map((s) => s.name).join(',') === '词表,备份', 'workbook 里两张表都列出', wb.sheets.map((s) => s.name));

  const pv1 = imp.xlsxWorkbookPreview(wb, 0);
  ok(pv1.sheet === '词表' && pv1.rows[0][0] === 'apple' && pv1.totalRows === 2, '预览第一张表（带表名与统计）', pv1);
  const pv2 = imp.xlsxWorkbookPreview(wb, 1);
  ok(pv2.sheet === '备份' && pv2.rows[0][0] === 'cat', '预览第二张表', pv2.rows);
  ok(imp.previewMetaHtml(pv2, 'x.xlsx').includes('Excel 工作表「备份」'), '元信息标注工作表名');
  ok(imp.previewMetaHtml(imp.rowsPreview([['单词', '释义'], ['cat', '猫']]), 'x.xlsx').includes('Excel 工作表（取第一个 sheet）'), '未带表名时回退旧文案');

  const meta = imp.previewMetaHtml(
    imp.rowsPreview([['单词', '释义'], ['cat', '猫']], {
      sheet: '第一页',
      notices: { formulas: 4, evaluated: 1, unsupported: 2, merges: 1, mergedCells: 3 }
    }),
    'y.xlsx'
  );
  ok(
    meta.includes('已计算 1 个公式') && meta.includes('2 个公式用 Excel 缓存值') && meta.includes('合并单元格补全 3 格'),
    '元信息提示公式 / 合并单元格处理结果',
    meta
  );
  ok(imp.xlsxNoticesText(null) === '' && imp.xlsxNoticesText({ formulas: 0 }) === '', '无有效统计时提示为空串');
  ok(imp.xlsxNoticesText({ evaluated: 2 }) === '已计算 2 个公式', '只列有内容的统计项');

  const picker = imp.sheetPickerHtml(wb.sheets, 1);
  ok(picker.includes('name="sheet"') && picker.includes('id="import-sheet"'), '工作表下拉含 name/id');
  ok(picker.includes('>词表<') && picker.includes('>备份<'), '下拉列出全部工作表');
  ok(picker.includes('value="1" selected') && !picker.includes('value="0" selected'), '选中项回填 selected');
  ok(imp.sheetPickerHtml([{ index: 0, name: '唯一', hidden: false }]) === '', '只有一张表时不渲染下拉');
  ok(imp.sheetPickerHtml(wb.sheets.map((s, i) => ({ ...s, hidden: i === 1 })), 0).includes('备份（隐藏）'), '隐藏表加「（隐藏）」标注');

  const handlers = {};
  const sel = { value: '1', addEventListener: (t, fn) => { handlers[t] = fn; } };
  let picked = -1;
  ok(
    imp.bindSheetPicker({ querySelector: (s) => (s === '#import-sheet' ? sel : null) }, (i) => { picked = i; }) === true,
    '绑定工作表下拉'
  );
  handlers.change();
  ok(picked === 1, '切换后回调拿到工作表序号', picked);
  ok(imp.bindSheetPicker({}, () => {}) === false, '没有下拉时安全返回 false');

  const fields = [
    { name: 'col-0', type: 'select-one', value: 'front' },
    { name: 'col-1', type: 'select-one', value: 'back' },
    { name: 'target', type: 'select-one', value: '__new__' },
    { name: 'newDeckName', type: 'text', value: 'X' },
    { name: 'sheet', type: 'select-one', value: '1' }
  ];
  const inputs = imp.readPreviewInputs({ querySelectorAll: (s) => (s === '[name]' ? fields : []) }, { cols: 2 });
  ok(inputs.sheet === 1, '读出选中的工作表序号', inputs);
  ok(imp.readPreviewInputs(null, { cols: 2 }).sheet === 0, '没有下拉时默认第一张表');

  const fromFirst = await imp.importMapped(makeBinFile('多表.xlsx', bytes), {
    mapping: ['front', 'back'],
    deckName: '第一张表'
  });
  ok(fromFirst.name === '第一张表' && fromFirst.added === 2, '默认导入第一张表（apple / book）', fromFirst.added);
  const fromSheet1 = await imp.importMapped(makeBinFile('多表2.xlsx', bytes), {
    mapping: ['front', 'back'],
    deckName: '指定工作表',
    sheet: 1
  });
  ok(fromSheet1.added === 1 && store.getDeck(fromSheet1.deckId).cards[0].front === 'cat', 'sheet 选项导入第二张表', fromSheet1.added);

  body.children.length = 0;
  await imp.openImportPreview(makeBinFile('多表预览.xlsx', bytes));
  await tick();
  const overlay = body.children.filter((c) => c && c.className === 'modal-overlay').pop();
  const html = overlay ? String(overlay.innerHTML) : '';
  ok(html.includes('import-sheet') && html.includes('>词表<') && html.includes('>备份<'), '预览弹窗含工作表下拉');
  ok(html.includes('Excel 工作表「词表」'), '预览弹窗元信息标注当前表名');
  ok(html.includes('import-preview-body'), '预览区包在可重渲染容器里');
  body.children.length = 0;
}


}

console.log('\n[标准 CSV 模版（下载）]');
{
  ok(
    imp.CSV_TEMPLATE_COLUMNS.join(',') === '单词,释义,例句,例句翻译,音标,标签',
    '模版列名（中文规范名）',
    imp.CSV_TEMPLATE_COLUMNS
  );
  const text = imp.csvTemplateText();
  ok(text.charCodeAt(0) === 0xfeff, '带 UTF-8 BOM（Excel 中文不乱码）');
  const lines = text.slice(1).replace(/\r\n$/, '').split('\r\n');
  ok(lines.length === 2, '表头 + 1 行示例', lines.length);
  ok(lines[0] === '单词,释义,例句,例句翻译,音标,标签', '首行为标准列名', lines[0]);
  ok(
    lines[1] === 'apple,苹果,This is an apple.,这是一个苹果。,/ˈæpl/,"水果,基础"',
    '示例行（标签含逗号 → 被引号包裹）',
    lines[1]
  );

  // 往返：模版文本走真实解析 + 表头映射
  const rows = imp.parseCsv(text);
  ok(imp.isHeaderRow(rows[0]) === true, '首行被识别为表头');
  ok(
    JSON.stringify(imp.mapHeader(rows[0])) ===
      JSON.stringify({ front: 0, back: 1, example: 2, exampleZh: 3, phonetic: 4, tags: 5 }),
    '表头自动对号到 front/back/example/exampleZh/phonetic/tags',
    imp.mapHeader(rows[0])
  );
  const words = imp.rowsToWords(rows);
  ok(words.length === 1 && words[0].front === 'apple' && words[0].back === '苹果', '示例行解析为 1 个词条', words[0]);
  ok(words[0].phonetic === '/ˈæpl/' && words[0].tags.join('|') === '水果|基础', '音标 / 标签解析正确', words[0]);

  // 下载入口
  const btn = imp.csvTemplateButtonHtml();
  ok(btn.includes('data-action="download-csv-template"') && btn.includes('下载 CSV 模版'), '「下载 CSV 模版」按钮');
  const dl = imp.downloadCsvTemplate();
  ok(dl.filename === imp.CSV_TEMPLATE_FILENAME && dl.text === text, 'downloadCsvTemplate 返回文件名与内容', dl.filename);

  // 端到端：把模版当文件导入（示例行会成为 1 张卡，印证「导入前请删除示例行」）
  const res = await imp.importDeckFromFile(makeFile('Mycard-CSV模版.csv', text));
  ok(res.words === 1 && res.name === 'Mycard-CSV模版', '模版可被直接导入（示例行 = 1 张卡）', res.words);
}

console.log('\n[模版变体：仅表头 / 多行示例]');
{
  ok(imp.CSV_TEMPLATE_VARIANTS.length === 3, '变体共 3 种（仅表头 / 1 行示例 / 多行示例）');
  ok(
    imp.CSV_TEMPLATE_VARIANTS.map((v) => v.value).join(',') === 'head,single,multi',
    '变体取值',
    imp.CSV_TEMPLATE_VARIANTS.map((v) => v.value)
  );
  ok(imp.CSV_TEMPLATE_EXAMPLES.length === 4, '多行示例共 4 行', imp.CSV_TEMPLATE_EXAMPLES.length);
  ok(imp.csvTemplateExampleRows('head').length === 0, 'head → 0 行示例');
  ok(imp.csvTemplateExampleRows('single').length === 1, 'single → 1 行示例');
  ok(imp.csvTemplateExampleRows('multi').length === 4, 'multi → 4 行示例');
  ok(imp.csvTemplateExampleRows('未定义的变体').length === 1, '未知变体回退到 1 行示例（稳健）');

  const head = imp.csvTemplateText({ variant: 'head' });
  ok(head.charCodeAt(0) === 0xfeff, '仅表头：仍带 UTF-8 BOM（Excel 友好）');
  ok(head.slice(1).replace(/\r\n$/, '').split('\r\n').length === 1, '仅表头：只有表头 1 行');
  ok(imp.csvTemplateRows({ variant: 'head' }).length === 1, 'csvTemplateRows 可复用得二维数组');

  const multi = imp.csvTemplateText({ variant: 'multi' });
  const mrows = imp.parseCsv(multi);
  ok(mrows.length === 5 && imp.isHeaderRow(mrows[0]), '多行示例：表头 + 4 行示例', mrows.length);
  ok(multi.includes('"Take notes, please."'), '含逗号的单元格被引号包裹（转义示例）', multi.split('\r\n')[3]);
  const mwords = imp.rowsToWords(mrows);
  ok(mwords.length === 4, '多行示例解析出 4 个词条', mwords.map((w) => w.front));
  const bank = mwords.find((w) => w.front === 'bank');
  ok(!!bank && bank.back === '银行；河岸' && !bank.example && !bank.phonetic, '多义词行：释义含「；」、无例句 / 无音标', bank);
  const note = mwords.find((w) => w.front === 'note');
  ok(!!note && note.example === 'Take notes, please.' && note.exampleZh === '请做笔记。', '例句含逗号的行仍被完整解析', note);
  const pear = mwords.find((w) => w.front === 'pear');
  ok(!!pear && pear.back === '梨' && !pear.example && !pear.tags, '只填必填两列的行也能解析', pear);

  // 变体模版同样可直接导入（与 1 行示例走同一解析链路）
  const resMulti = await imp.importDeckFromFile(makeFile('Mycard-CSV模版.csv', multi));
  ok(resMulti.words === 4, '多行示例模版可被直接导入（4 张卡）', resMulti.words);
}

console.log('\n[模版下载弹窗（先选示例行变体）]');
{
  const html = imp.csvTemplateDialogHtml();
  ok(html.includes('name="variant"'), '含变体下拉选择');
  for (const v of imp.CSV_TEMPLATE_VARIANTS) {
    ok(html.includes(`value="${v.value}"`) && html.includes(v.label), `变体选项「${v.label}」`);
  }
  ok(/value="single" selected/.test(html), '默认选中「表头 + 1 行示例」（与旧版一致）');
  ok(html.includes('单词 / 释义 / 例句 / 例句翻译 / 音标 / 标签'), '说明标准列');
  for (const v of imp.CSV_TEMPLATE_VARIANTS) ok(html.includes(v.note.split('：')[0].slice(0, 6)), `变体说明：${v.label}`);

  body.children.length = 0; // 先清空历史弹窗，便于计数
  const before = modalCount();
  const overlay = imp.openCsvTemplateDialog();
  ok(modalCount() === before + 1, '点「下载 CSV 模版」→ 打开选择弹窗', modalCount());
  ok(!!overlay && overlay.innerHTML.includes('name="variant"'), '弹窗内即变体选择表单');
  ok(modalCount() === 1, '再次打开不会叠加弹窗（openModal 先关旧的）');

  const dlHead = imp.downloadCsvTemplate({ variant: 'head' });
  ok(
    dlHead.filename === imp.CSV_TEMPLATE_FILENAME && dlHead.variant === 'head' && dlHead.text === imp.csvTemplateText({ variant: 'head' }),
    'downloadCsvTemplate 支持变体参数',
    dlHead.variant
  );
  const dlDefault = imp.downloadCsvTemplate();
  ok(dlDefault.variant === 'single' && dlDefault.text === imp.csvTemplateText(), '不传参 → 与旧版行为完全一致');
  body.children.length = 0; // 关闭弹窗
}

console.log('\n[标准 JSON 模版（下载）]');
{
  const text = imp.jsonTemplateText();
  ok(text.endsWith('\n'), 'JSON 模版：末尾换行（便于手工编辑）');
  ok(text.includes('\n  "words"') && text.includes('\n    {\n      "front"'), 'JSON 模版：2 空格缩进', text.split('\n')[1]);

  // 往返：模版文本走真实导入解析器
  const payload = imp.parseImportJson(text);
  ok(payload.name === '我的词库' && payload.words.length === 2, '模版可被 parseImportJson 解析（2 个词条）', payload.name);
  ok(payload.tags.join('|') === '导入' && payload.levelSize === 20, 'tags / levelSize 透传', { tags: payload.tags, levelSize: payload.levelSize });
  const apple = payload.words[0];
  ok(
    apple.front === 'apple' && apple.back === '苹果' && apple.example === 'This is an apple.' && apple.exampleZh === '这是一个苹果。' && apple.phonetic === '/ˈæpl/',
    '第一条：完整示例字段齐全',
    apple
  );
  ok(apple.tags.join('|') === '水果|基础' && apple.extraBacks.join('|') === '苹果树', '第一条：标签 + 多义词释义（extraBacks）', apple);
  ok(
    payload.words[1].front === 'pear' && payload.words[1].back === '梨' && !payload.words[1].example && !payload.words[1].phonetic,
    '第二条：只填必填项（可选字段可整块省略）',
    payload.words[1]
  );

  // 下载入口
  const btn = imp.jsonTemplateButtonHtml();
  ok(btn.includes('data-action="download-json-template"') && btn.includes('下载 JSON 模版'), '「下载 JSON 模版」按钮');
  const dl = imp.downloadJsonTemplate();
  ok(dl.filename === imp.JSON_TEMPLATE_FILENAME && dl.text === text, 'downloadJsonTemplate 返回文件名与内容', dl.filename);

  // 端到端：把 JSON 模版当文件导入
  const res = await imp.importDeckFromFile(makeFile('Mycard-JSON模版.json', text));
  ok(res.words === 2 && res.name === '我的词库', 'JSON 模版可被直接导入为卡组', { words: res.words, name: res.name });
}

console.log('\n[多文件批量导入 + 导入历史 / 回滚]');
{
  const hist = await import('../js/import-history.js');
  await hist.clearHistory();

  // 文件选择器支持多选
  const picker = imp.openFilePicker();
  ok(picker && picker.multiple === true && picker.type === 'file', '文件选择器支持多选', picker && picker.multiple);

  // 批量：两个文件 → 两个新卡组
  const before = store.getDb().decks.length;
  const batch = await imp.runBatchImport([
    makeFile('批量A.csv', 'word,meaning\nalpha,甲\nbeta,乙\n'),
    makeFile('批量B.csv', 'word,meaning\ngamma,丙\n')
  ]);
  ok(batch.done.length === 2 && batch.failed.length === 0, '两个文件各建一个卡组', batch.failed);
  ok(store.getDb().decks.length === before + 2, '卡组数 +2', store.getDb().decks.length);
  ok(
    batch.done.every((r) => r.mode === 'new' && r.addedCardIds.length === r.added),
    '每项记录 mode 与新增卡片 id'
  );
  const list1 = hist.listImports();
  ok(list1.length === 1 && list1[0].files.length === 2 && list1[0].total === 3, '写入 1 条历史（2 文件 / 3 张）', list1[0]);

  // 撤销整批 → 两个新建卡组都消失
  const ids = batch.done.map((r) => r.deckId);
  const u1 = await hist.undoImport(batch.historyId);
  ok(u1.ok && u1.undone === 2, '撤销整批导入', u1);
  ok(ids.every((id) => !store.getDeck(id)), '新建的卡组已删除');
  ok(hist.listImports().length === 0, '历史条目已移除');

  // 不支持的扩展名 → 全部跳过
  ok(imp.openBatchImport([makeFile('a.docx', 'x')]) === null, '无支持文件 → 不打开批量弹窗');

  // 追加导入 → 精确回滚（只删本次新增的卡）
  const host = store.createDeck({ name: '宿主卡组' });
  store.addManyCards(host.id, [{ front: 'keep', back: '保留' }]);
  const res = await imp.importMapped(makeFile('追加.csv', 'word,meaning\nnew1,新1\nnew2,新2\n'), { deckId: host.id });
  ok(res.mode === 'append' && res.addedCardIds.length === 2 && res.existing === true, '追加导入记录新增 id', res);
  const entry = await hist.recordImport([res]);
  const undoIds = await hist.undoableIds();
  ok(undoIds.has(entry.id), '追加导入在回滚窗口内', [...undoIds]);
  const u2 = await hist.undoImport(entry.id);
  ok(u2.ok && u2.undone === 1, '撤销追加导入', u2);
  const after = store.getDeck(host.id);
  ok(after.cards.length === 1 && after.cards[0].front === 'keep', '只移除新增卡片，原有卡片保留', after.cards.map((c) => c.front));

  // 历史 UI
  ok(hist.historyTimeLabel(Date.now()).startsWith('今天'), '今天导入的时间文案');
  const item = hist.historyItemHtml(
    { id: 'x', ts: Date.now(), total: 5, files: [{ deckName: '甲组', mode: 'append' }] },
    { undoable: true }
  );
  ok(item.includes('甲组') && item.includes('追加') && item.includes('data-action="import-undo"'), '历史条目 HTML（含撤销按钮）');
  ok(hist.historyListHtml([], new Set()).includes('还没有导入记录'), '空历史文案');
  ok(hist.importHistoryButtonHtml().includes('data-action="import-history"'), '首页历史入口按钮');

  await hist.clearHistory();
  ok(hist.listImports().length === 0, 'clearHistory 清空历史');
}

console.log(`\n文件导入结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
