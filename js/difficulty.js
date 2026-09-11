// ============================================================================
// difficulty.js — 卡片难度判定（纯逻辑，无 DOM / 无存储）
//
// 判定维度（按需求）：
//   1. 基础特征：词频（高频优先）、词长、音节数、熟悉度
//   2. 语种特性：英文看「不规则拼写」；日语看「汉字音读/训读」；
//                古文看「生僻字占比」
//   3. 外部数据：直接复用词典自带的频率数据（如高频/低频词表）
//
// 输出统一为 0~100 的难度分（越大越难），供 arrange.js 的关卡编排使用。
// 频率表通过 loadFrequency()/setFrequency() 注入（默认空表，缺失时按中低频处理）。
// ============================================================================

/** 词频表最大序号（超出即视为极低频） */
export const FREQ_MAX = 20000;
/** 词频表未知词的默认序号 */
export const FREQ_UNKNOWN = FREQ_MAX + 1;

/* ------------------------------ 频率数据 ------------------------------ */

let FREQ = null; // Map<string, number>  word(lowercase) -> rank（1 = 最高频）

/** 注入频率表（word -> rank） */
export function setFrequency(map) {
  if (!map) {
    FREQ = null;
    return;
  }
  FREQ = map instanceof Map ? map : new Map(Object.entries(map));
}

