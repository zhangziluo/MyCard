// ============================================================================
// countries.js — 世界各国与首都专属逻辑（纯逻辑 + 配置持久化）
//
// 卡片约定（data/countries-capitals.json）：
//   front  「国家中文名 · 英文名」（如 中国 · China）
//   back   「首都中文名 · 英文名」（如 北京 · Beijing）
//
// 测试题型（前 4 种默认启用，后 7 种可选、默认关闭）：
//   countryZh2capitalZh   国家中文 → 首都中文
//   capitalZh2countryZh   首都中文 → 国家中文
//   countryEn2capitalEn   国家英文 → 首都英文
//   capitalEn2countryEn   首都英文 → 国家英文
//   countryZh2countryEn   国家中文 → 国家英文
//   countryEn2countryZh   国家英文 → 国家中文
//   capitalZh2capitalEn   首都中文 → 首都英文
//   capitalEn2capitalZh   首都英文 → 首都中文
//   countryZh2capitalEn   国家中文 → 首都英文
//   countryEn2capitalZh   国家英文 → 首都中文
//   listenCountryEn2capitalEn  听国家英文 → 选首都英文
// ============================================================================

export const COUNTRIES_TYPES = [
  { id: 'countryZh2capitalZh', label: '国家中文选首都中文', optional: false, desc: '看国家中文名，从首都中文名中选出正确项' },
  { id: 'capitalZh2countryZh', label: '首都中文选国家中文', optional: false, desc: '看首都中文名，从国家中文名中选出正确项' },
  { id: 'countryEn2capitalEn', label: '国家英文选首都英文', optional: false, desc: '看国家英文名，从首都英文名中选出正确项' },
  { id: 'capitalEn2countryEn', label: '首都英文选国家英文', optional: false, desc: '看首都英文名，从国家英文名中选出正确项' },
  { id: 'countryZh2countryEn', label: '国家中文选国家英文', optional: true, desc: '看国家中文名，从国家英文名中选出正确项' },
  { id: 'countryEn2countryZh', label: '国家英文选国家中文', optional: true, desc: '看国家英文名，从国家中文名中选出正确项' },
  { id: 'capitalZh2capitalEn', label: '首都中文选首都英文', optional: true, desc: '看首都中文名，从首都英文名中选出正确项' },
  { id: 'capitalEn2capitalZh', label: '首都英文选首都中文', optional: true, desc: '看首都英文名，从首都中文名中选出正确项' },
  { id: 'countryZh2capitalEn', label: '国家中文选首都英文', optional: true, desc: '看国家中文名，从首都英文名中选出正确项' },
  { id: 'countryEn2capitalZh', label: '国家英文选首都中文', optional: true, desc: '看国家英文名，从首都中文名中选出正确项' },
  { id: 'listenCountryEn2capitalEn', label: '听国家英文选首都英文', optional: true, desc: '听国家英文名（TTS），从首都英文名中选出正确项' }
];

export const COUNTRIES_TYPE_IDS = COUNTRIES_TYPES.map((t) => t.id);
export const COUNTRIES_MANDATORY_TYPES = COUNTRIES_TYPES.filter((t) => !t.optional);
export const COUNTRIES_OPTIONAL_TYPES = COUNTRIES_TYPES.filter((t) => t.optional);
export const COUNTRIES_MANDATORY_IDS = COUNTRIES_MANDATORY_TYPES.map((t) => t.id);
export const COUNTRIES_OPTIONAL_IDS = COUNTRIES_OPTIONAL_TYPES.map((t) => t.id);
export const COUNTRIES_TYPE_LABELS = Object.fromEntries(COUNTRIES_TYPES.map((t) => [t.id, t.label]));

/** 题型说明（题面顶部小字） */
export const COUNTRIES_TYPE_HINTS = {
  countryZh2capitalZh: '看国家中文名，选择对应的首都中文名',
  capitalZh2countryZh: '看首都中文名，选择对应的国家中文名',
  countryEn2capitalEn: '看国家英文名，选择对应的首都英文名',
  capitalEn2countryEn: '看首都英文名，选择对应的国家英文名',
  countryZh2countryEn: '看国家中文名，选择对应的国家英文名',
  countryEn2countryZh: '看国家英文名，选择对应的国家中文名',
  capitalZh2capitalEn: '看首都中文名，选择对应的首都英文名',
  capitalEn2capitalZh: '看首都英文名，选择对应的首都中文名',
  countryZh2capitalEn: '看国家中文名，选择对应的首都英文名',
  countryEn2capitalZh: '看国家英文名，选择对应的首都中文名',
  listenCountryEn2capitalEn: '听国家英文名，选择对应的首都英文名'
};

