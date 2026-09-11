#!/usr/bin/env node
// ============================================================================
// gen-examples.mjs — 为词库 JSON 抓取真实英文例句
//   数据源: https://freedictionaryapi.com （Wiktionary 派生，CC BY-SA 4.0，无需 Key）
//   英文: 优先选取「像完整句子且包含目标词」的例句（无 examples 时回退 quotes）
//   中文: 用该词原有释义兜底（API 不提供中文）
//   用法:
//     node scripts/gen-examples.mjs --data data/words.json --sample 8     # 抽样 8 词试跑（不写回数据）
//     node scripts/gen-examples.mjs --data data/words.json                # 全量生成并写回
//     node scripts/gen-examples.mjs --data data/words.json --only-empty   # 只补齐 example 为空的词
//   参数: --data <词库 JSON 文件>（必填） / --sample N / --only-empty / --fix-bad / --clean
//   特性: 并发 + 指数退避重试 + 断点续跑（scripts/.examples-cache.json）
// ============================================================================

import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const dataArg = argv.find((a) => a.startsWith('--data=')) || (argv.includes('--data') ? argv[argv.indexOf('--data') + 1] : '');
/** 目标词库文件（--data 指定，相对当前工作目录解析） */
const DATA = dataArg ? resolve(process.cwd(), dataArg) : '';
const CACHE = resolve(ROOT, 'scripts/.examples-cache.json');
const API = 'https://freedictionaryapi.com/api/v1/entries/en/';

const SAMPLE = argv.includes('--sample') ? Number(argv[argv.indexOf('--sample') + 1]) || 5 : 0;
const ONLY_EMPTY = argv.includes('--only-empty');
const CONCURRENCY = Number((argv.find((a) => a.startsWith('--concurrency=')) || '').split('=')[1]) || 6;
const DELAY = 120; // 每个 worker 请求间隔（ms）
const MAX_RETRY = 6;
const CLEAN = argv.includes('--clean'); // 全部完成后清理缓存需要显式指定

