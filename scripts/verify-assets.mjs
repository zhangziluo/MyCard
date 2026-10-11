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
  must(readFileSync(rel('js/idb.js'), 'utf8').includes('export const DB_VERSION = 3'), 'IndexedDB 版本升到 3（revlog）');
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
  // v0.5.7：多工作表 / 公式求值 / 合并单元格
  must(
    xlsxSrc.includes('export function workbookSheets') && xlsxSrc.includes('export async function openXlsx') && xlsxSrc.includes('export async function listXlsxSheets'),
    '多工作表：workbook.xml + rels 解析（workbookSheets / openXlsx / listXlsxSheets）'
  );
  must(/state === 'hidden'/.test(xlsxSrc) && xlsxSrc.includes('firstSheetPath'), '识别隐藏工作表 + 兼容旧调用（firstSheetPath）');
  must(
    xlsxSrc.includes('export function evalFormula') && xlsxSrc.includes('export function isFormulaSupported') && xlsxSrc.includes('FORMULA_FUNCTION_NAMES'),
    '公式求值器（tokenizer + 递归下降；evalFormula / isFormulaSupported）'
  );
  must(
    xlsxSrc.includes('FORMULA_MODE') && xlsxSrc.includes("evaluate: 'evaluate'") && xlsxSrc.includes('formulaShared'),
    '公式两种模式（cached / evaluate）+ 共享公式从属格识别'
  );
  must(xlsxSrc.includes('visiting') && xlsxSrc.includes('unsupported'), '循环引用检测 + 求值失败统计（回退缓存值）');
  must(
    xlsxSrc.includes('MERGE_FILL') && xlsxSrc.includes('MERGE_BLANK') && xlsxSrc.includes('export function applyMerges'),
    '合并单元格（fill 填充 / blank 只留左上角）'
  );
  must(xlsxSrc.includes('export function parseSheetDetailed') && xlsxSrc.includes('notices'), '解析明细（rows / merges / notices 统计）');
  must(
    impSrc.includes('export function xlsxWorkbookPreview') && impSrc.includes('export function sheetPickerHtml') && impSrc.includes('export function bindSheetPicker'),
    '导入预览可选工作表（xlsxWorkbookPreview / sheetPickerHtml / bindSheetPicker）'
  );
  must(impSrc.includes('export function xlsxNoticesText'), '预览提示公式 / 合并单元格处理结果（xlsxNoticesText）');
  must(impSrc.includes("src = 'batch_import', sheet = 0") && impSrc.includes('parseXlsxRows(await readFileAsArrayBuffer(file), { sheet })'), '导入可指定工作表（importMapped sheet 选项）');
  must(readFileSync(rel('js/table-editor.js'), 'utf8').includes('parseXlsxRows(await readFileAsArrayBuffer(file), { sheet })'), '表格编辑页载入支持指定工作表');
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
  must(/export function deckToJson/.test(expSrc) && /export async function exportDeckJson/.test(expSrc), '提供 JSON 完整导出（deckToJson / exportDeckJson）');
  must(
    /export function cardToAnkiSched/.test(expSrc) && /cardToAnkiSched\(c, i \+ 1, now, todayNumber, \{ lapses:/.test(expSrc),
    'apkg 按卡片复习进度写入 Anki 调度列（cardToAnkiSched + lapses）'
  );
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

console.log('\n[复习日志 revlog：本机记录 / apkg revlog 表 / JSON 往返（v0.5.8）]');
{
  const rvSrc = readFileSync(rel('js/revlog.js'), 'utf8');
  const idbSrc = readFileSync(rel('js/idb.js'), 'utf8');
  const storeSrc2 = readFileSync(rel('js/store.js'), 'utf8');
  const expSrc2 = readFileSync(rel('js/export.js'), 'utf8');
  const impSrc = readFileSync(rel('js/import-file.js'), 'utf8');
  const revSrc = readFileSync(rel('js/review.js'), 'utf8');
  must(existsSync(rel('js/revlog.js')), 'js/revlog.js 存在');
  must(sw.includes("'./js/revlog.js'"), 'sw.js PRECACHE 含 ./js/revlog.js（离线可用）');
  must(
    /export const REVIEW_TYPES/.test(rvSrc) && /EASE_BY_FEEDBACK/.test(rvSrc) && /FEEDBACK_BY_EASE/.test(rvSrc),
    'revlog.js：Anki type / ease 映射表'
  );
  must(
    /export function makeEntry/.test(rvSrc) &&
      /export function reviewTypeOf/.test(rvSrc) &&
      /export function sanitizeEntry/.test(rvSrc),
    'revlog.js：生成 / 归类 / 清洗函数'
  );
  must(
    /export function pickReviewLog/.test(rvSrc) &&
      /export function summarize/.test(rvSrc) &&
      /export function toAnkiRow/.test(rvSrc),
    'revlog.js：外部日志提取 / 汇总 / Anki 行换算'
  );
  must(rvSrc.includes('MAX_IMPORT_LOG') && rvSrc.includes('MAX_TIME_MS'), 'revlog.js：导入上限与停留上限常量');

  must(/export const DB_VERSION = 3/.test(idbSrc), 'IndexedDB 版本升到 v3（新增 revlog store）');
  must(/export const STORE_REVLOG = 'revlog'/.test(idbSrc), 'idb.js 导出 STORE_REVLOG');
  must(
    /createObjectStore\(STORE_REVLOG, \{ keyPath: 'id' \}\)/.test(idbSrc) &&
      /createIndex\('byDeck'/.test(idbSrc) &&
      /createIndex\('byCard'/.test(idbSrc),
    'revlog store 以 id 为主键 + byDeck / byCard 索引'
  );
  must(idbSrc.includes('get(STORE_REVLOG).clear()'), '清空数据时一并清空 revlog');
  must(storeSrc2.includes("import * as revlog from './revlog.js'"), 'store.js 复用 revlog.js');
  must(
    /export function recordReview/.test(storeSrc2) &&
      /export async function revlogsOfDeck/.test(storeSrc2) &&
      /export function importRevlogs/.test(storeSrc2) &&
      /export async function revlogStats/.test(storeSrc2),
    'store.js：recordReview / revlogsOfDeck / importRevlogs / revlogStats'
  );
  must(
    storeSrc2.includes('pendingRevlogs = new Map()') && storeSrc2.includes('await idb.putAll(idb.STORE_REVLOG, logs)'),
    'store.js：日志走「写穿 + 合并防抖」队列落盘'
  );
  must(
    /purgeRevlogs\(\{ cardId \}\)/.test(storeSrc2) && /purgeRevlogs\(\{ deckId \}\)/.test(storeSrc2),
    'store.js：删卡片 / 删卡组时级联清理日志'
  );
  must(expSrc2.includes("import * as revlog from './revlog.js'"), 'export.js 复用 revlog.js');
  must(
    /INSERT INTO revlog VALUES/.test(expSrc2) && /revlog\.toAnkiRow\(e, cardId, nextRevId\(e\.ts\)\)/.test(expSrc2),
    'apkg 写入 revlog 表（每次评分一行 + 主键去重）'
  );
  must(/sched\.lapses/.test(expSrc2) && /sched\.left/.test(expSrc2), 'apkg cards 表写入 lapses / left');
  must(/formatVersion: 2/.test(expSrc2) && /out\.reviewLog = logs/.test(expSrc2), 'JSON 导出 formatVersion 2 + 每卡 reviewLog');
  must(
    /export async function exportDeckJson/.test(expSrc2) && /store\.revlogsOfDeck\(deckId\)/.test(expSrc2),
    'JSON / apkg 导出前读取该卡组日志'
  );
  must(
    /pickReviewLog\(w\)/.test(impSrc) &&
      /function attachReviewLogs/.test(impSrc) &&
      /store\.importRevlogs\(deck\.id, entries\)/.test(impSrc),
    'import-file.js：JSON 回导时按单词恢复复习日志'
  );
  must(/revlog\.reattach\(e, c\.id\)/.test(impSrc), 'import-file.js：日志重新归属到落库后的卡片 id');
  must(/logsWritten/.test(impSrc) && /恢复复习日志/.test(impSrc), '导入结果与提示包含恢复的日志条数');
  must(
    /store\.recordReview\(S\.deckId, snap, fb, updated, \{ timeMs:/.test(revSrc) &&
      /S\.shownAt = Date\.now\(\)/.test(revSrc) &&
      /const snap = \{ id: card\.id, state: card\.state/.test(revSrc),
    'review.js：评分时写入日志（含单卡停留时长 + 评分前快照）'
  );
  must(existsSync(rel('scripts/test-revlog.mjs')), '存在 scripts/test-revlog.mjs（纯函数单测）');
  must(
    readFileSync(rel('scripts/test-export.mjs'), 'utf8').includes('FROM revlog r JOIN cards c') &&
      readFileSync(rel('scripts/test-export.mjs'), 'utf8').includes('revlog 写入 3 行'),
    'test-export 用 Python 独立校验 apkg 的 revlog 表'
  );
  must(
    readFileSync(rel('scripts/test-idb-store.mjs'), 'utf8').includes('复习日志（revlog）：写穿') &&
      readFileSync(rel('scripts/test-idb-store.mjs'), 'utf8').includes('旧库从 v2 增量升级到 v3'),
    'test-idb-store 覆盖 v2→v3 升级与日志写穿 / 级联清理'
  );
}


// 8) v0.5.9「我的生词」批量整理
console.log('\n[我的生词批量整理（js/wordbook.js + js/wordbook-view.js，v0.5.9）]');
{
  const wbSrc = readFileSync(rel('js/wordbook.js'), 'utf8');
  const viewSrc = readFileSync(rel('js/wordbook-view.js'), 'utf8');
  const storeSrc2 = readFileSync(rel('js/store.js'), 'utf8');
  const appSrc = readFileSync(rel('js/app.js'), 'utf8');
  const decksSrc3 = readFileSync(rel('js/decks.js'), 'utf8');
  const awSrc2 = readFileSync(rel('js/add-words.js'), 'utf8');
  const uiSrc = readFileSync(rel('js/ui.js'), 'utf8');

  must(existsSync(rel('js/wordbook.js')), 'js/wordbook.js 存在（纯函数内核）');
  must(existsSync(rel('js/wordbook-view.js')), 'js/wordbook-view.js 存在（整理页）');
  must(sw.includes("'./js/wordbook.js'"), 'sw.js PRECACHE 含 ./js/wordbook.js');
  must(sw.includes("'./js/wordbook-view.js'"), 'sw.js PRECACHE 含 ./js/wordbook-view.js');
  must(/const VERSION = 'v1\.17\.0'/.test(sw), 'sw.js VERSION 已递增（v1.17.0）');

  // 内核：去重合并 / 标签 / 筛选排序 / 选中集 / 补查目标
  must(/export function normKey/.test(wbSrc), 'wordbook.js：normKey（大小写 / 空格归一为同一个词）');
  must(/export function dupGroups/.test(wbSrc) && /export function mergePlans/.test(wbSrc), 'wordbook.js：dupGroups / mergePlans');
  must(/export function keepScore/.test(wbSrc) && /STATE_RANK/.test(wbSrc), 'wordbook.js：主卡优先级（复习状态 > 次数 > 间隔 > 加入时间）');
  must(/extraBacks/.test(wbSrc), 'wordbook.js：合并后其它释义进 extraBacks');
  must(/export function filterWords/.test(wbSrc) && /export function sortWords/.test(wbSrc), 'wordbook.js：filterWords / sortWords');
  must(/export function tagPatchPlans/.test(wbSrc) && /export function renameTagPlans/.test(wbSrc), 'wordbook.js：批量加/去标签与重命名方案');
  must(/export function lookupTargets/.test(wbSrc), 'wordbook.js：补查目标（勾选的词 / 缺释义的词）');

  // 存储层：批量写与合并
  must(/export function updateCards/.test(storeSrc2), 'store.js：updateCards（批量写标签，单次落库）');
  must(/export function mergeCards/.test(storeSrc2), 'store.js：mergeCards（保留主卡 + 删副卡）');
  must(/queueDeleteCard\(c\.id\)/.test(storeSrc2) && /副卡日志一并清理/.test(storeSrc2), 'store.js：删副卡时级联清理复习日志');
  must(/merge: true/.test(storeSrc2) && /extraBacks/.test(storeSrc2), 'store.js：addWords 支持 { merge: true } 合并释义');

  // 路由与入口
  must(/APP_VERSION = 'v0\.9\.3'/.test(appSrc), 'app.js 版本号更新为 v0.9.3');
  must(/from '\.\/wordbook-view\.js'/.test(appSrc) && /renderWordbook\(root\)/.test(appSrc), 'app.js 挂载 renderWordbook');
  must(/seg\[0\] === 'words'/.test(appSrc) && /#\/words/.test(appSrc), 'app.js 解析 #/words 路由（含 ?page=N 分页）');
  must(/on\('nav-words'/.test(decksSrc3), 'decks.js 提供 nav-words 入口动作');
  must(/export function cardFormModal/.test(decksSrc3), 'decks.js 导出 cardFormModal（整理页复用编辑弹窗）');
  must(/整.*生词本/.test(decksSrc3), 'decks.js 首页 / 生词卡组菜单提供「整理生词本」入口');
  must(/export function prefillInput/.test(awSrc2) && /loadMergePref|saveMergePref/.test(awSrc2), 'add-words.js：prefillInput + 合并偏好');
  must(/export function icon/.test(uiSrc) && /wordbook-view\.js/.test(uiSrc), 'ui.js：共享 icon()（供整理页复用）');

  // 页面：分页 / 多选 / 批量
  must(/export const WORDS_PER_PAGE = 100/.test(viewSrc), '整理页分页常量 WORDS_PER_PAGE = 100');
  must(/data-action="wb-pick-page"/.test(viewSrc) && /data-action="wb-page"/.test(viewSrc), '整理页有本页全选与分页动作');
  must(/data-action="wb-batch-tag"/.test(viewSrc) && /data-action="wb-batch-delete"/.test(viewSrc), '整理页有批量加标签 / 删除');
  must(/data-action="wb-batch-lookup"/.test(viewSrc) && /prefillInput\(words/.test(viewSrc), '整理页「在线补查」回填首页查词框');
  must(/wbReportHtml/.test(viewSrc) && /openDedupeReport/.test(viewSrc), '整理页先出合并报告再落库');
  must(/openTagManager/.test(viewSrc) && /openBatchTagModal/.test(viewSrc), '整理页标签管理 / 批量标签弹窗');
  must(/setViewState|getViewState/.test(viewSrc), '整理页状态可读可写（测试用）');
  must(existsSync(rel('scripts/test-wordbook.mjs')), '存在 scripts/test-wordbook.mjs');
  must(/wb-/.test(css) && /\.field select/.test(css), 'css/style.css 含生词本样式与弹窗下拉框样式');
}

console.log('\n[明牌配对（v0.6.1，通关 ≥1 关解锁 · 每轮 5 对 · 棋局只存内存重进即重洗）]');
{
  must(existsSync(rel('js/match.js')), 'js/match.js 存在');
  must(sw.includes("'./js/match.js'"), 'sw.js PRECACHE 含 ./js/match.js');
  const mSrc = readFileSync(rel('js/match.js'), 'utf8');
  must(/export const UNLOCK_LEVELS = 1/.test(mSrc), 'match.js：解锁门槛 UNLOCK_LEVELS = 1（v0.5.12 起通关 1 关就能玩）');
  must(/export const ROUND_PAIRS = 5/.test(mSrc), 'match.js：每轮 ROUND_PAIRS = 5（多余的配对自动往后排）');
  must(/export const BOOM_MS = \d+/.test(mSrc), 'match.js：BOOM_MS（爆炸动画播完才把这对牌从棋盘移除）');
  must(/export const MAX_PAIRS/.test(mSrc), 'match.js：单局对数上限 MAX_PAIRS（兜底防异常数据）');
  must(/export const MAX_DECK_PAIRS = \d+/.test(mSrc), 'match.js：整卡组词源上限 MAX_DECK_PAIRS（兜底防超大卡组）');
  must(
    /export function normalizeSource/.test(mSrc) &&
      /export function defaultSource/.test(mSrc) &&
      /export function isValidSource/.test(mSrc) &&
      /export function sourceCards/.test(mSrc) &&
      /export function sourceTotal/.test(mSrc) &&
      /export function sourceLimit/.test(mSrc),
    'match.js：词源内核（normalizeSource / defaultSource / isValidSource / sourceCards / sourceTotal / sourceLimit）'
  );
  must(
    /export function sourceLabel/.test(mSrc) && /export function matchTitle/.test(mSrc) && /export function stateSource/.test(mSrc),
    'match.js：词源文案与取值（sourceLabel / matchTitle / stateSource）'
  );
  must(
    /data-action="match-source" data-kind="deck"/.test(mSrc) && /on\('match-source'/.test(mSrc),
    'match.js：词源 chips（整卡组 / 已通关关卡）+ match-source 动作'
  );
  must(/matchTitle\(src\)/.test(mSrc) && /sourceNoteHtml\(deck, state\)/.test(mSrc), 'match.js：页头标题与「整卡组已全部纳入 / 已纳入 X/Y 张」说明');
  must(/export function buildTiles/.test(mSrc) && /export function shuffle/.test(mSrc), 'match.js：buildTiles / shuffle（随机源可注入）');
  must(
    /export function splitRounds/.test(mSrc) && /export function buildBoard/.test(mSrc),
    'match.js：splitRounds / buildBoard（按轮切分 + 每轮独立洗牌）'
  );
  must(
    /export function roundTiles/.test(mSrc) && /export function roundStats/.test(mSrc) && /export function liveTiles/.test(mSrc),
    'match.js：roundTiles / roundStats / liveTiles（只铺当前轮的 5 对）'
  );
  must(
    !/sessionStorage\.(setItem|getItem|removeItem)/.test(mSrc),
    'match.js：棋局只存内存（不写 / 不读 sessionStorage → 每次进入都重新洗牌）'
  );
  must(
    !/loadSession|isRoundComplete|isBoardComplete/.test(mSrc),
    'match.js：已下线「从缓存复活棋局」的守门路径（重进即新局）'
  );
  must(/roundCleared/.test(mSrc), 'match.js：applyPick 返回 roundCleared（UI 据此铺下一轮）');
  must(/export function nextSelection/.test(mSrc) && /export function applyPick/.test(mSrc), 'match.js：点击状态机（nextSelection / applyPick）');
  must(/export function renderMatch/.test(mSrc) && /export function clearMatchSession/.test(mSrc), 'match.js：页面入口 renderMatch / 清场 clearMatchSession');
  must(/export function unlockInfo/.test(mSrc) && /export function formatDuration/.test(mSrc), 'match.js：解锁进度 / 用时文案');
  must(
    /S && S\.deckId === deckId \? S : null/.test(mSrc),
    'match.js：renderMatch 只认内存会话（内存里没有 → 重新洗牌开局）'
  );
  must(/from '\.\/(store|levels|ui)\.js'/.test(mSrc), 'match.js 只依赖 store / levels / ui（纯内核 + 薄 UI）');
  must(!/from '(?!\.\/)/.test(mSrc), 'match.js 只 import 本地模块（零第三方依赖）');

  const appSrc2 = readFileSync(rel('js/app.js'), 'utf8');
  must(/seg\[0\] === 'match'/.test(appSrc2) && /renderMatch\(root, route\.id\)/.test(appSrc2), 'app.js 路由 #/match/{deckId} → renderMatch');
  must(/case 'match':/.test(appSrc2) && /t = '明牌配对'/.test(appSrc2), 'app.js 顶栏标题「明牌配对」+ 返回卡组');
  must(/clearMatchSession\(\)/.test(appSrc2), 'app.js 路由切换 / 重置数据时清空配对会话');

  const decksSrc4 = readFileSync(rel('js/decks.js'), 'utf8');
  must(/data-action="open-match"/.test(decksSrc4) && /on\('open-match'/.test(decksSrc4), 'decks.js 卡组详情页入口横幅 + open-match 动作');
  must(/from '\.\/match\.js'/.test(decksSrc4), 'decks.js 复用 match.js 解锁判定（规则只写一处）');
  must(/match\.ROUND_PAIRS/.test(decksSrc4), 'decks.js 横幅文案复用 ROUND_PAIRS（每轮对数只写一处）');
  must(/整卡组 \$\{deck\.cards\.length\} 张/.test(decksSrc4), 'decks.js 入口横幅写明「整卡组 N 张」（v0.7.1）');

  must(/\.match-banner/.test(css) && /\.match-board/.test(css) && /\.match-tile/.test(css), 'css：配对横幅 / 棋盘 / 牌面样式');
  must(/\.match-board \{[^}]*repeat\(2, minmax\(0, 1fr\)\)/.test(css), 'css：棋盘固定两列（不再随屏宽变多列）');
  must(/\.match-round \{/.test(css), 'css：轮次行 .match-round（第 R/T 轮 · 本轮还剩 N 对）');
  must(/@keyframes match-goldflash/.test(css) && /@keyframes match-burst/.test(css), 'css：配对成功「金光 + 迸发」关键帧');
  must(/@keyframes match-boom/.test(css) && /\.match-tile\.is-boom/.test(css), 'css：配对成功「爆炸消除」关键帧（.is-boom）');
  must(/@keyframes match-shake/.test(css) && /@keyframes combo-pop/.test(css), 'css：配对失败抖动 / 连击弹出关键帧');
  must(/\.match-combo \{/.test(css) && /@keyframes combo-kick/.test(css), 'css：combo✖️N 连击提示 + 抖动关键帧');
  must(
    /\.match-combo \{[^}]*right: 0[^}]*bottom: 0/.test(css) && /\.match-board-wrap \{[^}]*padding-bottom: clamp\(/.test(css),
    'css：combo✖️N 贴棋盘右下角（棋盘底部留白条内 → 不压牌面文字）'
  );
  must(
    /\.match-combo \{[^}]*transform-origin: 100% 100%/.test(css),
    'css：combo✖️N 绕右下角缩放 / 旋转（锚点固定在右下角）'
  );
  must(/\.match-tile\.is-matched::after/.test(css), 'css：金色迸发挂在 ::after（一次性动画）');
  must(existsSync(rel('scripts/test-match.mjs')), '存在 scripts/test-match.mjs');
  must(readFileSync(rel('scripts/smoke-dom.mjs'), 'utf8').includes('#/match/'), 'smoke-dom 覆盖 #/match 界面渲染 + 会话清场');
}

// 9) v0.6.0 填字游戏（第二个游戏：按当前词库自定义生成棋盘）
console.log('\n[填字游戏（v0.6.0，通关 ≥1 关解锁 · 按当前词库生成 · 每局 6~12 词）]');
{
  const cwPath = 'js/crossword.js';
  must(existsSync(rel(cwPath)), 'js/crossword.js 存在');
  must(sw.includes("'./js/crossword.js'"), 'sw.js PRECACHE 含 ./js/crossword.js');
  const cwSrc = readFileSync(rel(cwPath), 'utf8');
  must(/export const UNLOCK_LEVELS = 1/.test(cwSrc), 'crossword.js：解锁门槛 UNLOCK_LEVELS = 1（与明牌配对一致）');
  must(
    /export const SIZES = \[6, 8, 10, 12\]/.test(cwSrc) && /export const DEFAULT_SIZE = 8/.test(cwSrc),
    'crossword.js：每局词数档位 6/8/10/12（默认 8）'
  );
  must(/export const MIN_LEN = 2/.test(cwSrc) && /export const MAX_LEN = 12/.test(cwSrc), 'crossword.js：可填单词长度 2–12');
  must(
    /export function sanitizeAnswer/.test(cwSrc) && /export function entryFromCard/.test(cwSrc),
    'crossword.js：词条清洗（sanitizeAnswer / entryFromCard）'
  );
  must(/export function candidateEntries/.test(cwSrc), 'crossword.js：候选词条按答案去重（candidateEntries）');
  must(
    /export function canPlace/.test(cwSrc) && /export function findPlacement/.test(cwSrc) && /export function placeWord/.test(cwSrc),
    'crossword.js：交叉排版内核（canPlace / findPlacement / placeWord）'
  );
  must(/export function generateCrossword/.test(cwSrc) && /export function buildBoard/.test(cwSrc), 'crossword.js：棋盘生成（generateCrossword / buildBoard）');
  must(
    /export function cellMap/.test(cwSrc) && /export function wordCells/.test(cwSrc) && /export function wordAt/.test(cwSrc),
    'crossword.js：格子 / 线索索引（cellMap / wordCells / wordAt）'
  );
  must(
    /export function newGame/.test(cwSrc) && /export function setLetter/.test(cwSrc) && /export function checkAll/.test(cwSrc),
    'crossword.js：逐格状态机（newGame / setLetter / checkAll）'
  );
  must(
    /export function hintCell/.test(cwSrc) && /export function revealWord/.test(cwSrc) && /export function revealCell/.test(cwSrc),
    'crossword.js：提示一字母 / 显示本词（hintCell / revealWord / revealCell）'
  );
  must(
    /export function progress/.test(cwSrc) && /export function isSolved/.test(cwSrc) && /export function playStats/.test(cwSrc),
    'crossword.js：进度与统计（progress / isSolved / playStats）'
  );
  must(/export function cellSize/.test(cwSrc), 'crossword.js：棋盘格尺寸自适应（cellSize：按行列数 + 视口）');
  must(
    /export function renderCrossword/.test(cwSrc) && /export function clearCrosswordSession/.test(cwSrc),
    'crossword.js：页面入口 renderCrossword / 清场 clearCrosswordSession'
  );
  must(/const SESSION_KEY = 'mycard-crossword-session'/.test(cwSrc), 'crossword.js：会话 key = mycard-crossword-session（sessionStorage）');
  must(/export function statusText/.test(cwSrc) && /export function formatDuration/.test(cwSrc), 'crossword.js：状态行 / 用时文案');
  must(/from '\.\/(store|levels|ui)\.js'/.test(cwSrc), 'crossword.js 只依赖 store / levels / ui（纯内核 + 薄 UI）');
  must(!/from '(?!\.\/)/.test(cwSrc), 'crossword.js 只 import 本地模块（零第三方依赖）');

  const appSrc3 = readFileSync(rel('js/app.js'), 'utf8');
  must(/from '\.\/crossword\.js'/.test(appSrc3), 'app.js 引入 crossword.js');
  must(/seg\[0\] === 'crossword'/.test(appSrc3) && /renderCrossword\(root, route\.id\)/.test(appSrc3), 'app.js 路由 #/crossword/{deckId} → renderCrossword');
  must(/case 'crossword':/.test(appSrc3) && /t = '填字游戏'/.test(appSrc3), 'app.js 顶栏标题「填字游戏」+ 返回卡组');
  must(/clearCrosswordSession\(\)/.test(appSrc3), 'app.js 路由切换 / 重置数据时清空填字会话');

  const decksSrc5 = readFileSync(rel('js/decks.js'), 'utf8');
  must(/data-action="open-crossword"/.test(decksSrc5) && /on\('open-crossword'/.test(decksSrc5), 'decks.js 卡组详情页入口横幅 + open-crossword 动作');
  must(/from '\.\/crossword\.js'/.test(decksSrc5), 'decks.js 复用 crossword.js 解锁判定（规则只写一处）');
  must(/crossword\.DEFAULT_SIZE/.test(decksSrc5), 'decks.js 横幅文案复用 DEFAULT_SIZE（每局词数只写一处）');

  must(/\.cw-banner/.test(css) && /\.cw-board/.test(css) && /\.cw-cell/.test(css) && /\.cw-input/.test(css), 'css：填字横幅 / 棋盘 / 格子样式');
  must(/\.cw-board \{[\s\S]{0,220}grid-template-columns: repeat\(var\(--cw-cols/.test(css), 'css：棋盘列数走 --cw-cols（由 cellSize 计算后内联）');
  must(/\.cw-board-wrap \{[\s\S]{0,160}overflow-x: auto/.test(css), 'css：棋盘过宽时外层横向滚动（不挤压文字）');
  must(/@keyframes cw-shake/.test(css) && !/animation:[^;]*infinite[^;]*cw-/.test(css), 'css：填错抖动关键帧（一次性 → 被 reduced-motion 收敛）');
  const uiSrc2 = readFileSync(rel('js/ui.js'), 'utf8');
  must(/^\s*grid: '/m.test(uiSrc2), 'ui.js：新增 grid 图标（填字入口与空态复用）');
  must(existsSync(rel('scripts/test-crossword.mjs')), '存在 scripts/test-crossword.mjs');
  must(readFileSync(rel('scripts/smoke-dom.mjs'), 'utf8').includes('#/crossword/'), 'smoke-dom 覆盖 #/crossword 界面渲染 + 会话清场');
  must(readFileSync(rel('scripts/test-a11y.mjs'), 'utf8').includes('#/crossword'), 'test-a11y 覆盖填字页键盘可达性与标注');
}

// 10) v0.7.0 移动端英文字母键盘（填字 / 填空题）
console.log('\n[移动端英文字母键盘（v0.7.0，填字页 / 填空题）]');
{
  must(existsSync(rel('js/keyboard.js')), 'js/keyboard.js 存在');
  must(sw.includes("'./js/keyboard.js'"), 'sw.js PRECACHE 含 ./js/keyboard.js');
  const kbSrc = readFileSync(rel('js/keyboard.js'), 'utf8');
  must(/export const KB_ROWS = \['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'\]/.test(kbSrc), 'keyboard.js：三行 QWERTY 键位（26 字母）');
  must(/export const BACK_KEY/.test(kbSrc) && /export const SPACE_KEY/.test(kbSrc), 'keyboard.js：退格 / 空格键常量');
  must(/export function isTouchDevice/.test(kbSrc) && /export function shouldAutoOpen/.test(kbSrc), 'keyboard.js：触屏判定 + 是否自动弹出');
  must(
    /export function openKeyboard/.test(kbSrc) &&
      /export function closeKeyboard/.test(kbSrc) &&
      /export function hideKeyboard/.test(kbSrc) &&
      /export function showKeyboard/.test(kbSrc),
    'keyboard.js：open / hide / show / close 四态操作'
  );
  must(/export function syncInputs/.test(kbSrc) && /export function inputMode/.test(kbSrc), 'keyboard.js：inputmode 抑制系统输入法（inputMode / syncInputs）');
  must(/export function keyboardInnerHtml/.test(kbSrc) && /export function keyboardMiniHtml/.test(kbSrc), 'keyboard.js：键位 HTML / 收起后的迷你胶囊');
  must(!/sessionStorage|localStorage/.test(kbSrc), 'keyboard.js 不碰存储（纯 UI 模块）');
  must(/from '\.\/ui\.js'/.test(kbSrc) && !/from '(?!\.\/)/.test(kbSrc), 'keyboard.js 只依赖本地 ui.js（零第三方依赖）');

  const cwSrc2 = readFileSync(rel('js/crossword.js'), 'utf8');
  must(/export const TOUCH_MIN_CELL = 30/.test(cwSrc2) && /export const MIN_CELL = 24/.test(cwSrc2), 'crossword.js：触屏格子下限 30px / 桌面 24px');
  must(/viewport\.touch == null \? vw <= TOUCH_VIEWPORT_WIDTH/.test(cwSrc2), 'crossword.js：cellSize 支持 touch 参数（缺省按视口宽推断）');
  must(/kb\.openKeyboard\(\{ inputs: '\.cw-input'/.test(cwSrc2), 'crossword.js：触屏接入字母键盘（inputs = .cw-input）');
  must(/kb\.syncInputs\(\)/.test(cwSrc2), 'crossword.js：渲染后同步 inputmode');
  must(/scrollIntoView/.test(cwSrc2), 'crossword.js：焦点格自动滚进视野（棋盘可横向滚动）');

  const testSrc2 = readFileSync(rel('js/test.js'), 'utf8');
  must(/kb\.openKeyboard\(\{/.test(testSrc2) && /inputs: '\.fill-field'/.test(testSrc2), 'test.js：填空题接入字母键盘（inputs = .fill-field）');
  must(/space: true/.test(testSrc2), 'test.js：填空题键盘带空格键（多词答案）');
  must(/kb\.closeKeyboard\(\)/.test(testSrc2), 'test.js：已作答 / 离场时收起键盘');

  must(/\.kb-bar \{/.test(css) && /\.kb-key \{/.test(css) && /\.kb-mini \{/.test(css), 'css：键盘条 / 键位 / 迷你胶囊样式');
  must(/\.kb-bar\[hidden\] \{ display: none; \}/.test(css), 'css：隐藏态用 [hidden] 退出 tab 序');
  must(/body\.kb-open #view \{ padding-bottom: calc\(var\(--safe-b\) \+ 76px \+ var\(--kb-h/.test(css), 'css：键盘展开时内容区按 --kb-h 留白');
  must(/@keyframes kbUp/.test(css), 'css：键盘升起关键帧（一次性 → reduced-motion 收敛）');
  must(
    /\.cw-board-wrap \{[\s\S]{0,120}display: block[\s\S]{0,80}text-align: center/.test(css) &&
      /\.cw-board \{[\s\S]{0,60}display: inline-grid/.test(css),
    'css：棋盘改 inline-grid + text-align 居中（横向滚动不会切掉左端）'
  );
  must(/@media \(max-width: 600px\) \{[\s\S]{0,160}\.cw-board-wrap/.test(css), 'css：移动端收窄棋盘内边距（把屏幕让给棋盘）');
  must(/^\s*--kb-h: /m.test(css), 'css：:root 给 --kb-h 默认值（var 审计通过）');
  must(existsSync(rel('scripts/test-keyboard.mjs')), '存在 scripts/test-keyboard.mjs');
  must(readFileSync(rel('scripts/test-crossword.mjs'), 'utf8').includes('kb-key'), 'test-crossword 覆盖屏幕字母键盘');
  must(readFileSync(rel('scripts/test-fill.mjs'), 'utf8').includes('kb-key'), 'test-fill 覆盖屏幕字母键盘');
  must(readFileSync(rel('scripts/smoke-dom.mjs'), 'utf8').includes('kb-hide'), 'smoke-dom 覆盖触屏键盘（展开 / 收起 / 唤出）');
}

// 11) v0.8.0 多端同步（WebDAV）
console.log('\n[多端同步（v0.8.0，WebDAV：词库 + 学习进度 + 复习日志）]');
{
  must(existsSync(rel('js/webdav.js')), 'js/webdav.js 存在（极简 WebDAV 客户端）');
  must(existsSync(rel('js/sync.js')), 'js/sync.js 存在（同步引擎 + 合并内核）');
  must(sw.includes("'./js/webdav.js'"), 'sw.js PRECACHE 含 ./js/webdav.js');
  must(sw.includes("'./js/sync.js'"), 'sw.js PRECACHE 含 ./js/sync.js');

  const wdSrc = readFileSync(rel('js/webdav.js'), 'utf8');
  must(/export const DEFAULT_TIMEOUT/.test(wdSrc) && /export class WebdavError/.test(wdSrc), 'webdav.js：超时常量与 WebdavError');
  must(/export function explainError/.test(wdSrc) && /export function normalizeBase/.test(wdSrc) && /export function normalizeDir/.test(wdSrc), 'webdav.js：错误说明 + URL 规范化');
  must(/export function buildUrl/.test(wdSrc) && /export function authHeader/.test(wdSrc), 'webdav.js：地址拼接（逐段编码）+ Basic 认证');
  must(/export async function probe/.test(wdSrc) && /export async function ensureCollection/.test(wdSrc), 'webdav.js：probe（PROPFIND）+ ensureCollection（递归 MKCOL）');
  must(/export async function getText/.test(wdSrc) && /export async function putText/.test(wdSrc) && /export async function remove/.test(wdSrc), 'webdav.js：GET / PUT（含 createOnly 抢锁）/ DELETE');
  must(!/from '(?!\.\/)/.test(wdSrc) && !/import \*/.test(wdSrc), 'webdav.js 零依赖（只用内置 fetch / AbortController / btoa）');

  const syncSrc = readFileSync(rel('js/sync.js'), 'utf8');
  must(/export const SNAPSHOT_VERSION = \d+/.test(syncSrc), 'sync.js：快照格式版本 SNAPSHOT_VERSION');
  must(/export const SNAPSHOT_FILE = 'mycard-sync\.json'/.test(syncSrc) && /export const BACKUP_FILE/.test(syncSrc) && /export const LOCK_FILE/.test(syncSrc), 'sync.js：快照 / 备份 / 锁文件名');
  must(/export function loadConfig/.test(syncSrc) && /export function saveConfig/.test(syncSrc) && /export function clearCredentials/.test(syncSrc) && /export function isConfigured/.test(syncSrc), 'sync.js：配置读写 / 清凭据 / 是否已配置');
  must(/export async function buildSnapshot/.test(syncSrc) && /export function parseSnapshot/.test(syncSrc) && /export function normalizeSnapshot/.test(syncSrc), 'sync.js：快照构造 / 解析 / 归一化');
  must(
    /export function mergeCard/.test(syncSrc) && /export function mergeRevlog/.test(syncSrc) && /export function mergeTombstones/.test(syncSrc),
    'sync.js：合并内核（卡片 / 日志 / 墓碑）'
  );
  must(/export function cardDeletedAt/.test(syncSrc) && /export function deckDeletedAt/.test(syncSrc), 'sync.js：删除墓碑判定（删除晚会真删，对方改过则保留）');
  must(/export function mergeDeckEntry/.test(syncSrc) && /export function mergeSnapshots/.test(syncSrc), 'sync.js：卡组 / 快照合并');
  must(/export function diffSnapshots/.test(syncSrc) && /export function statsText/.test(syncSrc) && /export function lastResultText/.test(syncSrc), 'sync.js：变更统计与文案');
  must(/export async function syncNow/.test(syncSrc) && /export async function acquireLock/.test(syncSrc) && /export async function releaseLock/.test(syncSrc), 'sync.js：执行同步 + 抢锁 / 释放锁');
  must(/export function initAutoSync/.test(syncSrc) && /export async function notifyDataChanged/.test(syncSrc) && /export function signature/.test(syncSrc), 'sync.js：自动同步（启动一次 + 变更后检查）');
  must(
    /const SCHED_FIELDS = \['state', 'repetitions', 'interval', 'easeFactor', 'due', 'lastReview'\]/.test(syncSrc),
    'sync.js：调度字段清单（进度按 lastReview 合并，保证只进不退）'
  );
  must(/from '\.\/(store|webdav)\.js'/.test(syncSrc) && !/from '(?!\.\/)/.test(syncSrc), 'sync.js 只依赖本地 store / webdav（零第三方依赖）');

  const storeSrc3 = readFileSync(rel('js/store.js'), 'utf8');
  must(/export const TOMBSTONE_KEY/.test(storeSrc3) && /export const TOMBSTONE_TTL/.test(storeSrc3), 'store.js：删除墓碑 key 与保留期');
  must(/export function recordTombstone/.test(storeSrc3) && /export function syncTombstones/.test(storeSrc3) && /export function setTombstones/.test(storeSrc3), 'store.js：墓碑记录 / 读取 / 覆盖');
  must(/export function applySyncDecks/.test(storeSrc3), 'store.js：applySyncDecks（保留 id 的合并落库，含 revlog 回写）');
  must(/updatedAt: c\.updatedAt \|\| c\.createdAt/.test(storeSrc3) && /updatedAt: d\.updatedAt \|\| d\.createdAt/.test(storeSrc3), 'store.js：卡片 / 卡组都带 updatedAt（同步冲突判定依据）');
  must(/const CARD_CONTENT_KEYS/.test(storeSrc3) && /CARD_CONTENT_KEYS\.some/.test(storeSrc3), 'store.js：只有内容编辑才推进卡片的 updatedAt（纯学习动作不推进）');

  const appSrc3 = readFileSync(rel('js/app.js'), 'utf8');
  must(/from '\.\/sync\.js'/.test(appSrc3) && /from '\.\/webdav\.js'/.test(appSrc3), 'app.js 引入 sync.js / webdav.js');
  must(/function syncSectionHtml/.test(appSrc3) && /多端同步（WebDAV）/.test(appSrc3), 'app.js：设置页「多端同步（WebDAV）」区块');
  must(/on\('sync-now'/.test(appSrc3) && /on\('sync-test'/.test(appSrc3) && /on\('sync-save'/.test(appSrc3) && /on\('sync-toggle'/.test(appSrc3), 'app.js：立即同步 / 测试连接 / 保存 / 开关动作');
  must(/sync\.initAutoSync\(\)/.test(appSrc3) && /sync\.notifyDataChanged\(\)/.test(appSrc3), 'app.js：启动时初始化自动同步 + 离开页面时尝试推送变更');
  must(/未勾「记住密码」|记住密码/.test(appSrc3) && /esc\(passPlaceholder\)/.test(appSrc3), 'app.js：密码默认不落盘，框内只给占位提示');

  must(/\.sync-grid/.test(css) && /\.sync-check/.test(css) && /\.sync-status/.test(css) && /\.sync-actions/.test(css), 'css：同步区块（网格 / 开关 / 状态 / 按钮组）样式');
  must(/\.sync-status\.is-good b \{ color: var\(--teal-tx\)/.test(css) && /\.sync-status\.is-bad b \{ color: var\(--soft-danger-tx\)/.test(css), 'css：成功 / 失败状态用语义变量（浅深色都可读）');
  must(/@media \(max-width: 520px\) \{ \.sync-row/.test(css), 'css：窄屏同步表单单列');
  must(existsSync(rel('scripts/test-sync.mjs')), '存在 scripts/test-sync.mjs');
  must(readFileSync(rel('scripts/smoke-dom.mjs'), 'utf8').includes('data-action="sync-now"'), 'smoke-dom 覆盖同步设置页（渲染 + 动作）');
  must(readFileSync(rel('scripts/test-a11y.mjs'), 'utf8').includes('同步表单字段都有可见'), 'test-a11y 覆盖同步表单标注');
}

// 12) v0.9.0 同步增强：增量传输（索引 + 分卡组文件）/ 预览差异 / 本机专用卡组
console.log('\n[同步增强（v0.9.0：增量 + 预览差异 + 本机专用）]');
{
  const syncSrc = readFileSync(rel('js/sync.js'), 'utf8');
  const storeSrc4 = readFileSync(rel('js/store.js'), 'utf8');
  const appSrc4 = readFileSync(rel('js/app.js'), 'utf8');
  const decksSrc3 = readFileSync(rel('js/decks.js'), 'utf8');
  // 增量布局
  must(/export const SNAPSHOT_VERSION = 2/.test(syncSrc), 'sync.js：快照格式升到 v2（索引 + 分卡组文件）');
  must(
    /export const DECK_DIR = 'mycard-decks'/.test(syncSrc) && /export const DECK_BACKUP_SUFFIX/.test(syncSrc),
    'sync.js：分卡组目录与备份后缀常量'
  );
  must(/export function deckFileOf/.test(syncSrc) && /export function deckBackupFileOf/.test(syncSrc), 'sync.js：分卡组文件路径 / 备份路径');
  must(/export function deckFileName/.test(syncSrc) && !/encodeURIComponent\(String\(deckId\)\)/.test(syncSrc), 'sync.js：文件名自带安全化（不重复编码，避免 %25）');
  must(/export function stableStringify/.test(syncSrc) && /export function deckHash/.test(syncSrc), 'sync.js：稳定序列化 + 内容指纹（与字段顺序无关）');
  must(/export function manifestEntry/.test(syncSrc) && /export function manifestOf/.test(syncSrc) && /export function emptyManifest/.test(syncSrc), 'sync.js：索引（manifest）生成');
  must(
    /maxCardUpdated/.test(syncSrc) && /maxLastReview/.test(syncSrc),
    'sync.js：索引带「最新修改 / 最新复习」摘要（判删除时不必多拉一次文件）'
  );
  must(/export function isLegacyManifest/.test(syncSrc), 'sync.js：识别 v0.8 单文件老格式');
  must(/export async function readRemote/.test(syncSrc) && /export async function writeRemote/.test(syncSrc), 'sync.js：readRemote / writeRemote（增量读写）');
  must(/export function uploadPlan/.test(syncSrc), 'sync.js：uploadPlan（哪些卡组要重传 / 哪些远端文件要删）');
  must(/指纹相同|hash === entry\.hash/.test(syncSrc), 'sync.js：指纹相同就跳过下载（增量读）');
  must(/toRemove/.test(syncSrc) && /webdav\.remove\(cfg\.url, deckFileOf\(id\)/.test(syncSrc), 'sync.js：合并后消失的卡组 → 删掉远端文件（不留垃圾）');
  must(
    /deckBackupFileOf\(id\)/.test(syncSrc) && /SNAPSHOT_FILE, JSON\.stringify\(manifest/.test(syncSrc),
    'sync.js：覆盖前先备份（索引 + 每个卡组文件）'
  );
  // 预览差异
  must(/export function buildReport/.test(syncSrc) && /contentFrom/.test(syncSrc) && /progressFrom/.test(syncSrc), 'sync.js：合并明细报告（逐卡组变化 + 冲突来源）');
  must(/export async function planSync/.test(syncSrc) && /export async function previewSync/.test(syncSrc), 'sync.js：planSync / previewSync（只算不写）');
  must(/export function previewText/.test(syncSrc) && /export function countsOf/.test(syncSrc), 'sync.js：预览文案与规模统计');
  must(/export function mergeSnapshots\(local, remote, \{ now = Date\.now\(\), device = '', report = true \}/.test(syncSrc), 'sync.js：mergeSnapshots 支持 report（预览明细与正式同步共用同一套计算）');
  must(!/previewSync[\s\S]{0,600}putText/.test(syncSrc.slice(syncSrc.indexOf('export async function previewSync'), syncSrc.indexOf('export function previewText'))), 'previewSync 不写任何文件（只 GET）');
  // 本机专用
  must(/export function isLocalOnlyDeck/.test(syncSrc) && /export function localOnlyDeckIds/.test(syncSrc), 'sync.js：isLocalOnlyDeck / localOnlyDeckIds');
  must(/if \(isLocalOnlyDeck\(deck\)\) continue|if \(isLocalOnlyDeck\(deck\)\) \{/.test(syncSrc), 'sync.js：buildSnapshot 跳过本机专用卡组');
  must(/localOnlyCards/.test(syncSrc) && /墓碑：本机专用卡组（及其卡片）的删除记录不外传/.test(syncSrc), 'sync.js：本机专用卡组的墓碑不外传');
  must(/keepDeckIds: localOnly/.test(syncSrc) && /keepDeckIds: plan\.keepDeckIds/.test(syncSrc), 'sync.js：同步落库时把本机专用 id 传给 keepDeckIds');
  must(/syncLocal: !!d\.syncLocal/.test(storeSrc4) && /syncLocal: !!deck\.syncLocal/.test(storeSrc4), 'store.js：syncLocal 随卡组规范化 / 元信息持久化');
  must(/keepDeckIds/.test(storeSrc4) && /keepLocal\.has\(String\(deck\.id\)\)/.test(storeSrc4), 'store.js：applySyncDecks 支持 keepDeckIds（不删本机专用卡组）');
  must(
    /if \(deck && !deck\.syncLocal\) recordTombstone\('deck'/.test(storeSrc4) &&
      /if \(!deck\.syncLocal\) recordTombstone\('card'/.test(storeSrc4) &&
      /if \(!deck\.syncLocal\) for \(const c of removed\) recordTombstone/.test(storeSrc4),
    'store.js：本机专用卡组（及其卡片）的删除不记墓碑'
  );
  must(/'syncLocal' in patch/.test(storeSrc4) && /syncLocal: !!fields\.syncLocal/.test(storeSrc4), 'store.js：createDeck / updateDeck 都支持 syncLocal');
  // UI 接线
  must(/on\('sync-preview'/.test(appSrc4) && /sync\.previewSync\(\{ cfg \}\)/.test(appSrc4) && /syncPreviewModal/.test(appSrc4), 'app.js：预览差异动作 + 弹窗渲染');
  must(/function runSync\(\)/.test(appSrc4) && /on\('sync-now', \(\) => \{\s*runSync\(\)/.test(appSrc4), 'app.js：立即同步 / 预览确认共用 runSync');
  must(/openModal\(/.test(appSrc4) && /from '\.\/ui\.js'/.test(appSrc4), 'app.js：预览用 ui.openModal（复用焦点陷阱 / Esc）');
  must(/class="sync-counts"/.test(appSrc4) && /class="sync-table"/.test(appSrc4), 'app.js：预览里展示规模对比与逐卡组明细');
  must(/data-action="deck-local"/.test(decksSrc3) && /on\('deck-local'/.test(decksSrc3) && /syncLocal: next/.test(decksSrc3), 'decks.js：卡组菜单可切换「本机专用」');
  must(/name="syncLocal"/.test(decksSrc3) && /本机专用（不参与多端同步）/.test(decksSrc3), 'decks.js：卡组编辑弹窗有「本机专用」勾选框');
  must(/pill-local/.test(decksSrc3) && /pill-local/.test(css), 'decks.js + css：卡组页用 .pill-local 标记');
  must(/\.sync-counts/.test(css) && /\.sync-table/.test(css) && /\.sync-note/.test(css) && /\.modal-wide/.test(css), 'css：预览弹窗（规模 / 表格 / 提示 / 宽弹窗）样式');
  const testSyncSrc = readFileSync(rel('scripts/test-sync.mjs'), 'utf8');
  must(/previewSync/.test(testSyncSrc) && /makeServer/.test(testSyncSrc) && /本机专用/.test(testSyncSrc), 'test-sync 覆盖增量同步 / 预览 / 本机专用（假 WebDAV 服务端）');
  must(
    readFileSync(rel('scripts/smoke-dom.mjs'), 'utf8').includes('data-action="sync-preview"'),
    'smoke-dom 覆盖「预览差异」弹窗'
  );
}

// 13) v0.9.1 修复：没开「英英选择」时不出英文题（多义多选不再回退 GCIDE）
console.log('\n[题型联动修复（v0.9.1：只开多义多选 → 不出英文题）]');
{
  const testSrc = readFileSync(rel('js/test.js'), 'utf8');
  const engineSrc = readFileSync(rel('js/test-engine.js'), 'utf8');
  const cfgSrc = readFileSync(rel('js/test-config.js'), 'utf8');
  must(/export function multiSenseSet\(card, max = 4, \{ allowEnglish = true \} = \{\}\)/.test(testSrc), 'test.js：multiSenseSet 支持 allowEnglish（不再无条件回退 GCIDE）');
  must(/if \(!allowEnglish\) return null;/.test(testSrc), 'test.js：不允许英文题时直接返回 null（中文释义不足就不出多义题）');
  must(/export function canBuildType\(card, type, \{ allowEnSenses = true \} = \{\}\)/.test(testSrc), 'test.js：canBuildType（抽题与出题共用的唯一判定口径）');
  must(
    /if \(type === 'eng_eng'\) return !!allowEnSenses/.test(testSrc) && /multiSenseSet\(card, 4, \{ allowEnglish: !!allowEnSenses \}\)/.test(testSrc),
    'test.js：canBuildType 同时约束 eng_eng 与 multi_sense'
  );
  must(/allowEnSenses = true \} = \{\}\)/.test(testSrc) && /buildQuestionsFromPlan\(deck, plan, hardIds = null, random = Math\.random, \{ allowEnSenses = true \}/.test(testSrc), 'test.js：buildQuestions / buildQuestionsFromPlan 接受 allowEnSenses');
  must(/if \(!allowEnSenses\) return null; \/\/ 没开「英英选择」时不该出现英文题/.test(testSrc), 'test.js：buildOneQuestion 对英英题有防御性回退');
  must(/const set = multiSenseSet\(card, 4, \{ allowEnglish: !!allowEnSenses \}\)/.test(testSrc), 'test.js：出题时按 allowEnSenses 决定要不要英文兜底');
  must(/const allowEnSenses = !!\(conf\.enabled && conf\.enabled\.eng_eng\)/.test(testSrc), 'test.js：startDeckTest 以「是否开启英英选择」作为 allowEnSenses');
  must(
    /canType: \(card, type\) => canBuildType\(card, type, \{ allowEnSenses \}\)/.test(testSrc) &&
      /buildQuestionsFromPlan\(deck, plan, hw\.hardSet\(deckId\), Math\.random, \{ allowEnSenses \}\)/.test(testSrc),
    'test.js：整卡组测试同时把 allowEnSenses 传给抽题计划与出题（两条链路一致）'
  );
  must(/canType = null \} = \{\}\)/.test(engineSrc) && /const byId = typeof canType === 'function'/.test(engineSrc), 'test-engine.js：samplePlan 支持 canType（卡片级可用性）');
  must(
    /export function assignTypesByCard\(seq, typeList, random = Math\.random, \{ byId = null, canType = null \} = \{\}\)/.test(engineSrc),
    'test-engine.js：assignTypesByCard 支持 byId / canType'
  );
  must(
    /const ok = cands\.filter\(\(t\) => canType\(card, t\)\)/.test(engineSrc) && /QUESTION_TYPES\.filter\(\(t\) => !used\.has\(t\) && canType\(card, t\)\)/.test(engineSrc),
    'test-engine.js：可用题优先；都不可用时借基础题型顶上，把槽位留给后面合适的卡'
  );
  must(/中文释义不足 2 条/.test(cfgSrc) && /GCIDE 英文释义兜底/.test(cfgSrc), 'test-config.js：题面说明写明英文兜底只在开启「英英选择」后生效');
  const testMsSrc = readFileSync(rel('scripts/test-multi-sense.mjs'), 'utf8');
  const testDeckSrc = readFileSync(rel('scripts/test-deck-test.mjs'), 'utf8');
  must(/allowEnglish: false/.test(testMsSrc) && /canBuildType/.test(testMsSrc), 'test-multi-sense 覆盖 allowEnglish / canBuildType');
  must(/canType/.test(testDeckSrc) && /没有任何英文多义题/.test(testDeckSrc), 'test-deck-test 覆盖抽题可用性 + 端到端「没有英文多义题」');
  must(readFileSync(rel('scripts/smoke-dom.mjs'), 'utf8').includes('不出英文题'), 'smoke-dom 覆盖「只开多义多选 → 不出英文题」的整卡组链路');
}

// 14) v0.9.2「连不上也说得清」：错误分类 + 逐步诊断 + 可复制报告（不再只报 request failed）
console.log('\n[同步连通性诊断（v0.9.2：错误说清原因 + 逐步定位）]');
{
  const wdSrc = readFileSync(rel('js/webdav.js'), 'utf8');
  const appSrc5 = readFileSync(rel('js/app.js'), 'utf8');
  must(/this\.kind = kind/.test(wdSrc) && /'timeout' \| 'offline' \| 'mixed-content' \| 'network'/.test(wdSrc), 'webdav.js：WebdavError 带 kind（超时 / 离线 / 混合内容 / 网络）');
  must(/export function causeText/.test(wdSrc), 'webdav.js：causeText 保留浏览器原始异常（name + message）');
  must(!/'request failed'/.test(wdSrc), 'webdav.js：不再把一切压成没有信息的 "request failed"');
  must(/kind: deviceOffline\(\) \? 'offline' : 'network'/.test(wdSrc), 'webdav.js：网络异常区分「离线」与「连不上」');
  must(/pageIsHttps\(\) && \/\^http:/.test(wdSrc) && /kind: 'mixed-content'/.test(wdSrc), 'webdav.js：HTTPS 页面 + http 地址 → 本地就拦下（不发请求）');
  must(/export async function diagnose/.test(wdSrc) && /export function setupHints/.test(wdSrc) && /export function diagnoseReport/.test(wdSrc), 'webdav.js：diagnose / setupHints / diagnoseReport（逐步诊断 + 自查清单 + 可复制报告）');
  must(
    /基础连通性（GET，不带认证）/.test(wdSrc) && /跨域预检（PROPFIND，不带认证）/.test(wdSrc) && /带认证的 PROPFIND/.test(wdSrc),
    'webdav.js：诊断按「连通性 → 跨域预检 → 认证」三步推进（能区分网络 / CORS / 账号）'
  );
  must(/服务器拒绝了浏览器的跨域预检/.test(wdSrc) && /应用密码/.test(wdSrc), 'webdav.js：结论给到「CORS 被拦」与「应用密码」这类可执行动作');
  must(/出于安全未包含在报告中/.test(wdSrc) && !/cfg\.pass \|\| ''/.test(wdSrc), 'webdav.js：诊断报告绝不含密码');
  must(/注册邮箱/.test(wdSrc) && /dav\.jianguoyun\.com/.test(wdSrc), 'webdav.js：自查清单含坚果云专用提示（注册邮箱 + 应用密码 + 正确端点）');
  must(/export function explainError/.test(wdSrc) && /浏览器原始信息/.test(wdSrc), 'webdav.js：explainError 把「地址 + 原始信息 + 怎么办」一起给出');
  must(/data-action="sync-diag"/.test(appSrc5) && /async function runDiagnose/.test(appSrc5) && /function syncDiagModal/.test(appSrc5), 'app.js：「诊断连接」按钮 + runDiagnose + 诊断弹窗');
  must(/await runDiagnose\(cfg\)/.test(appSrc5) && /if \(!Number\(e && e\.status\)\) await runDiagnose\(cfg\)/.test(appSrc5), 'app.js：测试连接 / 立即同步 / 预览失败时自动附上诊断');
  must(/webdav\.diagnoseReport\(rep, cfg\)/.test(appSrc5) && /function copyText/.test(appSrc5), 'app.js：诊断弹窗可复制报告（剪贴板不可用时降级提示手选）');
  must(/class="diag-list"/.test(appSrc5) && /diag-step is-/.test(appSrc5) && /diag-hints/.test(appSrc5), 'app.js：诊断弹窗结构（步骤列表 + 自查清单）');
  must(/\.diag-list/.test(css) && /\.diag-step\.is-fail/.test(css) && /\.diag-hints/.test(css), 'css：诊断样式（含失败态与清单）');
  const testSyncSrc2 = readFileSync(rel('scripts/test-sync.mjs'), 'utf8');
  must(/kind === 'network'/.test(testSyncSrc2) && /diagnose\('https:\/\/dav\.example\.com\/dav'/.test(testSyncSrc2), 'test-sync：覆盖错误分类 + 逐步诊断多场景');
  must(/报告绝不含密码/.test(testSyncSrc2), 'test-sync：断言诊断报告不含密码');
  must(readFileSync(rel('scripts/smoke-dom.mjs'), 'utf8').includes('data-action="sync-diag"'), 'smoke-dom：覆盖「诊断连接」弹窗（跨域 / 连接正常两种结论）');
}

// 15) v0.9.3：no-cors 可达性探测（把「网络不通」与「缺 CORS 头」彻底分开）
console.log('\n[同步诊断增强（v0.9.3：no-cors 可达性 → 区分网络 / CORS）]');
{
  const wdSrc2 = readFileSync(rel('js/webdav.js'), 'utf8');
  must(/export async function probeReachable/.test(wdSrc2), 'webdav.js：probeReachable（no-cors 黑盒探测）');
  must(/mode: 'no-cors'/.test(wdSrc2) && /cache: 'no-store'/.test(wdSrc2), 'webdav.js：探测用 mode:"no-cors" + no-store 的简单 GET');
  must(
    /return \{ ok: true \}/.test(wdSrc2) && /reason: aborted \? 'timeout' : deviceOffline\(\) \? 'offline' : 'unreachable'/.test(wdSrc2),
    'webdav.js：探测结果区分 resolve（可达）与 reject（超时 / 离线 / 不可达）'
  );
  must(/if \(!simpleOk\) \{\s*reach = await probeReachable/.test(wdSrc2), 'webdav.js：仅在「基础连通性」失败时才补一次可达性探测（不多发无用请求）');
  must(/服务器可达性（no-cors 探测）/.test(wdSrc2), 'webdav.js：诊断步骤名「服务器可达性」');
  must(
    /服务器其实是「可达」的，只是它没有给浏览器跨域许可/.test(wdSrc2) && /Worker/.test(wdSrc2),
    'webdav.js：可达 → 结论明确「缺 CORS 头」并给出出路（换网盘 / Worker 反代）'
  );
  must(
    /这台设备根本到不了服务器（请求没完成）/.test(wdSrc2) && /手机热点/.test(wdSrc2),
    'webdav.js：不可达 → 结论指向网络层面并给出换网络 / 关拦截器'
  );
  must(/Access-Control|CORS 响应头缺失/.test(wdSrc2), 'webdav.js：解释里点明「CORS 响应头缺失」这一机制');
  must(
    /诊断里「服务器可达性」也失败/.test(wdSrc2) && /内容拦截/.test(wdSrc2),
    'webdav.js：自查清单含「可达性也失败 = 网络 / 拦截」分支'
  );
  must(/Load failed/.test(wdSrc2) || /Failed to fetch/.test(wdSrc2), 'webdav.js：兼容 Safari 的 Load failed 与 Chrome 的 Failed to fetch 文案');
  const testSyncSrc3 = readFileSync(rel('scripts/test-sync.mjs'), 'utf8');
  must(/mode === 'no-cors'/.test(testSyncSrc3) && /服务器可达性/.test(testSyncSrc3), 'test-sync：覆盖 no-cors 探测与两条结论分支');
  must(/根本到不了服务器/.test(readFileSync(rel('scripts/smoke-dom.mjs'), 'utf8')) || /跨域许可/.test(readFileSync(rel('scripts/smoke-dom.mjs'), 'utf8')), 'smoke-dom：覆盖 Safari「Load failed + 可达」场景的结论');
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
