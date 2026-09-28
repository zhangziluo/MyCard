#!/usr/bin/env node
// ============================================================================
// verify-assets.mjs — 校验 PWA 关键资源存在且 index/manifest/SW 引用一致
//   运行: node scripts/verify-assets.mjs
// ============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => resolve(ROOT, p.replace(/^\.\//, ''));
let failed = 0;

function must(cond, msg) {
  if (cond) console.log('  ✓ ' + msg);
  else {
    failed++;
    console.error('  ✗ ' + msg);
  }
}

// 1) sw.js 预缓存清单是否都真实存在
console.log('\n[sw.js 预缓存清单]');
const sw = readFileSync(rel('sw.js'), 'utf8');
const m = sw.match(/const PRECACHE = \[([\s\S]*?)\];/);
must(!!m, 'sw.js 存在 PRECACHE 数组');
if (m) {
  const items = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  items.forEach((f) => must(existsSync(rel(f)), '存在: ' + f));
}

// 2) manifest 图标
console.log('\n[manifest.json]');
const manifest = JSON.parse(readFileSync(rel('manifest.json'), 'utf8'));
must(manifest.start_url === './' && manifest.display === 'standalone', 'start_url / display 正确');
(manifest.icons || []).forEach((ic) => must(existsSync(rel(ic.src)), '图标存在: ' + ic.src));

