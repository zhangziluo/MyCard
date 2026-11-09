#!/usr/bin/env node
// ============================================================================
// gen-flags.mjs — 下载 195 个国家国旗 SVG 到 assets/flags/
//   运行: node scripts/gen-flags.mjs
// 来源: FlagCDN (https://flagcdn.com/{iso2}.svg，基于 MIT 许可的 lipis/flag-icons)
// 说明: 国家英文名 → ISO 代码取自 js/countries.js 的 COUNTRY_ISO；
//       已存在的文件默认跳过（--force 覆盖）。
// ============================================================================

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { COUNTRY_ISO } = await import('../js/countries.js');

const force = process.argv.includes('--force');
const data = JSON.parse(readFileSync(resolve(ROOT, 'data/countries-capitals.json'), 'utf8'));
const names = data.words.map((w) => String(w.front).split(' · ').pop().trim());

const missing = [...new Set(names.filter((n) => !COUNTRY_ISO[n]))];
if (missing.length) {
  console.error('缺少 ISO 映射：', missing.join(', '));
  process.exit(1);
}

const outDir = resolve(ROOT, 'assets/flags');
mkdirSync(outDir, { recursive: true });

const jobs = [...new Set(names.map((n) => COUNTRY_ISO[n]))];
let done = 0;
let failed = 0;

async function download(iso) {
  const file = resolve(outDir, `${iso}.svg`);
  if (!force && existsSync(file)) {
    done += 1;
    return;
  }
  const url = `https://flagcdn.com/${iso}.svg`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${iso}: HTTP ${res.status}`);
  const text = await res.text();
  if (!text.trim().startsWith('<svg')) throw new Error(`${iso}: 不是有效 SVG`);
  writeFileSync(file, text);
  done += 1;
}

async function worker(queue) {
  while (queue.length) {
    const iso = queue.shift();
    try {
      await download(iso);
    } catch (e) {
      failed += 1;
      console.error('  ✗', e.message);
    }
  }
}

const queue = [...jobs];
await Promise.all(Array.from({ length: 8 }, () => worker(queue)));
console.log(`\n国旗 SVG: ${done} 个完成，${failed} 个失败，目录 ${outDir}`);
process.exit(failed ? 1 : 0);
