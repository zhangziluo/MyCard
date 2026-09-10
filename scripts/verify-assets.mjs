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

// 6) 内置考研词汇词库
console.log('\n[data/kaoyan.json]');
const kaoyan = JSON.parse(readFileSync(rel('data/kaoyan.json'), 'utf8'));
must(Array.isArray(kaoyan.words) && kaoyan.words.length >= 1000, '词库 ≥ 1000 词（当前 ' + kaoyan.words.length + '）');
const kBad = kaoyan.words.find((w) => !w.front || !w.back);
must(!kBad, '每条均含 front/back');
const dup = kaoyan.words.length !== new Set(kaoyan.words.map((w) => w.front)).size;
must(!dup, 'front 不重复（已按单词合并去重）');
const kWithEx = kaoyan.words.filter((w) => w.example).length;
must(
  kWithEx / kaoyan.words.length >= 0.95,
  '例句覆盖率 ≥ 95%（当前 ' + Math.round((kWithEx / kaoyan.words.length) * 100) + '%）'
);

console.log(failed ? `\n共 ${failed} 项校验失败` : '\n全部资源校验通过 ✔');
process.exit(failed ? 1 : 0);
