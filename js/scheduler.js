// ============================================================================
// scheduler.js — 艾宾浩斯遗忘曲线 · 间隔重复调度（纯逻辑，无 DOM / 无存储）
//
// 反馈四档（顺序即 UI 展示顺序）：
//   again 重来：完全没记住，10 分钟后立刻重学
//   hard  困难：勉强想起，复习间隔缩短
//   good  记住：正常回忆，按遗忘曲线推进
//   easy  轻松：毫不费力，复习间隔加长并跳档
//
// 复习间隔取自艾宾浩斯经典复习节奏（单位：天）：
//   10 分钟 → 1 小时 → 12 小时 → 1 天 → 2 天 → 4 天 → 7 天 → 15 天 → 30 天 → 60 天
// 实际间隔 = 曲线间隔 × 反馈系数 × easeFactor
// ============================================================================

export const DAY_MS = 86400000;

export const FEEDBACK_ORDER = ['again', 'hard', 'good', 'easy'];

export const FEEDBACKS = [
  { key: 'again', label: '重来', hint: '忘记了' },
  { key: 'hard', label: '困难', hint: '很吃力' },
  { key: 'good', label: '记住', hint: '正常' },
  { key: 'easy', label: '轻松', hint: '超简单' }
];

export const FEEDBACK_BY_KEY = Object.fromEntries(FEEDBACKS.map((f) => [f.key, f]));

/** 艾宾浩斯复习间隔（天） */
const EBBINGHAUS_DAYS = [10 / 1440, 1 / 24, 0.5, 1, 2, 4, 7, 15, 30, 60];

const DEFAULT_EASE = 2.5;
const MIN_EASE = 1.3;
const MAX_EASE = 3.0;

function clampEase(v) {
  if (typeof v !== 'number' || !isFinite(v)) v = DEFAULT_EASE;
  return Math.min(MAX_EASE, Math.max(MIN_EASE, v));
}

/** 第 n 次成功回忆对应的曲线间隔 */
function curveInterval(n) {
  const idx = Math.min(Math.max(1, n), EBBINGHAUS_DAYS.length - 1);
  return EBBINGHAUS_DAYS[idx];
}

function nextRepetition(card) {
  // 新卡片第一次回忆从 1 开始计数
  if (card.state === 'new' || !card.repetitions || card.repetitions <= 0) return 1;
  return card.repetitions + 1;
}

/**
 * 根据四档反馈推进一张卡片，返回更新后的副本（不修改入参）。
 * @param {object} card     卡片（含 state/repetitions/easeFactor/interval/due/lastReview）
 * @param {string} feedback 'again' | 'hard' | 'good' | 'easy'
 * @param {number} now      时间戳（毫秒），默认 Date.now()
 */
export function applyFeedback(card, feedback, now = Date.now()) {
  const c = { ...card };
  const ef = clampEase(c.easeFactor);

  if (feedback === 'again') {
    // 重来：遗忘，回到学习态，10 分钟后再次出现
    c.state = 'learning';
    c.repetitions = 0;
    c.easeFactor = clampEase(ef - 0.2);
    c.interval = EBBINGHAUS_DAYS[0]; // 10 分钟
  } else {
    let reps = nextRepetition(c);
    let factor = 1.0;

    if (feedback === 'hard') {
      factor = 0.8; // 更短的间隔
      c.easeFactor = clampEase(ef - 0.1);
    } else if (feedback === 'easy') {
      reps += 1; // 跳档：相当于连续答对两次
      c.easeFactor = clampEase(ef + 0.05);
    } // good：easeFactor 不变

    c.state = 'review';
    c.repetitions = reps;
    c.interval = curveInterval(reps) * factor * clampEase(c.easeFactor);
  }

  c.lastReview = now;
  c.due = now + Math.round(c.interval * DAY_MS);
  return c;
}

/** 是否尚未学过 */
export function isNewCard(card) {
  return card.state === 'new' || card.lastReview == null;
}

/** 是否已经过至少一次翻转评分 */
export function isReviewed(card) {
  return card.lastReview != null;
}

/** 是否为到期待复习（含新卡：随时可学） */
export function isDue(card, now = Date.now()) {
  if (isNewCard(card)) return true;
  return card.due <= now;
}

/** 相对时间友好文案 */
export function relativeLabel(ms) {
  const abs = Math.abs(ms);
  const min = Math.round(abs / 60000);
  if (min < 60) return Math.max(1, min) + ' 分钟';
  const hr = Math.round(min / 60);
  if (hr < 24) return hr + ' 小时';
  const day = Math.round(hr / 24);
  if (day < 30) return day + ' 天';
  const mo = Math.round(day / 30);
  return mo + ' 个月';
}

/** 下一次复习的展示文案 */
export function dueLabel(card, now = Date.now()) {
  if (isNewCard(card)) return '未学习';
  if (card.due <= now) return '待复习';
  return relativeLabel(card.due - now) + '后';
}

/** 学习状态徽标文案 */
export function stateLabel(card, now = Date.now()) {
  if (isNewCard(card)) return '新卡';
  if (card.state === 'learning') return '学习中';
  return '复习';
}