export const COUNTRIES_DEFAULT_ENABLED = Object.fromEntries(COUNTRIES_OPTIONAL_IDS.map((id) => [id, false]));

/** 默认权重：4 种必选题各 25%，7 种可选题 0% */
export const COUNTRIES_DEFAULT_WEIGHTS = Object.fromEntries(
  COUNTRIES_TYPE_IDS.map((id) => [id, COUNTRIES_MANDATORY_IDS.includes(id) ? 25 : 0])
);

const CONFIG_KEY = 'mycard-countries-test-config';

/** 是否世界各国与首都卡组。
 *  - 内置导入：source='countries'；
 *  - 从 JSON 备份重新导入后 source 会丢，此时用「世界各国」标签 + 国家 / 首都字段完整性兜底识别。
 */
export function isCountriesDeck(deck) {
  if (!deck) return false;
  if (deck.source === 'countries') return true;
  const cards = Array.isArray(deck.cards) ? deck.cards : [];
  const tags = [
    ...(Array.isArray(deck.tags) ? deck.tags : []),
    ...(cards[0] && Array.isArray(cards[0].tags) ? cards[0].tags : [])
  ];
  if (!tags.includes('世界各国')) return false;
  if (!cards.length) return true; // 仅用于首页横幅判断的轻量卡组对象
  return cards.every((card) => {
    const p = parseCountry(card);
    return !!p.countryZh && !!p.countryEn && !!p.capitalZh && !!p.capitalEn;
  });
}

export function isCountriesType(type) {
  return COUNTRIES_TYPE_IDS.includes(type);
}

/** 拆分「中文名 · 英文名」；缺少分隔符时整串作为中文名 */
function splitPair(raw) {
  const text = String(raw == null ? '' : raw).trim();
  const m = /^(.+?)\s*[·•]\s*(.+)$/.exec(text);
  return m ? [m[1].trim(), m[2].trim()] : [text, ''];
}

/** 解析一张国家卡；缺字段时返回空串（canBuild 会据此决定题型是否可用） */
export function parseCountry(card) {
  const c = card || {};
  const [countryZh, countryEn] = splitPair(c.front);
  const [capitalZh, capitalEn] = splitPair(c.back);
  return { countryZh, countryEn, capitalZh, capitalEn };
}

/** 供通用出题层调用（与 periodic.parseElement 同接口） */
export const parse = parseCountry;

/** 某题型需要的字段是否齐全 */
export function canBuild(card, type) {
  if (!isCountriesType(type) || !card) return false;
  const fields = COUNTRIES_FIELDS[type];
  if (!fields) return false;
  const p = parseCountry(card);
  return !!p[fields.prompt] && !!p[fields.answer];
}


/** 为卡组建立各字段的选项池（按文本去重） */
export function buildPools(deck) {
  const entries = ((deck && deck.cards) || []).map((card) => ({ card, ...parseCountry(card) }));
  const make = (key) => {
    const seen = new Set();
    const out = [];
    for (const e of entries) {
      const text = String(e[key] || '').trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push({
        id: e.card.id,
        text,
        countryZh: e.countryZh,
        countryEn: e.countryEn,
        capitalZh: e.capitalZh,
        capitalEn: e.capitalEn
      });
    }
    return out;
  };
  return {
    byId: new Map(entries.map((e) => [e.card.id, e])),
    countryZh: make('countryZh'),
    countryEn: make('countryEn'),
    capitalZh: make('capitalZh'),
    capitalEn: make('capitalEn')
  };
}

