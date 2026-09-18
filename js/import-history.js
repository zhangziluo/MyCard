// ============================================================================
// import-history.js — 导入历史与回滚（撤销导入）
//
// 记录每次导入（时间 / 文件 / 目标卡组 / 新增张数 / 模式），并支持撤销：
//   - mode='new'    → 删除该次新建的卡组
//   - mode='append' → 批量移除该次追加进已有卡组的卡片
//
// 存储：
//   - 摘要：localStorage['mycard-import-history']（保留最近 MAX_HISTORY 条）
//   - 回滚明细（append 的 cardIds）：IndexedDB `meta`，key = `import-rollback:{id}`
//     （只保留最近 MAX_ROLLBACK 条，避免无限增长；new 模式只需 deckId，无需明细）
// ============================================================================

import * as store from './store.js';
import * as idb from './idb.js';
import { on, toast, esc, openModal, closeModal, navigate } from './ui.js';

export const HISTORY_KEY = 'mycard-import-history';
export const ROLLBACK_PREFIX = 'import-rollback:';
export const MAX_HISTORY = 20;
/** 仅最近 N 次保留「追加导入」的 cardIds 明细（精确回滚窗口） */
export const MAX_ROLLBACK = 5;

/* ------------------------------ 存储 ------------------------------ */

function readAll() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const d = raw ? JSON.parse(raw) : null;
    return Array.isArray(d) ? d : [];
  } catch (e) {
    return [];
  }
}

function writeAll(list) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch (e) {}
}

/** 历史列表（新 → 旧） */
export function listImports() {
  return readAll();
}

async function saveRollback(id, data) {
  if (!idb.isAvailable()) return false;
  try {
    await idb.put(idb.STORE_META, { key: ROLLBACK_PREFIX + id, data });
    return true;
  } catch (e) {
    return false;
  }
}

async function loadRollback(id) {
  if (!idb.isAvailable()) return null;
  try {
    const r = await idb.get(idb.STORE_META, ROLLBACK_PREFIX + id);
    return (r && r.data) || null;
  } catch (e) {
    return null;
  }
}

async function dropRollback(id) {
  if (!idb.isAvailable()) return;
  try {
    await idb.del(idb.STORE_META, ROLLBACK_PREFIX + id);
  } catch (e) {}
}

/** 有「追加回滚明细」的导入 id 集合 */
export async function rollbackIds() {
  const out = new Set();
  for (const e of readAll().slice(0, MAX_ROLLBACK)) if (await loadRollback(e.id)) out.add(e.id);
  return out;
}

/* ------------------------------ 记录 / 撤销 ------------------------------ */

/**
 * 记录一次导入。
 * @param {Array<{fileName,deckId,deckName,added,skipped,mode,addedCardIds}>} files
 * @returns {Promise<object>} 历史条目（含 id）
 */
export async function recordImport(files, { ts = Date.now() } = {}) {
  const list = readAll();
  const norm = (files || []).map((f) => ({
    fileName: f.fileName || '',
    deckId: f.deckId || null,
    deckName: f.deckName || '',
    added: Number(f.added) || 0,
    skipped: Number(f.skipped) || 0,
    mode: f.mode === 'append' ? 'append' : 'new'
  }));
  const entry = {
    id: 'imp-' + ts.toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    ts,
    total: norm.reduce((s, f) => s + f.added, 0),
    files: norm
  };
  const kept = [entry, ...list].slice(0, MAX_HISTORY);
  writeAll(kept);

  // append 才需要 cardIds 明细（new 直接删卡组即可）
  const details = (files || [])
    .filter((f) => f.mode === 'append' && Array.isArray(f.addedCardIds) && f.addedCardIds.length)
    .map((f) => ({ deckId: f.deckId, ids: f.addedCardIds }));
  if (details.length) await saveRollback(entry.id, details);

  // 清理超出回滚窗口的旧明细
  for (const e of kept.slice(MAX_ROLLBACK)) await dropRollback(e.id);
  return entry;
}

/**
 * 撤销一次导入（new → 删卡组；append → 批量移除卡片）。
 * @returns {Promise<{ok:boolean, undone:number, error?:string}>}
 */
