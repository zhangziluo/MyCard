#!/usr/bin/env node
// ============================================================================
// test-xlsx.mjs — 极简 .xlsx 读取器（自写 ZIP 读取 + 最小 XML 扫描）测试
//   运行: node scripts/test-xlsx.mjs
// 覆盖：ZIP(STORED/DEFLATE) / 共享字符串 / 内联字符串 / 数值 / 布尔 / 日期 /
//      跳列补空 / workbook+rels 定位工作表 / 错误处理
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

console.log(`\nxlsx 结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
