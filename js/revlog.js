// ============================================================================
// revlog.js — 复习日志（本机「每次评分」明细，对齐 Anki 的 revlog 表）
//
// 为什么需要：Mycard 早期只保存「聚合调度状态」（state / repetitions / interval /
// easeFactor / due），导出的 .apkg 里 Anki 的 revlog（每次评分明细）只能留空，
// 于是 Anki 侧的复习热力图、记忆保持率、单卡历史全部为 0。本模块把每次评分
// 落成一条结构化日志，导出时直接写进 collection.anki2 的 revlog 表；
// 同时随 JSON 导出 / 导入往返（见 export.deckToJson / import-file.pickReviewLog）。
//
// 字段与 Anki revlog 的对应关系：
//   id      → 本机 `ts`（毫秒时间戳；导出时换算为 Anki 的毫秒主键）
//   cid     → cardId（导出时映射为卡包内的 cards.id）
//   ease    1 重来 / 2 困难 / 3 记住 / 4 轻松
//   ivl     本机单位统一为「天」（浮点）→ 导出时按 Anki 约定换算：
//           正数 = 天；不足 1 天的学习 / 重学步 = 负数秒（见 entryToAnkiIvl）
//   lastIvl 评分前的间隔（天）→ 同上换算
//   factor  easeFactor（1.3~3.0）→ 导出时 ×1000（Anki 存整数）
//   time    该卡停留毫秒（上限 1 小时，避免挂机数据失真）
//   type    0 学习 / 1 复习 / 2 重学（遗忘） / 3 提前复习
//
// 约定：日志只追加、不覆盖（与 Anki 一致，本机不设条数上限）；
//       仅当「从外部 JSON 导入」时按 MAX_IMPORT_LOG 截断，防止异常数据撑爆存储。
// 本模块为纯函数（无 DOM / 无存储依赖），便于 Node 单测。
// ============================================================================

/** Anki revlog.type */
export const REVIEW_TYPES = { LEARN: 0, REVIEW: 1, RELEARN: 2, CRAM: 3 };

