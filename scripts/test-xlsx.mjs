#!/usr/bin/env node
// ============================================================================
// test-xlsx.mjs — 极简 .xlsx 读取器（自写 ZIP 读取 + 最小 XML 扫描）测试
//   运行: node scripts/test-xlsx.mjs
// 覆盖：ZIP(STORED/DEFLATE) / 共享字符串 / 内联字符串 / 数值 / 布尔 / 日期 /
//      跳列补空 / workbook+rels 定位工作表 / 多工作表选择 / 公式求值（cached vs
//      evaluate / 循环引用 / 不支持函数回退）/ 合并单元格（fill / blank）/ 错误处理
// ============================================================================

import { deflateRawSync } from 'node:zlib';

/* ---------- 浏览器全局桩（export.js 需要，用于 zipStore/crc32） ---------- */
const mem = {};
const storage = {
  getItem(k) { return k in mem ? mem[k] : null; },
  setItem(k, v) { mem[k] = String(v); },
  removeItem(k) { delete mem[k]; }
};
function fakeEl() {
  return {
    innerHTML: '', value: '', dataset: {}, style: {}, className: '', textContent: '', children: [], parentNode: null,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(c) { this.children.push(c); return c; }, removeChild(c) { return c; },
    addEventListener() {}, removeEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, remove() {}, focus() {}, setAttribute() {}, click() {}
  };
}
globalThis.localStorage = storage;
globalThis.sessionStorage = storage;
globalThis.document = {
  body: fakeEl(), head: fakeEl(), documentElement: fakeEl(),
  addEventListener() {}, removeEventListener() {},
  querySelector() { return null; }, querySelectorAll() { return []; },
  getElementById() { return fakeEl(); }, createElement() { return fakeEl(); }
};
globalThis.window = { addEventListener() {}, dispatchEvent() {}, scrollTo() {} };
globalThis.location = { hash: '#/home', href: '' };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const ex = await import('../js/export.js');
const xl = await import('../js/xlsx.js');

let pass = 0;
let fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

/* ---------- 工具：手拼单条目 ZIP（可 STORED / DEFLATE） ---------- */
const U16 = (n) => [n & 0xff, (n >> 8) & 0xff];
const U32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];

