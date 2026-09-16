#!/usr/bin/env node
// ============================================================================
// test-export.mjs — 卡组导出（标准 txt / Anki .apkg）测试
//   运行: node scripts/test-export.mjs
// 覆盖：txt 格式与转义 / ZIP 写出器 / CRC32 / Anki schema 与 models·decks·dconf /
//       collection.anki2 生成（sql.js）→ 用 Python zipfile+sqlite3 独立校验产物
// ============================================================================

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------- 浏览器全局桩 ---------- */
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
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
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

const store = await import('../js/store.js');
const ex = await import('../js/export.js');

let pass = 0;
let fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

/* ---------- 测试卡组 ---------- */
const deck = store.createDeck({ name: '导出测试·四级' });
store.addManyCards(deck.id, [
  { front: 'abandon', back: 'v. 放弃', example: 'He abandoned the plan.', exampleZh: '他放弃了这个计划。', phonetic: '/əˈbændən/', tags: ['考研', 'core'] },
  { front: 'book', back: 'n. 书', extraBacks: ['v. 预订'], example: 'I read a book.', exampleZh: '我读了一本书。', tags: ['basic'] },
  { front: 'with\ttab\nnewline', back: '含制表符与换行' },
  { front: '', back: '没有正面的行应被跳过' }
]);
const live = store.getDeck(deck.id);

console.log('\n[文件名校验]');
{
  ok(ex.safeFileName('我的 卡组') === '我的 卡组', '正常名称保留');
  ok(ex.safeFileName('a/b\\c:d*e?f"g<h>i|j') === 'a_b_c_d_e_f_g_h_i_j', '非法字符替换为下划线', ex.safeFileName('a/b\\c:d*e?f"g<h>i|j'));
  ok(ex.safeFileName('   ') === 'mycard', '空名称回退默认');
  ok(ex.safeFileName('...hidden') === 'hidden', '去掉开头点号');
}

console.log('\n[标准 txt（TSV）]');
{
  ok(ex.TXT_COLUMNS.join(',') === 'front,back,example,exampleZh,phonetic,tags', '列定义顺序');
  ok(ex.tsvCell('a\tb\nc') === 'a b c', '单元格内制表符/换行转空格');
  const row = ex.cardToTxtRow(live.cards[0]);
  ok(row.join('|') === 'abandon|v. 放弃|He abandoned the plan.|他放弃了这个计划。|/əˈbændən/|考研,core', '一行 6 列', row);

  const txt = ex.deckToTxt(live);
  ok(txt.charCodeAt(0) === 0xfeff, '带 UTF-8 BOM（Excel/Anki 识别）');
  const lines = txt.slice(1).replace(/\r\n$/, '').split('\r\n');
  ok(lines.length === 4, '表头 + 3 张有效卡（无正面的卡片被跳过）', lines.length);
  ok(lines[0] === ex.TXT_COLUMNS.join('\t'), '首行为列名');
  ok(lines[1].split('\t')[0] === 'abandon', '第 1 张卡正面');
  ok(lines[3].includes('with tab newline'), '含制表符/换行的卡片被清洗为单行', lines[3]);
  ok(lines.every((l) => l.split('\t').length === 6), '每行均为 6 列');
  const noHeader = ex.deckToTxt(live, { header: false }).slice(1).replace(/\r\n$/, '').split('\r\n');
  ok(noHeader.length === 3 && noHeader[0].startsWith('abandon'), 'header:false 不输出列名');
}

console.log('\n[CRC32 与 ZIP 写出器]');
{
  const crc = ex.crc32(new TextEncoder().encode('123456789'));
  ok(crc === 3421780262, 'CRC32("123456789") = 0xCBF43926', crc);
  ok(ex.crc32(new Uint8Array(0)) === 0, '空数据 CRC = 0');

  const zip = ex.zipStore([
    { name: 'collection.anki2', data: new Uint8Array([1, 2, 3]) },
    { name: 'media', data: '{}' }
  ]);
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  ok(dv.getUint32(0, true) === 0x04034b50, 'ZIP 起始为本地文件头签名');
  ok(dv.getUint32(zip.length - 22, true) === 0x06054b50, '末尾 22 字节为 EOCD 签名');
  const text = new TextDecoder('latin1').decode(zip);
  ok(text.includes('collection.anki2') && text.includes('media'), 'ZIP 内含两个条目名');
  ok(dv.getUint16(zip.length - 14, true) === 2, 'EOCD 记录 2 个条目');
}

