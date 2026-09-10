// ============================================================================
// levelstats.js — 关卡挑战统计（sessionStorage）
// 记录每个卡组每关的「重刷次数」与「历史最佳正确率(%)」。
//   key: mycard-level-stats → { [deckId]: { [level]: { retries, best } } }
// 注意：使用 sessionStorage，关闭标签页后重置（按需求指定的存储位置）。
// ============================================================================

const STATS_KEY = 'mycard-level-stats';

function read() {
  try {
    const raw = sessionStorage.getItem(STATS_KEY);
    const data = raw ? JSON.parse(raw) : null;
    return data && typeof data === 'object' ? data : {};
  } catch (e) {
    return {};
  }
}

function write(data) {
  try {
    sessionStorage.setItem(STATS_KEY, JSON.stringify(data));
  } catch (e) {}
}

function slot(data, deckId, level) {
  const dk = String(deckId);
  if (!data[dk] || typeof data[dk] !== 'object') data[dk] = {};
  const lk = String(level);
  if (!data[dk][lk] || typeof data[dk][lk] !== 'object') data[dk][lk] = { retries: 0, best: null };
  const s = data[dk][lk];
  if (typeof s.retries !== 'number' || s.retries < 0) s.retries = 0;
  if (typeof s.best !== 'number') s.best = null;
  return s;
}

/** 读取某关统计（无记录时返回 { retries: 0, best: null }） */
export function getLevelStats(deckId, level) {
  const s = slot(read(), deckId, level);
  return { retries: s.retries, best: s.best };
}

/** 重刷次数 +1（用于「重新挑战 / 再测一次」） */
export function bumpRetries(deckId, level) {
  const data = read();
  const s = slot(data, deckId, level);
  s.retries += 1;
  write(data);
  return { retries: s.retries, best: s.best };
}

/** 记录本次正确率(%)，仅当高于历史最佳时更新 */
export function recordScore(deckId, level, pct) {
  const data = read();
  const s = slot(data, deckId, level);
  const v = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  if (s.best == null || v > s.best) s.best = v;
  write(data);
  return { retries: s.retries, best: s.best };
}

/** 清空全部关卡统计（测试/重置用） */
export function clearLevelStats() {
  try {
    sessionStorage.removeItem(STATS_KEY);
  } catch (e) {}
}
