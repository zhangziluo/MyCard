// ============================================================================
// wordbook-view.js — v0.5.9「生词本整理」页（#/words）
//
// 页面职责（纯页面逻辑：算数据靠 wordbook.js，写数据靠 store.js）：
//   1) 筛选排序：关键词搜索 / 标签 chips / 来源 chips / 只看缺释义 / 排序方式 / 分页
//   2) 多选批量：加标签、去标签、在线补查（回填首页查词框）、删除
//   3) 去重合并：先出「合并报告」（保留哪张、合并后有几个释义、删几张）→ 确认后一次落库
//   4) 标签管理：整本重命名 / 删除某个标签
//
// 落库约定：写操作一律「先出报告 → 用户确认 → 单次 store 调用」，与导入 / 复习流程一致；
//          被删掉的副卡由 store 级联清理复习日志（revlog），复习进度不丢。
// 状态：筛选 / 排序 / 选中在内存（切页不丢），分页走 URL（#/words?page=N，可回退）。
// ============================================================================

import * as store from './store.js';
import * as wb from './wordbook.js';
import { esc, on, icon, navigate, openModal, readForm, toast, confirmDialog, parseTags } from './ui.js';
import { cardFormModal } from './decks.js';
import { prefillInput } from './add-words.js';

/** 每页条数（生词本可能上千条，分页渲染避免卡顿） */
export const WORDS_PER_PAGE = 100;

/** 页面状态（筛选 / 排序 / 选中） */
const S = {
  q: '',
  tag: wb.ALL,
  src: wb.ALL,
  sort: 'added',
  missing: false,
  sel: new Set()
};

let searchTimer = null; // 搜索输入防抖

/* ------------------------------ 小工具 ------------------------------ */

function byId(id) {
  return typeof document !== 'undefined' && document.getElementById ? document.getElementById(id) : null;
}

function rootView() {
  return byId('view');
}

function userDeck() {
  return store.getUserDeck();
}

function userCards() {
  const d = userDeck();
  return d ? d.cards : [];
}

/** URL 里的页码（1 起，非法值按 1） */
function pageFromHash() {
  const loc = typeof location !== 'undefined' ? location : null;
  const raw = loc && loc.hash ? String(loc.hash) : '';
  const m = raw.match(/[?&]page=(\d+)/);
  const n = m ? Number(m[1]) : 1;
  return n > 0 ? n : 1;
}

/** 渲染（分页重置时走 URL，保证浏览器回退行为正常） */
function rerender({ resetPage = false } = {}) {
  const root = rootView();
  if (!root) return;
  if (resetPage && pageFromHash() !== 1) {
    navigate('#/words');
    return; // hashchange → app.render → renderWordbook
  }
  renderWordbook(root);
}

function focusSearchBox(root) {
  if (!root || !root.querySelector) return;
  const el = root.querySelector('#wb-search');
  if (el && el.focus) {
    el.focus();
    if (el.setSelectionRange) el.setSelectionRange(el.value.length, el.value.length);
  }
}

/* ------------------------------ 数据视图（测试可直接调用） ------------------------------ */

/** 当前筛选（未排序）命中的卡片 */
export function filteredCards() {
  let list = wb.filterWords(userCards(), { q: S.q, tag: S.tag, src: S.src });
  if (S.missing) list = list.filter((c) => !String(c.back || '').trim());
  return list;
}

/** 当前筛选 + 排序后的全部卡片 */
export function visibleCards() {
  return wb.sortWords(filteredCards(), S.sort);
}

/** 当前页卡片 */
export function pageCards() {
  const all = visibleCards();
  const start = (pageFromHash() - 1) * WORDS_PER_PAGE;
  return all.slice(start, start + WORDS_PER_PAGE);
}

/** 页面状态快照（测试用） */
export function getViewState() {
  return { ...S, sel: new Set(S.sel), page: pageFromHash() };
}