console.log('\n[Anki schema / 模板 JSON]');
{
  ok(ex.ANKI_SCHEMA.includes('CREATE TABLE col') && ex.ANKI_SCHEMA.includes('CREATE TABLE notes'), '含 col/notes 表');
  ok(ex.ANKI_SCHEMA.includes('CREATE TABLE cards') && ex.ANKI_SCHEMA.includes('CREATE TABLE revlog'), '含 cards/revlog 表');
  ok(ex.ANKI_SCHEMA.includes('CREATE TABLE graves'), '含 graves 表');
  ok(ex.ankiHtml('<b>a</b>&b\nc') === '&lt;b&gt;a&lt;/b&gt;&amp;b<br>c', 'Anki 字段 HTML 转义 + 换行转 <br>');
  ok(ex.plainText('<b>ab</b><br>cd') === 'ab cd', 'sfld 取纯文本');
  ok(ex.ankiTag('hello world') === 'hello_world', '标签空格转下划线');
  ok(ex.ankiTag('a"b\'c') === 'abc', '标签去引号');
  ok(ex.ankiGuid().length === 10, 'guid 长度 10 且非空', ex.ankiGuid());
  ok(ex.ankiGuid() !== ex.ankiGuid(), 'guid 不重复');
  const mid = 1650000000000;
  const model = ex.basicModel(mid, 1, 1700000000000)[mid];
  ok(model.name === 'Basic' && model.tmpls[0].qfmt === '{{Front}}', 'Basic 模板：Front 问题面');
  ok(model.tmpls[0].afmt.includes('{{Back}}'), 'Basic 模板：答案面含 {{Back}}');
  ok(model.flds.map((f) => f.name).join(',') === 'Front,Back', '模板两个字段');
  ok(model.req[0][0] === 0 && model.req[0][1] === 'all', 'req 定义有效');
  const decks = ex.decksJson(1, '四级词库', 1700000000000);
  ok(decks['1'].name === '四级词库' && decks['1'].conf === 1, 'decks JSON 用卡组名');
  const dconf = ex.dconfJson(1700000000000);
  ok(!!dconf['1'].new && !!dconf['1'].rev && !!dconf['1'].lapse, 'dconf 含 new/rev/lapse');
  const conf = ex.colConfJson(mid, 1);
  ok(conf.curModel === String(mid) && conf.nextPos === 1, 'col.conf 指向模板');
  const fields = ex.cardToAnkiFields(live.cards[1]);
  ok(fields[0].includes('/əˈbændən/') === false, '音标只在该卡有值时写入');
  ok(fields[1].includes('v. 预订'), '多释义并入背面');
  ok(fields[1].includes('I read a book.'), '例句并入背面');
  ok(ex.cardToAnkiFields(live.cards[0])[0].includes('/əˈbændən/'), '有音标 → 正面附音标');
}

console.log('\n[下载触发]');
{
  const savedCreate = URL.createObjectURL;
  const savedRevoke = URL.revokeObjectURL;
  const savedCreateEl = document.createElement;
  try {
    delete URL.createObjectURL;
    ok(ex.downloadBlob('x.txt', 'hi', 'text/plain') === null, '无 createObjectURL → 安全返回 null');
  } finally {
    URL.createObjectURL = savedCreate;
  }
  const clicks = [];
  const revoked = [];
  URL.createObjectURL = () => 'blob:test';
  URL.revokeObjectURL = (u) => revoked.push(u);
  document.createElement = () => {
    const el = fakeEl();
    el.click = () => clicks.push(el.download);
    return el;
  };
  const res = ex.downloadBlob('我的词表.txt', 'hi', 'text/plain');
  ok(!!res && res.filename === '我的词表.txt' && res.size === 2, '返回文件名与字节数', res && res.filename);
  ok(clicks[0] === '我的词表.txt', '触发 <a download> 点击', clicks);
  URL.createObjectURL = savedCreate;
  URL.revokeObjectURL = savedRevoke;
  document.createElement = savedCreateEl;
}

