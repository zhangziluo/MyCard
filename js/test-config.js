// ============================================================================
// test-config.js — 整卡组测试配置（纯逻辑 + localStorage 持久化）
//   题数：默认 50，可调 20~150（步长 10）；预设档位 快速20 / 标准50 / 挑战150
//   题型权重：5 种题型比例（总和 100，默认各 20）
//   通关阈值：正确率 ≥ 80%
// ============================================================================

/** 题型清单（与 test.js 共用，避免循环依赖） */
export const QUESTION_TYPES = ['word2def', 'def2word', 'sentence2word', 'fill', 'listen'];

/** 题型展示名 */
export const TYPE_LABELS = {
  word2def: '英选中',
  def2word: '中选英',
  sentence2word: '句选词',
  fill: '填空',
  listen: '听音辨义'
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

export const DEFAULT_WEIGHTS = { word2def: 20, def2word: 20, sentence2word: 20, fill: 20, listen: 20 };

const KEY = 'mycard-test-config';

/** 题数取整到步长并夹在 20~150 */
export function clampCount(n) {
  const v = Number(n);
  if (!isFinite(v) || v <= 0) return DEFAULT_QUESTIONS;
  const stepped = Math.round(v / STEP_QUESTIONS) * STEP_QUESTIONS;
  return Math.min(MAX_QUESTIONS, Math.max(MIN_QUESTIONS, stepped));
}

/** 权重归一：非法/全 0 → 默认；否则缩放到总和 100（整数） */
export function normalizeWeights(w) {
  const raw = {};
  let sum = 0;
  for (const t of QUESTION_TYPES) {
    const v = Math.max(0, Number(w && w[t]) || 0);
    raw[t] = v;
    sum += v;
  }
  if (sum <= 0) return { ...DEFAULT_WEIGHTS };
  const out = {};
  let acc = 0;
  QUESTION_TYPES.forEach((t, i) => {
    if (i === QUESTION_TYPES.length - 1) {
      out[t] = Math.max(0, 100 - acc);
    } else {
      out[t] = Math.round((raw[t] / sum) * 100);
      acc += out[t];
    }
  });
  return out;
}

/** 读取配置（缺失/损坏时回落到默认） */
export function loadConfig() {
  try {
    const raw = localStorage.getItem(KEY);
    const d = raw ? JSON.parse(raw) : null;
    return { count: clampCount(d && d.count), weights: normalizeWeights(d && d.weights) };
  } catch (e) {
    return { count: DEFAULT_QUESTIONS, weights: { ...DEFAULT_WEIGHTS } };
  }
}

/**
 * 调整某题型权重（0~100），其余题型按当前比例分摊，保证总和 = 100。
 * 例：adjustWeights({各20}, 'listen', 40) → listen 40%，其余各 15%。
 */
export function adjustWeights(weights, key, value) {
  const cur = normalizeWeights(weights);
  const v = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  const others = QUESTION_TYPES.filter((t) => t !== key);
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
  // 兜底修正（取整/夹取导致的偏差）
  const sum = QUESTION_TYPES.reduce((s, t) => s + out[t], 0);
  if (sum !== 100) out[others[0]] = Math.max(0, out[others[0]] + (100 - sum));
  return out;
}

/** 保存配置（部分字段可省略） */
export function saveConfig(patch = {}) {
  const cur = loadConfig();
  const next = {
    count: patch.count == null ? cur.count : clampCount(patch.count),
    weights: patch.weights == null ? cur.weights : normalizeWeights(patch.weights)
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch (e) {}
  return next;
}