/** 设置页面状态（测试用；sel 接受数组 / Set） */
export function setViewState(patch = {}) {
  if ('q' in patch) S.q = String(patch.q || '');
  if ('tag' in patch) S.tag = patch.tag || wb.ALL;
  if ('src' in patch) S.src = patch.src === undefined || patch.src === null ? wb.ALL : String(patch.src);
  if ('sort' in patch) S.sort = patch.sort || 'added';
  if ('missing' in patch) S.missing = !!patch.missing;
  if ('sel' in patch) S.sel = new Set([...(patch.sel || [])].map(String));
  return getViewState();
}


/* ------------------------------ HTML 片段（纯函数，测试可直接断言） ------------------------------ */

/** 学习状态小徽标 */
function stateChip(card) {
  const label = card.state === 'review' ? '复习' : card.state === 'learning' ? '学习' : '新词';
  const cls = card.state === 'review' ? 'pill-learned' : card.state === 'learning' ? 'pill-live' : 'pill-lock';
  return `<span class="pill ${cls}">L${(card.level ?? 0) + 1} · ${label}</span>`;
}

/** 单行卡片 HTML */
export function wbRowHtml(card, picked = false) {
  const c = card || {};
  const front = String(c.front || '').trim();
  const back = String(c.back || '').trim();
  const extra = (c.extraBacks || []).length;
  const tags = (c.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
  return `
  <div class="card-row glass wb-item${picked ? ' is-picked' : ''}">
    <label class="wb-check">
      <input type="checkbox" data-action="wb-pick" data-card="${esc(c.id)}"${picked ? ' checked' : ''}
        aria-label="选择 ${esc(front || '未命名词')}">
    </label>
    <div class="card-row-main">
      <div class="card-row-q">${front ? esc(front) : '<i class="wb-void">（无正面）</i>'}${
        c.phonetic ? `<span class="wb-ipa">${esc(c.phonetic)}</span>` : ''
      }</div>
      <div class="card-row-a">${back ? esc(back) : '<i class="wb-void">（缺释义，可「在线补查」）</i>'}${
        extra ? `<span class="wb-more">+${extra} 义</span>` : ''
      }</div>
      ${c.example ? `<div class="card-row-ex">${esc(c.example)}</div>` : ''}
      <div class="card-row-tags">
        ${stateChip(c)}
        ${tags}
        ${c.src ? `<span class="tag tag-src">${esc(wb.srcLabel(c.src))}</span>` : ''}
      </div>
    </div>
    <div class="card-row-ops">
      <button class="icon-btn" data-action="wb-edit" data-card="${esc(c.id)}" aria-label="编辑">${icon('edit', 17)}</button>
      <button class="icon-btn danger" data-action="wb-remove" data-card="${esc(c.id)}" aria-label="删除">${icon('trash', 17)}</button>
    </div>
  </div>`;
}

/** 标签 / 来源 筛选 chips */
export function wbChipsHtml(cards, state = S) {
  const list = cards || [];
  const counts = wb.tagCounts(list);
  const chips = [
    `<button class="chip${state.tag === wb.ALL ? ' chip-on' : ''}" data-action="wb-tag" data-tag="${wb.ALL}" aria-pressed="${
      state.tag === wb.ALL
    }">全部 (${list.length})</button>`
  ];
  if (counts.untagged) {
    chips.push(
      `<button class="chip${state.tag === wb.UNTAGGED ? ' chip-on' : ''}" data-action="wb-tag" data-tag="${
        wb.UNTAGGED
      }" aria-pressed="${state.tag === wb.UNTAGGED}">未打标签 (${counts.untagged})</button>`
    );
  }
  for (const t of counts.list) {
    chips.push(
      `<button class="chip${state.tag === t.tag ? ' chip-on' : ''}" data-action="wb-tag" data-tag="${esc(
        t.tag
      )}" aria-pressed="${state.tag === t.tag}">${esc(t.tag)} (${t.count})</button>`
    );
  }
  const srcChips = [];
  const srcs = wb.srcCounts(list);
  if (srcs.length) {
    srcChips.push(
      `<button class="chip chip-src${state.src === wb.ALL ? ' chip-on' : ''}" data-action="wb-src" data-src="${
        wb.ALL
      }" aria-pressed="${state.src === wb.ALL}">全部来源</button>`
    );
    for (const s of srcs) {
      srcChips.push(
        `<button class="chip chip-src${state.src === s.src ? ' chip-on' : ''}" data-action="wb-src" data-src="${esc(
          s.src
        )}" aria-pressed="${state.src === s.src}">${esc(s.label)} (${s.count})</button>`
      );
    }
  }
  return (
    `<div class="chips scroll-x" id="wb-tag-chips" role="group" aria-label="按标签筛选">${chips.join('')}</div>` +
    (srcChips.length
      ? `<div class="chips scroll-x" id="wb-src-chips" role="group" aria-label="按来源筛选">${srcChips.join('')}</div>`
      : '')
  );
}


/** 顶部概览（总数 / 缺释义 / 重复组 / 未打标签，都可点击下钻） */
export function wbOverviewHtml(cards) {
  const st = wb.statsOf(cards);
  const off = (n) => (n ? '' : ' is-off');
  return `
  <div class="wb-stats glass" role="group" aria-label="生词本概览（可点击下钻）">
    <button class="wb-stat" data-action="wb-all" aria-label="生词总数 ${st.total}，查看全部"><b>${st.total}</b><span>生词总数</span></button>
    <button class="wb-stat${off(st.noBack)}${S.missing ? ' chip-on' : ''}" data-action="wb-toggle-missing" aria-pressed="${
      S.missing ? 'true' : 'false'
    }"><b>${
      st.noBack
    }</b><span>缺释义</span></button>
    <button class="wb-stat${off(st.dupGroups)}" data-action="wb-dedupe-report" ${st.dupGroups ? '' : 'disabled'}><b>${
      st.dupGroups
    }</b><span>重复词组</span></button>
    <button class="wb-stat${off(st.untagged)}${S.tag === wb.UNTAGGED ? ' chip-on' : ''}" data-action="wb-tag" data-tag="${
      wb.UNTAGGED
    }" aria-pressed="${S.tag === wb.UNTAGGED ? 'true' : 'false'}"><b>${st.untagged}</b><span>未打标签</span></button>
  </div>`;
}

/** 多选批量操作栏（未选中任何卡片时不渲染） */
export function wbBatchBarHtml(count) {
  if (!count) return '';
  return `
  <div class="wb-batch glass">
    <span class="wb-batch-info">已选 <b>${count}</b> 张</span>
    <div class="wb-batch-ops">
      <button class="btn btn-ghost btn-sm" data-action="wb-batch-tag">${icon('tag', 15)} 加标签</button>
      <button class="btn btn-ghost btn-sm" data-action="wb-batch-untag">去标签</button>
      <button class="btn btn-ghost btn-sm" data-action="wb-batch-lookup">在线补查</button>
      <button class="btn btn-ghost btn-sm danger" data-action="wb-batch-delete">${icon('trash', 15)} 删除</button>
      <button class="btn-link" data-action="wb-clear-sel">清除选择</button>
    </div>
  </div>`;
}

/** 分页条（复用 .pager 样式） */
export function wbPagerHtml(page, total, per = WORDS_PER_PAGE) {
  const pages = Math.max(1, Math.ceil(total / per));
  if (pages <= 1) return '';
  const from = (page - 1) * per + 1;
  const to = Math.min(total, page * per);
  return `
  <div class="pager glass" role="navigation" aria-label="生词本分页">
    <button class="pager-btn" data-action="wb-page" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''} aria-label="上一页生词">‹ 上一页</button>
    <div class="pager-info"><b>第 ${page}/${pages} 页</b><span>第 ${from}–${to} 个 / 共 ${total} 个</span></div>
    <button class="pager-btn" data-action="wb-page" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''} aria-label="下一页生词">下一页 ›</button>
  </div>`;
}

/* ------------------------------ 页面渲染 ------------------------------ */

/** 渲染「生词本整理」页（app.js 路由 #/words 调用） */
export function renderWordbook(root, { focusSearch = false } = {}) {
  if (!root) return;
  const cards = userCards();
  S.sel = wb.limitSelection(cards, S.sel); // 卡片被删 / 合并后，选中集合自动收敛

  if (!cards.length) {
    S.sel = new Set();
    root.innerHTML = `
    <div class="view view-wordbook">
      <div class="section-head">
        <h2 class="screen-title">生词本整理</h2>
        <span class="sub-note">${esc(store.USER_DECK_NAME)}</span>
      </div>
      <div class="empty glass">
        <div class="empty-icon">${icon('card', 28)}</div>
        <h3>生词本还是空的</h3>
        <p>用首页的「添加单词」在线查词，或导入词表，生词会自动进到这里；重复词、乱标签、缺释义都能在这页批量整理。</p>
        <button class="btn btn-primary" data-action="wb-go-add">${icon('plus', 16)} 去添加生词</button>
      </div>
    </div>`;
    return;
  }

  const all = visibleCards();
  const rows = pageCards();
  const pages = Math.max(1, Math.ceil(all.length / WORDS_PER_PAGE));
  const page = Math.min(pages, pageFromHash());
  const allPicked = wb.isAllSelected(rows, S.sel);
  const somePicked = wb.isPartialSelected(rows, S.sel);
  const dupGroups = wb.statsOf(cards).dupGroups;

  root.innerHTML = `
  <div class="view view-wordbook">
    <div class="section-head">
      <h2 class="screen-title">生词本整理</h2>
      <span class="sub-note">${esc(store.USER_DECK_NAME)} · 共 ${cards.length} 个词${
        all.length !== cards.length ? ` · 筛选出 ${all.length}` : ''
      }</span>
    </div>
    ${wbOverviewHtml(cards)}

    <div class="wb-tools glass">
      <div class="wb-search-box">
        ${icon('search', 16)}
        <input id="wb-search" class="wb-search" type="search" inputmode="search" data-action="wb-search"
          placeholder="搜索单词 / 释义 / 例句 / 标签" value="${esc(S.q)}" autocomplete="off"
          spellcheck="false" aria-label="搜索生词">
        ${S.q ? `<button class="wb-search-clear" data-action="wb-search-clear" aria-label="清空搜索">${icon('close', 15)}</button>` : ''}
      </div>
      ${wbChipsHtml(cards, S)}
      <div class="wb-tools-row">
        <select class="wb-sort" data-action="wb-sort" aria-label="排序方式">
          ${wb.SORTS.map((s) => `<option value="${s.id}"${S.sort === s.id ? ' selected' : ''}>${esc(s.label)}</option>`).join('')}
        </select>
        <button class="btn-link${S.missing ? ' is-on' : ''}" data-action="wb-toggle-missing">${
          S.missing ? '显示全部' : '只看缺释义'
        }</button>
        <button class="btn-link" data-action="wb-tag-manage">${icon('tag', 14)} 标签管理</button>
      </div>
    </div>

    ${wbBatchBarHtml(S.sel.size)}

    ${
      rows.length
        ? `<label class="wb-pick-page"><input type="checkbox" data-action="wb-pick-page"${
            allPicked ? ' checked' : ''
          }><span>本页全选（${rows.length} 个）${somePicked ? ' · 已选部分' : ''}</span></label>`
        : `<div class="empty glass"><div class="empty-icon">${icon('search', 22)}</div><h3>没有匹配的单词</h3><p>换个关键词，或点「全部」清除筛选。</p></div>`
    }
    <div class="wb-list">${rows.map((c) => wbRowHtml(c, S.sel.has(String(c.id)))).join('')}</div>
    ${wbPagerHtml(page, all.length)}

    <div class="fab-bar wb-fab">
      <button class="btn btn-primary" data-action="wb-dedupe-report" ${dupGroups ? '' : 'disabled'}>${icon(
        'refresh',
        16
      )} 合并重复词${dupGroups ? `（${dupGroups} 组）` : ''}</button>
      <button class="btn btn-ghost" data-action="wb-go-add">${icon('plus', 15)} 添加生词</button>
    </div>
  </div>`;

  if (focusSearch) focusSearchBox(root);
}



/* ------------------------------ 去重合并 ------------------------------ */

/** 合并报告 HTML（纯）：一组一行，展示保留哪张 + 合并后的释义 */
export function wbReportHtml(plans) {
  const removed = plans.reduce((n, p) => n + p.removeIds.length, 0);
  return `
  <div class="wb-report">
    <p class="wb-report-lead">发现 <b>${plans.length}</b> 组重复词（大小写 / 空格不同、但其实是同一个词）。合并后删掉
      <b>${removed}</b> 张多余卡片，它们的释义会并入保留卡片。</p>
    <ul class="wb-plan-list">
      ${plans
        .map(
          (p) => `<li class="wb-plan">
        <div class="wb-plan-head">
          <b>${esc(p.front)}</b>
          <span class="sub-note">${p.groupSize} 张 → 1 张 · ${p.senses} 个释义</span>
        </div>
        <div class="wb-plan-senses">${(p.backs || [])
          .slice(0, 4)
          .map((b) => `<span class="wb-sense">${esc(b)}</span>`)
          .join('')}${
            (p.backs || []).length > 4 ? `<span class="sub-note">…还有 ${p.backs.length - 4} 个</span>` : ''
          }</div>
      </li>`
        )
        .join('')}
    </ul>
    <p class="hint">保留规则：优先保留已经在复习的卡片（复习进度与复习日志不丢），其次是复习次数多、间隔长、加入早的；
      原释义永远是第一义，其它释义追加到「其它释义」，复习进度不会改变。</p>
  </div>`;
}

/** 应用合并方案（写库 + 提示 + 重新渲染） */
export function runMerge(plans) {
  const deck = userDeck();
  if (!deck || !plans || !plans.length) {
    toast('没有发现重复词', 'warn');
    return { kept: 0, removed: 0, groups: 0 };
  }
  const res = store.mergeCards(deck.id, plans);
  if (res.removed) toast(`已合并 ${res.groups} 组重复词：删除 ${res.removed} 张，保留的卡片带着复习进度`, 'good');
  else toast('没有可合并的重复词', 'warn');
  S.sel = new Set();
  rerender();
  return res;
}

/** 一键合并全部重复词（跳过报告弹窗；测试与「报告确认」共用） */
export function mergeDuplicates() {
  const deck = userDeck();
  if (!deck) return { kept: 0, removed: 0, groups: 0 };
  return runMerge(wb.mergePlans(deck.cards));
}

/** 打开「合并报告」弹窗：先看报告，再决定是否合并 */
export function openDedupeReport() {
  const deck = userDeck();
  const plans = deck ? wb.mergePlans(deck.cards) : [];
  if (!plans.length) {
    toast('没有发现重复词（大小写 / 空格不同的同一个词也会被识别）', 'good');
    return null;
  }
  const removed = plans.reduce((n, p) => n + p.removeIds.length, 0);
  openModal({
    title: `合并重复词 · ${plans.length} 组`,
    wide: true,
    body: wbReportHtml(plans),
    actions: [
      {
        label: `合并（保留 ${plans.length} 张，删 ${removed} 张）`,
        cls: 'btn-primary',
        onClick: () => {
          runMerge(plans);
          return true;
        }
      },
      { label: '取消', cls: 'btn-ghost' }
    ]
  });
  return plans;
}


/* ------------------------------ 标签整理 ------------------------------ */

/** 批量加 / 去标签（弹窗确认后调用；测试可直接调用） */
export function applyTagsToSelected({ add = [], remove = [] } = {}) {
  const deck = userDeck();
  if (!deck || !S.sel.size) return { updated: 0 };
  const plans = wb.tagPatchPlans(deck.cards, S.sel, { add, remove });
  const res = store.updateCards(deck.id, plans);
  const names = (add.length ? add : remove).join('、');
  if (res.updated) {
    toast(add.length ? `已给 ${res.updated} 张卡片加标签「${names}」` : `已从 ${res.updated} 张卡片移除标签「${names}」`, 'good');
  } else {
    toast('这些卡片已经是目标状态，没有需要改动的地方', 'warn');
  }
  rerender();
  return res;
}

/** 重命名 / 删除标签（整本生词本生效；to 为空 = 删除该标签） */
export function renameTag(from, to) {
  const deck = userDeck();
  const src = String(from || '').trim();
  const dst = String(to || '').trim();
  if (!deck || !src) return { updated: 0 };
  const plans = wb.renameTagPlans(deck.cards, src, dst);
  if (!plans.length) {
    toast(`没有卡片使用标签「${src}」`, 'warn');
    return { updated: 0 };
  }
  const res = store.updateCards(deck.id, plans);
  toast(dst ? `已把标签「${src}」改为「${dst}」（${res.updated} 张）` : `已删除标签「${src}」（${res.updated} 张）`, 'good');
  if (S.tag !== wb.ALL && wb.normKey(S.tag) === wb.normKey(src)) S.tag = wb.ALL; // 正在筛该标签 → 回到全部
  rerender();
  return res;
}

/** 已有标签快捷 chips（弹窗里点一下填入输入框） */
export function wbQuickTagsHtml(cards, exclude = []) {
  const skip = new Set((exclude || []).map((t) => wb.normKey(t)));
  const list = wb
    .tagCounts(cards)
    .list.filter((t) => !skip.has(wb.normKey(t.tag)))
    .slice(0, 12);
  if (!list.length) return '';
  return `<div class="wb-quick-tags">${list
    .map(
      (t) => `<button type="button" class="chip" data-action="wb-quick-tag" data-tag="${esc(t.tag)}">${esc(t.tag)}</button>`
    )
    .join('')}</div>`;
}

/** 弹窗内读表单（无 DOM 时返回空对象） */
function modalForm() {
  const overlay =
    typeof document !== 'undefined' && document.querySelector ? document.querySelector('.modal-overlay') : null;
  return overlay ? readForm(overlay) : {};
}

/** 打开「标签管理」弹窗（重命名 / 删除某个标签） */
export function openTagManager() {
  const counts = wb.tagCounts(userCards());
  if (!counts.list.length) {
    toast('还没有任何标签，可以先勾选卡片用「加标签」打标签', 'warn');
    return null;
  }
  openModal({
    title: '标签管理',
    body: `
    <div class="form">
      <label class="field"><span>要处理的标签</span>
        <select name="from">${counts.list
          .map((t) => `<option value="${esc(t.tag)}">${esc(t.tag)}（${t.count} 张）</option>`)
          .join('')}</select>
      </label>
      <label class="field"><span>改为（留空 = 删除该标签）</span>
        <input name="to" type="text" placeholder="例如：高频" maxlength="24" autocomplete="off">
      </label>
      <p class="hint">重命名会更新整本生词本里用到该标签的所有卡片；留空 = 删除这个标签（卡片本身保留）。</p>
    </div>`,
    actions: [
      {
        label: '应用',
        cls: 'btn-primary',
        onClick: () => {
          const v = modalForm();
          if (!v.from) {
            toast('请选择要处理的标签', 'warn');
            return false;
          }
          renameTag(v.from, v.to || '');
          return true;
        }
      },
      { label: '取消', cls: 'btn-ghost' }
    ]
  });
  return counts;
}


/** 打开「批量加 / 去标签」弹窗 */
export function openBatchTagModal(mode = 'add') {
  const isAdd = mode === 'add';
  if (!S.sel.size) {
    toast('请先勾选要整理的卡片', 'warn');
    return;
  }
  const cards = userCards();
  openModal({
    title: isAdd ? `给选中的 ${S.sel.size} 张加标签` : `移除选中卡片的标签`,
    body: `
    <div class="form">
      <label class="field"><span>${isAdd ? '新标签' : '要移除的标签'}（空格 / 逗号分隔，可多个）</span>
        <input name="tags" type="text" placeholder="${isAdd ? '例如：高频 考研' : '例如：四级'}" autocomplete="off">
      </label>
      ${isAdd ? wbQuickTagsHtml(cards) : ''}
      <p class="hint">只影响当前勾选的 ${S.sel.size} 张卡片，其它卡片不受影响。</p>
    </div>`,
    actions: [
      {
        label: isAdd ? '添加' : '移除',
        cls: 'btn-primary',
        onClick: () => {
          const v = modalForm();
          const list = parseTags(v.tags);
          if (!list.length) {
            toast('请填写标签', 'warn');
            return false;
          }
          applyTagsToSelected(isAdd ? { add: list } : { remove: list });
          return true;
        }
      },
      { label: '取消', cls: 'btn-ghost' }
    ]
  });
}

/* ------------------------------ 删除 / 补查 / 编辑 ------------------------------ */

/** 删除若干卡片（由调用方负责确认；测试可直接调用） */
export function deleteCardsByIds(ids) {
  const deck = userDeck();
  const list = [...new Set((ids || []).map(String).filter(Boolean))];
  if (!deck || !list.length) return { deleted: 0 };
  const before = deck.cards.length;
  store.deleteCards(deck.id, list);
  const deleted = Math.max(0, before - userCards().length);
  const dead = new Set(list);
  S.sel = new Set([...S.sel].filter((id) => !dead.has(id))); // 只收敛被删掉的选中项
  if (deleted) toast(`已删除 ${deleted} 个词`, 'good');
  rerender();
  return { deleted };
}

/** 删除选中的词（带确认弹窗） */
export async function deleteSelected() {
  if (!S.sel.size) {
    toast('请先勾选要删除的卡片', 'warn');
    return { deleted: 0 };
  }
  const n = S.sel.size;
  const okDel = await confirmDialog(
    `确定从「${store.USER_DECK_NAME}」删除选中的 ${n} 个词吗？它们的复习记录会一并清理，且无法撤销。`,
    { title: '删除生词', danger: true }
  );
  if (!okDel) return { deleted: 0 };
  return deleteCardsByIds([...S.sel]);
}

/**
 * 在线补查：把待查词填进首页的查词框并跳回首页。
 * 未勾选卡片时 → 只补查「缺释义」的词；勾选后 → 补查勾选的词（查到的释义自动并入原卡片）。
 * @returns {number} 填入的词数
 */
export function lookupSelected() {
  const onlyMissing = !S.sel.size;
  const words = wb.lookupTargets(userCards(), S.sel, { onlyMissing });
  if (!words.length) {
    toast(onlyMissing ? '没有缺释义的词' : '选中的词都已有释义', 'warn');
    return 0;
  }
  prefillInput(words, { merge: true });
  toast(`已把 ${words.length} 个词填进查词框，点首页的「添加」即可补全（重复词自动合并）`, 'good');
  navigate('#/home');
  return words.length;
}

/* ------------------------------ Action 注册 ------------------------------ */

/** 重渲染会重建输入框 → 恢复焦点与光标位置（type=search 可能不支持 setSelectionRange） */
function restoreSearchFocus(caret) {
  const root = rootView();
  const box = root && root.querySelector ? root.querySelector('#wb-search') : null;
  if (!box || !box.focus) return;
  box.focus();
  if (caret !== null && box.setSelectionRange) {
    try {
      box.setSelectionRange(caret, caret);
    } catch (e) {
      /* 忽略：部分浏览器对 type=search 限制 setSelectionRange */
    }
  }
}

// 搜索：输入防抖 180ms 后重渲染（筛选靠重渲染，输入框内容与光标位置保持不变）
on(
  'wb-search',
  (el) => {
    const caret = el && typeof el.selectionStart === 'number' ? el.selectionStart : null;
    S.q = String((el && el.value) || '');
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      rerender({ resetPage: true });
      setTimeout(() => restoreSearchFocus(caret), 0);
    }, 180);
  },
  'input'
);

