#!/usr/bin/env node
// ============================================================================
// test-export.mjs — 卡组导出（标准 txt / CSV / Markdown / Anki .apkg）测试
//   运行: node scripts/test-export.mjs
// 覆盖：txt 格式与转义 / CSV RFC4180 转义与表头 / Markdown 表格与转义 /
//       Anki meta protobuf（PackageMetadata 版本号）/ ZIP 写出器 / CRC32 /
//       Anki schema 与 models·decks·dconf / collection.anki2 生成（sql.js）
//       → 用 Python zipfile+sqlite3 独立校验产物（含 meta 字节）
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

console.log('\n[CSV（带表头）]');
{
  ok(ex.csvCell('ab') === 'ab', '普通字段不加引号');
  ok(ex.csvCell('') === '', '空字段为裸空');
  ok(ex.csvCell('a,b') === '"a,b"', '含逗号 → 双引号包裹');
  ok(ex.csvCell('a"b') === '"a""b"', '内部引号加倍为 ""');
  ok(ex.csvCell('a\nb') === '"a\nb"', '含换行 → 双引号包裹（保留换行）');
  ok(ex.csvCell(null) === '', 'null 视为空');
  ok(
    ex.cardToCsvRow(live.cards[0]).join('|') === 'abandon|v. 放弃|He abandoned the plan.|他放弃了这个计划。|/əˈbændən/|"考研,core"',
    '一行 6 列且含逗号的标签被引号包裹',
    ex.cardToCsvRow(live.cards[0])
  );

  const csv = ex.deckToCsv(live);
  ok(csv.charCodeAt(0) === 0xfeff, '带 UTF-8 BOM（Excel 识别）');
  const lines = csv.slice(1).replace(/\r\n$/, '').split('\r\n');
  ok(lines.length === 4, '表头 + 3 张有效卡', lines.length);
  ok(lines[0] === ex.TXT_COLUMNS.join(','), '首行为列名（逗号分隔）');
  ok(lines[1] === 'abandon,v. 放弃,He abandoned the plan.,他放弃了这个计划。,/əˈbændən/,"考研,core"', '首卡整行正确', lines[1]);
  ok(lines[2] === 'book,n. 书,I read a book.,我读了一本书。,,basic', '空音标保留空列', lines[2]);
  ok(lines[3] === '"with\ttab\nnewline",含制表符与换行,,,,', '含制表符/换行的单元格被引号包裹且不破坏分行', JSON.stringify(lines[3]));
  const noHeader = ex.deckToCsv(live, { header: false }).slice(1);
  ok(noHeader.startsWith('abandon,'), 'header:false 不输出列名');
}