if (!DATA) {
  console.error('缺少 --data 参数（目标词库 JSON 文件），例如：--data data/words.json');
  process.exit(1);
}
if (!existsSync(DATA)) {
  console.error(`词库文件不存在：${DATA}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ 例句解析 ------------------------------ */

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 常见屈折变化（与 test.js blankWord 保持一致） */
function containsWord(sentence, word) {
  const s = String(sentence).toLowerCase();
  const base = String(word).trim().toLowerCase();
  if (!base) return false;
  if (base.includes(' ') || base.includes('-')) return s.includes(base);
  const forms = [base, base + 's', base + 'es', base + 'ed', base + 'd', base + 'ing'];
  if (/[^aeiou]y$/.test(base)) forms.push(base.slice(0, -1) + 'ies');
  return forms.some((f) => new RegExp('\\b' + escapeRegExp(f) + '\\b').test(s));
}

/** freedictionaryapi.com 结构：entries[].senses[].examples[] / quotes[] / subsenses[] */
function extractCandidates(payload) {
  const clean = (s) => String(s).replace(/\s+/g, ' ').trim();
  const direct = [];
  const quotes = [];
  for (const entry of (payload && payload.entries) || []) {
    for (const s of entry.senses || []) {
      for (const x of s.examples || []) direct.push(clean(x));
      for (const sub of s.subsenses || []) for (const x of sub.examples || []) direct.push(clean(x));
      for (const q of s.quotes || []) if (q && q.text) quotes.push(clean(q.text));
    }
  }
  return { direct, quotes };
}

/** 明显不适合当例句的：诗歌分行、古英语连字 */
const UNUSABLE = /[ſﬀﬁﬂ]| \/ /;

/** 占位/元信息文本（非例句），必须排除而非兜底使用 */
const PLACEHOLDER = /For quotations using this term|see Citations|^See also\b|^Citations:/i;

/** 形如「1580, ... p. 907, ...」的文献引用，而非例句 */
function isCitationLike(text) {
  if (/→|OCLC|quoted by|edition|\(ed\.\)/.test(text)) return true;
  if (/^(?:c\.\s*)?(?:1[5-9]\d\d|20\d\d)[,，]/.test(text)) return true; // 以年份开头
  if (/\b(?:vol|no|pp?)\.\s*\d/i.test(text) && /\b(?:1[5-9]\d\d|20\d\d)\b/.test(text)) return true;
  return false;
}

/** 是否「像完整句子」：首字母大写（可含引导引号）且以句末标点结束 */
function isCompleteSentence(text) {
  return /^["'(]?[A-Z]/.test(text) && /[.!?"']$/.test(text);
}

/** 判断已选例句是否“质量欠佳”，用于 --fix-bad 定向重抓 */
function isBadExample(text, word) {
  if (!text) return true;
  if (/\n/.test(text) || text.includes(' / ') || /[ſﬀﬁﬂ]/.test(text)) return true;
  if (PLACEHOLDER.test(text)) return true;
  if (isCitationLike(text)) return true;
  if (text.length > 180) return true;
  if (!isCompleteSentence(text)) return true; // 片段而非完整句
  return false;
}

/**
 * 从候选里挑一条：优先「完整句子」，其次「包含目标词」、长度适中且较短。
 * direct = 词典直出例句；quotes = 文献引文（同分时让位给 direct）。
 */
function pickExample(direct, quotes, word) {
  const norm = (arr) => [...new Set((arr || []).map((s) => String(s).replace(/\s+/g, ' ').trim()).filter(Boolean))];
  const bad = (t) => UNUSABLE.test(t) || PLACEHOLDER.test(t) || isCitationLike(t) || t.length > 240;
  const pool = [
    ...norm(direct).filter((t) => !bad(t)).map((text) => ({ text, fromQuote: false })),
    ...norm(quotes).filter((t) => !bad(t)).map((text) => ({ text, fromQuote: true }))
  ];
  if (!pool.length) {
    // 全被过滤：仍不使用占位/诗歌文本，宁可返回 null（该词无例句）
    const fb = [...norm(direct), ...norm(quotes)].filter((t) => !PLACEHOLDER.test(t) && !UNUSABLE.test(t));
    return fb.length ? fb[0] : null;
  }
  const scored = pool.map(({ text, fromQuote }) => {
    let score = 0;
    if (isCompleteSentence(text)) score += 5;
    if (containsWord(text, word)) score += 3;
    if (text.length >= 20 && text.length <= 120) score += 1;
    if (text.length > 180) score -= 2;
    if (fromQuote) score -= 1;
    return { text, score, len: text.length };
  });
  scored.sort((a, b) => b.score - a.score || a.len - b.len);
  return scored[0].text;
}

/** 取该词首段中文释义（去掉 "v."/"n." 等词性前缀） */
function primaryMeaning(back) {
  const first = String(back || '').split(' / ')[0].trim();
  const stripped = first.replace(/^(?:[a-z]+\.\s*)+/i, '').trim();
  return stripped || first;
}

/* ------------------------------ 网络抓取 ------------------------------ */

/** 查询变体：原词 → 首字母大写（月份/星期/专有名词）→ 去尾部标点 */
function variantsOf(word) {
  const base = String(word).trim();
  const out = [base];
  const cap = base.charAt(0).toUpperCase() + base.slice(1);
  if (cap !== base) out.push(cap);
  const noPunct = base.replace(/[.]+$/, '').trim();
  if (noPunct && noPunct !== base) {
    out.push(noPunct, noPunct.charAt(0).toUpperCase() + noPunct.slice(1));
  }
  return [...new Set(out)];
}

/** 对单个查询词抓取（含重试） */
async function fetchOne(queryWord, originalWord) {
  const url = API + encodeURIComponent(queryWord);
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20000);
    try {
      const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'mycard-example-gen/1.0' } });
      clearTimeout(timer);
      if (res.status === 404) return { status: 'notfound', example: null };
      if (res.status === 429) {
        // 限流：优先遵循 Retry-After，否则指数退避（上限 30s）
        const ra = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra, 30) * 1000 : Math.min(30000, 2000 * 2 ** (attempt - 1));
        throw Object.assign(new Error('HTTP 429'), { retryAfter: wait });
      }
      if (res.status >= 500) throw new Error('HTTP ' + res.status);
      if (!res.ok) return { status: 'error', example: null, error: 'HTTP ' + res.status };
      const data = await res.json();
      const { direct, quotes } = extractCandidates(data);
      const example = pickExample(direct, quotes, originalWord);
      return { status: 'ok', example };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < MAX_RETRY) await sleep(e.retryAfter || 400 * attempt * attempt);
    }
  }
  return { status: 'error', example: null, error: String((lastErr && lastErr.message) || lastErr) };
}

/** 按查询变体依次尝试，直到拿到例句（仅在前面变体无例句时才追加请求） */
async function fetchWord(word) {
  let last = { status: 'ok', example: null };
  for (const q of variantsOf(word)) {
    const r = await fetchOne(q, word);
    if (r.status === 'error') return r; // 网络/限流失败：交给上层重试
    if (r.status === 'ok' && r.example) return r;
    last = r;
  }
  return last;
}

/** 简单并发池 */
async function runPool(items, worker, concurrency, delayMs) {
  let cursor = 0;
  let done = 0;
  const total = items.length;
  async function runner() {
    while (cursor < total) {
      const i = cursor++;
      await worker(items[i], i);
      done++;
      if (done % 25 === 0 || done === total) process.stdout.write(`\r  进度 ${done}/${total}   `);
      if (delayMs) await sleep(delayMs);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, runner));
  process.stdout.write('\n');
}

/* ------------------------------ 主流程 ------------------------------ */

const raw = JSON.parse(readFileSync(DATA, 'utf8'));
const words = raw.words || [];
const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};

const targets = ONLY_EMPTY ? words.filter((w) => !w.example) : words;
const limited = SAMPLE ? targets.slice(0, SAMPLE) : targets;
const FIX_BAD = argv.includes('--fix-bad'); // 重抓已缓存但质量欠佳的例句
const todo = limited.filter((w) => {
  const c = cache[w.front];
  if (!c || c.status === 'error') return true; // 未抓取或瞬时失败 → 抓取
  if (FIX_BAD && c.status === 'ok' && isBadExample(c.example, w.front)) return true; // 质量欠佳 → 重抓
  return false;
});

console.log(
  `词库总数: ${words.length} | 本次目标: ${limited.length} | 待抓取: ${todo.length} | 并发: ${CONCURRENCY}${SAMPLE ? '（抽样模式，不写回数据）' : ''}`
);

let sinceSave = 0;
await runPool(
  todo,
  async (w) => {
    cache[w.front] = await fetchWord(w.front);
    if (++sinceSave >= 25) {
      sinceSave = 0;
      writeFileSync(CACHE, JSON.stringify(cache));
    }
  },
  CONCURRENCY,
  DELAY
);
writeFileSync(CACHE, JSON.stringify(cache));

/* ------------------------------ 回填与统计 ------------------------------ */

let okCount = 0;
let fbPhrase = 0;
let fbEmpty = 0;

for (const w of words) {
  const c = cache[w.front];
  const meaning = primaryMeaning(w.back);
  if (c && c.status === 'ok' && c.example) {
    w.example = c.example;
    w.exampleZh = meaning; // 中文用原释义兜底
    okCount++;
  } else if (w.example && !PLACEHOLDER.test(w.example)) {
    fbPhrase++; // 保留原搭配短语与其中文
  } else {
    // 词典无可用例句，且原值是占位/不可用文本 → 清空
    w.example = '';
    w.exampleZh = '';
    fbEmpty++;
  }
}

console.log(`\n真实例句: ${okCount} | 回退（保留搭配短语）: ${fbPhrase} | 仍无例句: ${fbEmpty}`);
const stillError = words.filter((w) => cache[w.front] && cache[w.front].status === 'error').length;
const notFound = words.filter((w) => cache[w.front] && cache[w.front].status === 'notfound').length;
console.log(`缓存状态: 待重试(error)=${stillError} | 词典无此词(notfound)=${notFound} | 已缓存=${Object.keys(cache).length}/${words.length}`);
for (const w of limited.filter((x) => x.example).slice(0, SAMPLE || 3)) {
  console.log(`  · ${w.front} → ${w.example} ／ ${w.exampleZh}`);
}

if (SAMPLE) {
  console.log(`\n抽样模式：未写回 ${DATA}（缓存已保存，可继续全量运行）`);
} else {
  mkdirSync(dirname(DATA), { recursive: true });
  writeFileSync(DATA, JSON.stringify(raw, null, 2) + '\n');
  if (CLEAN && existsSync(CACHE)) unlinkSync(CACHE);
  console.log(
    stillError > 0
      ? `\n已写回 ${DATA}（缓存保留，可再次运行重试 ${stillError} 个限流失败项；全部完成后用 --clean 清理缓存）`
      : `\n已写回 ${DATA}（缓存保留，如需清理请加 --clean）`
  );
}
