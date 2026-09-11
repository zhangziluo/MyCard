// ============================================================================
// test-config.js — 测试配置（纯逻辑 + localStorage 持久化）
//
// 题数：默认 50，可调 20~150（步长 10）；预设档位 快速20 / 标准50 / 挑战150
// 题型：
//   基础 5 种（始终可用）：word2def / def2word / sentence2word / fill / listen
//   可选 2 种（默认关闭，可在「题型比例」面板里开启）：
//     eng_eng     英英选择（看词选英文释义 / 看英文释义猜词，数据来自 GCIDE）
//     multi_sense 多义多选（一词多义，优先卡组中文释义，缺失则用 GCIDE 英文释义）
// 权重：在「已启用题型」集合内归一化到 100%；开启某题型时与其余题型等比平分
//       （例：开启 eng_eng 后 6 种各约 1/6 ≈ 16.7%）。
// 通关阈值：正确率 ≥ 80%
// ============================================================================

/** 基础题型（顺序即权重面板顺序） */
export const QUESTION_TYPES = ['word2def', 'def2word', 'sentence2word', 'fill', 'listen'];

/** 可选题型（默认关闭） */
export const OPTIONAL_TYPES = [
  {
    id: 'eng_eng',
    label: '英英选择',
    desc: '建议考研及以上水平使用（需较强英文阅读理解能力）'
  },
  {
    id: 'multi_sense',
    label: '多义多选',
    desc: '建议考研及以上水平使用'
  }
];

export const OPTIONAL_IDS = OPTIONAL_TYPES.map((t) => t.id);

/** 全部题型 id（基础 + 可选） */
export const ALL_TYPES = [...QUESTION_TYPES, ...OPTIONAL_IDS];

/** 题型展示名 */
export const TYPE_LABELS = {
  word2def: '英选中',
  def2word: '中选英',
  sentence2word: '句选词',
  fill: '填空',
  listen: '听音辨义',
  eng_eng: '英英选择',
  multi_sense: '多义多选'
};

export const MIN_QUESTIONS = 20;
export const MAX_QUESTIONS = 150;
export const STEP_QUESTIONS = 10;
export const DEFAULT_QUESTIONS = 50;
export const PASS_RATIO = 0.8;

export const PRESETS = [
  { key: 'quick', label: '快速', count: 20 },
  { key: 'standard', label: '标准', count: 50 },
  { key: 'challenge', label: '挑战', count: 150 }
];

/** 默认权重：基础 5 种各 20%，可选 2 种 0%（未启用） */
export const DEFAULT_WEIGHTS = {
  word2def: 20,
  def2word: 20,
  sentence2word: 20,
  fill: 20,
  listen: 20,
  eng_eng: 0,
  multi_sense: 0
};

/** 默认启用状态：可选题型默认关闭 */
export const DEFAULT_ENABLED = { eng_eng: false, multi_sense: false };

const KEY = 'mycard-test-config';

/** 题数取整到步长并夹在 20~150 */
export function clampCount(n) {
  const v = Number(n);
  if (!isFinite(v) || v <= 0) return DEFAULT_QUESTIONS;
  const stepped = Math.round(v / STEP_QUESTIONS) * STEP_QUESTIONS;
  return Math.min(MAX_QUESTIONS, Math.max(MIN_QUESTIONS, stepped));
}

/** 已启用题型 id 列表（基础 5 + 已开启的可选题型） */
export function enabledTypeIds(enabled = DEFAULT_ENABLED) {
  const e = { ...DEFAULT_ENABLED, ...(enabled || {}) };
  return [...QUESTION_TYPES, ...OPTIONAL_IDS.filter((id) => !!e[id])];
}

/** 权重归一：在「已启用题型」内缩放到总和 100（未启用的可选题型固定 0）
 *  兼容旧签名：不传 enabled 时只归一基础 5 种（保持旧测试/调用行为） */