console.log('\n[.apkg 生成（内置 sql.js）+ Python 独立校验]');
{
  const require = createRequire(import.meta.url);
  const initSqlJs = require(join(ROOT, 'vendor/sql.js/sql-wasm.js'));
  ok(typeof initSqlJs === 'function', 'vendor/sql.js 的 UMD 构建可加载');
  const SQL = await initSqlJs({ locateFile: (f) => join(ROOT, 'vendor/sql.js', f) });
  ex.__setSqlJs(SQL);
  ok(!!SQL && typeof SQL.Database === 'function', 'sql.js 初始化成功（WASM）');

  const bytes = await ex.deckToApkg(live);
  ok(bytes instanceof Uint8Array && bytes.length > 2000, '生成 .apkg 字节', bytes.length);

  const dir = mkdtempSync(join(tmpdir(), 'mycard-apkg-'));
  const apkgPath = join(dir, 'deck.apkg');
  writeFileSync(apkgPath, bytes);

  const py = `
import json, os, sqlite3, sys, tempfile, zipfile
p = sys.argv[1]
z = zipfile.ZipFile(p)
print('NAMES=' + ','.join(sorted(z.namelist())))
print('MEDIA=' + z.read('media').decode('utf-8'))
d = tempfile.mkdtemp()
f = os.path.join(d, 'collection.anki2')
open(f, 'wb').write(z.read('collection.anki2'))
con = sqlite3.connect(f)
print('TABLES=' + ','.join(sorted(r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'"))))
row = con.execute('SELECT ver, models, decks, dconf, conf, crt FROM col').fetchone()
print('COL_ROWS=%d' % con.execute('SELECT COUNT(*) FROM col').fetchone()[0])
print('VER=%s' % row[0])
print('MODELS_JSON=' + str(bool(json.loads(row[1]))).lower())
decks = json.loads(row[2])
print('DECK_NAME=%s' % decks['1']['name'])
print('DECK_CONF=%s' % decks['1']['conf'])
print('DCONF_KEYS=' + ','.join(sorted(json.loads(row[3])['1'].keys())))
print('CONF_KEYS=' + ','.join(sorted(json.loads(row[4]).keys())))
print('CRT=%s' % row[5])
print('NOTES=%d' % con.execute('SELECT COUNT(*) FROM notes').fetchone()[0])
print('CARDS=%d' % con.execute('SELECT COUNT(*) FROM cards').fetchone()[0])
print('REVLOG=%d' % con.execute('SELECT COUNT(*) FROM revlog').fetchone()[0])
print('GRAVES=%d' % con.execute('SELECT COUNT(*) FROM graves').fetchone()[0])
n = con.execute('SELECT flds, sfld, tags, guid, csum FROM notes ORDER BY id LIMIT 1').fetchone()
print('FLD_SEP=' + str('\\x1f' in n[0]).lower())
print('FLD0=%s' % n[0].split('\\x1f')[0])
print('SFLD=%s' % n[1])
print('TAGS=%s' % n[2].strip())
print('GUID_LEN=%d' % len(n[3]))
print('CSUM_POS=' + str(n[4] > 0).lower())
c = con.execute('SELECT did, ord, type, queue, factor, reps FROM cards ORDER BY id LIMIT 1').fetchone()
print('CARD=' + ','.join(str(x) for x in c))
print('INTEGRITY=' + str(con.execute('PRAGMA integrity_check').fetchone()[0]))
`;
  let out = '';
  try {
    out = execFileSync('python3', ['-c', py, apkgPath], { encoding: 'utf8' });
  } catch (e) {
    ok(false, 'python3 校验执行失败：' + (e && e.message));
  }
  const v = {};
  for (const line of out.trim().split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) v[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }

  ok(v.NAMES === 'collection.anki2,media', 'ZIP 内仅 collection.anki2 与 media', v.NAMES);
  ok(v.MEDIA === '{}', 'media 为 {}');
  ok(v.TABLES === 'cards,col,graves,notes,revlog', 'SQLite 表结构正确', v.TABLES);
  ok(v.COL_ROWS === '1', 'col 恰 1 行');
  ok(v.VER === '11', 'col.ver = 11（Anki 2.1 schema）', v.VER);
  ok(v.MODELS_JSON === 'true', 'models 是合法 JSON');
  ok(v.DECK_NAME === '导出测试·四级', 'decks JSON 使用卡组名', v.DECK_NAME);
  ok(v.DECK_CONF === '1' && v.DCONF_KEYS.includes('new') && v.DCONF_KEYS.includes('rev'), 'dconf 含 new/rev', v.DCONF_KEYS);
  ok(v.CONF_KEYS.includes('curModel') && v.CONF_KEYS.includes('nextPos'), 'col.conf 完整', v.CONF_KEYS);
  ok(v.NOTES === '3' && v.CARDS === '3', 'notes/cards 行数 = 有效卡数（3）', [v.NOTES, v.CARDS]);
  ok(v.REVLOG === '0' && v.GRAVES === '0', 'revlog/graves 为空（全新导入）');
  ok(v.FLD_SEP === 'true', 'notes.flds 用 \\x1f 分隔字段');
  ok(String(v.FLD0).startsWith('abandon'), '第一张卡正面内容正确', v.FLD0);
  ok(v.SFLD === 'abandon', 'sfld 为纯文本正面');
  ok(v.TAGS.includes('core') && v.TAGS.includes('考研'), '标签已写入（空格分隔）', v.TAGS);
  ok(Number(v.GUID_LEN) === 10, 'guid 已写入', v.GUID_LEN);
  ok(v.CSUM_POS === 'true', 'csum 已计算（SHA-1 前 8 位）');
  ok(v.CARD === '1,0,0,0,2500,0', 'card：did=1 / ord=0 / 新卡 / factor=2500 / reps=0', v.CARD);
  ok(v.INTEGRITY === 'ok', 'SQLite PRAGMA integrity_check = ok', v.INTEGRITY);
}

console.log(`\n导出结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

