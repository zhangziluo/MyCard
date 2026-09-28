// ============================================================================
// wordbook.js — 「我的生词」批量整理内核（纯函数，无 DOM / 无存储依赖）
//
// 用途（v0.5.9）：
//   1) 去重合并：找出「同一个词」的多张卡片（大小写 / 多余空格视为同一个词），
//      选定「主卡」保留复习进度与复习日志（revlog 挂在 cardId 上，主卡必须活下来），
//      把其余卡片的释义 / 例句 / 音标 / 标签合并进去，再删掉多余卡片。
//   2) 按标签整理：标签计数、批量加/去标签、整本重命名或删除某标签。
//   3) 筛选 / 排序 / 概览 / 多选助手：供 #/words 页面（wordbook-view.js）直接使用。
//
// 设计约定：
//   - 所有函数**不改动入参**（返回新数组 / patch 描述），由 store 统一落库，
//     便于 Node 单测（scripts/test-wordbook.mjs）。
//   - 「同一个词」= normKey(front)：去首尾空白 + 折叠内部空白 + 转小写。
//   - 主卡优先级：复习进度更靠前（review > learning > new → 次数 → 间隔 → 难度系数），
//     其次「加入时间更早」，最后按 id 稳定排序（保证结果可复现）。
// ============================================================================