// 3) index.html 引用的本地资源
console.log('\n[index.html 引用]');
const html = readFileSync(rel('index.html'), 'utf8');
for (const ref of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const url = ref[1];
  if (/^(https?:|#|data:|blob:)/.test(url)) continue;
  const path = url.split('?')[0];
  must(existsSync(rel(path)), '存在: ' + path);
}

// 4) 词库数据
console.log('\n[data/words.json]');
const words = JSON.parse(readFileSync(rel('data/words.json'), 'utf8'));
must(Array.isArray(words.words) && words.words.length >= 50, '词库 ≥ 50 词（当前 ' + words.words.length + '）');
const bad = words.words.find((w) => !w.front || !w.back || !w.example || !w.exampleZh);
must(!bad, '每条均含 front/back/example/exampleZh');

// 5) v0.2 易混分组与多释义
console.log('\n[data/confusables.json]');
const conf = JSON.parse(readFileSync(rel('data/confusables.json'), 'utf8'));
const wordSet = new Set(words.words.map((w) => w.front));
must(Array.isArray(conf.groups) && conf.groups.length > 0, '存在易混分组（' + conf.groups.length + ' 组）');
const memberSet = new Set();
let confBad = false;
for (const g of conf.groups) {
  if (!g.id || !Array.isArray(g.members) || !g.members.length) confBad = true;
  for (const m of g.members) {
    memberSet.add(m);
    if (!wordSet.has(m)) confBad = true;
  }
}
must(!confBad, '分组 members 均指向词库内单词');
const extraKeys = Object.keys(conf.extraDefs || {});
must(extraKeys.length > 0, '多释义覆盖 ' + extraKeys.length + ' 个词');
must(extraKeys.every((k) => wordSet.has(k)), 'extraDefs 键均为词库内单词');
const uncovered = [...wordSet].filter((w) => !memberSet.has(w)).sort();
must(
  uncovered.length === 3 &&
    uncovered.includes('water') &&
    uncovered.includes('money') &&
    uncovered.includes('time'),
  '允许不分组，且未分组词恰为 water/money/time（实际: ' + (uncovered.join(',') || '无') + '）'
);

// 6) 应用内只保留示范词库（清单 / 预缓存均已移除考试词库）
console.log('\n[应用内仅剩示范词库]');
must(!existsSync(rel('js/decks-meta.js')), 'js/decks-meta.js 已删除（内置词库清单移除）');
must(sw.includes("'./data/words.json'"), 'sw.js 仍预缓存示范词库 words.json');
must(!/importBuiltinDeck|importAllBuiltins/.test(readFileSync(rel('js/decks.js'), 'utf8')), 'decks.js 已移除按需导入内置词库的逻辑');
const storeSrc = readFileSync(rel('js/store.js'), 'utf8');
must(storeSrc.includes('export function purgeRemovedBuiltins') && storeSrc.includes('REMOVED_BUILTIN_SOURCES'), 'store.js 提供「清理旧内置词库」');
must(storeSrc.includes("'kaoyan'") && storeSrc.includes("'tem8'"), '清理清单覆盖 10 本考试词库来源');
must(/purgeRemovedBuiltins\(\)/.test(readFileSync(rel('js/app.js'), 'utf8')), 'app.js 启动时清理浏览器中遗留的考试词库');

// 7) 桌面端自适应布局（#app 放宽 + 卡组平铺）
console.log('\n[css/style.css 桌面适配]');
const css = readFileSync(rel('css/style.css'), 'utf8');
must(css.includes('@media (min-width: 960px)'), '存在 ≥960px 桌面断点');
must(css.includes('#app { max-width: 1080px; }'), '桌面容器放宽至 1080px');
must(css.includes('#app { max-width: 1280px; }'), '更大屏容器放宽至 1280px');
must(css.includes('repeat(auto-fill, minmax(240px, 1fr))'), '卡组网格 auto-fill 随宽度平铺');
must(css.includes('repeat(2, minmax(0, 1fr))'), '宽屏下关卡列表两列平铺');

// 8) 新题型「英英选择 / 多义多选」的数据与配置
console.log('\n[data/eng-defs.json（GCIDE 英文释义）]');
const eng = JSON.parse(readFileSync(rel('data/eng-defs.json'), 'utf8'));
const engKeys = Object.keys(eng);
must(engKeys.length >= 1000, '释义词条 ≥ 1000（当前 ' + engKeys.length + '）');
must(!engKeys.find((k) => !Array.isArray(eng[k]) || !eng[k].length), '每词释义为非空数组');
must(!engKeys.find((k) => eng[k].some((d) => typeof d !== 'string' || d.length < 10)), '释义条目均为非空字符串');
const multiWords = engKeys.filter((k) => eng[k].length >= 2).length;
must(multiWords >= 1000, '可做「多义多选」的词 ≥ 1000（当前 ' + multiWords + '）');

console.log('\n[可选题型（js/test-config.js / js/engdefs.js）]');
const confSrc = readFileSync(rel('js/test-config.js'), 'utf8');
must(confSrc.includes("id: 'eng_eng'") && confSrc.includes("id: 'multi_sense'"), '登记 eng_eng / multi_sense 两种可选题型');
must(confSrc.includes('eng_eng: false') && confSrc.includes('multi_sense: false'), '两种可选题型默认关闭');
must(confSrc.includes('建议考研及以上水平使用'), '携带「建议考研及以上水平使用」说明文案');
must(readFileSync(rel('js/engdefs.js'), 'utf8').includes('data/eng-defs.json'), 'engdefs.js 指向 data/eng-defs.json');
must(css.includes('min-height: 48px'), '选项按钮最小高度 48px（功能一要求）');
must(css.includes('.multi-badge'), '存在「多选」徽标样式');
{
  // 关卡测试固定五种基础题型：typesForRetry 不再取 enabledTypes()（可选题型只在整卡组测试启用）
  const testSrc = readFileSync(rel('js/test.js'), 'utf8');
  const fn = /export function typesForRetry[\s\S]*?\n}/.exec(testSrc);
  must(!!fn, '存在 typesForRetry（关卡测试题型来源）');
  must(!!fn && fn[0].includes('cfg.QUESTION_TYPES'), 'typesForRetry 只用五种基础题型');
  must(!!fn && !fn[0].includes('enabledTypes()'), 'typesForRetry 不再引入可选题型（enabledTypes）');
  must(testSrc.includes('ensureSession') && testSrc.includes('typesForRetry(retries)'), '关卡测试会话（ensureSession）使用 typesForRetry');
}

console.log('\n[首页「添加单词/词表」（js/add-words.js）]');
{
  must(existsSync(rel('js/add-words.js')), 'js/add-words.js 存在');
  must(sw.includes("'./js/add-words.js'"), 'sw.js PRECACHE 含 ./js/add-words.js');
  const awSrc = readFileSync(rel('js/add-words.js'), 'utf8');
  must(awSrc.includes('输入单词查释义，或粘贴词表（每行一个）...'), '占位提示与需求一致');
  must(awSrc.includes('data-action="aw-submit"') && awSrc.includes('preview-area'), '面板含 [添加] 按钮与 .preview-area');
  must(awSrc.includes('api.dictionaryapi.dev') && awSrc.includes('jisho.org'), '接 Free Dictionary API 与 Jisho（日语）');
  must(awSrc.includes('RATE_LIMIT_MS = 100'), '请求限速 100ms');
  must(awSrc.includes('retries = 1'), '失败重试一次');
  must(awSrc.includes('STORE_LOOKUP'), '查询结果写入 lookup 缓存 store');
  const decksSrc = readFileSync(rel('js/decks.js'), 'utf8');
  must(decksSrc.includes("from './add-words.js'") && decksSrc.includes('addWordsPanelHtml()'), '首页（decks.js）挂载该面板');
  must(readFileSync(rel('js/idb.js'), 'utf8').includes("export const DB_VERSION = 2"), 'IndexedDB 版本升到 2');
  must(readFileSync(rel('index.html'), 'utf8').includes('js/app.js'), 'index.html 仍从 app.js 引导');
}

console.log('\n[本地文件导入词库（js/import-file.js）]');
{
  must(existsSync(rel('js/import-file.js')), 'js/import-file.js 存在');
  must(sw.includes("'./js/import-file.js'"), 'sw.js PRECACHE 含 ./js/import-file.js');
  const impSrc = readFileSync(rel('js/import-file.js'), 'utf8');
  must(impSrc.includes('export function parseCsv') && impSrc.includes('export function parseImportJson'), '实现 CSV / JSON 两种解析');
  must(impSrc.includes('export function pickSchedFields'), 'JSON 词条透传复习进度字段（pickSchedFields）');
  // xlsx（零依赖读取器）
  must(existsSync(rel('js/xlsx.js')), 'js/xlsx.js 存在（零依赖 .xlsx 读取器）');
  must(sw.includes("'./js/xlsx.js'"), 'sw.js PRECACHE 含 ./js/xlsx.js');
  const xlsxSrc = readFileSync(rel('js/xlsx.js'), 'utf8');
  must(
    xlsxSrc.includes('export async function unzip') && xlsxSrc.includes('deflate-raw') && xlsxSrc.includes('STORED'),
    'ZIP 读取器：STORED + DEFLATE(deflate-raw)'
  );
  must(
    xlsxSrc.includes('export async function parseXlsxRows') && xlsxSrc.includes('sharedStrings') && xlsxSrc.includes('export function parseSheet'),
    'xlsx 解析：共享字符串 + 工作表 + 单元格类型'
  );
  must(impSrc.includes("from './xlsx.js'") && impSrc.includes('parseXlsxRows'), 'import-file 接入 xlsx 解析');
  must(impSrc.includes('export function isXlsxFile') && impSrc.includes('export function rowsPreview'), 'xlsx 判定 + 二维表预览');
  must(impSrc.includes('export function readFileAsArrayBuffer'), 'xlsx 走二进制读取（readFileAsArrayBuffer）');
  // 标准 CSV 模版下载
  must(
    impSrc.includes('export function csvTemplateText') && impSrc.includes('export function downloadCsvTemplate'),
    '标准 CSV 模版（csvTemplateText / downloadCsvTemplate）'
  );
  must(
    impSrc.includes("on('download-csv-template'") && impSrc.includes('data-action="download-csv-template"'),
    '注册「下载 CSV 模版」动作与入口'
  );
  must(impSrc.includes('CSV_TEMPLATE_COLUMNS') && impSrc.includes("'单词'"), '模版列名为中文规范名（可自动对号）');
  must(readFileSync(rel('js/decks.js'), 'utf8').includes('csvTemplateButtonHtml'), '首页导入栏渲染「下载 CSV 模版」');
  // 模版增强（v0.5.4）：CSV 模版可选示例行 + JSON 模版下载
  must(
    impSrc.includes('export function csvTemplateDialogHtml') && impSrc.includes('export function openCsvTemplateDialog'),
    'CSV 模版下载前可选示例行（csvTemplateDialogHtml / openCsvTemplateDialog）'
  );
  must(
    impSrc.includes("value: 'head'") && impSrc.includes("value: 'single'") && impSrc.includes("value: 'multi'"),
    'CSV 模版三档变体（仅表头 / 1 行示例 / 多行示例）'
  );
  must(
    impSrc.includes('CSV_TEMPLATE_EXAMPLES') && impSrc.includes('return [CSV_TEMPLATE_EXAMPLE.slice()];'),
    '不传变体时仍是 1 行示例（兼容旧行为）'
  );
  must(impSrc.includes('export function csvTemplateRows'), '模版二维数组可复用（csvTemplateRows）');
  must(
    impSrc.includes('JSON_TEMPLATE_FILENAME') &&
      impSrc.includes('export function jsonTemplateText') &&
      impSrc.includes('export function downloadJsonTemplate'),
    '标准 JSON 模版（jsonTemplateText / downloadJsonTemplate）'
  );
  must(
    impSrc.includes("on('download-json-template'") && impSrc.includes('data-action="download-json-template"'),
    '注册「下载 JSON 模版」动作与入口'
  );
  must(impSrc.includes('extraBacks') && impSrc.includes('levelSize: 20'), 'JSON 模版示例覆盖多义词（extraBacks）与 levelSize');
  must(impSrc.includes('JSON_TEMPLATE_SAMPLE') && impSrc.includes("words: ["), 'JSON 模版结构 = 导入格式（name / tags / words）');
  must(readFileSync(rel('js/decks.js'), 'utf8').includes('jsonTemplateButtonHtml'), '首页导入栏渲染「下载 JSON 模版」');
  must(css.includes('.tpl-notes'), '模版弹窗样式（.tpl-notes）');
  must(impSrc.includes('.xlsx') && impSrc.includes('spreadsheetml.sheet'), 'ACCEPT 含 .xlsx 扩展名与 MIME');
  // 多文件批量导入 + 导入历史 / 回滚
  must(existsSync(rel('js/import-history.js')), 'js/import-history.js 存在（导入历史 / 回滚）');
  must(sw.includes("'./js/import-history.js'"), 'sw.js PRECACHE 含 ./js/import-history.js');
  const histSrc = readFileSync(rel('js/import-history.js'), 'utf8');
  must(
    histSrc.includes('export async function recordImport') && histSrc.includes('export async function undoImport'),
    '历史记录 + 撤销（recordImport / undoImport）'
  );
  must(histSrc.includes('import-rollback:') && histSrc.includes('STORE_META'), '追加导入的回滚明细存 IndexedDB meta');
  must(
    impSrc.includes('export async function runBatchImport') && impSrc.includes('export function openBatchImport'),
    '多文件批量导入（每个文件各建一个卡组）'
  );
  must(/input\.multiple = !!multiple/.test(impSrc), '文件选择器支持多选（multiple）');
  must(readFileSync(rel('js/store.js'), 'utf8').includes('export function deleteCards'), 'store.deleteCards（批量删除，供回滚）');
  must(readFileSync(rel('js/decks.js'), 'utf8').includes('importHistoryButtonHtml'), '首页渲染「导入历史」入口');
  must(impSrc.includes('data-action="import-file"') && impSrc.includes('input.type = \'file\''), '首页入口 + file input');
  must(impSrc.includes('seedBuiltinDeck'), '复用存储层 seedBuiltinDeck 入库');
  must(impSrc.includes('FileReader') || impSrc.includes('file.text()'), '读取本地文件');
  must(!/from 'papaparse'|from 'dexie'|require\(/.test(impSrc), '零第三方依赖（无 papaparse / Dexie / require）');
  must(readFileSync(rel('js/decks.js'), 'utf8').includes("from './import-file.js'"), '首页（decks.js）挂载导入入口');

  // v0.6.2：CSV 选择 / 拖拽 → 前 10 行预览表格（暗色兼容）→ 确认导入
  must(impSrc.includes('export function csvPreview') && impSrc.includes('export function previewTableHtml'), 'CSV 预览（表格渲染）');
  must(impSrc.includes('PREVIEW_ROWS = 10'), '预览只取前 10 行');
  must(impSrc.includes('delimiterLabel') && impSrc.includes('detectDelimiter'), '分隔符自动识别 + 文案');
  must(impSrc.includes('export async function openImportPreview') && impSrc.includes('export async function runMappedImport'), '预览弹窗 + 确认导入闭环');
  must(impSrc.includes('export function fieldMapHtml') && impSrc.includes('export function applyMapping'), '字段映射（下拉 + 按映射取列）');
  must(impSrc.includes('export function defaultMapping') && impSrc.includes('COLUMN_FIELDS'), '默认映射（第一列正面/第二列背面）');
  must(impSrc.includes('export function targetDeckHtml') && impSrc.includes('store.getDb().decks'), '目标牌组（已有下拉 + 新建）');
  must(impSrc.includes('addManyCards'), '导入到已有牌组（追加）');
  must(impSrc.includes('importSuccessHtml') && impSrc.includes('showImportSuccess'), '成功提示 + 去学习');
  must(impSrc.includes('去学习'), '「去学习」跳转按钮');
  must(css.includes('.field-map') && css.includes('.deck-target'), '字段映射 / 目标牌组样式');
  must(impSrc.includes('export function dropzoneHtml') && impSrc.includes('export function bindDropzone'), '拖拽导入区');
  must(impSrc.includes('data-dropzone') && impSrc.includes('dataTransfer'), '拖拽区标记与 drop 处理');
  must(impSrc.includes('<td>') && impSrc.includes('esc('), '表格单元格转义输出');
  must(readFileSync(rel('js/decks.js'), 'utf8').includes('bindDropzone(root)'), '首页渲染后绑定拖拽区');
  must(css.includes('.dropzone') && css.includes('.dropzone.is-drag'), '拖拽区样式（含拖入高亮）');
  must(css.includes('.csv-table') && css.includes('.csv-table thead th'), '预览表格样式（含粘性表头）');
  must(css.includes('var(--glass-brd)') && css.includes('var(--tx3)'), '预览/拖拽样式复用暗色 CSS 变量');
}

console.log('\n[表格编辑页（js/table-editor.js）]');
{
  must(existsSync(rel('js/table-editor.js')), 'js/table-editor.js 存在');
  must(sw.includes("'./js/table-editor.js'"), 'sw.js PRECACHE 含 ./js/table-editor.js');
  const teSrc = readFileSync(rel('js/table-editor.js'), 'utf8');
  const impSrc = readFileSync(rel('js/import-file.js'), 'utf8');
  const appSrc = readFileSync(rel('js/app.js'), 'utf8');
  const decksSrc = readFileSync(rel('js/decks.js'), 'utf8');

  // 列以 CSV 模版为准（同源常量，不重复维护列名）
  must(teSrc.includes('export const TABLE_COLUMNS = CSV_TEMPLATE_COLUMNS'), '表格列取自 CSV_TEMPLATE_COLUMNS（模版同源）');
  must(
    teSrc.includes("export const TABLE_FIELDS = ['front', 'back', 'example', 'exampleZh', 'phonetic', 'tags']"),
    '列 → 字段映射与模版列一一对应'
  );
  must(teSrc.includes('let rows = []') && teSrc.includes('let target = ') && teSrc.includes('let deckName = '), '模块级状态（重渲染保留输入）');

  // 纯函数内核（便于单测）
  for (const fn of [
    'export function blankRow',
    'export function normalizeTable',
    'export function cleanRows',
    'export function tableToWords',
    'export function wordsToTable',
    'export function tableStats',
    'export function setCell',
    'export function addRow',
    'export function removeRow',
    'export function moveRow',
    'export function alignToTemplate',
    'export function tableCsvRows',
    'export function tableCsvText'
  ]) {
    must(teSrc.includes(fn), '提供 ' + fn.replace('export function ', ''));
  }
  must(teSrc.includes('export function loadDraft') && teSrc.includes('export function saveDraft') && teSrc.includes('export function clearDraft'), '草稿存取（localStorage）');
  must(teSrc.includes('TABLE_DRAFT_KEY = '), '草稿存储键常量（清数据不误删）');
  must(teSrc.includes('dupeRows') && teSrc.includes('te-dup'), '重复行标记（统计 + 行高亮）');
  must(teSrc.includes("export async function tableRowsFromFile") && teSrc.includes('parseXlsxRows'), '从文件载入（CSV/TSV/XLSX/JSON 复用既有解析器）');

  // 页面与交互（复用文件导入链路）
  must(teSrc.includes('export function tableEditorHtml') && teSrc.includes('export function renderTableEditor'), '渲染函数（tableEditorHtml / renderTableEditor）');
  must(teSrc.includes('export function tableEditorLinkHtml') && teSrc.includes('data-action="open-table-editor"'), '首页入口（tableEditorLinkHtml）');
  must(teSrc.includes('export async function importTableToDeck') && teSrc.includes('importWordsToDeck(words, {'), '导入走 import-file 的 importWordsToDeck（同校验 / 去重 / 写库）');
  must(teSrc.includes('recordImport([res])') && teSrc.includes('showImportSuccess(res)'), '复用导入历史与成功弹窗（可撤销）');
  must(teSrc.includes("src: 'table_editor'"), '卡片来源标记 src=table_editor');
  must(/on\(\s*'te-cell',[\s\S]*?refreshStats\(\)/.test(teSrc), '单元格输入只刷新统计（保住光标）');
  for (const act of ['te-target', 'te-deck-name', 'te-add-row', 'te-move-up', 'te-move-down', 'te-del-row', 'te-clear', 'te-download', 'te-load-file', 'te-import-deck']) {
    must(new RegExp("on\\(\\s*'" + act + "'").test(teSrc), '注册动作 ' + act);
  }
  must(teSrc.includes('DOWNLOAD') || teSrc.includes('downloadCsvRows(TABLE_CSV_FILENAME'), '下载 CSV（表头 = 模版列名）');
  must(teSrc.includes('confirmDialog('), '载入 / 清空前二次确认（防误丢手填内容）');

  // v0.5.5：粘贴多行自动扩行 / 单元格 textarea 自适应 / 导入前预览报告
  must(
    teSrc.includes('export function gridFromPaste') && teSrc.includes('export function applyPaste'),
    '粘贴板二维数组内核（gridFromPaste / applyPaste）'
  );
  must(
    teSrc.includes("document.addEventListener('paste'") && teSrc.includes('bindPasteOnce'),
    '文档级 paste 绑定（只绑一次，多行粘贴自动扩行）'
  );
  must(teSrc.includes('added++') && teSrc.includes('truncated'), '粘贴自动补行 + 超上限截断标记');
  must(teSrc.includes('evt.preventDefault') && teSrc.includes('gridFromPaste'), '多行粘贴拦截默认行为（单格不拦截）');
  must(teSrc.includes('<textarea class="te-cell"') && teSrc.includes('rows="1"'), '单元格改为 textarea（长文本 / 多行可编辑）');
  must(teSrc.includes('function autoGrow') && teSrc.includes('TE_CELL_MAX_H'), '单元格高度按内容自适应（带上限）');
  must(
    teSrc.includes('export function importPreviewRows') &&
      teSrc.includes('export function importReport') &&
      teSrc.includes('export function importPreviewHtml') &&
      teSrc.includes('export function openTableImportPreview'),
    '导入前预览 / 校验报告（importReport / importPreviewHtml / openTableImportPreview）'
  );
  must(teSrc.includes("on('te-import-deck', () => openTableImportPreview())"), '「导入为卡组」先出预览报告，确认后才写库');
  must(teSrc.includes('previewTableHtml') && teSrc.includes('PREVIEW_ROWS'), '预览表格复用文件导入的 previewTableHtml / PREVIEW_ROWS');
  must(teSrc.includes('目标卡组已存在') && teSrc.includes('表内重复去重'), '报告含「已存在跳过 / 表内去重」提示');
  must(css.includes('.te-preview-list') && css.includes('resize: none') && css.includes('.tpl-notes'), '预览报告 / textarea / 模版弹窗样式齐备');

  // import-file.js 新增的复用导出
  must(impSrc.includes('export function csvText') && impSrc.includes('export function csvTemplateText'), 'csvText 抽取 + 模版复用');
  must(impSrc.includes('export function downloadCsvRows'), 'downloadCsvRows（通用 CSV 下载）');
  must(impSrc.includes('export function importWordsToDeck'), 'importWordsToDeck（已解析词条 → 与文件导入同链路）');
  must(/duplicates: payload\.duplicates \|\| duplicates \|\| 0/.test(impSrc), '新建卡组也报告文件内重复条数');

  // 路由与首页入口
  must(/if \(seg\[0\] === 'editor'\) return \{ view: 'editor', mode \}/.test(appSrc), "app.js 解析路由 #/editor");
  must(/route\.view === 'editor'/.test(appSrc) && appSrc.includes("from './table-editor.js'"), 'app.js 路由到 renderTableEditor');
  must(appSrc.includes("t = '表格编辑'"), '顶栏标题「表格编辑」');
  must(decksSrc.includes('tableEditorLinkHtml') && decksSrc.includes("from './table-editor.js'"), '首页导入栏挂载「在网页里填表格」');

  // 样式（复用既有变量，零硬编码颜色）
  must(css.includes('.te-table') && css.includes('.te-cell') && css.includes('.te-stats') && css.includes('.te-tools'), '表格编辑样式齐备（.te-*）');
  must(/\.te-dup/.test(css) && !/\.te-dup[^}]*#[0-9a-f]{3,6}/i.test(css), '重复行高亮用 CSS 变量而非硬编码色值');

  // 测试脚本
  must(existsSync(rel('scripts/test-table-editor.mjs')), '存在 scripts/test-table-editor.mjs（表格编辑单测）');
  must(readFileSync(rel('scripts/smoke-dom.mjs'), 'utf8').includes('#/editor'), 'smoke-dom.mjs 覆盖 #/editor 路由渲染');
}

console.log('\n[浅色 / 深色模式（js/theme.js + css/style.css + index.html）]');
{
  const themeSrc = readFileSync(rel('js/theme.js'), 'utf8');
  const appSrc = readFileSync(rel('js/app.js'), 'utf8');
  const html = readFileSync(rel('index.html'), 'utf8');

  must(themeSrc.includes("MODE_KEY = 'mycard-mode'"), 'theme.js 定义 mycard-mode 存储键');
  must(/export function applyMode/.test(themeSrc) && /export function resolveMode/.test(themeSrc), 'theme.js 提供 applyMode / resolveMode');
  must(/export function toggleMode/.test(themeSrc) && /export function setMode/.test(themeSrc), 'theme.js 提供 setMode / toggleMode');
  must(themeSrc.includes("'light'") && themeSrc.includes("'dark'") && themeSrc.includes("'system'"), '三档：浅色 / 深色 / 跟随系统');
  must(themeSrc.includes('prefers-color-scheme: dark'), '跟随系统用 prefers-color-scheme');
  must(themeSrc.includes('theme-color'), '同步 <meta name="theme-color">');
  must(
    /export function textOnDark/.test(themeSrc) && /export function textOnLight/.test(themeSrc),
    'theme.js 按底色派生强调文字色（textOnDark / textOnLight）'
  );
  must(
    /export function relativeLuminance/.test(themeSrc) &&
      /export function contrastRatio/.test(themeSrc) &&
      /export function ensureTextContrast/.test(themeSrc),
    'theme.js 用 WCAG 相对亮度 / 对比度二分求解（relativeLuminance / contrastRatio / ensureTextContrast）'
  );
  must(themeSrc.includes('TEXT_CONTRAST = 4.5'), '强调文字目标对比度 4.5:1（WCAG AA）');
  must(
    /export function lightenHex/.test(themeSrc) && themeSrc.includes('TEXT_LIGHTEN_STEP = 0.12'),
    '深色底统一「提亮一档」（lightenHex / TEXT_LIGHTEN_STEP）'
  );
  must(!/export function mixHex/.test(themeSrc), '已移除固定混色 mixHex');
  must(themeSrc.includes("'--tag-tx-dark'") && themeSrc.includes("'--tag-tx-light'"), 'accentVars 输出 --tag-tx-dark / --tag-tx-light');

  must(/data-action="toggle-mode"/.test(appSrc), '顶栏渲染明暗快捷切换按钮');
  must(/on\('set-mode'/.test(appSrc) && /on\('toggle-mode'/.test(appSrc), 'app.js 注册 set-mode / toggle-mode');
  must(appSrc.includes('theme.MODES.map'), '设置页「外观」按 MODES 渲染分段按钮');
  must(appSrc.includes('theme.init(() => render())'), '启动时应用明暗模式并跟随系统变化重渲染');

  must(html.includes("mycard-mode"), 'index.html 首屏前读取已保存模式（防闪屏）');
  must(html.includes("setAttribute('data-theme'"), 'index.html 内联脚本提前写 data-theme');

  // CSS：浅色主题覆盖块 + color-scheme + 变量完整性
  must(css.includes(":root[data-theme='light']"), 'CSS 存在浅色主题覆盖块');
  must(/color-scheme:\s*dark/.test(css) && /color-scheme:\s*light/.test(css), '深/浅两套 color-scheme（原生控件跟随）');
  const lightBlock = css.slice(css.indexOf(":root[data-theme='light']"));
  // 变量定义行之外的规则（用于检查是否还有写死的中性色）
  const cssNoDefs = css
    .split('\n')
    .filter((l) => !/^\s*--[a-z0-9-]+\s*:/.test(l))
    .join('\n');
  for (const v of ['--bg', '--bg2', '--bg3', '--tx', '--tx2', '--tx3', '--glass-bg', '--glass-bg-strong', '--glass-brd', '--shadow', '--ovl-1', '--field-bg', '--panel-top', '--appbar-solid', '--teal-tx', '--modal-a', '--modal-b', '--tag-tx', '--soft-danger-tx']) {
    must(lightBlock.includes(v + ':'), `浅色主题覆盖 ${v}`);
  }
  must(css.includes('--tag-tx-dark:') && css.includes('--tag-tx-light:'), ':root 定义 --tag-tx-dark / --tag-tx-light（默认色兜底，JS 覆盖）');
  must(/--tag-tx:\s*var\(--tag-tx-dark\)/.test(css), '深色模式 --tag-tx 取 --tag-tx-dark');
  must(/--tag-tx:\s*var\(--tag-tx-light\)/.test(lightBlock), '浅色模式 --tag-tx 取 --tag-tx-light（随主色加深）');
  must(/--accent-tx:\s*var\(--tag-tx\)/.test(css), '--accent-tx 与 --tag-tx 同源（别名，浅色块自动跟随）');
  must(
    !/(^|[^-a-z])color:\s*var\(--accent\)\s*;/.test(cssNoDefs),
    '强调文字已统一走 --accent-tx（规则中不再有 color: var(--accent)）'
  );
  must(
    (cssNoDefs.match(/color:\s*var\(--accent-tx\)/g) || []).length >= 8,
    '--accent-tx 已用于 ≥8 处文字/图标前景色',
    (cssNoDefs.match(/color:\s*var\(--accent-tx\)/g) || []).length
  );
  // 非文字前景（焦点环 / 输入与高亮边框 / 原生 accent-color）同样随主色派生
  must(
    !/(outline|border[a-z-]*|accent-color):[^;]*var\(--accent\)/.test(cssNoDefs),
    '焦点环 / 边框 / accent-color 不再直接用 --accent'
  );
  must(
    (cssNoDefs.match(/(outline|border[a-z-]*|accent-color):[^;]*var\(--accent-tx\)/g) || []).length >= 8,
    '--accent-tx 已用于 ≥8 处非文字前景（焦点环 / 边框 / 原生控件）',
    (cssNoDefs.match(/(outline|border[a-z-]*|accent-color):[^;]*var\(--accent-tx\)/g) || []).length
  );
  must(css.includes('.seg-btn') && css.includes('.segmented'), '设置页分段按钮样式');
  // 弹窗与暗底专用文字必须走变量（浅色下才能整体翻转）
  must(/\.modal \{[^}]*var\(--modal-a\)/.test(cssNoDefs), '弹窗背景使用 --modal-a/--modal-b 变量');
  must(!/rgba\(26, 31, 58|rgba\(15, 19, 38/.test(cssNoDefs), '规则中不再有写死的深色弹窗渐变');
  must(!/#b9c1ff|#ff9ba6|#ffb1b1/.test(cssNoDefs), '暗底专用浅色文字已变量化');
  // 硬编码中性色已收敛为变量（浅色下才能整体翻转）；仅变量定义行允许保留
  const leftover =
    (cssNoDefs.match(/rgba\(255, ?255, ?255, 0\.0[0-9]\)/g) || []).length +
    (cssNoDefs.match(/rgba\(10, ?13, ?26,/g) || []).length;
  must(leftover === 0, `规则中不再有硬编码中性色（定义行除外），实际 ${leftover}`);
  // 变量使用审计：var(--x) 必须都已定义
  const defined = new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
  const missing = [...used].filter((v) => !defined.has(v));
  must(missing.length === 0, `var() 引用均已定义（未定义：${missing.join(', ') || '无'}）`);
  must(css.split('{').length === css.split('}').length, 'CSS 花括号平衡');
}

console.log('\n[导出 txt / CSV / Markdown / JSON / Anki apkg（js/export.js + vendor/sql.js）]');
{
  const expSrc = readFileSync(rel('js/export.js'), 'utf8');
  const decksSrc = readFileSync(rel('js/decks.js'), 'utf8');
  const storeSrc = readFileSync(rel('js/store.js'), 'utf8');
  must(existsSync(rel('js/export.js')), 'js/export.js 存在');
  must(sw.includes("'./js/export.js'"), 'sw.js PRECACHE 含 ./js/export.js');
  must(existsSync(rel('vendor/sql.js/sql-wasm.js')) && existsSync(rel('vendor/sql.js/sql-wasm.wasm')), 'vendor/sql.js 已内置（js + wasm）');
  must(existsSync(rel('vendor/sql.js/package.json')), 'vendor/sql.js/package.json 声明 CommonJS（供 Node 测试加载）');
  must(sw.includes("'./vendor/sql.js/sql-wasm.wasm'"), 'sw.js 预缓存 sql.js WASM（离线也能导出 apkg）');
  must(/export function deckToTxt/.test(expSrc) && /export async function deckToApkg/.test(expSrc), '提供 deckToTxt / deckToApkg');
  must(/export function deckToCsv/.test(expSrc) && /export function deckToMarkdown/.test(expSrc), '提供 deckToCsv / deckToMarkdown');
  must(/export function csvCell/.test(expSrc) && /export function mdCell/.test(expSrc), 'CSV / Markdown 单元格转义函数');
  must(/export function exportDeckTxt/.test(expSrc) && /export async function exportDeckApkg/.test(expSrc), '提供导出入口函数');
  must(/export function exportDeckCsv/.test(expSrc) && /export function exportDeckMarkdown/.test(expSrc), '提供 CSV / Markdown 导出入口');
  must(/export function deckToJson/.test(expSrc) && /export function exportDeckJson/.test(expSrc), '提供 JSON 完整导出（deckToJson / exportDeckJson）');
  must(/export function cardToAnkiSched/.test(expSrc) && /cardToAnkiSched\(c, i \+ 1, now, todayNumber\)/.test(expSrc), 'apkg 按卡片复习进度写入 Anki 调度列（cardToAnkiSched）');
  must(/on\('export-json'/.test(expSrc), '注册 export-json 动作');
  must(/export function pickScheduling/.test(storeSrc) && storeSrc.includes('...pickScheduling(f)') && storeSrc.includes('...pickScheduling(w)'), '导入路径保留复习进度（store.pickScheduling）');
  must(/export function crc32/.test(expSrc) && /export function zipStore/.test(expSrc), '内置最小 ZIP 写出器（CRC32 + STORED）');
  must(/export function encodePackageMetadata/.test(expSrc) && /name: 'meta'/.test(expSrc), 'apkg 写入新版 Anki 要求的 meta（PackageMetadata protobuf）');
  must(/export const ANKI_META_VERSION/.test(expSrc) && expSrc.includes('PackageMetadata'), 'meta 版本枚举（ANKI_META_VERSION）与说明齐备');
  must(expSrc.includes('collection.anki2') && expSrc.includes('CREATE TABLE col') && expSrc.includes('CREATE TABLE notes'), 'apkg 内为 Anki collection.anki2 + 完整 schema');
  must(expSrc.includes('initSqlJs') && expSrc.includes('sql-wasm.wasm'), '通过 sql.js(WASM) 生成 SQLite');
  must(expSrc.includes('createObjectURL') && expSrc.includes('downloadBlob'), '用 Blob + createObjectURL 触发下载');
  must(
    /data-action="export-txt"/.test(decksSrc) &&
      /data-action="export-csv"/.test(decksSrc) &&
      /data-action="export-md"/.test(decksSrc) &&
      /data-action="export-json"/.test(decksSrc) &&
      /data-action="export-apkg"/.test(decksSrc),
    '卡组菜单含 txt / csv / md / json / apkg 五个导出入口'
  );
  must(/from '\.\/export\.js'|import '\.\/export\.js'/.test(decksSrc), 'decks.js 加载 export.js（注册导出动作）');
}

console.log('\n[大卡组性能（单遍统计 / 复用 levels / 抽题快路径）]');
{
  const lvSrc = readFileSync(rel('js/levels.js'), 'utf8');
  const engineSrc = readFileSync(rel('js/test-engine.js'), 'utf8');
  const decksSrc2 = readFileSync(rel('js/decks.js'), 'utf8');
  must(
    /export function deckStats/.test(lvSrc) && /for \(const c of \(deck && deck\.cards\) \|\| \[\]\)/.test(lvSrc),
    'deckStats 单次遍历（不再两次 filter）'
  );
  must(/export function levelStates\(deck, levels = deckLevels\(deck\)\)/.test(lvSrc), 'levelStates 支持复用已算好的 levels');
  must(/levelStates\(deck, levels\)/.test(decksSrc2), 'decks.js 渲染时复用 levels（避免重复整卡组遍历）');
  must(/部分 Fisher-Yates/.test(engineSrc) && /words >= n/.test(engineSrc), '抽题「词数 ≥ 题数」走 O(n) 快路径');
  must(
    /prio\.length && words >= n/.test(engineSrc) && /交换删除/.test(engineSrc) && /takeAt/.test(engineSrc),
    '带优先池且「词数 ≥ 题数」也走部分洗牌（非优先槽位 O(1) 取未用过的词）'
  );
  must(
    /const posOf = new Map/.test(engineSrc) && /posOf\.delete\(ci\)/.test(engineSrc),
    '优先槽位取走的词从候选池 O(1) 摘除（不重复扫描卡组）'
  );
  must(/快路径 A/.test(engineSrc) && /快路径 B/.test(engineSrc), '两条抽题快路径（无优先池 / 带优先池）注释清晰');
  must(!/Math\.min\(\.\.\.gapOk/.test(engineSrc), 'pickLeastUsed 已合并为单趟扫描（去掉 spread 全量 Math.min）');
  must(/export const CARDS_PER_PAGE = 100/.test(decksSrc2), '卡片管理分页常量 CARDS_PER_PAGE = 100');
  must(/data-action="cards-page"/.test(decksSrc2) && /on\('cards-page'/.test(decksSrc2), '卡片分页条 + cards-page 动作');
  must(/all\.slice\(page \* CARDS_PER_PAGE/.test(decksSrc2), '卡片管理只渲染当前页（不再一次性塞入全部）');
  must(existsSync(rel('scripts/test-perf.mjs')), '存在 scripts/test-perf.mjs（万级性能金丝雀）');
  must(
    readFileSync(rel('scripts/test-deck-test.mjs'), 'utf8').includes('优先池快路径：词数 ≥ 题数'),
    'test-deck-test 覆盖优先池快路径不变量（只错题可能重复 / 配额 / 可复现）'
  );
  must(
    readFileSync(rel('scripts/test-perf.mjs'), 'utf8').includes('new Proxy(deck.cards'),
    'test-perf 用 Proxy 计数卡组读取次数（拦住快路径被退回全量扫描的回归）'
  );
}

console.log(failed ? `\n共 ${failed} 项校验失败` : '\n全部资源校验通过 ✔');
process.exit(failed ? 1 : 0);
