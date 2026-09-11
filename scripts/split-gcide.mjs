#!/usr/bin/env node
// ============================================================================
// split-gcide.mjs — 把 GCIDE 语料（原 26 个 CIDE.A–Z 分卷，约 60MB）重打包为
//                  3~4 个纯文本分卷，每个 **小于 25MB**（便于上传/分发）。
//   运行: node scripts/split-gcide.mjs            # 默认 4 卷，每卷上限 25MB
//         PARTS=3 MAX_MB=25 node scripts/split-gcide.mjs
//
// 说明：
//  - 内容 = CIDE.A…CIDE.Z 顺序拼接（含原有换行与标记），只在**行边界**切分，
//    因此 `cat gcide-part*.txt > CIDE.full.txt` 可无损还原；
//  - 生成后删除旧的 CIDE.* 分卷（原始文件可从 Dictionary/gcide-0.51.zip 恢复）；
//  - 重复运行是幂等的：已拆分过则先合并现有 gcide-part*.txt 再重新分卷。
//  - scripts/build-engdefs.mjs 会自动识别并读取 gcide-part*.txt。
// ============================================================================

import { readFileSync, readdirSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'gcide-0.51');
const PARTS = Math.max(1, Number(process.env.PARTS || 4));
const MAX_BYTES = Math.max(1, Number(process.env.MAX_MB || 25)) * 1024 * 1024;

const partName = (i) => `gcide-part${i}.txt`;
const listParts = () =>
  readdirSync(DIR)
    .filter((f) => /^gcide-part\d+\.txt$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

function readSources() {
  const files = readdirSync(DIR);
  const sides = files.filter((f) => /^CIDE\.[A-Z]$/.test(f)).sort();
  if (sides.length) {
    console.log(`来源：CIDE.[A-Z] 共 ${sides.length} 个分卷`);
    return sides.map((f) => ({ name: f, path: join(DIR, f) }));
  }
  const parts = listParts();
  if (parts.length) {
    console.log(`来源：已有分卷 ${parts.join(', ')}（重新分卷）`);
    return parts.map((f) => ({ name: f, path: join(DIR, f) }));
  }
  console.error('✗ 未找到 CIDE.* 或 gcide-part*.txt');
  process.exit(1);
}

function main() {
  const sources = readSources();
  const all = Buffer.concat(sources.map((s) => readFileSync(s.path))); // 按原始字节拼接，不做任何增删
  const total = all.length;
  const target = Math.min(MAX_BYTES, Math.ceil(total / PARTS));
  console.log(
    `语料合计 ${(total / 1048576).toFixed(1)} MB → 目标 ${PARTS} 卷，每卷约 ${(target / 1048576).toFixed(1)} MB（上限 ${(MAX_BYTES / 1048576).toFixed(0)} MB）`
  );

  // 在「换行字节」处切分：既保证分卷边界不截断条目，也保证拼接后与原文件逐字节一致
  const cuts = [0];
  let pos = 0;
  while (pos + target < total) {
    const idx = all.indexOf(0x0a, pos + target); // 0x0a = '\n'
    if (idx < 0) break;
    pos = idx + 1;
    cuts.push(pos);
  }
  cuts.push(total);

  // 尾卷过小则并入前一卷（合并后仍需 < 上限）
  if (cuts.length > 2) {
    const lastSize = cuts[cuts.length - 1] - cuts[cuts.length - 2];
    const prevSize = cuts[cuts.length - 2] - cuts[cuts.length - 3];
    if (lastSize < Math.min(2 * 1048576, target / 4) && prevSize + lastSize <= MAX_BYTES) {
      cuts.splice(cuts.length - 2, 1);
    }
  }

  const oldParts = listParts();
  const oldSides = readdirSync(DIR).filter((f) => /^CIDE\.[A-Z]$/.test(f));
  const names = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const name = partName(i + 1);
    writeFileSync(join(DIR, name), all.subarray(cuts[i], cuts[i + 1]));
    names.push(name);
  }
  // 清理旧文件（新分卷写完后）
  const keep = new Set(names);
  for (const f of [...oldParts, ...oldSides]) {
    if (!keep.has(f)) unlinkSync(join(DIR, f));
  }

  let maxBytes = 0;
  let sum = 0;
  names.forEach((name) => {
    const size = statSync(join(DIR, name)).size;
    maxBytes = Math.max(maxBytes, size);
    sum += size;
    console.log(`  ✓ ${name}  ${(size / 1048576).toFixed(2)} MB`);
  });
  const lossless = sum === total;
  console.log(
    `\n共 ${names.length} 卷，合计 ${(sum / 1048576).toFixed(1)} MB，最大单卷 ${(maxBytes / 1048576).toFixed(2)} MB ` +
      `${maxBytes < MAX_BYTES ? '（全部 < 上限 ✔）' : '（⚠ 超过上限）'}`
  );
  console.log(`无损校验：分卷字节合计 ${lossless ? '等于' : '不等于'}原文件（${total} 字节）${lossless ? ' ✔' : ' ✗'}`);
  console.log(`还原：cat gcide-0.51/gcide-part*.txt > CIDE.full.txt`);
}

main();

