// ============================================================================
// periodic.js — 元素周期表专属逻辑（纯逻辑 + 配置持久化）
//
// 卡片约定（data/periodic-table.json）：
//   front  中文名（如 氢）
//   back   「缩写 · 英文全名」（如 H · Hydrogen）
//   back2  「原子序号：N」
//   back3  一句话中文描述
//
// 测试题型（前 4 种默认启用，后 5 种可选、默认关闭）：
//   zh2symbol      中文名 → 缩写
//   zh2number      中文名 → 原子序号
//   zh2desc        中文名 → 一句话描述
//   symbol2zh      缩写 → 中文名
//   number2zh      原子序号 → 中文名
//   desc2zh        一句话描述 → 中文名
//   listenDesc2zh  听一句话描述 → 中文名
//   zh2enName      中文名 → 英文全名
//   enName2zh      英文全名 → 中文名
// ============================================================================

export const MAX_ATOMIC_NUMBER = 118;

export const PERIODIC_TYPES = [
  { id: 'zh2symbol', label: '中文名选缩写', optional: false, desc: '看中文名，从元素缩写中选出正确项' },
  { id: 'zh2number', label: '中文名选原子序号', optional: false, desc: '看中文名，从原子序号中选出正确项' },
  { id: 'zh2desc', label: '中文名选一句话描述', optional: true, desc: '看中文名，从一句话描述中选出正确项' },
  { id: 'symbol2zh', label: '缩写选中文名', optional: false, desc: '看元素缩写，从中文名中选出正确项' },
  { id: 'number2zh', label: '原子序号选中文名', optional: false, desc: '看原子序号，从中文名中选出正确项' },
  { id: 'desc2zh', label: '一句话描述选中文名', optional: true, desc: '看一句话描述，从中文名中选出正确项' },
  { id: 'listenDesc2zh', label: '听一句话描述选中文名', optional: true, desc: '听一句话描述（TTS），从中文名中选出正确项' },
  { id: 'zh2enName', label: '中文名选英文全名', optional: true, desc: '看中文名，从英文全名中选出正确项' },
  { id: 'enName2zh', label: '英文全名选中文名', optional: true, desc: '看英文全名，从中文名中选出正确项' }
];

export const PERIODIC_TYPE_IDS = PERIODIC_TYPES.map((t) => t.id);
export const PERIODIC_MANDATORY_TYPES = PERIODIC_TYPES.filter((t) => !t.optional);
export const PERIODIC_OPTIONAL_TYPES = PERIODIC_TYPES.filter((t) => t.optional);
export const PERIODIC_MANDATORY_IDS = PERIODIC_MANDATORY_TYPES.map((t) => t.id);
export const PERIODIC_OPTIONAL_IDS = PERIODIC_OPTIONAL_TYPES.map((t) => t.id);
export const PERIODIC_TYPE_LABELS = Object.fromEntries(PERIODIC_TYPES.map((t) => [t.id, t.label]));

export const PERIODIC_DEFAULT_ENABLED = Object.fromEntries(PERIODIC_OPTIONAL_IDS.map((id) => [id, false]));

/** 默认权重：4 种必选题各 25%，5 种可选题 0% */
export const PERIODIC_DEFAULT_WEIGHTS = Object.fromEntries(
  PERIODIC_TYPE_IDS.map((id) => [id, PERIODIC_MANDATORY_IDS.includes(id) ? 25 : 0])
);

const CONFIG_KEY = 'mycard-periodic-test-config';

/** 是否周期表卡组。
 *  - 内置 / 范围导入：source='periodic'；
 *  - 从 JSON 备份重新导入后 source 会丢（导入按普通卡组处理），此时用「元素周期表」标签 + 元素字段完整性兜底识别。
 */
