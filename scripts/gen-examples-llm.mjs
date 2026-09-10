#!/usr/bin/env node
// ============================================================================
// gen-examples-llm.mjs — 用大模型（DeepSeek / OpenAI 兼容接口）为考研词库生成
//   自然英文例句 + 真正的整句中文翻译，写入 data/kaoyan.json 的 example / exampleZh。
//   用法:
//     LLM_API_KEY=sk-xxx node scripts/gen-examples-llm.mjs --sample 6        # 抽样试跑
//     LLM_API_KEY=sk-xxx node scripts/gen-examples-llm.mjs                   # 全量生成
//     LLM_API_KEY=sk-xxx node scripts/gen-examples-llm.mjs --only-missing    # 仅补空缺/失败项
//   环境变量: LLM_API_KEY(必填) / LLM_BASE_URL(默认 https://api.deepseek.com) / LLM_MODEL(默认 deepseek-chat)
//   特性: 批量请求 + 并发 + 失败重试 + 断点续跑(scripts/.llm-cache.json)
//   ⚠️ 不要把 API Key 写入任何文件；仅通过环境变量传入。
// ============================================================================

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = resolve(ROOT, 'data/kaoyan.json');
const CACHE = resolve(ROOT, 'scripts/.llm-cache.json');

const API_KEY = process.env.LLM_API_KEY || '';
const BASE_URL = (process.env.LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const MODEL = process.env.LLM_MODEL || 'deepseek-chat';

const argv = process.argv.slice(2);
const SAMPLE = argv.includes('--sample') ? Number(argv[argv.indexOf('--sample') + 1]) || 5 : 0;
const ONLY_MISSING = argv.includes('--only-missing');
const CLEAN = argv.includes('--clean');
const BATCH = Number((argv.find((a) => a.startsWith('--batch=')) || '').split('=')[1]) || 20;
const CONCURRENCY = Number((argv.find((a) => a.startsWith('--concurrency=')) || '').split('=')[1]) || 4;
const MAX_RETRY = 3;

if (!API_KEY) {
  console.error('缺少 LLM_API_KEY 环境变量（例如：LLM_API_KEY=sk-xxx node scripts/gen-examples-llm.mjs）');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 取该词首段中文释义（去掉 "v."/"n." 等词性前缀） */
function primaryMeaning(back) {
  const first = String(back || '').split(' / ')[0].trim();
  const stripped = first.replace(/^(?:[a-z]+\.\s*)+/i, '').trim();
  return stripped || first;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 例句是否包含目标词（容错常见屈折变化；仅用于统计与宽松校验） */
function containsWord(sentence, word) {
  const s = String(sentence).toLowerCase();
  const base = String(word).trim().toLowerCase();
  if (!base || !s) return false;
  if (base.includes(' ') || base.includes('-')) return s.includes(base);
  const forms = [base, base + 's', base + 'es', base + 'ed', base + 'd', base + 'ing'];
  if (/[^aeiou]y$/.test(base)) {
    const y = base.slice(0, -1);
    forms.push(y + 'ies', y + 'ied', y + 'ying');
  }
  if (/e$/.test(base)) forms.push(base.slice(0, -1) + 'ing');
  if (/[^aeiouwxy][aeiou][^aeiouwxy]$/.test(base)) {
    const d = base + base.slice(-1);
    forms.push(d + 'ed', d + 'ing');
  }
  if (forms.some((f) => new RegExp('\\b' + escapeRegExp(f) + '\\b').test(s))) return true;
  // 词干兜底：去掉词尾 y/e 后的前 ≥4 字符作为子串，覆盖派生/不规则变化
  const stem = base.replace(/[ye]$/, '');
  return stem.length >= 4 && s.includes(stem);
}

/* ------------------------------ Prompt 与解析 ------------------------------ */

function buildPrompt(words) {
  const list = words
    .map((w, i) => `${i + 1}. ${w.front}（释义：${primaryMeaning(w.back)}）`)
    .join('\n');
  return `你是英语学习词典的例句编辑。请为下列每个考研英语单词各写 1 条自然、地道、简短的英文例句（8-20 个单词），并给出与整句对应的准确中文翻译。

要求：
1) 例句必须实际包含该单词（可用常见屈折变化，如复数、过去式、-ing）；
2) 贴近常见用法与真实语境，避免生僻义、专有名词堆砌和不雅内容；
3) exampleZh 必须是整句翻译，不是只翻译单词；
4) 只输出 JSON 数组，不要解释、不要 Markdown 代码块，格式：
[{"front":"单词","example":"英文例句","exampleZh":"中文翻译"}]

单词列表（共 ${words.length} 个）：
${list}`;
}

/** 从模型回复里提取 JSON 数组 */
function parseItems(content) {
  let text = String(content || '').trim();
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

async function callLLM(prompt) {
  const url = BASE_URL + '/chat/completions';
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: '你是专业的英语学习词典例句编辑，只输出严格合法的 JSON。' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.6,
    max_tokens: 4000,
    stream: false
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + API_KEY },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error('HTTP ' + res.status + ' ' + txt.slice(0, 160));
  }
  const data = await res.json();
  return parseItems(data?.choices?.[0]?.message?.content);
}

/** 处理一批单词（含重试），返回 { front: {example, exampleZh} } */
async function processBatch(batch) {
  const want = new Set(batch.map((w) => w.front));
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const items = await callLLM(buildPrompt(batch));
      const out = {};
      for (const it of items) {
        const front = String(it && it.front ? it.front : '').trim();
        const example = String(it && it.example ? it.example : '').trim();
        const exampleZh = String(it && it.exampleZh ? it.exampleZh : '').trim();
        if (!want.has(front) || !example || !exampleZh) continue;
        out[front] = { example, exampleZh };
      }
      if (Object.keys(out).length) return out;
      lastErr = new Error('返回中未解析出有效条目');
    } catch (e) {
      lastErr = e;
    }
    if (attempt < MAX_RETRY) await sleep(1500 * attempt);
  }
  throw lastErr || new Error('batch failed');
}

