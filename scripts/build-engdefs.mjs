#!/usr/bin/env node
// ============================================================================
// build-engdefs.mjs — 从 GCIDE（gcide-0.51/CIDE.*）提取英文释义 → data/eng-defs.json
//   运行: node scripts/build-engdefs.mjs
//
// 用途：新题型「英英选择 eng_eng」与「多义多选 multi_sense」的英文释义来源。
// 做法：只索引 data/*.json 各词库出现过的 front（避免把 79MB 词典全量搬进 PWA），
//       按 GCIDE 的 <p><ent>…<def>…</def> 结构抽取，清洗标记与实体后每词保留最多 4 条。
// 输出：{ "word": ["def1", "def2", ...] }（key 已小写归一）
// ============================================================================

import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GCIDE_DIR = resolve(ROOT, 'gcide-0.51');
const DATA_DIR = resolve(ROOT, 'data');
const OUT = join(DATA_DIR, 'eng-defs.json');

const MAX_SENSES = 4; // 每词最多保留的释义条数
const MAX_LEN = 140; // 单条释义最大长度（过长不适合做选项）
const MIN_LEN = 10; // 过短/碎片化释义丢弃
const SKIP_FILES = new Set(['eng-defs.json', 'frequency.json', 'confusables.json']);

/** 词形归一：小写、只保留字母/连字符/撇号/空格 */
function norm(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z\-' ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 收集词表：并集所有 data/*.json 的 front */
function collectWords() {
  const words = new Set();
  for (const f of readdirSync(DATA_DIR)) {
    if (!f.endsWith('.json') || SKIP_FILES.has(f)) continue;
    let payload;
    try {
      payload = JSON.parse(readFileSync(join(DATA_DIR, f), 'utf8'));
    } catch (e) {
      continue;
    }
    const list = Array.isArray(payload && payload.words) ? payload.words : [];
    for (const w of list) {
      const key = norm(w && w.front);
      if (key) words.add(key);
    }
  }
  return words;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&[a-zA-Z]+;/g, ' ');
}

/** 去标签 + 解码实体 + 折叠空白；残留的 <xxx/ 类标记一并清掉 */
function plain(raw) {
  return decodeEntities(
    String(raw)
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/<[^>\s]{0,12}\/?/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

/** 清洗一条 <def> 文本；不合格返回 null */
function cleanDef(raw) {
  let t = plain(raw);
  t = t.replace(/^(?:--+|[-–—])\s*/, '').trim(); // 前导破折号
  t = t.replace(/\s*\[[^\]]*\]\s*$/g, '').trim(); // 尾部 [ ... ]
  if (!t) return null;
  if (t.length < MIN_LEN || t.length > MAX_LEN) return null;
  if (/^(see|cf\.|syn\.|obs\.|same as|variant of)\b/i.test(t)) return null; // 交叉引用/同义提示
  if (!/[a-z]{3}/i.test(t)) return null;
  if (/[<>{}\\|]/.test(t)) return null; // 仍有残留标记
  return t;
}

/** 从一个 CIDE 文件抽取 wanted 中出现的词的释义（记录来源与顺序） */
function extractFromFile(text, wanted, acc) {
  const chunks = text.split('<p><ent>');
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i];
    const ents = [];
    // 首个词头：split 已消费掉它的 "<p><ent>"，故从 chunk 开头取到第一个 </ent>
    const head = /^([\s\S]*?)<\/ent>/.exec(chunk);
    if (head) {
      const key = norm(head[1]);
      if (key && wanted.has(key)) ents.push(key);
    }
    // 同一 <p> 可能还有其它 <ent>（拼写变体，如 make-up / makeup）
    for (const m of chunk.matchAll(/<ent>([\s\S]*?)<\/ent>/g)) {
      const key = norm(m[1]);
      if (key && wanted.has(key)) ents.push(key);
    }
    if (!ents.length) continue;

    // 逐条 <def>：读取其后 240 字符判断是否来自 WordNet（现代义项，更适合出题）
    const defs = [];
    for (const m of chunk.matchAll(/<def>([\s\S]*?)<\/def>/g)) {
      const d = cleanDef(m[1]);
      if (!d) continue;
      const tail = chunk.slice(m.index + m[0].length, m.index + m[0].length + 240);
      defs.push({ text: d, wn: /WordNet/i.test(tail) });
    }
    if (!defs.length) continue;

    for (const key of ents) {
      let list = acc.get(key);
      if (!list) {
        list = [];
        acc.set(key, list);
      }
      for (const d of defs) list.push(d);
    }
  }
}

/**
 * 每词挑若干条最优释义：
 *  1) 优先 WordNet 来源（简短、现代、常用义）；
 *  2) 不足时按文档顺序补 1913 Webster 义项；
 *  3) 文本去重（忽略大小写），最多 MAX_SENSES 条。
 */
function selectSenses(list) {
  const seen = new Set();
  const picked = [];
  const push = (text) => {
    const k = text.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    picked.push(text);
  };
  for (const d of list) if (d.wn && picked.length < MAX_SENSES) push(d.text);
  for (const d of list) {
    if (picked.length >= MAX_SENSES) break;
    if (!d.wn) push(d.text);
  }
  return picked;
}

/** GCIDE 语料文件：优先读取拆分后的分卷，其次原始 CIDE.[A-Z] */
function sourceFiles() {
  const files = readdirSync(GCIDE_DIR);
  const parts = files
    .filter((f) => /^gcide-part\d+\.txt$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  if (parts.length) return parts;
  return files.filter((f) => /^CIDE\.[A-Z]$/.test(f)).sort();
}

function main() {
  if (!statSync(GCIDE_DIR, { throwIfNoEntry: false })) {
    console.error('✗ 未找到 GCIDE 目录：' + GCIDE_DIR);
    process.exit(1);
  }
  const wanted = collectWords();
  console.log(`词表：${wanted.size} 个（来自 data/*.json 的 front 并集）`);

  const acc = new Map();
  const files = sourceFiles();
  let bytes = 0;
  for (const f of files) {
    const text = readFileSync(join(GCIDE_DIR, f), 'utf8');
    bytes += text.length;
    extractFromFile(text, wanted, acc);
  }
  console.log(`已扫描 ${files.length} 个 GCIDE 分卷（${(bytes / 1e6).toFixed(1)} MB 文本）`);

  const out = {};
  let senses = 0;
  let withMulti = 0;
  for (const [word, list] of [...acc.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const picked = selectSenses(list);
    if (!picked.length) continue;
    out[word] = picked;
    senses += picked.length;
    if (picked.length >= 2) withMulti += 1;
  }

  writeFileSync(OUT, JSON.stringify(out), 'utf8');
  const size = statSync(OUT).size;
  console.log(`✓ 覆盖词：${Object.keys(out).length} / ${wanted.size}（${Math.round((Object.keys(out).length / wanted.size) * 100)}%）`);
  console.log(`✓ 释义总数：${senses}（均值 ${(senses / Math.max(1, Object.keys(out).length)).toFixed(2)} 条/词）`);
  console.log(`✓ 可做「多义多选」的词（≥2 条释义）：${withMulti}`);
  console.log(`✓ 输出：${OUT}（${(size / 1e6).toFixed(2)} MB）`);
}

main();