export function isPeriodicDeck(deck) {
  if (!deck) return false;
  if (deck.source === 'periodic') return true;
  const cards = Array.isArray(deck.cards) ? deck.cards : [];
  if (!cards.length) return false;
  const tags = [...(Array.isArray(deck.tags) ? deck.tags : []), ...(Array.isArray(cards[0].tags) ? cards[0].tags : [])];
  if (!tags.includes('元素周期表')) return false;
  return cards.every((card) => {
    const p = parseElement(card);
    return !!p.zh && !!p.symbol && !!p.atomicNumber;
  });
}

export function isPeriodicType(type) {
  return PERIODIC_TYPE_IDS.includes(type);
}

/** 解析一张周期表卡片；缺字段时返回空串（canBuild 会据此决定题型是否可用） */
export function parseElement(card) {
  const c = card || {};
  const rawBack = String(c.back ?? '').trim();
  const m = /^([A-Z][a-z]?)\s*[·•]\s*(.+?)\s*$/.exec(rawBack);
  const numberMatch = /(\d{1,3})/.exec(String(c.back2 ?? ''));
  const number = numberMatch ? Number(numberMatch[1]) : 0;
  return {
    zh: String(c.front ?? '').trim(),
    symbol: m ? m[1] : '',
    enName: m ? String(m[2]).trim() : '',
    atomicNumber: number >= 1 && number <= MAX_ATOMIC_NUMBER ? String(number) : '',
    description: String(c.back3 ?? '').trim()
  };
}

/** 供通用出题层调用（与 countries.parseCountry 同接口） */
export const parse = parseElement;

/** 某题型需要的字段是否齐全 */
export function canBuild(card, type) {
  if (!isPeriodicType(type) || !card) return false;
  const p = parseElement(card);
  if (!p.zh) return false;
  if (type === 'zh2desc' || type === 'desc2zh' || type === 'listenDesc2zh') return !!p.description;
  if (type === 'zh2enName' || type === 'enName2zh') return !!p.enName;
  if (type === 'zh2number' || type === 'number2zh') return !!p.atomicNumber;
  if (type === 'zh2symbol' || type === 'symbol2zh') return !!p.symbol && !!p.enName;
  return false;
}

/** 为一组周期表卡片建立各字段的选项池（按文本去重） */
export function buildPools(deck) {
  const entries = ((deck && deck.cards) || []).map((card) => ({ card, ...parseElement(card) }));
  const make = (key) => {
    const seen = new Set();
    const out = [];
    for (const e of entries) {
      const text = String(e[key] || '').trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push({ id: e.card.id, text });
    }
    return out;
  };
  return {
    byId: new Map(entries.map((e) => [e.card.id, e])),
    zh: make('zh'),
    symbol: make('symbol'),
    atomicNumber: make('atomicNumber'),
    enName: make('enName'),
    description: make('description')
  };
}

/** 某题型对应的题干字段 / 正确字段 / 选项池字段 */
export const PERIODIC_FIELDS = {
  zh2symbol: { prompt: 'zh', answer: 'symbol', pool: 'symbol' },
  zh2number: { prompt: 'zh', answer: 'atomicNumber', pool: 'atomicNumber' },
  zh2desc: { prompt: 'zh', answer: 'description', pool: 'description' },
  symbol2zh: { prompt: 'symbol', answer: 'zh', pool: 'zh' },
  number2zh: { prompt: 'atomicNumber', answer: 'zh', pool: 'zh' },
  desc2zh: { prompt: 'description', answer: 'zh', pool: 'zh' },
  listenDesc2zh: { prompt: 'description', answer: 'zh', pool: 'zh', listen: true },
  zh2enName: { prompt: 'zh', answer: 'enName', pool: 'enName' },
  enName2zh: { prompt: 'enName', answer: 'zh', pool: 'zh' }
};

/* ------------------------------ 范围拆分 ------------------------------ */

export function clampAtomicNumber(n, fallback = 1) {
  const v = Math.floor(Number(n));
  if (!isFinite(v)) return fallback;
  return Math.min(MAX_ATOMIC_NUMBER, Math.max(1, v));
}