on('wb-search-clear', () => {
  S.q = '';
  if (searchTimer) clearTimeout(searchTimer);
  rerender({ resetPage: true });
  setTimeout(() => restoreSearchFocus(null), 0);
});


// 标签 / 来源 / 全部：切换筛选并回到第 1 页
on('wb-tag', (el) => {
  S.tag = (el && el.dataset && el.dataset.tag) || wb.ALL;
  rerender({ resetPage: true });
});

on('wb-src', (el) => {
  const raw = el && el.dataset ? el.dataset.src : wb.ALL;
  S.src = raw === wb.ALL ? wb.ALL : String(raw ?? '');
  rerender({ resetPage: true });
});

on('wb-all', () => {
  S.tag = wb.ALL;
  S.src = wb.ALL;
  S.missing = false;
  rerender({ resetPage: true });
});

on('wb-toggle-missing', () => {
  S.missing = !S.missing;
  rerender({ resetPage: true });
});

// 排序下拉
on(
  'wb-sort',
  (el) => {
    S.sort = (el && el.value) || 'added';
    rerender();
  },
  'change'
);

// 分页（页码写进 URL，浏览器回退正常）
on('wb-page', (el) => {
  const n = Number(el && el.dataset ? el.dataset.page : 0);
  if (!Number.isFinite(n) || n < 1) return;
  navigate(n <= 1 ? '#/words' : `#/words?page=${n}`);
});