/** 反馈档位 → Anki ease（1~4） */
export const EASE_BY_FEEDBACK = { again: 1, hard: 2, good: 3, easy: 4 };
/** Anki ease → 反馈档位 */
export const FEEDBACK_BY_EASE = { 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' };

/** 外部 JSON 导入时的单卡日志上限（取最近的一批） */
export const MAX_IMPORT_LOG = 500;
/** 单次评分停留时长上限（毫秒） */
export const MAX_TIME_MS = 3600000;
export const SECS_PER_DAY = 86400;

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

/** 反馈档位 → ease（非法返回 null） */
export function easeOf(feedback) {
  return EASE_BY_FEEDBACK[feedback] || null;
}

/**
 * 本次评分对应的 Anki revlog.type。
 *  - 卡组里已是「复习」态又答「重来」→ 2（重学 / lapse）
 *  - 新卡或学习态答「重来」→ 0（学习步）
 *  - 评分前是新卡 / 学习态 → 0 / 2（学习步内继续）
 *  - 其余 → 1（复习）
 */
export function reviewTypeOf(before, feedback) {
  const state = (before && before.state) || 'new';
  if (feedback === 'again') return state === 'review' ? REVIEW_TYPES.RELEARN : REVIEW_TYPES.LEARN;
  if (state === 'new') return REVIEW_TYPES.LEARN;
  if (state === 'learning') return REVIEW_TYPES.RELEARN;
  return REVIEW_TYPES.REVIEW;
}

/** 日志主键（时间戳 + 卡片 id，保证同一张卡的不同次评分相互独立） */
function logId(ts, cardId) {
  return `${ts}-${String(cardId)}`;
}

/**
 * 生成一条日志（评分瞬间调用）。
 * @param {{cardId:string, ts:number, feedback:string, before?:object, after?:object, timeMs?:number}} p
 * @returns {object|null} 参数不合法（无卡片 / 未知反馈 / 无时间戳）时返回 null
 */
export function makeEntry({ cardId, ts, feedback, before, after, timeMs = 0 } = {}) {
  const ease = easeOf(feedback);
  const at = Math.round(Number(ts));
  if (!cardId || !ease || !isFinite(at) || at <= 0) return null;
  const ivl = num(after && after.interval);
  const lastIvl = num(before && before.interval);
  const ef = num(after && after.easeFactor);
  return {
    id: logId(at, cardId),
    cardId: String(cardId),
    ts: at,
    ease,
    type: reviewTypeOf(before, feedback),
    ivl: ivl != null && ivl > 0 ? ivl : 0,
    lastIvl: lastIvl != null && lastIvl > 0 ? lastIvl : 0,
    factor: clampFactor(ef),
    time: clampTime(timeMs)
  };
}

/** easeFactor（1.3~3.0）→ Anki 的整数 factor（1300~3000） */
export function clampFactor(ef) {
  const v = Number(ef);
  if (!isFinite(v) || v <= 0) return 2500;
  return Math.max(1300, Math.min(3000, Math.round(v * 1000)));
}

/** 停留时长钳制到 [0, 1 小时] */
export function clampTime(ms) {
  const v = Number(ms);
  if (!isFinite(v) || v <= 0) return 0;
  return Math.min(MAX_TIME_MS, Math.round(v));
}

const clampEase = (v) => {
  const n = Math.round(Number(v));
  return n >= 1 && n <= 4 ? n : 3;
};

const clampType = (v) => {
  const n = Math.round(Number(v));
  return n >= 0 && n <= 3 ? n : REVIEW_TYPES.REVIEW;
};


/**
 * 校验并规范化一条外部日志（不受信任的 JSON）：
 * 非法 → null；`ivl` / `lastIvl` 一律按「天」解读（本机 JSON 的单位约定）。
 * 说明：允许 cardId 缺失（外部 JSON 的卡片可能不写 id）——此时 cardId 为空字符串，
 *       由导入侧按单词匹配到具体卡片后回填（见 import-file.attachReviewLogs）。
 * @param {object} raw
 * @param {string} [fallbackCardId] 顶层卡片的 id（条目里没写 cardId 时兜底）
 */
export function sanitizeEntry(raw, fallbackCardId = '') {
  if (!raw || typeof raw !== 'object') return null;
  const ts = Math.round(Number(raw.ts));
  if (!isFinite(ts) || ts <= 0) return null;
  const cardId = String(raw.cardId || raw.cid || fallbackCardId || '');
  const clampDays = (v) => {
    const n = Number(v);
    return isFinite(n) && n > 0 ? Math.min(36500, n) : 0;
  };
  return {
    id: String(raw.id || logId(ts, cardId)),
    cardId,
    ts,
    ease: clampEase(raw.ease),
    type: clampType(raw.type),
    ivl: clampDays(raw.ivl),
    lastIvl: clampDays(raw.lastIvl),
    factor: clampFactor((Number(raw.factor) || 2500) / 1000),
    time: clampTime(raw.time)
  };
}

/** 按时间升序排序（返回新数组） */
export function sortEntries(list) {
  return [...(list || [])].sort((a, b) => a.ts - b.ts || String(a.id).localeCompare(String(b.id)));
}

/**
 * 把日志归属到另一张卡片（JSON 回导时卡片 id 会重新生成），同步刷新主键。
 * @param {object} entry
 * @param {string} cardId 目标卡片 id
 */
export function reattach(entry, cardId) {
  const id = String(cardId || '');
  if (!entry || !id || entry.cardId === id) return entry;
  return { ...entry, cardId: id, id: logId(entry.ts, id) };
}

/**
 * 从卡片 / 词条对象里读取复习日志：
 *   兼容 `reviewLog`（本机导出）与 `revlog`（Anki 风格）；无则返回 []。
 */
export function pickReviewLog(src) {
  const s = src || {};
  const raw = Array.isArray(s.reviewLog) ? s.reviewLog : Array.isArray(s.revlog) ? s.revlog : null;
  if (!raw || !raw.length) return [];
  const fallback = String(s.id || s.cardId || '');
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const e = sanitizeEntry(item, fallback);
    if (!e || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return sortEntries(out).slice(-MAX_IMPORT_LOG);
}

/** 遗忘次数（Anki cards.lapses）＝ type=2（重学）的条数 */
export function lapsesOf(list) {
  return (list || []).filter((e) => e && e.type === REVIEW_TYPES.RELEARN).length;
}

/** 汇总（卡组详情 / 测试断言用） */
export function summarize(list) {
  const rows = Array.isArray(list) ? list : [];
  const ease = { again: 0, hard: 0, good: 0, easy: 0 };
  let timeMs = 0;
  let lapses = 0;
  let first = null;
  let last = null;
  for (const e of rows) {
    const key = FEEDBACK_BY_EASE[e && e.ease];
    if (key) ease[key]++;
    timeMs += clampTime(e && e.time);
    if (e && e.type === REVIEW_TYPES.RELEARN) lapses++;
    if (e && (first == null || e.ts < first)) first = e.ts;
    if (e && (last == null || e.ts > last)) last = e.ts;
  }
  return { total: rows.length, lapses, timeMs, first, last, ease };
}

/** 本机「天」→ Anki 间隔值：≥1 天用整天；不足 1 天的学习步用「负秒数」（Anki 约定：正=天、负=秒） */
function toSignedIvl(days, learning) {
  const d = Math.max(0, Number(days) || 0);
  if (d >= 1) return Math.round(d);
  if (!learning) return 0;
  const secs = Math.round(d * SECS_PER_DAY);
  return secs > 0 ? -secs : 0;
}

/** 本机「天」→ Anki revlog.ivl（复习卡至少 1 天；学习步不足 1 天写负秒数） */
export function entryToAnkiIvl(entry) {
  const learning = entry ? entry.type === REVIEW_TYPES.LEARN || entry.type === REVIEW_TYPES.RELEARN : false;
  const v = toSignedIvl(entry && entry.ivl, learning);
  return !learning && v < 1 ? 1 : v;
}

/** 本机「天」→ Anki revlog.lastIvl（复习态允许 0：新卡首次评分前没有间隔） */
export function entryToAnkiLastIvl(entry) {
  const learning = entry ? entry.type === REVIEW_TYPES.LEARN || entry.type === REVIEW_TYPES.RELEARN : false;
  return toSignedIvl(entry && entry.lastIvl, learning);
}

/**
 * 一条日志 → Anki `revlog` 表插入值（顺序与 INSERT 语句一致）。
 * @param {object} entry 本机日志
 * @param {number} cid   卡包内对应的 cards.id
 * @param {number} id    revlog.id（毫秒，由调用方保证唯一）
 */
export function toAnkiRow(entry, cid, id) {
  return [
    id,
    cid,
    0, // usn
    entry.ease,
    entryToAnkiIvl(entry),
    entryToAnkiLastIvl(entry),
    Math.max(1300, Math.min(3000, Math.round(Number(entry.factor) || 2500))),
    clampTime(entry.time),
    entry.type
  ];
}