/** 规范化范围：越界夹到 1–118，起止写反时自动交换 */
export function normalizeRange(start, end) {
  let a = clampAtomicNumber(start, 1);
  let b = clampAtomicNumber(end, MAX_ATOMIC_NUMBER);
  if (a > b) [a, b] = [b, a];
  return { start: a, end: b };
}

export function rangeLabel(range) {
  return `${range.start}–${range.end}`;
}

/**
 * 把范围按每段最多 size 个原子序号拆分。
 * size <= 0 或 size 大于范围长度 → 返回整段一个卡组。
 */
export function splitRange(start, end, size = 0) {
  const r = normalizeRange(start, end);
  const len = r.end - r.start + 1;
  const step = Math.floor(Number(size)) || 0;
  if (step <= 0 || step >= len) return [r];
  const out = [];
  for (let s = r.start; s <= r.end; s += step) {
    out.push({ start: s, end: Math.min(r.end, s + step - 1) });
  }
  return out;
}

/** 从原始词条数组中筛出指定原子序号范围的元素（保持原顺序） */
export function wordsInRange(words, start, end) {
  const r = normalizeRange(start, end);
  return (Array.isArray(words) ? words : []).filter((w) => {
    const p = parseElement(w);
    const n = Number(p.atomicNumber);
    return n >= r.start && n <= r.end;
  });
}

/* ------------------------------ 测试配置 ------------------------------ */

function equalSplit(ids) {
  const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
  const out = {};
  if (!list.length) return out;
  const each = Math.floor(100 / list.length);
  const rem = 100 - each * list.length;
  list.forEach((t, i) => {
    out[t] = each + (i < rem ? 1 : 0);
  });
  return out;
}

/** 已启用题型：4 种必选 + 配置里开启的可选题型 */
export function enabledTypeIds(enabled = PERIODIC_DEFAULT_ENABLED) {
  const e = { ...PERIODIC_DEFAULT_ENABLED, ...(enabled || {}) };
  return [...PERIODIC_MANDATORY_IDS, ...PERIODIC_OPTIONAL_IDS.filter((id) => !!e[id])];
}

/** 在已启用题型内归一化到 100%，未启用可选题型固定 0 */
/** 最大余数法：把精确占比四舍五入到整数百分比，并保证合计恰好 100 */
function apportion(raw, set) {
  const sum = set.reduce((s, t) => s + (raw[t] || 0), 0);
  const parts = set.map((t) => {
    const exact = (raw[t] / sum) * 100;
    const base = Math.floor(exact);
    return { t, base, frac: exact - base };
  });
  let rest = 100 - parts.reduce((s, p) => s + p.base, 0);
  const order = parts.map((p, i) => ({ p, i })).sort((a, b) => b.p.frac - a.p.frac || a.i - b.i);
  for (let k = 0; k < rest; k++) order[k % order.length].p.base += 1;
  const out = {};
  for (const p of parts) out[p.t] = p.base;
  return out;
}

export function normalizeWeights(w, enabled) {
  const set = enabledTypeIds(enabled);
  const raw = {};
  let sum = 0;
  for (const t of set) {
    const v = Math.max(0, Number(w && w[t]) || 0);
    raw[t] = v;
    sum += v;
  }
  const out = sum <= 0 ? equalSplit(set) : apportion(raw, set);
  for (const t of PERIODIC_TYPE_IDS) if (!(t in out)) out[t] = 0;
  return out;
}

/** 调整某题型权重，其余已启用题型按当前比例分摊，合计保持 100% */
export function adjustWeights(weights, key, value, enabled) {
  const set = enabledTypeIds(enabled);
  if (!set.includes(key)) return normalizeWeights(weights, enabled);
  const cur = normalizeWeights(weights, enabled);
  const v = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  const others = set.filter((t) => t !== key);
  if (!others.length) return normalizeWeights({ ...cur, [key]: 100 }, enabled);
  const rest = 100 - v;
  const out = { [key]: v };
  const curSum = others.reduce((s, t) => s + cur[t], 0);
  let acc = 0;
  others.forEach((t, i) => {
    let share;
    if (i === others.length - 1) share = rest - acc;
    else share = curSum > 0 ? Math.round((rest * cur[t]) / curSum) : Math.floor(rest / others.length);
    if (share < 0) share = 0;
    out[t] = share;
    acc += share;
  });
  const sum = set.reduce((s, t) => s + (out[t] || 0), 0);
  if (sum !== 100) out[others[0]] = Math.max(0, out[others[0]] + (100 - sum));
  return normalizeWeights(out, enabled);
}