function zipOne(name, text, method = 8) {
  const nameBytes = new TextEncoder().encode(name);
  const raw = new TextEncoder().encode(text);
  const comp = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;
  const crc = ex.crc32(raw);
  const parts = [];
  parts.push(new Uint8Array([
    ...U32(0x04034b50), ...U16(20), ...U16(0), ...U16(method), ...U16(0), ...U16(0),
    ...U32(crc), ...U32(comp.length), ...U32(raw.length), ...U16(nameBytes.length), ...U16(0)
  ]));
  parts.push(nameBytes, comp);
  const localSize = 30 + nameBytes.length + comp.length;
  parts.push(new Uint8Array([
    ...U32(0x02014b50), ...U16(20), ...U16(20), ...U16(0), ...U16(method), ...U16(0), ...U16(0),
    ...U32(crc), ...U32(comp.length), ...U32(raw.length), ...U16(nameBytes.length),
    ...U16(0), ...U16(0), ...U16(0), ...U16(0), ...U32(0), ...U32(0)
  ]));
  parts.push(nameBytes);
  const centralSize = 46 + nameBytes.length;
  parts.push(new Uint8Array([
    ...U32(0x06054b50), ...U16(0), ...U16(0), ...U16(1), ...U16(1),
    ...U32(centralSize), ...U32(localSize), ...U16(0)
  ]));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/* ---------- 工具：拼一个最小 xlsx（STORED 条目） ---------- */
const CT = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`;
const RELS = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
const WB = `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId7"/></sheets></workbook>`;
const WBRELS = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
const SST = `<?xml version="1.0"?><sst count="6" uniqueCount="6"><si><t>单词</t></si><si><t>释义</t></si><si><t>apple</t></si><si><t>苹果</t></si><si><r><t>多</t></r><r><t>义</t></r></si><si><t>hello &amp; &lt;world&gt;</t></si></sst>`;
// A1 单词 / B1 释义（表头）；A2 apple / B2 苹果；A3 多义（富文本）/ B3 数值；
// 第 4 行：B4 内联字符串 + 跳列（A4 空）；第 5 行：布尔
const SHEET = `<?xml version="1.0"?><worksheet><sheetData>` +
  `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>` +
  `<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row>` +
  `<row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3"><v>42</v></c></row>` +
  `<row r="4"><c r="B4" t="inlineStr"><is><t>内联</t></is></c></row>` +
  `<row r="5"><c r="A5" t="b"><v>1</v></c><c r="B5" t="s"><v>5</v></c></row>` +
  `</sheetData></worksheet>`;
const STYLES = `<?xml version="1.0"?><styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>`;

function makeXlsx() {
  return ex.zipStore([
    { name: '[Content_Types].xml', data: CT },
    { name: '_rels/.rels', data: RELS },
    { name: 'xl/workbook.xml', data: WB },
    { name: 'xl/_rels/workbook.xml.rels', data: WBRELS },
    { name: 'xl/sharedStrings.xml', data: SST },
    { name: 'xl/styles.xml', data: STYLES },
    { name: 'xl/worksheets/sheet1.xml', data: SHEET }
  ]);
}

console.log('\n[XML 基础]');
{
  ok(xl.decodeXml('a&amp;b&lt;c&gt;d&quot;e&apos;f') === 'a&b<c>d"e\'f', 'XML 实体解码');
  ok(xl.decodeXml('&#65;&#x42;') === 'AB', '数字实体（十进制/十六进制）');
  ok(xl.decodeXml('') === '' && xl.decodeXml(null) === '', '空值安全');
  ok(xl.colIndex('A') === 0 && xl.colIndex('B1') === 1, 'colIndex A/B');
  ok(xl.colIndex('Z9') === 25 && xl.colIndex('AA1') === 26 && xl.colIndex('AB') === 27, 'colIndex Z/AA/AB');
  ok(xl.colIndex('') === -1 && xl.colIndex('12') === -1, '无列字母 → -1');
}

console.log('\n[共享字符串 / 日期]');
{
  const sst = xl.parseSharedStrings(SST);
  ok(sst.length === 6, '解析出 6 条共享字符串', sst.length);
  ok(sst[0] === '单词' && sst[3] === '苹果', '普通 <t> 文本');
  ok(sst[4] === '多义', '富文本多段 <r><t> 拼接', sst[4]);
  ok(sst[5] === 'hello & <world>', '共享字符串内实体解码', sst[5]);
  ok(xl.parseSharedStrings('').length === 0, '空输入 → 空数组');

  ok(/^20\d\d-\d\d-\d\d$/.test(xl.excelSerialToDate(45000)), 'Excel 序列号 → 日期', xl.excelSerialToDate(45000));
  ok(/^20\d\d-\d\d-\d\d \d\d:\d\d$/.test(xl.excelSerialToDate(45000.5)), '含小数的序列号带时间', xl.excelSerialToDate(45000.5));
  ok(xl.excelSerialToDate('abc') === 'abc', '非数字原样返回');

  const dates = xl.parseDateStyleIndexes(STYLES);
  ok(dates.has(1) && dates.has(2) && !dates.has(0), '日期样式下标（内置 14 + 自定义 164）', [...dates]);
  const rows = xl.parseSheet('<row r="1"><c r="A1" s="1"><v>45000</v></c><c r="B1"><v>7</v></c></row>', {
    dateStyles: dates
  });
  ok(/^20\d\d-\d\d-\d\d$/.test(rows[0][0]), '日期单元格按格式转文本', rows[0][0]);
  ok(rows[0][1] === '7', '非日期数值保持数字文本', rows[0][1]);
}

console.log('\n[ZIP 读取]');
{
  const xlsx = makeXlsx();
  const files = await xl.unzip(xlsx);
  ok(files.size === 7, 'STORED：读出 7 个条目', files.size);
  ok(files.has('xl/worksheets/sheet1.xml') && files.has('xl/sharedStrings.xml'), '条目名正确');
  ok(new TextDecoder().decode(files.get('xl/workbook.xml')).includes('Sheet1'), '条目内容正确');
  ok(xl.firstSheetPath(files) === 'xl/worksheets/sheet1.xml', '按 workbook + rels 定位工作表', xl.firstSheetPath(files));

  const stored = await xl.unzip(zipOne('a.txt', 'hello', 0));
  ok(new TextDecoder().decode(stored.get('a.txt')) === 'hello', 'STORED 单条目解出');

  const deflated = await xl.unzip(zipOne('b.txt', '你好，世界', 8));
  ok(new TextDecoder().decode(deflated.get('b.txt')) === '你好，世界', 'DEFLATE 单条目解出（真实 DecompressionStream）');

  let injected = null;
  const viaInject = await xl.unzip(zipOne('c.txt', 'xyz', 8), {
    inflate: async (d) => { injected = d; return new TextEncoder().encode('INFLATED'); }
  });
  ok(injected instanceof Uint8Array && new TextDecoder().decode(viaInject.get('c.txt')) === 'INFLATED', 'method=8 走注入的 inflate');

  let e1 = null;
  try { await xl.unzip(new Uint8Array([1, 2, 3, 4])); } catch (e) { e1 = e; }
  ok(!!e1 && /不是有效的 \.xlsx/.test(e1.message), '非 ZIP 字节 → 明确报错', e1 && e1.message);
}

console.log('\n[parseXlsxRows 端到端]');
{
  const rows = await xl.parseXlsxRows(makeXlsx());
  ok(rows.length === 5, '5 行', rows.length);
  ok(rows[0].join('|') === '单词|释义', '首行（表头）', rows[0]);
  ok(rows[1].join('|') === 'apple|苹果', '共享字符串行', rows[1]);
  ok(rows[2].join('|') === '多义|42', '富文本 + 数值行', rows[2]);
  ok(rows[3].join('|') === '|内联', '跳列补空 + 内联字符串', rows[3]);
  ok(rows[4].join('|') === 'TRUE|hello & <world>', '布尔 + 实体解码', rows[4]);

  // 无 workbook/rels 时回退到 sheet1.xml
  const bare = ex.zipStore([{ name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>' }]);
  ok((await xl.parseXlsxRows(bare))[0][0] === 'x', '缺少 workbook.xml 时回退 sheet1.xml');

  let e = null;
  try { await xl.parseXlsxRows(ex.zipStore([{ name: 'foo.txt', data: 'x' }])); } catch (err) { e = err; }
  ok(!!e && /没有找到工作表/.test(e.message), '无工作表 → 明确报错', e && e.message);
}

console.log('\n[单元格引用]');
{
  ok(xl.refToRC('C12').r === 11 && xl.refToRC('C12').c === 2, 'refToRC 基础');
  ok(xl.refToRC('$AA$3').r === 2 && xl.refToRC('$AA$3').c === 26, 'refToRC 容忍 $ 绝对引用');
  ok(xl.refToRC('bogus') === null && xl.refToRC('') === null, '非法引用 → null');
  ok(xl.rcToRef(0, 0) === 'A1' && xl.rcToRef(11, 2) === 'C12', 'rcToRef 基础');
  ok(xl.rcToRef(0, 26) === 'AA1' && xl.rcToRef(0, 27) === 'AB1', 'rcToRef 进位（AA/AB）');
  ok(xl.rcToRef(xl.refToRC('ZZ100').r, xl.refToRC('ZZ100').c) === 'ZZ100', '往返一致');
}

console.log('\n[公式求值]');
{
  const ctx = {
    getRef: (ref) => ({ A1: 10, B1: 4, C1: 'apple', D1: '' }[ref] ?? ''),
    getRange: (from, to) => (from === 'A1' ? [10, 4, '', 'apple'] : [])
  };
  const ev = (f) => xl.evalFormula(f, ctx);

  ok(ev('1+2*3') === 7, '四则运算优先级', ev('1+2*3'));
  ok(ev('(1+2)*3') === 9, '括号优先');
  ok(ev('2^3^2') === 64, '幂运算左结合（Excel 语义：(2^3)^2）', ev('2^3^2'));
  ok(ev('-2^2') === 4, '负号先于幂（Excel 语义）', ev('-2^2'));
  ok(ev('7/2') === 3.5 && ev('7%') === 0.07, '除法与后缀百分比', ev('7%'));
  ok(ev('A1+B1') === 14 && ev('A1*B1') === 40, '单元格引用参与算术', ev('A1+B1'));
  ok(ev('C1&"!"') === 'apple!' && ev('A1&"个"') === '10个', '& 字符串拼接');
  ok(ev('A1>B1') === true && ev('A1=B1') === false && ev('A1<>B1') === true, '比较运算');
  ok(ev('C1="APPLE"') === true, '文本比较不区分大小写');
  ok(ev('SUM(A1:A2)') === 14 && ev('SUM(A1,B1,1)') === 15, 'SUM 区域 / 多参', ev('SUM(A1:A2)'));
  ok(ev('AVERAGE(B1,6)') === 5 && ev('MIN(A1,B1)') === 4 && ev('MAX(A1,B1)') === 10, 'AVERAGE / MIN / MAX');
  ok(ev('COUNT(A1:A2)') === 2 && ev('COUNTA(A1:A2)') === 3, 'COUNT 只数数字 / COUNTA 数非空', [ev('COUNT(A1:A2)'), ev('COUNTA(A1:A2)')]);
  ok(ev('ROUND(1/3,2)') === 0.33 && ev('ROUND(2.5)') === 3, 'ROUND（含默认 0 位）', ev('ROUND(1/3,2)'));
  ok(ev('ABS(-3)') === 3 && ev('INT(-1.2)') === -2 && ev('MOD(-1,3)') === 2, 'ABS / INT / MOD');
  ok(ev('POWER(2,10)') === 1024 && ev('SQRT(16)') === 4, 'POWER / SQRT');
  ok(ev('LEN(C1)') === 5 && ev('UPPER(C1)') === 'APPLE' && ev('LOWER("AB")') === 'ab', 'LEN / UPPER / LOWER');
  ok(ev('TRIM("  a   b  ")') === 'a b', 'TRIM 合并内部空白', ev('TRIM("  a   b  ")'));
  ok(ev('LEFT(C1,3)') === 'app' && ev('RIGHT(C1,3)') === 'ple' && ev('MID(C1,2,3)') === 'ppl', 'LEFT / RIGHT / MID');
  ok(ev('CONCAT(C1,"-",B1)') === 'apple-4' && ev('CONCATENATE("a","b")') === 'ab', 'CONCAT / CONCATENATE');
  ok(ev('IF(A1>B1,"大","小")') === '大' && ev('IF(1>2,1)') === false, 'IF 两分支 / 省略 else');
  ok(ev('IF(FALSE,1/0,"ok")') === 'ok', 'IF 惰性求值（不碰未命中分支）');
  ok(ev('IFERROR(1/0,"err")') === 'err' && ev('IFERROR(1,"ok")') === 1, 'IFERROR');
  ok(ev('AND(A1>1,B1>1)') === true && ev('OR(FALSE,FALSE)') === false && ev('NOT(TRUE)') === false, 'AND / OR / NOT');
  ok(ev('TRUE()') === true && ev('FALSE') === false, 'TRUE() / FALSE');
  ok(ev('"汉字"') === '汉字' && ev('"a""b"') === 'a"b', '字符串字面量（"" 转义）');
  ok(ev('SUM(A1:A2)') === 14, '区域引用');
  ok(ev('1/0') === null && ev('SQRT(-1)') === null, '除零 / 负数开方 → null（回退）');
  ok(ev('VLOOKUP("cat",A1:B2,1,0)') === null, '不支持的函数 → null（回退缓存值）');
  ok(ev('已定义的名称') === null && ev('A1+') === null && ev('') === null, '中文名 / 残缺表达式 / 空 → null');
  ok(ev('Sheet1!A1') === null, '跨表引用 → null');
  ok(xl.evalFormula('SUM(A1:A2)') === 0, '没给 ctx 时区域为空 → 0');
  ok(xl.isFormulaSupported('SUM(A1:A2)') === true && xl.isFormulaSupported('VLOOKUP(A1,B1,1,0)') === true, 'isFormulaSupported 只看能否解析');
  ok(xl.isFormulaSupported('Sheet1!A1') === false, '跨表引用解析失败 → 不支持');
  ok(xl.isFormulaSupported('=B4*2') === true, '容忍前导 =');
  ok(xl.FORMULA_FUNCTION_NAMES.includes('SUM') && xl.FORMULA_FUNCTION_NAMES.includes('IF') && xl.FORMULA_FUNCTION_NAMES.includes('IFERROR'), '函数名清单含 SUM/IF/IFERROR');
  ok(xl.FORMULA_OPERATORS.includes('^') && xl.FORMULA_OPERATORS.includes('&'), '运算符清单');
  ok(xl.formatFormulaValue(42) === '42' && xl.formatFormulaValue(true) === 'TRUE' && xl.formatFormulaValue(false) === 'FALSE', 'formatFormulaValue 数字 / 布尔');
  ok(xl.formatFormulaValue(1 / 3) === '0.333333333333', '浮点尾巴被裁到 12 位有效数字', xl.formatFormulaValue(1 / 3));
}

console.log('\n[合并单元格]');
{
  const M = '<mergeCells count="2"><mergeCell ref="A1:A3"/><mergeCell ref="B1:C1"/></mergeCells>';
  const merges = xl.parseMerges(M);
  ok(merges.length === 2, '解析出 2 个合并区', merges.length);
  ok(merges[0].ref === 'A1:A3' && merges[0].r1 === 0 && merges[0].c1 === 0 && merges[0].r2 === 2, 'A1:A3 坐标（0 基）', merges[0]);
  ok(merges[1].ref === 'B1:C1' && merges[1].c2 === 2, 'B1:C1 横向区', merges[1]);
  ok(xl.parseMerges('<mergeCells count="1"><mergeCell ref="A1:A1"/></mergeCells>').length === 0, '单格合并不算');
  ok(xl.parseMerges('<worksheet><mergeCells count="2"/><mergeCell ref="A1:B2"/></worksheet>').length === 0, '没有 mergeCell 子标签 → 空');

  const region = xl.parseMerges('<mergeCells><mergeCell ref="A1:A3"/></mergeCells>');
  const filled = xl.applyMerges([['动物'], [''], [''], ['猫科', 'cat']], region);
  ok(filled.rows[0][0] === '动物' && filled.rows[1][0] === '动物' && filled.rows[2][0] === '动物', 'fill：左上角值填满整个区域', filled.rows);
  ok(filled.filled === 2, 'fill：统计填充格数', filled.filled);
  ok(filled.rows[3][0] === '猫科' && filled.rows[3][1] === 'cat', 'fill：不触碰区域外的行');

  const kept = xl.applyMerges([['动物'], ['dog'], ['cat']], region);
  ok(kept.rows[1][0] === 'dog' && kept.rows[2][0] === 'cat' && kept.filled === 0, 'fill：只填空格，不覆盖已有数据', kept.rows);

  const keep = xl.applyMerges([['动物'], ['dog'], ['']], region, { mode: 'blank' });
  ok(keep.rows[1][0] === 'dog' && keep.rows[2][0] === '' && keep.filled === 0, 'blank：只保留左上角', keep.rows);

  const grown = xl.applyMerges([['x']], xl.parseMerges('<mergeCells><mergeCell ref="A1:C3"/></mergeCells>'));
  ok(grown.rows.length === 3 && grown.rows[1][2] === 'x' && grown.rows[2][1] === 'x', 'fill：区域超出已有行列时自动补齐', grown.rows);
  ok(xl.applyMerges([['a']], []).rows.length === 1 && xl.applyMerges(null, null).rows.length === 0, '空入参安全');
}

/* ---------- 多工作表 + 公式 + 合并单元格 的端到端料件 ---------- */
const WB2 = `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
  `<sheet name="词表" sheetId="1" r:id="rId1"/>` +
  `<sheet name="隐藏页" sheetId="2" state="hidden" r:id="rId3"/>` +
  `<sheet name="备份" sheetId="3" r:id="rId2"/>` +
  `</sheets></workbook>`;
const WBRELS2 = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/>` +
  `<Relationship Id="rId2" Type="x/worksheet" Target="worksheets/sheet3.xml"/>` +
  `<Relationship Id="rId3" Type="x/worksheet" Target="worksheets/sheet2.xml"/>` +
  `</Relationships>`;
// 第 3 行 A3 属于合并区 A2:A3，XML 里没有值 → 应被左上角「动物」填充
// B4/C4/D4 无缓存值 → 需要求值；A5 共享公式主格；A6 共享公式从属格（只能取缓存值）
// A7 不支持的函数（有缓存值）；A8/B8 循环引用；A9 缓存值与实际结果不同（验证两种模式）
const SHEET_A = `<?xml version="1.0"?><worksheet><sheetData>` +
  `<row r="1"><c r="A1" t="inlineStr"><is><t>分类</t></is></c><c r="B1" t="inlineStr"><is><t>单词</t></is></c></row>` +
  `<row r="2"><c r="A2" t="inlineStr"><is><t>动物</t></is></c><c r="B2" t="inlineStr"><is><t>cat</t></is></c></row>` +
  `<row r="3"><c r="B3" t="inlineStr"><is><t>dog</t></is></c></row>` +
  `<row r="4"><c r="A4" t="inlineStr"><is><t>合计</t></is></c><c r="B4"><f>COUNTA(B2:B3)</f></c>` +
  `<c r="C4"><f>B4*10</f></c><c r="D4"><f>IF(B4&gt;1,"多","少")</f></c></row>` +
  `<row r="5"><c r="A5"><f t="shared" si="0" ref="A5:A6">SUM(1,2)</f><v>3</v></c></row>` +
  `<row r="6"><c r="A6"><f t="shared" si="0"/><v>3</v></c></row>` +
  `<row r="7"><c r="A7"><f>VLOOKUP("cat",B2:B3,1,0)</f><v>cat</v></c></row>` +
  `<row r="8"><c r="A8"><f>A8+1</f></c><c r="B8"><f>B8</f></c></row>` +
  `<row r="9"><c r="A9"><f>2+3</f><v>999</v></c></row>` +
  `</sheetData><mergeCells count="1"><mergeCell ref="A2:A3"/></mergeCells></worksheet>`;
const SHEET_C = `<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>备份词</t></is></c></row></sheetData></worksheet>`;
const SHEET_B = `<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>隐藏词</t></is></c></row></sheetData></worksheet>`;

function makeXlsxMulti() {
  return ex.zipStore([
    { name: '[Content_Types].xml', data: CT },
    { name: 'xl/workbook.xml', data: WB2 },
    { name: 'xl/_rels/workbook.xml.rels', data: WBRELS2 },
    { name: 'xl/worksheets/sheet1.xml', data: SHEET_A },
    { name: 'xl/worksheets/sheet2.xml', data: SHEET_B },
    { name: 'xl/worksheets/sheet3.xml', data: SHEET_C }
  ]);
}

console.log('\n[多工作表]');
{
  const bytes = makeXlsxMulti();
  const sheets = await xl.listXlsxSheets(bytes);
  ok(sheets.length === 3, '列出 3 个工作表', sheets.length);
  ok(sheets.map((s) => s.name).join(',') === '词表,隐藏页,备份', '按 workbook.xml 顺序 + 名称', sheets.map((s) => s.name));
  ok(sheets[1].hidden === true && sheets[0].hidden === false, '识别隐藏工作表', sheets[1]);
  ok(sheets[0].path === 'xl/worksheets/sheet1.xml' && sheets[1].path === 'xl/worksheets/sheet2.xml', '按 rels 映射到实际 XML', sheets.map((s) => s.path));
  ok(xl.firstSheetPath(await xl.unzip(bytes)) === 'xl/worksheets/sheet1.xml', 'firstSheetPath 兼容旧调用');

  const wb = await xl.openXlsx(bytes);
  ok(wb.sheets.length === 3 && typeof wb.read === 'function', 'openXlsx 返回 sheets + read');
  ok(wb.read(0).rows[0][0] === '分类', 'read(0) 读第一张表');
  ok(wb.read(2).rows[0][0] === '备份词', 'read(2) 按下标读第三张表');
  ok(wb.read('备份').rows[0][0] === '备份词', 'read("备份") 按名称读表', wb.read('备份').rows);
  ok(wb.read(1).rows[0][0] === '隐藏词', '隐藏表也能显式读取');
  ok(wb.read(0) === wb.read(0), '同一张表重复读取走缓存（同一对象引用）');
  ok(wb.readAll().length === 3 && wb.readAll()[2].name === '备份', 'readAll 解析全部工作表');
  ok((await xl.parseXlsxRows(bytes, { sheet: 1 }))[0][0] === '隐藏词', 'parseXlsxRows 支持 sheet 选项');
  ok((await xl.parseXlsxSheets(bytes))[2].rows[0][0] === '备份词', 'parseXlsxSheets 返回全部内容');
  ok((await xl.parseXlsxRows(bytes))[0][0] === '分类', '不给 sheet → 默认第一张表');

  let e = null;
  try { wb.read('不存在'); } catch (err) { e = err; }
  ok(!!e && /没有找到工作表/.test(e.message), '未知工作表名 → 明确报错', e && e.message);

  // 无 workbook.xml：回退 sheetN.xml 并给出占位名称
  const bare = await xl.unzip(ex.zipStore([
    { name: 'xl/worksheets/sheet2.xml', data: '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>2</t></is></c></row></sheetData></worksheet>' },
    { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>1</t></is></c></row></sheetData></worksheet>' }
  ]));
  const bareSheets = xl.workbookSheets(bare);
  ok(bareSheets.length === 2 && bareSheets[0].path === 'xl/worksheets/sheet1.xml', '无 workbook.xml → 按 sheetN 排序回退', bareSheets.map((s) => s.path));
  ok(bareSheets[0].name === 'Sheet1' && bareSheets[1].name === 'Sheet2', '回退时用占位名称', bareSheets.map((s) => s.name));
  ok(xl.workbookSheets(new Map()).length === 0, '空 ZIP → 无工作表');
}

console.log('\n[公式 / 合并单元格 端到端]');
{
  const bytes = makeXlsxMulti();
  const detail = (await xl.openXlsx(bytes)).read(0);
  const rows = detail.rows;

  ok(rows[1][0] === '动物' && rows[2][0] === '动物', '合并单元格：A3 被左上角「动物」填充', rows.slice(1, 3));
  ok(detail.merges.length === 1 && detail.merges[0].ref === 'A2:A3', 'merges 一并返回');
  ok(detail.notices.merges === 1 && detail.notices.mergedCells === 1, 'notices 记录合并统计', detail.notices);
  ok(rows[3][1] === '2' && rows[3][2] === '20' && rows[3][3] === '多', '无缓存值的公式被求值（COUNTA→算术→IF）', rows[3]);
  ok(rows[4][0] === '3' && rows[5][0] === '3', '共享公式主格用缓存值 / 从属格回退缓存值', rows.slice(4, 6));
  ok(rows[6][0] === 'cat', '不支持的函数 → 回退 Excel 缓存值', rows[6]);
  ok(rows[7][0] === '' && rows[7][1] === '', '循环引用 → 求值失败回退（空缓存值）', rows[7]);
  ok(rows[8][0] === '999', '默认 cached 模式：缓存值优先', rows[8]);
  ok(detail.notices.formulas === 9, 'notices.formulas 统计公式格数', detail.notices);
  ok(detail.notices.evaluated === 3, 'notices.evaluated 统计真正求值的格数', detail.notices);
  ok(detail.notices.unsupported === 2, 'notices.unsupported 统计求值失败的格数（循环引用）', detail.notices);

  const evaluated = (await xl.openXlsx(bytes, { formulaMode: 'evaluate' })).read(0);
  ok(evaluated.rows[8][0] === '5', 'evaluate 模式：自己算（2+3=5）', evaluated.rows[8]);
  ok(evaluated.rows[4][0] === '3' && evaluated.rows[6][0] === 'cat', 'evaluate 模式仍能回退（共享从属格 / 不支持函数）', [evaluated.rows[4][0], evaluated.rows[6][0]]);
  ok(evaluated.notices.unsupported === 3, 'evaluate 模式下 VLOOKUP 记为不支持', evaluated.notices);

  const blanked = (await xl.openXlsx(bytes, { mergeMode: 'blank' })).read(0);
  ok(blanked.rows[1][0] === '动物' && blanked.rows[2][0] === '', 'mergeMode=blank：只保留左上角', blanked.rows.slice(1, 3));
  ok(blanked.notices.mergedCells === 0, 'blank 模式填充数为 0', blanked.notices);

  ok(xl.parseSheet(SHEET_A)[1][1] === 'cat', 'parseSheet 仍返回纯二维表');
}

console.log(`\nxlsx 结果: ${pass} 通过, ${fail} 失败`);



process.exit(fail ? 1 : 0);