console.log('\n[Markdown（表格）]');
{
  ok(ex.mdCell('a|b') === 'a\\|b', '竖线转义为 \\|');
  ok(ex.mdCell('a\\b') === 'a\\\\b', '反斜杠转义');
  ok(ex.mdCell('a\tb') === 'a b', '制表符转空格');
  ok(ex.mdCell('a\nb') === 'a<br>b', '换行转 <br>');
  ok(ex.mdCell('  a  ') === 'a', '去首尾空白');

  const md = ex.deckToMarkdown(live);
  const lines = md.replace(/\n$/, '').split('\n');
  ok(lines[0] === '# 导出测试·四级', '首行为 # 卡组名标题', lines[0]);
  ok(lines[1] === '', '标题后空行');
  ok(lines[2] === '| front | back | example | exampleZh | phonetic | tags |', '表头行', lines[2]);
  ok(lines[3] === '| --- | --- | --- | --- | --- | --- |', '分隔行', lines[3]);
  ok(
    lines[4] === '| abandon | v. 放弃 | He abandoned the plan. | 他放弃了这个计划。 | /əˈbændən/ | 考研,core |',
    '首卡数据行',
    lines[4]
  );
  ok(lines[6] === '| with tab<br>newline | 含制表符与换行 |  |  |  |  |', '含制表符/换行的卡片被清洗为单行', lines[6]);
  ok(lines.length === 7, '标题 + 空行 + 表头 + 分隔 + 3 张有效卡', lines.length);
  ok(!md.includes('没有正面的行'), '无正面卡片被跳过');
  ok(ex.deckToMarkdown(live, { title: false }).split('\n')[0] === '| front | back | example | exampleZh | phonetic | tags |', 'title:false 直接以表头开始');
  ok(ex.deckToMarkdown(live, { header: false }).split('\n')[2].startsWith('| abandon |'), 'header:false 不输出表头/分隔行');
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

console.log('\n[Anki meta protobuf（PackageMetadata）]');
{
  ok(
    ex.ANKI_META_VERSION.LEGACY_1 === 1 && ex.ANKI_META_VERSION.LEGACY_2 === 2 && ex.ANKI_META_VERSION.LATEST === 3,
    '版本枚举与 Anki proto 一致（LEGACY_1=1 / LEGACY_2=2 / LATEST=3）'
  );
  const b1 = ex.encodePackageMetadata(ex.ANKI_META_VERSION.LEGACY_1);
  ok(b1 instanceof Uint8Array && b1.length === 2 && b1[0] === 0x08 && b1[1] === 1, 'PackageMetadata{version=1} = 08 01', [...b1]);
  ok(String([...ex.encodePackageMetadata()]) === '8,1', '默认版本即 LEGACY_1', [...ex.encodePackageMetadata()]);
  const b300 = ex.encodePackageMetadata(300);
  ok(b300.length === 3 && b300[0] === 0x08 && b300[1] === 0xac && b300[2] === 0x02, 'varint 多字节编码（300 → 08 AC 02）', [...b300]);
  const b0 = ex.encodePackageMetadata(0);
  ok(b0.length === 2 && b0[1] === 0, 'version=0 也有编码（Anki 会判 UNKNOWN 报错，故不采用）', [...b0]);
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

console.log('\n[Anki 调度映射（复习进度）]');
{
  const NOW = 1700000000000;
  const DAY = ex.ANKI_DAY_MS;
  ok(DAY === 86400000, 'ANKI_DAY_MS = 86400000');

  const n = ex.cardToAnkiSched({ state: 'new' }, 3, NOW, 0);
  ok(n.type === 0 && n.queue === 0 && n.due === 3, '新卡：type/queue=0、due=队列位置', n);
  ok(n.ivl === 0 && n.factor === 2500 && n.reps === 0, '新卡：ivl=0 / factor=2500 / reps=0', n);

  const l = ex.cardToAnkiSched({ state: 'learning', easeFactor: 2.3 }, 5, NOW, 0);
  ok(l.type === 1 && l.queue === 1 && l.due === 0, '学习卡：type/queue=1、due=今天', l);
  ok(l.ivl === 0 && l.factor === 2300 && l.reps === 0, '学习卡：ivl=0 / factor=ease×1000', l);

  const r = ex.cardToAnkiSched(
    { state: 'review', lastReview: NOW, repetitions: 4, interval: 7, easeFactor: 2.6, due: NOW + 7 * DAY },
    1,
    NOW,
    0
  );
  ok(r.type === 2 && r.queue === 2, '复习卡：type/queue=2', r);
  ok(r.ivl === 7, '复习卡：ivl = 间隔天数', r.ivl);
  ok(r.factor === 2600, '复习卡：factor = easeFactor × 1000', r.factor);
  ok(r.reps === 4, '复习卡：reps = 连续答对次数', r.reps);
  ok(r.due === 7, '复习卡：due = 今天 + 剩余天数', r.due);

  ok(
    ex.cardToAnkiSched({ state: 'review', lastReview: NOW, interval: 3, easeFactor: 2.5, due: NOW - 5 * DAY }, 1, NOW, 0).due === 0,
    '逾期卡：due 不小于今天'
  );
  ok(ex.cardToAnkiSched({ state: 'review', lastReview: NOW, interval: 1, easeFactor: 9, due: NOW }, 1, NOW, 0).factor === 3000, 'easeFactor 上限钳制到 3000');
  ok(ex.cardToAnkiSched({ state: 'review', lastReview: NOW, interval: 1, easeFactor: 0.1, due: NOW }, 1, NOW, 0).factor === 1300, 'easeFactor 下限钳制到 1300');
  ok(ex.cardToAnkiSched({ state: 'review', lastReview: NOW, interval: 0.2, easeFactor: 2.5, due: NOW }, 1, NOW, 0).ivl === 1, '不足 1 天的间隔按 1 天');
  ok(ex.cardToAnkiSched({ state: 'learning' }, 1, NOW, 1).due === 1, 'todayNumber 参与 due 计算');
  ok(ex.cardToAnkiSched({ state: 'review', lastReview: null }, 2, NOW, 0).type === 0, '无 lastReview 的 review 态按新卡处理');
}

console.log('\n[JSON 导出（含复习进度）]');
{
  const obj = JSON.parse(ex.deckToJson(live));
  ok(obj.formatVersion === 1, 'formatVersion = 1');
  ok(obj.name === '导出测试·四级', '包含卡组名', obj.name);
  ok(obj.cards.length === 3, '只导出有正面的卡（3 张）', obj.cards.length);
  const c0 = obj.cards[0];
  ok(c0.front === 'abandon' && c0.exampleZh === '他放弃了这个计划。', '内容字段完整');
  ok(
    ['state', 'repetitions', 'interval', 'easeFactor', 'due', 'lastReview'].every((k) => k in c0),
    '含全部复习进度字段',
    Object.keys(c0)
  );
  ok(c0.state === 'new' && c0.easeFactor === 2.5 && c0.repetitions === 0, '新卡默认进度');
  ok(ex.deckToJson(live, { pretty: false }).indexOf('\n') === -1, 'pretty:false 输出单行');

  const dj = store.createDeck({ name: 'JSON 进度' });
  const card = store.addCard(dj.id, { front: 'x', back: 'y' });
  store.updateCard(dj.id, card.id, {
    state: 'review',
    repetitions: 5,
    interval: 15,
    easeFactor: 2.7,
    due: 9999999999999,
    lastReview: 1700000000000
  });
  const jc = JSON.parse(ex.deckToJson(store.getDeck(dj.id))).cards[0];
  ok(jc.state === 'review' && jc.repetitions === 5 && jc.interval === 15 && jc.easeFactor === 2.7, '复习进度被导出', jc);
  ok(jc.due === 9999999999999 && jc.lastReview === 1700000000000, 'due / lastReview 被导出', [jc.due, jc.lastReview]);
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
  const zipText = new TextDecoder('latin1').decode(bytes);
  ok(zipText.includes('collection.anki2') && zipText.includes('meta'), 'ZIP 含 collection.anki2 与 meta 条目名');
  ok(zipText.includes('\x08\x01'), 'ZIP 内含 PackageMetadata{version=1} 字节（08 01）');

  const dir = mkdtempSync(join(tmpdir(), 'mycard-apkg-'));
  const apkgPath = join(dir, 'deck.apkg');
  writeFileSync(apkgPath, bytes);

  const py = `
import json, os, sqlite3, sys, tempfile, zipfile
p = sys.argv[1]
z = zipfile.ZipFile(p)
print('NAMES=' + ','.join(sorted(z.namelist())))
print('MEDIA=' + z.read('media').decode('utf-8'))
print('META_HEX=' + z.read('meta').hex())
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

  ok(v.NAMES === 'collection.anki2,media,meta', 'ZIP 内为 collection.anki2 / media / meta', v.NAMES);
  ok(v.MEDIA === '{}', 'media 为 {}');
  ok(v.META_HEX === '0801', 'meta = PackageMetadata{version=LEGACY_1} 的 protobuf 字节 08 01', v.META_HEX);
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

  /* 复习进度随 .apkg 迁移（独立卡组：1 张复习卡 + 1 张新卡） */
  const NOW2 = 1700000000000;
  const DAY2 = ex.ANKI_DAY_MS;
  const dS = store.createDeck({ name: '进度导出' });
  const revCard = store.addCard(dS.id, { front: 'rev', back: '已复习' });
  store.addCard(dS.id, { front: 'fresh', back: '新卡' });
  store.updateCard(dS.id, revCard.id, {
    state: 'review',
    repetitions: 4,
    interval: 7,
    easeFactor: 2.6,
    due: NOW2 + 7 * DAY2,
    lastReview: NOW2
  });
  const bytes2 = await ex.deckToApkg(store.getDeck(dS.id), { now: NOW2 });
  const apkgPath2 = join(mkdtempSync(join(tmpdir(), 'mycard-sched-')), 'sched.apkg');
  writeFileSync(apkgPath2, bytes2);

  const py2 = [
    'import os, sqlite3, sys, tempfile, zipfile',
    'z = zipfile.ZipFile(sys.argv[1])',
    'd = tempfile.mkdtemp()',
    "f = os.path.join(d, 'collection.anki2')",
    "open(f, 'wb').write(z.read('collection.anki2'))",
    'con = sqlite3.connect(f)',
    "q = 'SELECT n.sfld, c.type, c.queue, c.due, c.ivl, c.factor, c.reps FROM cards c JOIN notes n ON n.id = c.nid ORDER BY c.id'",
    'for r in con.execute(q):',
    "    print('ROW=%s|%d|%d|%d|%d|%d|%d' % r)"
  ].join('\n');
  let out2 = '';
  try {
    out2 = execFileSync('python3', ['-c', py2, apkgPath2], { encoding: 'utf8' });
  } catch (e) {
    ok(false, 'python3 复习进度校验执行失败：' + (e && e.message));
  }
  const rows = {};
  for (const line of out2.trim().split('\n')) {
    if (!line.startsWith('ROW=')) continue;
    const [sfld, type, queue, due, ivl, factor, reps] = line.slice(4).split('|');
    rows[sfld] = { type: +type, queue: +queue, due: +due, ivl: +ivl, factor: +factor, reps: +reps };
  }
  ok(!!rows.rev && !!rows.fresh, 'notes 含 rev / fresh 两张卡', Object.keys(rows));
  const R = rows.rev || {};
  ok(R.type === 2 && R.queue === 2, 'apkg 复习卡 type/queue = 2', R);
  ok(R.ivl === 7 && R.factor === 2600 && R.reps === 4, 'apkg 复习卡 ivl=7 / factor=2600 / reps=4', R);
  ok(R.due === 7, 'apkg 复习卡 due = 7（今天 0 + 剩余 7 天）', R.due);
  const F = rows.fresh || {};
  ok(F.type === 0 && F.queue === 0 && F.factor === 2500 && F.reps === 0, 'apkg 新卡仍为 type/queue=0 / factor=2500', F);
  ok(F.due === 2, 'apkg 新卡 due = 队列位置 2', F.due);
}

console.log(`\n导出结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