/** 启用 / 停用可选题型；启用后与其余已启用题型等比平分 */
export function setTypeEnabled(weights, enabled, id, on) {
  if (!PERIODIC_OPTIONAL_IDS.includes(id)) {
    return { weights: normalizeWeights(weights, enabled), enabled: { ...PERIODIC_DEFAULT_ENABLED, ...(enabled || {}) } };
  }
  const nextEnabled = { ...PERIODIC_DEFAULT_ENABLED, ...(enabled || {}), [id]: !!on };
  const ids = enabledTypeIds(nextEnabled);
  const out = {};
  if (on) {
    Object.assign(out, equalSplit(ids));
  } else {
    const base = { ...PERIODIC_DEFAULT_WEIGHTS, ...(weights || {}) };
    const sum = ids.reduce((s, t) => s + Math.max(0, Number(base[t]) || 0), 0);
    let acc = 0;
    ids.forEach((t, i) => {
      if (i === ids.length - 1) out[t] = Math.max(0, 100 - acc);
      else {
        out[t] = sum > 0 ? Math.round((100 * Math.max(0, Number(base[t]) || 0)) / sum) : Math.floor(100 / ids.length);
        acc += out[t];
      }
    });
    out[id] = 0;
  }
  return { weights: normalizeWeights(out, nextEnabled), enabled: nextEnabled };
}



export function loadConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    const d = raw ? JSON.parse(raw) : null;
    const enabled = { ...PERIODIC_DEFAULT_ENABLED, ...(d && d.enabled ? d.enabled : {}) };
    return { weights: normalizeWeights(d && d.weights, enabled), enabled };
  } catch (e) {
    return {
      weights: normalizeWeights(PERIODIC_DEFAULT_WEIGHTS, PERIODIC_DEFAULT_ENABLED),
      enabled: { ...PERIODIC_DEFAULT_ENABLED }
    };
  }
}

export function saveConfig(patch = {}) {
  const cur = loadConfig();
  const enabled = patch.enabled == null ? cur.enabled : { ...PERIODIC_DEFAULT_ENABLED, ...patch.enabled };
  const next = {
    weights: patch.weights == null ? cur.weights : normalizeWeights(patch.weights, enabled),
    enabled
  };
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
  } catch (e) {}
  return next;
}

export function resetDefaults(enabled = PERIODIC_DEFAULT_ENABLED) {
  const ids = enabledTypeIds(enabled);
  return {
    weights: normalizeWeights(equalSplit(ids), enabled),
    enabled: { ...PERIODIC_DEFAULT_ENABLED, ...(enabled || {}) }
  };
}

/** 关卡重刷时微调题型分布（与通用题型 typesForRetry 同思路） */
export function typesForRetry(retry = 0) {
  const types = enabledTypeIds(loadConfig().enabled);
  const r = Math.max(0, Math.floor(Number(retry) || 0));
  if (r <= 0) return [...types];
  const idx = (r - 1) % types.length;
  return types.flatMap((t, i) => (i === idx ? [t, t] : [t]));
}

/* 通用出题层使用的统一别名（与 countries.js 同接口） */
export const TYPE_IDS = PERIODIC_TYPE_IDS;
export const TYPE_LABELS = PERIODIC_TYPE_LABELS;
export const MANDATORY_TYPES = PERIODIC_MANDATORY_TYPES;
export const OPTIONAL_TYPES = PERIODIC_OPTIONAL_TYPES;
export const MANDATORY_IDS = PERIODIC_MANDATORY_IDS;
export const FIELDS = PERIODIC_FIELDS;