// 单张勾选 / 本页全选
on(
  'wb-pick',
  (el) => {
    S.sel = wb.toggleId(S.sel, el && el.dataset ? el.dataset.card : '');
    rerender();
  },
  'change'
);

on(
  'wb-pick-page',
  (el) => {
    const on_ = !!(el && el.checked);
    const set = new Set(S.sel);
    for (const c of pageCards()) {
      if (on_) set.add(String(c.id));
      else set.delete(String(c.id));
    }
    S.sel = set;
    rerender();
  },
  'change'
);

on('wb-clear-sel', () => {
  S.sel = new Set();
  rerender();
});

// 批量操作
on('wb-batch-tag', () => openBatchTagModal('add'));
on('wb-batch-untag', () => openBatchTagModal('remove'));
on('wb-batch-lookup', () => lookupSelected());
on('wb-batch-delete', () => deleteSelected());

on('wb-quick-tag', (el) => {
  const tag = el && el.dataset ? el.dataset.tag : '';
  const overlay =
    typeof document !== 'undefined' && document.querySelector ? document.querySelector('.modal-overlay') : null;
  const input = overlay && overlay.querySelector ? overlay.querySelector('input[name="tags"]') : null;
  if (!input || !tag) return;
  const cur = String(input.value || '').trim();
  if (!cur.split(/\s+/).includes(tag)) input.value = cur ? `${cur} ${tag}` : tag;
  if (input.focus) input.focus();
});

on('wb-tag-manage', () => openTagManager());

// 单张操作
on('wb-edit', (el) => editCard(el && el.dataset ? el.dataset.card : ''));
on('wb-remove', (el) => deleteCardsByIds([el && el.dataset ? el.dataset.card : '']));

// 去重合并 / 去添加
on('wb-dedupe-report', () => openDedupeReport());
on('wb-go-add', () => navigate('#/home'));


/** 编辑单张卡片（复用卡组管理里的表单弹窗） */
export function editCard(id) {
  const deck = userDeck();
  const card = deck ? deck.cards.find((c) => String(c.id) === String(id)) : null;
  if (deck && card) cardFormModal(deck, card);
  return card || null;
}