/** 简单并发池 */
async function runPool(items, worker, concurrency) {
  let cursor = 0;
  let done = 0;
  const total = items.length;
  async function runner() {
    while (cursor < total) {
      const i = cursor++;
      await worker(items[i], i);
      done++;
      process.stdout.write(`\r  进度 ${done}/${total} 批   `);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, runner));
  process.stdout.write('\n');
}

/* ------------------------------ 主流程 ------------------------------ */

const raw = JSON.parse(readFileSync(DATA, 'utf8'));
const words = raw.words || [];
const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};

let targets = words;
if (ONLY_MISSING) targets = words.filter((w) => !(cache[w.front] && cache[w.front].example));
if (SAMPLE) targets = targets.slice(0, SAMPLE);

// 已缓存但缺少例句/翻译的 → 需重做（不因「未检测到目标词」而丢弃）
const pending = targets.filter((w) => {
  const c = cache[w.front];
  return !c || !c.example || !c.exampleZh;
});

console.log(
  `词库 ${words.length} 词 | 本次目标 ${targets.length} | 需生成 ${pending.length} | 批大小 ${BATCH} | 并发 ${CONCURRENCY} | 模型 ${MODEL}`
);

const batches = [];
for (let i = 0; i < pending.length; i += BATCH) batches.push(pending.slice(i, i + BATCH));

let saved = 0;
await runPool(
  batches,
  async (batch) => {
    try {
      const out = await processBatch(batch);
      for (const [k, v] of Object.entries(out)) cache[k] = v;
    } catch (e) {
      console.error(`\n  ! 批次失败（${batch.length} 词）：${e.message}`);
    }
    if (++saved % 5 === 0) writeFileSync(CACHE, JSON.stringify(cache));
  },
  CONCURRENCY
);
writeFileSync(CACHE, JSON.stringify(cache));

/* ------------------------------ 回填与统计 ------------------------------ */

let ok = 0;
let noWord = 0;
const badWords = [];
for (const w of words) {
  const c = cache[w.front];
  if (c && c.example && c.exampleZh) {
    w.example = c.example;
    w.exampleZh = c.exampleZh;
    ok++;
    if (!containsWord(c.example, w.front)) noWord++;
  } else {
    badWords.push(w.front);
  }
}

console.log(`\n已写入 LLM 例句: ${ok} | 其中例句未检测到目标词: ${noWord} | 未生成: ${badWords.length}`);
if (badWords.length) console.log('未生成：', badWords.slice(0, 25).join(' '), badWords.length > 25 ? '…' : '');

if (SAMPLE) {
  console.log('\n抽样结果预览:');
  for (const w of targets) {
    const c = cache[w.front];
    console.log(`  ${w.front} → ${c && c.example ? c.example : '(无)'} ／ ${c && c.exampleZh ? c.exampleZh : ''}`);
  }
  console.log('\n抽样模式：未写回 data/kaoyan.json（缓存已保存）');
} else {
  writeFileSync(DATA, JSON.stringify(raw, null, 2) + '\n');
  if (CLEAN && existsSync(CACHE)) unlinkSync(CACHE);
  console.log('\n已写回 data/kaoyan.json' + (CLEAN ? '，并清理缓存' : '（缓存保留，可再次运行重试失败项；完成后加 --clean）'));
}
