// ============================================================================
// engdefs.js — GCIDE 英文释义表（data/eng-defs.json）懒加载
//
// 用途：新题型「英英选择 eng_eng」与「多义多选 multi_sense」需要英文释义。
// 策略：数据由 scripts/build-engdefs.mjs 从 gcide-0.51/CIDE.* 预生成（约 2.7MB），
//       不进入 SW 预缓存，首次使用时按需 fetch（之后由 SW 运行时缓存 / 内存 Map）。
// 用法：app.boot() 里 ensureLoaded() 预载；出题时用 defs(word) 同步取。
// ============================================================================

export const ENG_DEFS_URL = './data/eng-defs.json';

let MAP = null; // Map<word, string[]>
let loading = null;

/** 词形归一（小写、去首尾空白），与构建脚本保持一致 */
export function normWord(word) {
  return String(word ?? '').trim().toLowerCase();
}

export function loaded() {
  return !!MAP;
}

export function size() {
  return MAP ? MAP.size : 0;
}

/** 预载释义表（失败时静默降级为空表，调用方可稍后重试） */
export function ensureLoaded(url = ENG_DEFS_URL) {
  if (MAP) return Promise.resolve(MAP);
  if (loading) return loading;
  loading = fetch(url, { cache: 'force-cache' })
    .then((resp) => {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.json();
    })
    .then((data) => {
      MAP = new Map(Object.entries(data || {}));
      return MAP;
    })
    .catch((e) => {
      MAP = null;
      throw e;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** 测试/离线注入：直接给一张 word -> string[] 表 */
export function setEngDefs(obj) {
  MAP = new Map(Object.entries(obj || {}));
  return MAP;
}

export function clearEngDefs() {
  MAP = null;
}

/** 某词的英文释义数组（未加载或无词 → []） */
export function defs(word) {
  if (!MAP) return [];
  return MAP.get(normWord(word)) || [];
}

export function hasDefs(word) {
  return defs(word).length > 0;
}

/** 某词的前 n 条释义（默认 4；多义多选需要 ≥2 条） */
export function senses(word, max = 4) {
  return defs(word).slice(0, max);
}

/** 随机取该词的一条英文释义（英英选择子模式 A 用） */
export function pickSense(word, random = Math.random, max = 4) {
  const list = senses(word, max);
  if (!list.length) return null;
  return list[Math.floor(random() * list.length)];
}