export function normalizeWeights(w, enabled) {
  const set = enabled ? enabledTypeIds(enabled) : [...QUESTION_TYPES];
  const raw = {};
  let sum = 0;
  for (const t of set) {
    const v = Math.max(0, Number(w && w[t]) || 0);
    raw[t] = v;
    sum += v;
  }
  const out = {};
  let acc = 0;
  if (sum <= 0) {
    // 全 0 → 等比平分（6 项 → 17/17/17/17/16/16）
    const split = equalSplit(set);
    for (const t of set) out[t] = split[t];
  } else {
    set.forEach((t, i) => {
      if (i === set.length - 1) out[t] = Math.max(0, 100 - acc);
      else {
        out[t] = Math.round((raw[t] / sum) * 100);
        acc += out[t];
      }
    });
  }
  for (const t of ALL_TYPES) if (!(t in out)) out[t] = 0;
  return out;
}

/**
 * 调整某题型权重（0~100），其余**已启用**题型按当前比例分摊，保证合计 = 100。
 * 例：adjustWeights({各20}, 'listen', 40) → listen 40%，其余各 15%。
 */
export function adjustWeights(weights, key, value, enabled) {
  const set = enabled ? enabledTypeIds(enabled) : [...QUESTION_TYPES];
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
  // 兜底修正（取整导致的偏差）
  const sum = set.reduce((s, t) => s + (out[t] || 0), 0);
  if (sum !== 100) out[others[0]] = Math.max(0, out[others[0]] + (100 - sum));
  return normalizeWeights(out, enabled);
}

/**
 * 启用 / 停用某个可选题型，并返回新的 { weights, enabled }。
 *  - 启用：与其余已启用题型**等比平分**（5 基础 + 1 可选 → 各约 1/6 ≈ 16.7%）
 *  - 停用：其余题型按原比例重新归一，该题型权重置 0
 */
export function setTypeEnabled(weights, enabled, id, on) {
  if (!OPTIONAL_IDS.includes(id)) return { weights: normalizeWeights(weights, enabled), enabled: { ...DEFAULT_ENABLED, ...enabled } };
  const nextEnabled = { ...DEFAULT_ENABLED, ...(enabled || {}), [id]: !!on };
  const ids = enabledTypeIds(nextEnabled);
  const base = { ...DEFAULT_WEIGHTS, ...(weights || {}) };
  const out = {};
  if (on) {
    const ids2 = ids;
    const split = equalSplit(ids2);
    for (const t of ids2) out[t] = split[t];
  } else {
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

/** 读取配置（缺失/损坏时回落到默认） */
export function loadConfig() {
  try {
    const raw = localStorage.getItem(KEY);
    const d = raw ? JSON.parse(raw) : null;
    const enabled = { ...DEFAULT_ENABLED, ...(d && d.enabled ? d.enabled : {}) };
    return { count: clampCount(d && d.count), weights: normalizeWeights(d && d.weights, enabled), enabled };
  } catch (e) {
    return { count: DEFAULT_QUESTIONS, weights: { ...DEFAULT_WEIGHTS }, enabled: { ...DEFAULT_ENABLED } };
  }
}

/** 保存配置（部分字段可省略） */
export function saveConfig(patch = {}) {
  const cur = loadConfig();
  const enabled = patch.enabled == null ? cur.enabled : { ...DEFAULT_ENABLED, ...patch.enabled };
  const next = {
    count: patch.count == null ? cur.count : clampCount(patch.count),
    weights: patch.weights == null ? cur.weights : normalizeWeights(patch.weights, enabled),
    enabled
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch (e) {}
  return next;
}

/** 某题型当前是否可用（基础题型恒可用；可选题型看 enabled） */
export function isTypeEnabled(id, enabled = DEFAULT_ENABLED) {
  return QUESTION_TYPES.includes(id) || !!(enabled && enabled[id]);
}

/** 等权分配：把 100% 平摊到若干题型，余数分给前几项（6 项 → 17/17/17/17/16/16 ≈ 16.7%） */
export function equalSplit(ids) {
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

/** 恢复默认：题数默认 + 已启用题型等比平分（可选题型保持当前启用状态） */
export function resetDefaults(enabled = DEFAULT_ENABLED) {
  const ids = enabledTypeIds(enabled);
  return { count: DEFAULT_QUESTIONS, weights: normalizeWeights(equalSplit(ids), enabled), enabled: { ...DEFAULT_ENABLED, ...enabled } };
}