export async function undoImport(id) {
  const list = readAll();
  const entry = list.find((e) => e.id === id);
  if (!entry) return { ok: false, undone: 0, error: '找不到该导入记录' };
  const details = await loadRollback(id);
  let undone = 0;
  try {
    for (const f of entry.files) {
      if (f.mode === 'new') {
        if (f.deckId && store.getDeck(f.deckId)) store.deleteDeck(f.deckId);
        undone++;
      } else {
        const d = (details || []).find((x) => x.deckId === f.deckId);
        if (d && Array.isArray(d.ids) && store.getDeck(f.deckId)) {
          store.deleteCards(f.deckId, d.ids);
          undone++;
        }
      }
    }
  } catch (e) {
    return { ok: false, undone, error: (e && e.message) || String(e) };
  }
  writeAll(readAll().filter((e) => e.id !== id));
  await dropRollback(id);
  return { ok: true, undone };
}

/** 清空导入历史（含回滚明细） */
export async function clearHistory() {
  for (const e of readAll()) await dropRollback(e.id);
  writeAll([]);
}

/* ------------------------------ UI ------------------------------ */

/** 时间 → 友好文案 */
export function historyTimeLabel(ts, now = Date.now()) {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (new Date(now).toDateString() === d.toDateString()) return `今天 ${hm}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}

/** 单条历史 HTML */
export function historyItemHtml(e, { undoable = false } = {}) {
  const files = e.files || [];
  const names = files.map((f) => f.deckName || f.fileName || '—').join('、');
  const modes = [...new Set(files.map((f) => (f.mode === 'append' ? '追加' : '新建')))].join('/');
  return `<div class="history-item glass">
    <div class="history-main">
      <b>${esc(names)}</b>
      <span class="csv-meta">${esc(historyTimeLabel(e.ts))} · ${files.length} 个文件 · 共 ${e.total} 张 · ${esc(modes || '新建')}</span>
    </div>
    ${undoable ? `<button class="btn-link" data-action="import-undo" data-id="${esc(e.id)}">撤销</button>` : '<span class="csv-hint">不可撤销</span>'}
  </div>`;
}

/** 历史列表 HTML */
export function historyListHtml(list, undoableSet) {
  if (!list || !list.length) return '<p class="csv-hint">还没有导入记录。</p>';
  return `<div class="history-list">${list.map((e) => historyItemHtml(e, { undoable: undoableSet.has(e.id) })).join('')}</div>`;
}

/** 「可撤销」id 集合：new 模式总能撤；append 需有明细 */
export async function undoableIds() {
  const set = await rollbackIds();
  for (const e of listImports()) if ((e.files || []).some((f) => f.mode === 'new' && f.deckId)) set.add(e.id);
  return set;
}

/** 打开「导入历史」弹窗 */
export async function openHistoryModal() {
  const list = listImports();
  const undoable = await undoableIds();
  openModal({
    title: '导入历史',
    wide: true,
    body:
      historyListHtml(list, undoable) +
      '<p class="csv-hint">「撤销」会删除该次<b>新建</b>的卡组，或移除该次<b>追加</b>进已有卡组的卡片（追加导入仅保留最近 5 次可精确回滚）。</p>',
    actions: [
      {
        label: '清空历史',
        cls: 'btn-ghost',
        onClick: async () => {
          await clearHistory();
          toast('导入历史已清空');
          setTimeout(() => openHistoryModal(), 120);
          return true;
        }
      },
      { label: '关闭', cls: 'btn-ghost' }
    ]
  });
}

/** 首页「导入历史」图标按钮 */
export function importHistoryButtonHtml() {
  return `<button class="icon-btn glass" data-action="import-history" aria-label="导入历史" title="导入历史"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3.5 2"/></svg></button>`;
}

/* ------------------------------ Action 注册 ------------------------------ */

on('import-history', () => {
  openHistoryModal();
});

on('import-undo', async (el) => {
  const id = el.dataset && el.dataset.id;
  const res = await undoImport(id);
  if (res.ok) {
    closeModal();
    toast(`已撤销本次导入（${res.undone} 个卡组）`);
    navigate('#/home');
  } else {
    toast(`撤销失败：${res.error || '未知错误'}`, 'error');
  }
});
