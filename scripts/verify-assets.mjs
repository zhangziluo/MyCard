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

console.log(failed ? `\n共 ${failed} 项校验失败` : '\n全部资源校验通过 ✔');
process.exit(failed ? 1 : 0);
