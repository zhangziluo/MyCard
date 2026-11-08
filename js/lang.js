// ============================================================================
// lang.js — 语种检测 / 卡组学习模式判定（纯函数，无 DOM、无存储）
//
// 用途：让测试题型按「卡组正反面语种关系」自适应，而不是默认「英文单词 + 中文释义」：
//   · 跨语种（cross）：front 与 back 语种不同（如 英-中 / 日-中 / 德-中）→ 保留全部 5 种题型；
//   · 同语种（same） ：front 与 back 语种相同（如 中文-中文）→ 去掉「句子选词」，
//                      「听音辨意」改为「听背面 → 填写正面」的听写填空。
//
// 检测口径基于 Unicode 字符区间（无需词典）：
//   假名 → ja；谚文 → ko；汉字 → zh（纯汉字默认中文，日语通常含假名）；希腊字母 → el；
//   西里尔字母 → ru；ä/ö/ü/ß → de；ñ/¿/¡ → es；其余带重音的拉丁字母 → fr；纯拉丁 → en。
//
// 已知限制：拉丁字母语种（英/德/法/西…）在**不带重音字符**时无法可靠区分，会统一归为 en。
// 这不会影响「同语种 vs 跨语种」的判定（如 德-中、法-中仍是跨语种），
// 但「法-英」「德-英」这类双拉丁语种卡组可能被判成同语种。中文-中文是主要同语种场景。
// ============================================================================

/** 各语种使用的字符区间 */
const SCRIPTS = {
  kana: /[\u3040-\u30ff\u31f0-\u31ff]/, // 平假名 / 片假名
  hangul: /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/, // 谚文
  han: /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/, // 汉字
  greek: /[\u0370-\u03ff\u1f00-\u1fff]/,
  cyrillic: /[\u0400-\u04ff\u0500-\u052f]/,
  de: /[äöüß]/i,
  es: /[ñ¿¡]/i,
  fr: /[àâæçéèêëîïôœùûÿ]/i
};

/** 非拉丁字符（用于判断答案是否需要英文式的屈折/大小写容错） */
const NON_LATIN = /[\u3040-\u30ff\u31f0-\u31ff\u1100-\u11ff\u3130-\u318f\uac00-\ud7af\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u0370-\u03ff\u1f00-\u1fff\u0400-\u04ff\u0500-\u052f]/;

const LATIN_LETTER = /[A-Za-z\u00c0-\u024f]/;

/** 语种 → BCP-47 语音标签（TTS 用） */
const LANG_TAGS = {
  en: 'en-US',
  zh: 'zh-CN',
  ja: 'ja-JP',
  ko: 'ko-KR',
  el: 'el-GR',
  ru: 'ru-RU',
  de: 'de-DE',
  fr: 'fr-FR',
  es: 'es-ES',
  it: 'it-IT',
  pt: 'pt-PT'
};

/**
 * 基于字符范围判断文本语种。
 * @param {string} text
 * @param {{ hanAs?: 'zh'|'ja' }} [opts] 纯汉字（无假名）时归为哪种语种：
 *        默认 'zh'（中日区分靠假名：含假名 → ja，纯汉字 → zh）；
 *        查词路由等「汉字一律走日语词典」的场景可传 'ja'。
 * @returns {'zh'|'ja'|'ko'|'el'|'ru'|'de'|'es'|'fr'|'en'}
 */
export function detectLang(text, { hanAs = 'zh' } = {}) {
  const s = String(text == null ? '' : text);
  if (!s) return 'en';
  if (SCRIPTS.kana.test(s)) return 'ja';
  if (SCRIPTS.hangul.test(s)) return 'ko';
  if (SCRIPTS.han.test(s)) return hanAs === 'ja' ? 'ja' : 'zh';
  if (SCRIPTS.greek.test(s)) return 'el';
  if (SCRIPTS.cyrillic.test(s)) return 'ru';
  if (SCRIPTS.de.test(s)) return 'de';
  if (SCRIPTS.es.test(s)) return 'es';
  if (SCRIPTS.fr.test(s)) return 'fr';
  return 'en';
}

/** 文本是否只使用拉丁字母（决定是否启用英文式单复数 / 屈折容错与字母键盘） */
export function isLatin(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return false;
  if (NON_LATIN.test(s)) return false;
  return LATIN_LETTER.test(s);
}

/**
 * 取 TTS 语音标签。既可传语种代码（'zh' / 'ja'…），也可直接传文本（自动检测）。
 */
export function langTag(langOrText) {
  const key = String(langOrText == null ? '' : langOrText).trim();
  if (LANG_TAGS[key]) return LANG_TAGS[key];
  return LANG_TAGS[detectLang(key)] || 'en-US';
}

/**
 * 卡组级语种投票：一段文本列表里出现最多的语种。
 * 含假名的卡组把「纯汉字」也并入日语（避免「学生」这类纯汉字日语词被记为中文）。
 * @param {string[]} texts
 */
export function deckLang(texts) {
  const list = Array.isArray(texts) ? texts : [];
  const counts = new Map();
  let sawKana = false;
  for (const raw of list) {
    const s = String(raw == null ? '' : raw);
    if (!s.trim()) continue;
    if (SCRIPTS.kana.test(s)) sawKana = true;
    const l = detectLang(s);
    counts.set(l, (counts.get(l) || 0) + 1);
  }
  if (sawKana && counts.has('zh')) {
    counts.set('ja', (counts.get('ja') || 0) + counts.get('zh'));
    counts.delete('zh');
  }
  let best = 'en';
  let max = 0;
  for (const [lang, n] of counts) {
    if (n > max) {
      max = n;
      best = lang;
    }
  }
  return best;
}

/**
 * 卡组学习模式：
 *   'same'  —— 正面与背面主语种一致（如 中文-中文）→ 4 种题型（无句子选词、听写填空）；
 *   'cross' —— 正面与背面语种不同（如 英-中）→ 保留全部 5 种题型。
 * @param {object|Array} deck 卡组对象（含 cards）或卡片数组
 */
export function deckMode(deck) {
  const cards = Array.isArray(deck) ? deck : (deck && deck.cards) || [];
  const fronts = [];
  const backs = [];
  for (const c of cards) {
    if (!c) continue;
    if (c.front) fronts.push(c.front);
    if (c.back) backs.push(c.back);
  }
  if (!fronts.length || !backs.length) return 'cross';
  return deckLang(fronts) === deckLang(backs) ? 'same' : 'cross';
}