/** 单词归一化键：去首尾空白、折叠内部空白、转小写 */
export function normKey(s) {
  return String(s ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** 复习状态排序权重（越大越「学得深」） */
export const STATE_RANK = { review: 2, learning: 1, new: 0 };

/** 主卡候选评分（数组按字典序比较，越大越优先保留） */
export function keepScore(card) {
  const c = card || {};
  const rank = STATE_RANK[c.state];
  return [
    rank == null ? 0 : rank,
    Math.max(0, Math.floor(Number(c.repetitions) || 0)),
    Math.max(0, Number(c.interval) || 0),
    Math.max(0, Number(c.easeFactor) || 0)
  ];
}

/** 字典序比较两个评分数组：>0 表示 a 更优 */
function cmpScore(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** 加入时间（缺失视为最晚，让有记录的先当主卡） */
function joinTime(c) {
  const t = Number((c && (c.addedAt || c.createdAt)) || 0);
  return t > 0 ? t : Infinity;
}

/** 一个重复组里应保留的「主卡」（进度最优 → 加入最早 → id 稳定） */
export function pickKeeper(cards) {
  const list = (cards || []).filter(Boolean);
  if (!list.length) return null;
  return list
    .slice()
    .sort(
      (a, b) =>
        cmpScore(keepScore(b), keepScore(a)) ||
        joinTime(a) - joinTime(b) ||
        String(a.id).localeCompare(String(b.id))
    )[0];
}

/** 按归一化单词分组，返回出现 ≥2 次的重复组（组内保持原始顺序） */
export function dupGroups(cards) {
  const map = new Map();
  for (const c of cards || []) {
    if (!c) continue;
    const key = normKey(c.front);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(c);
  }
  const out = [];
  for (const [key, list] of map) {
    if (list.length < 2) continue;
    const keeper = pickKeeper(list);
    out.push({ key, front: keeper ? keeper.front : list[0].front, cards: list, keepId: keeper ? keeper.id : null });
  }
  out.sort((a, b) => b.cards.length - a.cards.length || a.key.localeCompare(b.key));
  return out;
}

/** 重复情况概览：{ groups, groupCount, redundant, words } */
export function dedupeStats(cards) {
  const groups = dupGroups(cards);
  return {
    groups,
    groupCount: groups.length,
    redundant: groups.reduce((n, g) => n + g.cards.length - 1, 0),
    words: groups.map((g) => g.front)
  };
}

/* ------------------------------ 合并（去重） ------------------------------ */

/**
 * 合并若干个文本列表：去掉空值与重复（大小写不敏感），保持出现顺序。
 * 可传数组或单值（单值会被当作只含一项的列表）。
 */
export function mergeText(...lists) {
  const out = [];
  const seen = new Set();
  for (const raw of lists) {
    const list = Array.isArray(raw) ? raw : raw == null || raw === '' ? [] : [raw];
    for (const v of list) {
      const s = String(v ?? '').trim();
      if (!s) continue;
      const k = s.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}

/** 释义序列：back 为第一义，其余（含已有 extraBacks）按顺序追加 */
function senseSeq(cards) {
  const seq = [];
  for (const c of cards || []) {
    if (!c) continue;
    seq.push(c.back);
    for (const b of c.extraBacks || []) seq.push(b);
  }
  return mergeText(seq);
}

/** 按「主卡在前、副卡在后」的释义序列生成 back / extraBacks 补丁 */
function sensePatch(main, others) {
  const backs = senseSeq([main, ...others]);
  const head = String((main && main.back) || '').trim() || backs[0] || '';
  const rest = backs.filter((b) => b.toLowerCase() !== head.toLowerCase());
  const patch = {};
  const prevHead = String((main && main.back) || '');
  const prevRest = ((main && main.extraBacks) || []).map(String);
  if (head !== prevHead) patch.back = head;
  if (rest.join('\n') !== prevRest.join('\n')) patch.extraBacks = rest;
  return patch;
}

/** 取第一个非空文本（用于补音标 / 例句这类「有就好」的字段） */
function firstNonEmpty(cards, field) {
  for (const c of cards || []) {
    const v = c && c[field];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return '';
}

/**
 * 把一条「新查到的词条」并入已有卡片（不动复习进度）。
 * 语义：原 back 永远是第一义，新释义追加为 extraBacks；空字段才补。
 * @param {object} card 已有卡片
 * @param {object} item { front, back, extraBacks, phonetic/ipa, example, exampleZh, tags }
 * @returns {{ patch:object, changed:boolean }}
 */
export function mergeInto(card, item) {
  const c = card || {};
  const it = item || {};
  const incoming = {
    back: String(it.back ?? it.word ?? '').trim(),
    extraBacks: Array.isArray(it.extraBacks) ? it.extraBacks : []
  };
  const patch = sensePatch(c, [incoming]);
  if (!String(c.phonetic || '').trim() && String(it.phonetic ?? it.ipa ?? '').trim()) {
    patch.phonetic = String(it.phonetic ?? it.ipa).trim();
  }
  if (!String(c.example || '').trim() && String(it.example ?? '').trim()) patch.example = String(it.example).trim();
  if (!String(c.exampleZh || '').trim() && String(it.exampleZh ?? '').trim()) patch.exampleZh = String(it.exampleZh).trim();
  const tags = mergeText(c.tags, it.tags);
  if (tags.join('\n') !== ((c.tags || []).map(String).join('\n'))) patch.tags = tags;
  return { patch, changed: Object.keys(patch).length > 0 };
}

/**
 * 一个重复组 → 合并方案：保留主卡（复习进度 / 复习日志不丢）+ 字段补丁 + 待删除卡片 id。
 * @returns {{ keepId:string, front:string, patch:object, removeIds:string[], senses:number, groupSize:number }|null}
 */
export function mergeGroup(cards) {
  const list = (cards || []).filter(Boolean);
  if (list.length < 2) return null;
  const keeper = pickKeeper(list);
  const others = list.filter((c) => c !== keeper);
  const patch = sensePatch(keeper, others);
  const all = [keeper, ...others];
  const phonetic = firstNonEmpty(all, 'phonetic');
  if (phonetic && String(keeper.phonetic || '').trim() !== phonetic) patch.phonetic = phonetic;
  const example = firstNonEmpty(all, 'example');
  if (example && String(keeper.example || '').trim() !== example) patch.example = example;
  const exampleZh = firstNonEmpty(all, 'exampleZh');
  if (exampleZh && String(keeper.exampleZh || '').trim() !== exampleZh) patch.exampleZh = exampleZh;
  const tags = mergeText(...all.map((c) => c.tags));
  if (tags.join('\n') !== ((keeper.tags || []).map(String).join('\n'))) patch.tags = tags;
  const groups = mergeText(...all.map((c) => c.groups));
  if (groups.join('\n') !== ((keeper.groups || []).map(String).join('\n'))) patch.groups = groups;
  const backs = senseSeq(all); // 合并后的完整释义序列（报告里预览用）
  return {
    keepId: keeper.id,
    front: keeper.front,
    patch,
    removeIds: others.map((c) => c.id),
    backs,
    senses: backs.length,
    groupSize: list.length
  };
}

/** 全部重复组的合并方案（可直接交给 store.mergeCards 一次应用） */
export function mergePlans(cards) {
  return dupGroups(cards)
    .map((g) => mergeGroup(g.cards))
    .filter(Boolean);
}

/* ------------------------------ 标签整理 ------------------------------ */

/** 标签计数：各标签出现次数（降序）+ 未打标签卡片数 */
export function tagCounts(cards) {
  const map = new Map();
  let untagged = 0;
  for (const c of cards || []) {
    if (!c) continue;
    const tags = mergeText(c.tags);
    if (!tags.length) {
      untagged++;
      continue;
    }
    for (const t of tags) {
      const key = t.toLowerCase();
      const hit = map.get(key);
      if (hit) hit.count++;
      else map.set(key, { tag: t, count: 1 });
    }
  }
  const list = [...map.values()];
  list.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  return { list, untagged, total: list.length };
}

/** 来源显示名 */
export function srcLabel(src) {
  const s = String(src || '');
  if (s === 'online_lookup') return '在线查词';
  if (s === 'batch_import') return '词表导入';
  if (s === 'file_import') return '文件导入';
  return s || '其它';
}

/** 来源计数（在线查词 / 词表导入 / 其它） */
export function srcCounts(cards) {
  const map = new Map();
  for (const c of cards || []) {
    if (!c) continue;
    const src = c.src ? String(c.src) : '';
    map.set(src, (map.get(src) || 0) + 1);
  }
  return [...map]
    .map(([src, count]) => ({ src, label: srcLabel(src), count }))
    .sort((a, b) => b.count - a.count);
}

/** 批量标签编辑 → 新标签数组（纯，不改入参） */
export function applyTagEdit(tags, { add = [], remove = [] } = {}) {
  const kill = new Set(mergeText(remove).map((t) => t.toLowerCase()));
  const kept = mergeText(tags).filter((t) => !kill.has(t.toLowerCase()));
  return mergeText(kept, add);
}

/** 批量标签方案：只返回真正发生变化的卡片 [{ id, tags, patch }] */
export function tagPatchPlans(cards, ids, opts = {}) {
  const want = new Set([...(ids || [])].map(String));
  const out = [];
  for (const c of cards || []) {
    if (!c || !want.has(String(c.id))) continue;
    const now = mergeText(c.tags);
    const next = applyTagEdit(now, opts);
    if (next.join('\n') === now.join('\n')) continue;
    out.push({ id: c.id, tags: next, patch: { tags: next } });
  }
  return out;
}

/** 整本重命名标签（to 为空 = 删除该标签）→ [{ id, tags, patch }] */
export function renameTagPlans(cards, from, to) {
  const key = normKey(from);
  if (!key) return [];
  const target = String(to ?? '').trim();
  const out = [];
  for (const c of cards || []) {
    if (!c) continue;
    const tags = mergeText(c.tags);
    if (!tags.some((t) => t.toLowerCase() === key)) continue;
    const rest = tags.filter((t) => t.toLowerCase() !== key);
    const next = target ? mergeText(rest, [target]) : rest;
    out.push({ id: c.id, tags: next, patch: { tags: next } });
  }
  return out;
}

/* ------------------------------ 筛选 / 排序 ------------------------------ */

/** 「全部」筛选值 */
export const ALL = '全部';
/** 「未打标签」筛选值（不会与真实标签冲突） */
export const UNTAGGED = '__untagged__';

/** 排序方式（UI 下拉与测试共用一份清单） */
export const SORTS = [
  { id: 'added', label: '加入时间（新→旧）' },
  { id: 'alpha', label: '字母序' },
  { id: 'level', label: '关卡顺序' }
];

/** 按 关键词 / 标签 / 来源 筛选（关键词命中 正面·释义·其它释义·例句·标签） */
export function filterWords(cards, { q = '', tag = ALL, src = ALL } = {}) {
  const query = String(q || '').trim().toLowerCase();
  const wantTag = tag === ALL ? null : tag === UNTAGGED ? UNTAGGED : normKey(tag);
  const wantSrc = src === ALL ? null : String(src);
  return (cards || []).filter((c) => {
    if (!c) return false;
    if (wantTag) {
      const tags = mergeText(c.tags);
      const hit = wantTag === UNTAGGED ? !tags.length : tags.some((t) => normKey(t) === wantTag);
      if (!hit) return false;
    }
    if (wantSrc != null && String(c.src || '') !== wantSrc) return false;
    if (query) {
      const hay = mergeText([c.front], [c.back], c.extraBacks, [c.example], [c.exampleZh], c.tags)
        .join(' ')
        .toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });
}

/** 排序（不修改入参数组） */
export function sortWords(cards, by = 'added') {
  const list = (cards || []).filter(Boolean).slice();
  const alpha = (a, b) => normKey(a.front).localeCompare(normKey(b.front));
  if (by === 'alpha') list.sort(alpha);
  else if (by === 'level') list.sort((a, b) => ((a.level ?? 0) - (b.level ?? 0)) || alpha(a, b));
  else list.sort((a, b) => joinTime(b) - joinTime(a) || alpha(a, b));
  return list;
}

/* ------------------------------ 概览 / 多选 ------------------------------ */

/** 生词本概览（单遍遍历） */
export function statsOf(cards) {
  const list = (cards || []).filter(Boolean);
  const tags = tagCounts(list);
  const dup = dedupeStats(list);
  let noBack = 0;
  let noExample = 0;
  let learned = 0;
  for (const c of list) {
    if (!String(c.back || '').trim()) noBack++;
    if (!String(c.example || '').trim()) noExample++;
    if (c.lastReview != null) learned++;
  }
  return {
    total: list.length,
    learned,
    noBack,
    noExample,
    dupGroups: dup.groupCount,
    redundant: dup.redundant,
    tagTotal: tags.total,
    untagged: tags.untagged
  };
}

/** 把「id 集合」统一成 Set<string>（同时接受数组 / Set / undefined） */
function toIdSet(ids) {
  return new Set([...(ids || [])].map(String));
}

/** 选中集合：增删一个 id（返回新 Set） */
export function toggleId(ids, id) {
  const next = toIdSet(ids);
  const key = String(id);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** 一批卡片的 id 列表 */
export function idsOf(cards) {
  return (cards || []).filter(Boolean).map((c) => String(c.id));
}

/** 是否已全选（空列表视为未全选） */
export function isAllSelected(cards, ids) {
  const list = idsOf(cards);
  const sel = toIdSet(ids);
  return list.length > 0 && list.every((id) => sel.has(id));
}

/** 是否部分选中 */
export function isPartialSelected(cards, ids) {
  const sel = toIdSet(ids);
  const hit = idsOf(cards).filter((id) => sel.has(id)).length;
  return hit > 0 && !isAllSelected(cards, sel);
}

/** 把选中集合限制在给定卡片范围内（切换筛选后丢弃看不见的选中项） */
export function limitSelection(cards, ids) {
  const keep = new Set(idsOf(cards));
  const next = new Set();
  for (const id of ids || []) if (keep.has(String(id))) next.add(String(id));
  return next;
}

/** 需要「在线补查」的词：选中的词，或（未选中时）全部缺释义的词 */
export function lookupTargets(cards, ids, { onlyMissing = false } = {}) {
  const sel = new Set([...(ids || [])].map(String));
  const useSel = sel.size > 0;
  const out = [];
  for (const c of cards || []) {
    if (!c) continue;
    if (useSel && !sel.has(String(c.id))) continue;
    if (onlyMissing && String(c.back || '').trim()) continue;
    const w = String(c.front || '').trim();
    if (w) out.push(w);
  }
  return mergeText(out);
}