/** 某题型对应的题干字段 / 正确字段 / 选项池字段 */
export const COUNTRIES_FIELDS = {
  countryZh2capitalZh: { prompt: 'countryZh', answer: 'capitalZh', pool: 'capitalZh' },
  capitalZh2countryZh: { prompt: 'capitalZh', answer: 'countryZh', pool: 'countryZh' },
  countryEn2capitalEn: { prompt: 'countryEn', answer: 'capitalEn', pool: 'capitalEn' },
  capitalEn2countryEn: { prompt: 'capitalEn', answer: 'countryEn', pool: 'countryEn' },
  countryZh2countryEn: { prompt: 'countryZh', answer: 'countryEn', pool: 'countryEn' },
  countryEn2countryZh: { prompt: 'countryEn', answer: 'countryZh', pool: 'countryZh' },
  capitalZh2capitalEn: { prompt: 'capitalZh', answer: 'capitalEn', pool: 'capitalEn' },
  capitalEn2capitalZh: { prompt: 'capitalEn', answer: 'capitalZh', pool: 'capitalZh' },
  countryZh2capitalEn: { prompt: 'countryZh', answer: 'capitalEn', pool: 'capitalEn' },
  countryEn2capitalZh: { prompt: 'countryEn', answer: 'capitalZh', pool: 'capitalZh' },
  listenCountryEn2capitalEn: { prompt: 'countryEn', answer: 'capitalEn', pool: 'capitalEn', listen: true }
};


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
export function enabledTypeIds(enabled = COUNTRIES_DEFAULT_ENABLED) {
  const e = { ...COUNTRIES_DEFAULT_ENABLED, ...(enabled || {}) };
  return [...COUNTRIES_MANDATORY_IDS, ...COUNTRIES_OPTIONAL_IDS.filter((id) => !!e[id])];
}

/** 最大余数法：把精确占比四舍五入到整数百分比，并保证合计恰好 100 */
function apportion(raw, set) {
  const sum = set.reduce((s, t) => s + (raw[t] || 0), 0);
  const parts = set.map((t) => {
    const exact = (raw[t] / sum) * 100;
    const base = Math.floor(exact);
    return { t, base, frac: exact - base };
  });
  let rest = 100 - parts.reduce((s, p) => s + p.base, 0);
  // 小数部分大的先补 1；同小数时保持 set 的稳定顺序（必选题在前）
  const order = parts.map((p, i) => ({ p, i })).sort((a, b) => b.p.frac - a.p.frac || a.i - b.i);
  for (let k = 0; k < rest; k++) order[k % order.length].p.base += 1;
  const out = {};
  for (const p of parts) out[p.t] = p.base;
  return out;
}

/** 在已启用题型内归一化到 100%，未启用可选题型固定 0 */
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
  for (const t of COUNTRIES_TYPE_IDS) if (!(t in out)) out[t] = 0;
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
  if (!COUNTRIES_OPTIONAL_IDS.includes(id)) {
    return { weights: normalizeWeights(weights, enabled), enabled: { ...COUNTRIES_DEFAULT_ENABLED, ...(enabled || {}) } };
  }
  const nextEnabled = { ...COUNTRIES_DEFAULT_ENABLED, ...(enabled || {}), [id]: !!on };
  const ids = enabledTypeIds(nextEnabled);
  const out = {};
  if (on) {
    Object.assign(out, equalSplit(ids));
  } else {
    const base = { ...COUNTRIES_DEFAULT_WEIGHTS, ...(weights || {}) };
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
    const enabled = { ...COUNTRIES_DEFAULT_ENABLED, ...(d && d.enabled ? d.enabled : {}) };
    return { weights: normalizeWeights(d && d.weights, enabled), enabled };
  } catch (e) {
    return {
      weights: normalizeWeights(COUNTRIES_DEFAULT_WEIGHTS, COUNTRIES_DEFAULT_ENABLED),
      enabled: { ...COUNTRIES_DEFAULT_ENABLED }
    };
  }
}

export function saveConfig(patch = {}) {
  const cur = loadConfig();
  const enabled = patch.enabled == null ? cur.enabled : { ...COUNTRIES_DEFAULT_ENABLED, ...patch.enabled };
  const next = {
    weights: patch.weights == null ? cur.weights : normalizeWeights(patch.weights, enabled),
    enabled
  };
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
  } catch (e) {}
  return next;
}

export function resetDefaults(enabled = COUNTRIES_DEFAULT_ENABLED) {
  const ids = enabledTypeIds(enabled);
  return {
    weights: normalizeWeights(equalSplit(ids), enabled),
    enabled: { ...COUNTRIES_DEFAULT_ENABLED, ...(enabled || {}) }
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

/* 通用出题层使用的统一别名（与 periodic.js 同接口） */
export const TYPE_IDS = COUNTRIES_TYPE_IDS;
export const TYPE_LABELS = COUNTRIES_TYPE_LABELS;
export const MANDATORY_TYPES = COUNTRIES_MANDATORY_TYPES;
export const OPTIONAL_TYPES = COUNTRIES_OPTIONAL_TYPES;
export const MANDATORY_IDS = COUNTRIES_MANDATORY_IDS;
export const FIELDS = COUNTRIES_FIELDS;