/** 从 data/frequency.json 加载频率表（失败时静默降级为空表） */
export async function loadFrequency(url = './data/frequency.json') {
  try {
    const resp = await fetch(url, { cache: 'force-cache' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    setFrequency(data);
    return FREQ.size;
  } catch (e) {
    setFrequency(null);
    return 0;
  }
}

export function frequencyLoaded() {
  return !!FREQ && FREQ.size > 0;
}

/** 归一化词形（小写、去首尾空白；英文取首个词） */
export function normalizeWord(word) {
  return String(word ?? '')
    .trim()
    .toLowerCase()
    .split(/\s+/)[0];
}

/** 词频序号（1 = 最高频；未知 → FREQ_UNKNOWN） */
export function freqRank(word) {
  if (!FREQ) return FREQ_UNKNOWN;
  const k = normalizeWord(word);
  if (!k) return FREQ_UNKNOWN;
  const r = FREQ.get(k);
  return Number.isFinite(r) ? r : FREQ_UNKNOWN;
}

/* ------------------------------ 基础特征 ------------------------------ */

export function wordLength(word) {
  const w = String(word ?? '').trim();
  // 中文按字数、英文按字母数
  return [...w].length;
}

/** 英文音节数估算（元音组计数 + 词尾 e 修正），非英文按字符数近似 */
export function estimateSyllables(word) {
  const w = String(word ?? '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (!w) {
    const t = String(word ?? '').trim();
    return t ? [...t].length : 0;
  }
  const groups = w.match(/[aeiouy]+/g);
  let n = groups ? groups.length : 1;
  if (w.endsWith('e') && !w.endsWith('le') && n > 1) n -= 1; // make / take
  return Math.max(1, n);
}

/** 熟悉度 0~1（1 = 非常熟悉）：来自间隔重复状态 + 困难/错题记录 */
export function familiarity(card, { hardCount = 0, wrongCount = 0 } = {}) {
  if (!card || card.lastReview == null) return 0;
  const reps = Math.max(0, Number(card.repetitions) || 0);
  const ef = Number.isFinite(card.easeFactor) ? card.easeFactor : 2.5;
  const repScore = Math.min(1, reps / 6); // 连续答对 6 次视为熟记
  const efScore = Math.min(1, Math.max(0, (ef - 1.3) / (3.0 - 1.3)));
  const penalty = Math.min(0.6, hardCount * 0.2 + wrongCount * 0.1);
  return Math.max(0, Math.min(1, repScore * 0.6 + efScore * 0.4 - penalty));
}

/* ------------------------------ 语种特性 ------------------------------ */

/** 常见不发音/不规则字母组合（英文拼写难度启发式） */
const IRREGULAR_PATTERNS = [
  /ough/, /augh/, /eigh/, /igh/, /tion$/, /sion$/, /cious$/, /tious$/,
  /ph/, /rh/, /ps/, /pn/, /kn/, /wr/, /gn/, /mb$/, /mn$/, /bt$/, /ckle$/, /ique$/
];

/**
 * 英文不规则拼写分 0~1：不规则字母组合密度 + 字母/音节比偏高（拼读不一致）。
 */
export function englishSpellingScore(word) {
  const w = String(word ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  let hits = 0;
  for (const re of IRREGULAR_PATTERNS) if (re.test(w)) hits += 1;
  const patternScore = Math.min(1, hits / 3);
  const syl = estimateSyllables(w);
  const ratio = syl ? w.length / syl : w.length;
  const ratioScore = Math.min(1, Math.max(0, (ratio - 2.4) / 2.6)); // 3.0+ 字母/音节 偏难
  const silentScore = Math.min(1, (/([^aeiouy]*[aeiouy]+[^aeiouy]*e)$/.test(w) ? 0.25 : 0) + hits * 0.05);
  return Math.min(1, patternScore * 0.6 + ratioScore * 0.3 + silentScore * 0.1);
}

/**
 * 汉字「生僻字占比」0~1（古文维度）。
 * 传入常用字集（字符串/Set）时可精确计算；缺省退化为「非常用 Unicode 区段」启发式。
 */
export function rareCharRatio(text, commonSet = null) {
  const chars = [...String(text ?? '')].filter((c) => /[\u3400-\u9fff\uf900-\ufaff]/.test(c));
  if (!chars.length) return 0;
  const common = commonSet
    ? commonSet instanceof Set
      ? commonSet
      : new Set([...String(commonSet)])
    : null;
  if (common) {
    const rare = chars.filter((c) => !common.has(c)).length;
    return rare / chars.length;
  }
  // 启发式：CJK 扩展区（生僻）视为生僻字
  const rare = chars.filter((c) => /[\u3400-\u4dbf\uf900-\ufaff]/.test(c)).length;
  return rare / chars.length;
}

/**
 * 日语「汉字读音（音读/训读）」难度 0~1。
 * 需要汉字→读音词典；未提供时按「汉字占比」启发式（汉字越多越难）。
 */
export function japaneseKanjiScore(word, kanjiReadings = null) {
  const text = String(word ?? '');
  const chars = [...text];
  const kanji = chars.filter((c) => /[\u3400-\u9fff]/.test(c));
  if (!chars.length) return 0;
  const ratio = kanji.length / chars.length;
  if (kanjiReadings && kanjiReadings.size) {
    let known = 0;
    for (const c of kanji) if (kanjiReadings.has(c)) known += 1;
    const unknownRatio = kanji.length ? 1 - known / kanji.length : 0;
    return Math.min(1, ratio * 0.6 + unknownRatio * 0.4);
  }
  return Math.min(1, ratio);
}

/**
 * 语种特性分 0~1。
 * @param {string} lang 'en' | 'ja' | 'zh-classic'（其它按通用处理）
 */
export function languageScore(word, lang = 'en', opts = {}) {
  if (lang === 'ja') return japaneseKanjiScore(word, opts.kanjiReadings);
  if (lang === 'zh-classic' || lang === 'zh') return rareCharRatio(word, opts.commonChars);
  return englishSpellingScore(word);
}

/* ------------------------------ 综合难度 ------------------------------ */

/** 各维度权重（合计 1.0） */
export const WEIGHTS = {
  freq: 0.34,
  length: 0.16,
  syllable: 0.14,
  language: 0.22,
  unknown: 0.14
};

/** 词频分 0~1（越低频越高） */
export function frequencyScore(word) {
  const rank = freqRank(word);
  const denom = Math.log10(FREQ_MAX + 1);
  const s = Math.log10(Math.min(rank, FREQ_UNKNOWN) + 1) / denom;
  return Math.max(0, Math.min(1, s));
}

/**
 * 单卡难度 0~100。
 * @param {object} card
 * @param {object} ctx  { lang, hardCount, wrongCount, weights, kanjiReadings, commonChars }
 */
export function cardDifficulty(card, ctx = {}) {
  const word = card?.front ?? card?.word ?? '';
  const w = ctx.weights || WEIGHTS;
  let score =
    frequencyScore(word) * w.freq +
    Math.min(1, Math.max(0, (wordLength(word) - 3) / 12)) * w.length +
    Math.min(1, Math.max(0, (estimateSyllables(word) - 1) / 5)) * w.syllable +
    languageScore(word, ctx.lang || 'en', ctx) * w.language;

  if (freqRank(word) >= FREQ_UNKNOWN) score += w.unknown; // 词表外 → 偏难

  // 熟悉度：越熟悉越简单（最多降低 35%）
  score *= 1 - 0.35 * familiarity(card, ctx);

  return Math.round(Math.max(0, Math.min(1, score)) * 100);
}

/** 难度缓存键（挂在卡片对象上，避免重复计算） */
const SCORE_KEY = '__difficulty';

/** 批量计算难度（带缓存；缓存键不可枚举，避免被 JSON 序列化进存储） */
export function scoreCards(cards, ctx = {}) {
  const lang = ctx.lang || 'en';
  const hard = ctx.hardCount || 0;
  const wrong = ctx.wrongCount || 0;
  return (cards || []).map((c) => {
    const cache = c && typeof c === 'object' ? c[SCORE_KEY] : null;
    if (cache && cache.lang === lang && cache.hard === hard && cache.wrong === wrong) return cache.value;
    const value = cardDifficulty(c, ctx);
    if (c && typeof c === 'object') {
      Object.defineProperty(c, SCORE_KEY, {
        value: { lang, hard, wrong, value },
        enumerable: false,
        configurable: true,
        writable: true
      });
    }
    return value;
  });
}

export function clearScoreCache(cards) {
  for (const c of cards || []) {
    if (c && typeof c === 'object') delete c[SCORE_KEY];
  }
}

/**
 * 分页（关卡编排与展示共用的难度分档）：
 * 把已按难度升序排好的卡片切成 K 段，返回每段的下标范围。
 */
export function difficultyBands(sortedCount, k) {
  const out = [];
  if (sortedCount <= 0 || k <= 0) return out;
  const base = Math.floor(sortedCount / k);
  const rem = sortedCount % k;
  let start = 0;
  for (let i = 0; i < k; i++) {
    const size = base + (i < rem ? 1 : 0);
    out.push({ start, end: start + size });
    start += size;
  }
  return out;
}

