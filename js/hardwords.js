// ============================================================================
// hardwords.js — 「困难词」标记（localStorage）
// 翻转记忆中点击「重来 / 不认识」的卡片会被标记为困难词；「轻松」会取消标记。
// 用途：重新进入翻转时困难词前置到队列前几张；测试时提高其出现概率。
//   key: mycard-hard-words → { [deckId]: { [cardId]: count } }
// ============================================================================

const HARD_KEY = 'mycard-hard-words';

function read() {
  try {
    const raw = localStorage.getItem(HARD_KEY);
    const data = raw ? JSON.parse(raw) : null;
    return data && typeof data === 'object' ? data : {};
  } catch (e) {
    return {};
  }
}

function write(data) {
  try {
    localStorage.setItem(HARD_KEY, JSON.stringify(data));
  } catch (e) {}
}

/** 标记为困难词（次数 +1），返回该词累计次数 */
export function markHard(deckId, cardId) {
  const data = read();
  const dk = String(deckId);
  if (!data[dk] || typeof data[dk] !== 'object') data[dk] = {};
  const ck = String(cardId);
  data[dk][ck] = (Number(data[dk][ck]) || 0) + 1;
  write(data);
  return data[dk][ck];
}

/** 取消困难词标记（如点击「轻松」） */
export function clearHard(deckId, cardId) {
  const data = read();
  const dk = String(deckId);
  if (!data[dk] || typeof data[dk] !== 'object') return;
  delete data[dk][String(cardId)];
  if (!Object.keys(data[dk]).length) delete data[dk];
  write(data);
}

/** 是否困难词 */
export function isHard(deckId, cardId) {
  const d = read()[String(deckId)];
  return !!(d && Number(d[String(cardId)]) > 0);
}

/** 困难词数量 */
export function hardCount(deckId) {
  const d = read()[String(deckId)];
  return d && typeof d === 'object' ? Object.keys(d).length : 0;
}

/** 困难词 id 集合（Set<string>） */
export function hardSet(deckId) {
  const d = read()[String(deckId)];
  return new Set(d && typeof d === 'object' ? Object.keys(d) : []);
}

/** 清空某卡组（deckId 省略则清空全部）的困难词标记 */
export function clearAll(deckId) {
  const data = read();
  if (deckId == null) {
    write({});
    return;
  }
  delete data[String(deckId)];
  write(data);
}
