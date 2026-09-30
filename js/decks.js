// ============================================================================
// decks.js — 卡组管理：首页列表（标签筛选）、卡组详情（关卡视图）、卡片管理
// ============================================================================

import * as store from './store.js';
import * as lv from './levels.js';
import * as ls from './levelstats.js';
import * as hw from './hardwords.js';
import * as te from './test-engine.js';
import { clearTestSession } from './test.js';
import { addWordsPanelHtml } from './add-words.js';
import { importFileButtonHtml, dropzoneHtml, bindDropzone, csvTemplateButtonHtml, jsonTemplateButtonHtml } from './import-file.js';
import { tableEditorLinkHtml } from './table-editor.js'; // 首页入口：在网页里填表格（#/editor）
import { importHistoryButtonHtml } from './import-history.js'; // 注册「导入历史 / 撤销」入口
import './export.js'; // 注册卡组菜单的「导出 txt / apkg」动作
import * as match from './match.js'; // 明牌配对：解锁判定 + 入口横幅（#/match/{deck}）
import { esc, on, icon, navigate, openModal, closeModal, readForm, toast, confirmDialog, parseTags } from './ui.js';

const ACTIVE_TAG_KEY = 'mycard-active-tag';
let activeTag = localStorage.getItem(ACTIVE_TAG_KEY) || '全部';

/* ------------------------------- 小工具 ------------------------------- */

/**
 * 卡组标签。
 * - interactive=true（默认）：渲染为 <button>，键盘可达，点击 = 按该标签筛选（用于卡组详情页的纯容器里）。
 * - interactive=false：渲染为纯 <span> 标签，用于「卡组磁贴」——磁贴本身是 role="button"，
 *   按 ARIA 规范其中不能嵌套可聚焦控件；键盘用户可在首页 chips 行完成同样的标签筛选。
 */
function tagBadges(tags, cls = '', interactive = true) {
  return (tags || [])
    .map((t) =>
      interactive
        ? `<button type="button" class="tag ${cls}" data-action="filter-tag" data-tag="${esc(
            t
          )}" aria-label="按标签「${esc(t)}」筛选">${esc(t)}</button>`
        : `<span class="tag ${cls}" data-action="filter-tag" data-tag="${esc(t)}">${esc(t)}</span>`
    )
    .join('');
}

/* ------------------------------ 首页 / 卡组列表 ------------------------------ */

function levelProgressSummary(deck) {
  const levels = lv.deckLevels(deck);
  if (!levels.length) return { levels: 0, passed: 0 };
  const states = lv.levelStates(deck, levels); // 复用已算好的关卡分组，避免重复整卡组遍历
  const passed = levels.filter((l) => states[l.index] === 'passed').length;
  return { levels: levels.length, passed };
}

function deckTileHtml(deck) {
  const stats = lv.deckStats(deck);
  const prog = levelProgressSummary(deck);
  const pct = stats.total ? Math.round((stats.learned / stats.total) * 100) : 0;
  return `
  <article class="deck-tile glass" data-action="open-deck" data-id="${esc(deck.id)}" tabindex="0" role="button">
    <div class="deck-tile-top">
      <h3 class="deck-name">${esc(deck.name)}</h3>
      ${deck.paused ? '<span class="pill pill-paused">已暂停</span>' : ''}
      ${deck.demo ? '<span class="pill pill-demo">示范</span>' : ''}
    </div>
    ${deck.description ? `<p class="deck-desc">${esc(deck.description)}</p>` : ''}
    <div class="tag-row">${tagBadges(deck.tags, '', false)}</div>
    <div class="deck-progress">
      <div class="progress-track" role="progressbar" aria-label="学习进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i class="progress-fill" style="width:${pct}%"></i></div>
      <div class="deck-stat">
        <span><b>${stats.total}</b> 卡片</span>
        <span><b>${stats.learned}</b> 已学</span>
        ${stats.due ? `<span class="warn"><b>${stats.due}</b> 待复习</span>` : ''}
        <span class="level-note">${prog.levels ? `关卡 ${prog.passed}/${prog.levels}` : '暂无卡片'}</span>
      </div>
    </div>
    <div class="deck-tile-foot">
      <span class="deck-date">${stats.due ? '有到期复习' : stats.total ? (stats.learned === stats.total ? '全部已学过' : '等待开始学习') : ''}</span>
      <button class="icon-btn" data-action="deck-options" data-id="${esc(deck.id)}" aria-label="卡组菜单">${icon('more', 20)}</button>
    </div>
  </article>`;
}

export function renderHome(root) {
  const db = store.getDb();
  const decks = db.decks.filter(
    (d) => activeTag === '全部' || (d.tags || []).includes(activeTag)
  );
  const tags = store.allTags();
  const hasDemo = store.hasDemoDeck();

  const chips = ['全部', ...tags]
    .map(
      (t) =>
        `<button class="chip${t === activeTag ? ' chip-on' : ''}" data-action="filter-tag" data-tag="${esc(t)}" aria-pressed="${
          t === activeTag
        }">${esc(t)}${t === '全部' ? ` (${db.decks.length})` : ''}</button>`
    )
    .join('');

  const demoBanner = !hasDemo
    ? `<div class="banner glass" data-action="import-demo" role="button" tabindex="0" aria-label="导入示范卡组：内置英语高频词约 60 词，分 3 关">
         <span class="banner-icon">${icon('card', 22)}</span>
         <div><b>导入示范卡组</b><p>内置「英语高频词」约 60 词，分 3 关，体验关卡闯关模式</p></div>
         <span class="banner-go">${icon('back', 18)}</span>
       </div>`
    : '';

  const userDeck = store.getUserDeck();
  const wordsEntry = userDeck && userDeck.cards.length
    ? `<button class="icon-btn glass" data-action="nav-words" aria-label="整理生词本" title="整理生词本（去重 / 标签 / 补查）">${icon('layers', 20)}</button>`
    : '';

  const empty = !decks.length
    ? `<div class="empty glass">
         <div class="empty-icon">${icon('cards', 30)}</div>
         <h3>${db.decks.length ? '该标签下还没有卡组' : '开始你的第一个卡组'}</h3>
         <p>${db.decks.length ? '试试切换其它标签，或新建一个卡组。' : '创建卡组添加学习卡片，或导入内置示范词库，马上开始闯关记忆。'}</p>
         <button class="btn btn-primary" data-action="new-deck">${icon('plus', 16)} 新建卡组</button>
       </div>`
    : '';

  root.innerHTML = `
    <div class="view">
      ${demoBanner}
      ${addWordsPanelHtml()}
      <div class="section-head">
        <h2 class="screen-title">我的卡组</h2>
        <div class="section-tools">
          ${wordsEntry}
          ${importFileButtonHtml()}
          ${importHistoryButtonHtml()}
          <button class="icon-btn glass" data-action="nav-settings" aria-label="设置">${icon('gear', 20)}</button>
        </div>
      </div>
      ${dropzoneHtml()}
      <p class="csv-hint">没有模版？${csvTemplateButtonHtml()}（标准列：单词 / 释义 / 例句 / 例句翻译 / 音标 / 标签；示例行可选，导入前请删除）　${jsonTemplateButtonHtml()}（JSON 结构：name / tags / words）　不方便准备文件？${tableEditorLinkHtml()}</p>
      ${tags.length ? `<div class="chips scroll-x" role="group" aria-label="按标签筛选卡组">${chips}</div>` : ''}
      <div class="deck-grid">${decks.map(deckTileHtml).join('') || empty}</div>
    </div>`;
  bindDropzone(root); // 绑定拖拽导入（CSV / JSON → 预览 → 确认导入）
}
/* ------------------------------ 卡组详情（关卡视图） ------------------------------ */

function levelAction(deck, lvInfo, state, now) {
  const dueCount = lvInfo.cards.filter((c) => c.lastReview != null && c.due <= now).length;
  const unreviewed = lvInfo.cards.filter((c) => c.lastReview == null).length;
  const did = `data-id="${esc(deck.id)}" data-level="${lvInfo.index}"`;

  if (state === 'passed') {
    const st = ls.getLevelStats(deck.id, lvInfo.index);
    const hint = [st.best != null ? `最佳 ${st.best}%` : '', st.retries ? `已刷 ${st.retries} 次` : '']
      .filter(Boolean)
      .join(' · ');
    return `
      <button class="btn btn-primary" data-action="level-retry" ${did}>${icon('refresh', 16)} 重新挑战</button>
      ${dueCount > 0 ? `<button class="btn-link" data-action="level-review" ${did}>复习 ${dueCount} 张</button>` : ''}
      ${hint ? `<span class="btn-hint">${hint}</span>` : ''}`;
  }
  if (state === 'locked') {
    return `<button class="btn btn-disabled" disabled>${icon('lock', 15)} 通关上一关后解锁</button>`;
  }
  // unlocked
  const allReviewed = unreviewed === 0;
  const parts = [];
  if (!allReviewed) {
    parts.push(`<button class="btn btn-primary glow" data-action="level-learn" ${did}>开始学习 · ${unreviewed} 张新卡</button>`);
    if (dueCount > 0) parts.push(`<button class="btn-link" data-action="level-review" ${did}>复习 ${dueCount}</button>`);
    parts.push(`<span class="btn-hint">${icon('lock', 13)} 学完本关全部卡片后解锁测试</span>`);
  } else if (dueCount > 0) {
    parts.push(`<button class="btn btn-primary glow" data-action="level-review" ${did}>复习 ${dueCount} 张</button>`);
  }
  if (allReviewed) {
    parts.push(`<button class="btn btn-test" data-action="level-test" ${did}>进入测试 · 冲刺通关</button>`);
  }
  return parts.join('');
}

function levelCardHtml(deck, lvInfo, state, now) {
  const total = lvInfo.cards.length;
  const learned = lvInfo.cards.filter((c) => c.lastReview != null).length;
  const pct = total ? Math.round((learned / total) * 100) : 0;
  const badge =
    state === 'passed'
      ? '<span class="pill pill-pass">已通关</span>'
      : state === 'locked'
        ? `<span class="pill pill-lock">${icon('lock', 12)} 未解锁</span>`
        : total === learned
          ? '<span class="pill pill-go">待测试通关</span>'
          : `<span class="pill pill-live">闯关中</span>`;
  return `
  <section class="level-card glass lv-${state}" data-level="${lvInfo.index}">
    <div class="level-card-head">
      <div class="level-title">
        <span class="level-badge">${lvInfo.index + 1}</span>
        <div>
          <h3>第 ${lvInfo.index + 1} 关</h3>
          <p>${total} 张卡片 · 已学 ${learned}/${total}</p>
        </div>
      </div>
      ${badge}
    </div>
    <div class="progress-track" role="progressbar" aria-label="已学 ${learned} / ${total} 张" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i class="progress-fill" style="width:${pct}%"></i></div>
    <div class="level-card-foot">${levelAction(deck, lvInfo, state, now)}</div>
  </section>`;
}

/* ------------------------------ 关卡分页 ------------------------------ */

/** 从 hash 读取页号（URL 为 1 基：?page=2 → 第 2 页） */
function pageFromHash() {
  const m = /[?&]page=(\d+)/.exec(location.hash || '');
  return m ? Math.max(1, Number(m[1])) : null;
}

/** 关卡分页条：关卡数 > 15 时展示「第 2/45 页」 */
function pagerHtml(deckId, page, totalLevels) {
  const total = lv.levelPageCount(totalLevels);
  if (total <= 1) return '';
  const from = page * lv.LEVELS_PER_PAGE + 1;
  const to = Math.min(totalLevels, (page + 1) * lv.LEVELS_PER_PAGE);
  return `
  <div class="pager glass" role="navigation" aria-label="关卡分页">
    <button class="pager-btn" data-action="deck-page" data-id="${esc(deckId)}" data-page="${page}" ${page <= 0 ? 'disabled' : ''} aria-label="上一页关卡">‹ 上一页</button>
    <div class="pager-info"><b>${lv.levelPageLabel(page, totalLevels)}</b><span>第 ${from}–${to} 关 / 共 ${totalLevels} 关</span></div>
    <button class="pager-btn" data-action="deck-page" data-id="${esc(deckId)}" data-page="${page + 2}" ${page >= total - 1 ? 'disabled' : ''} aria-label="下一页关卡">下一页 ›</button>
  </div>`;
}

export function renderDeck(root, deckId) {
  const deck = store.getDeck(deckId);
  if (!deck) {
    root.innerHTML = `<div class="view"><div class="empty glass"><h3>卡组不存在</h3><a class="btn btn-primary" href="#/home">返回首页</a></div></div>`;
    return;
  }
  const now = Date.now();
  const levels = lv.deckLevels(deck);
  const states = lv.levelStates(deck, levels); // 复用关卡分组（万级卡组只遍历一次）
  const stats = lv.deckStats(deck, now);
  const hardCount = hw.hardCount(deck.id); // 只读一次 localStorage（hero 里复用了 2 次）
  const per = lv.effectivePerLevel(deck, store.getDb().settings);

  const totalLevels = levels.length;
  const firstOpen = levels.find((l) => states[l.index] !== 'passed');
  const autoPage = firstOpen ? lv.levelPageOf(firstOpen.index) : 0;
  const hashPage = pageFromHash();
  const page = lv.clampLevelPage(hashPage ? hashPage - 1 : autoPage, totalLevels);

  let levelsHtml;
  if (!levels.length) {
    levelsHtml = `<div class="empty glass">
      <div class="empty-icon">${icon('card', 26)}</div>
      <h3>还没有卡片</h3>
      <p>添加 ${per} 张以上卡片后，将按「每关 ${per} 张」自动划分关卡。</p>
      <button class="btn btn-primary" data-action="open-cards" data-id="${esc(deck.id)}">添加卡片</button>
    </div>`;
  } else {
    levelsHtml =
      lv
        .sliceLevelsPage(levels, page)
        .map((l) => levelCardHtml(deck, l, states[l.index] || 'locked', now))
        .join('') + pagerHtml(deck.id, page, totalLevels);
  }

  const heroBadges = [
    deck.paused ? '<span class="pill pill-paused">已暂停</span>' : '',
    deck.demo ? '<span class="pill pill-demo">示范</span>' : ''
  ].join('');

  const passedCount = levels.filter((l) => states[l.index] === 'passed').length;
  // 明牌配对：通关 ≥ UNLOCK_LEVELS 关后出现入口（v0.5.12 起只需 1 关；玩法见 js/match.js）
  const matchUnlock = match.unlockInfo(deck);
  const matchBanner = matchUnlock.unlocked
    ? `
      <button type="button" class="match-banner glass" data-action="open-match" data-id="${esc(deck.id)}">
        <span class="match-banner-icon" aria-hidden="true">${icon('layers', 22)}</span>
        <span class="match-banner-body">
          <b>明牌配对 · 玩一局</b>
          <span>把「${esc(deck.name)}」的单词与释义两两配对 · 每轮 ${match.ROUND_PAIRS} 对（可选 ${passedCount} 个已通关关卡）</span>
        </span>
        <span class="match-banner-go" aria-hidden="true">开始 ›</span>
      </button>`
    : '';

  root.innerHTML = `
    <div class="view">
      <div class="deck-hero glass">
        <div class="hero-top">
          <h2>${esc(deck.name)}</h2>${heroBadges}
        </div>
        ${deck.description ? `<p class="hero-desc">${esc(deck.description)}</p>` : ''}
        ${deck.tags && deck.tags.length ? `<div class="tag-row">${tagBadges(deck.tags)}</div>` : ''}
        <div class="hero-stats">
          <div><b>${stats.total}</b><span>卡片</span></div>
          <div><b>${stats.learned}</b><span>已学</span></div>
          <div><b>${stats.due}</b><span>待复习</span></div>
          <div><b>${passedCount}/${levels.length}</b><span>通关关卡</span></div>
        </div>
        ${stats.total ? `<div class="hero-actions">
          <button class="btn btn-primary btn-block hero-flip-btn" data-action="open-all-review" data-id="${esc(deck.id)}">${icon('refresh', 18)} 翻转记忆 · 整卡组循环${hardCount ? `（困难词 ${hardCount}）` : ''}</button>
          <button class="btn btn-test btn-block" data-action="open-deck-test" data-id="${esc(deck.id)}">${icon('card', 18)} 整卡组测试 · 20~150 题</button>
          <button class="btn btn-ghost btn-block" data-action="rearrange-deck" data-id="${esc(deck.id)}">${icon('refresh', 16)} 按难度重排关卡（错题提前）</button>
        </div>` : ''}
      </div>
      ${matchBanner}
      <div class="levels-wrap">${levelsHtml}</div>
      <button class="btn btn-ghost btn-block manage-btn" data-action="open-cards" data-id="${esc(deck.id)}">${icon('cards', 16)} 管理卡片（${stats.total} 张）</button>
    </div>`;
}
/* ------------------------------ 卡片管理 ------------------------------ */

/** 卡片管理页每页张数（万级卡组只渲染当前页，避免一次性塞入上万 DOM 节点） */
export const CARDS_PER_PAGE = 100;

/** 卡片分页条：卡片数 > CARDS_PER_PAGE 时展示「第 2/3 页」 */
function cardsPagerHtml(deckId, page, totalCards) {
  const totalPages = Math.max(1, Math.ceil(totalCards / CARDS_PER_PAGE));
  if (totalPages <= 1) return '';
  const from = page * CARDS_PER_PAGE + 1;
  const to = Math.min(totalCards, (page + 1) * CARDS_PER_PAGE);
  return `
  <div class="pager glass" role="navigation" aria-label="卡片分页">
    <button class="pager-btn" data-action="cards-page" data-id="${esc(deckId)}" data-page="${page}" ${page <= 0 ? 'disabled' : ''} aria-label="上一页卡片">‹ 上一页</button>
    <div class="pager-info"><b>第 ${page + 1}/${totalPages} 页</b><span>第 ${from}–${to} 张 / 共 ${totalCards} 张</span></div>
    <button class="pager-btn" data-action="cards-page" data-id="${esc(deckId)}" data-page="${page + 2}" ${page >= totalPages - 1 ? 'disabled' : ''} aria-label="下一页卡片">下一页 ›</button>
  </div>`;
}

function stateChip(card) {
  if (card.lastReview == null) return '<span class="pill pill-new">新卡</span>';
  return `<span class="pill pill-learned">L${(card.level ?? 0) + 1} · ${card.state === 'learning' ? '学习' : '复习'}</span>`;
}

function cardRowHtml(deck, card) {
  const front = card.front || '<i style="opacity:.5">（无正面）</i>';
  const back = card.back || '<i style="opacity:.5">（无背面）</i>';
  return `
  <div class="card-row glass" data-level="${card.level ?? 0}">
    <div class="card-row-main">
      <div class="card-row-q">${esc(front)}</div>
      <div class="card-row-a">${esc(back)}</div>
      ${card.example ? `<div class="card-row-ex">${esc(card.example)}</div>` : ''}
      <div class="card-row-tags">
        ${stateChip(card)}
        <span class="tag">第 ${(card.level ?? 0) + 1} 关</span>
      </div>
    </div>
    <div class="card-row-ops">
      <button class="icon-btn" data-action="edit-card" data-id="${esc(deck.id)}" data-card="${esc(card.id)}" aria-label="编辑">${icon('edit', 17)}</button>
      <button class="icon-btn danger" data-action="delete-card" data-id="${esc(deck.id)}" data-card="${esc(card.id)}" aria-label="删除">${icon('trash', 17)}</button>
    </div>
  </div>`;
}

export function renderCards(root, deckId) {
  const deck = store.getDeck(deckId);
  if (!deck) {
    root.innerHTML = `<div class="view"><div class="empty glass"><h3>卡组不存在</h3><a class="btn btn-primary" href="#/home">返回首页</a></div></div>`;
    return;
  }
  const all = [...deck.cards].sort((a, b) => (a.level ?? 0) - (b.level ?? 0) || a.createdAt - b.createdAt);
  // 万级卡组：只渲染当前页（URL ?page=N，1 基）
  const totalPages = Math.max(1, Math.ceil(all.length / CARDS_PER_PAGE));
  const hashPage = pageFromHash();
  const page = Math.min(totalPages - 1, Math.max(0, hashPage ? hashPage - 1 : 0));
  const cards = all.slice(page * CARDS_PER_PAGE, (page + 1) * CARDS_PER_PAGE);
  const rows = cards.length
    ? cards.map((c) => cardRowHtml(deck, c)).join('')
    : `<div class="empty glass"><div class="empty-icon">${icon('card', 26)}</div><h3>这个卡组还是空的</h3><p>点击下方按钮添加第一张学习卡片。</p></div>`;

  root.innerHTML = `
    <div class="view view-cards">
      <div class="section-head">
        <h2 class="screen-title">卡片管理</h2>
        <span class="sub-note">${esc(deck.name)} · ${all.length} 张${totalPages > 1 ? ` · 第 ${page + 1}/${totalPages} 页` : ''}</span>
      </div>
      <div class="cards-list">${rows}</div>
      ${cardsPagerHtml(deck.id, page, all.length)}
      <div class="fab-bar">
        <button class="btn btn-primary fab-main" data-action="add-card" data-id="${esc(deck.id)}">${icon('plus', 18)} 添加卡片</button>
      </div>
    </div>`;
}
/* ------------------------------ 表单弹窗 ------------------------------ */

const DECK_FORM_TMPL = (d) => `
  <div class="form">
    <label class="field"><span>卡组名称 *</span>
      <input name="name" type="text" maxlength="40" placeholder="如：考研英语 1000 词" value="${esc(d ? d.name : '')}">
    </label>
    <label class="field"><span>描述</span>
      <textarea name="description" rows="2" maxlength="200" placeholder="这个卡组学什么…（可选）">${esc(d ? d.description : '')}</textarea>
    </label>
    <label class="field"><span>标签（空格/逗号分隔）</span>
      <input name="tags" type="text" placeholder="如：英语 词汇" value="${esc(d ? (d.tags || []).join(' ') : '')}">
    </label>
    <label class="field"><span>每关卡片数（留空 = 跟随全局设置）</span>
      <input name="cardsPerLevel" type="number" min="15" max="30" step="1" placeholder="15–30，默认 20"
        value="${d && d.cardsPerLevel ? d.cardsPerLevel : ''}">
    </label>
    <p class="hint">关卡模式：卡片按设定数量自动分组，顺序解锁，测试 ≥80% 正确率通关。</p>
  </div>`;

const CARD_FORM_TMPL = (c) => `
  <div class="form">
    <label class="field"><span>正面 · 问题/单词 *</span>
      <textarea name="front" rows="2" maxlength="300" placeholder="如：abandon">${esc(c ? c.front : '')}</textarea>
    </label>
    <label class="field"><span>背面 · 答案/释义 *</span>
      <textarea name="back" rows="2" maxlength="500" placeholder="如：v. 放弃；抛弃">${esc(c ? c.back : '')}</textarea>
    </label>
    <label class="field"><span>例句（可选）</span>
      <textarea name="example" rows="2" maxlength="300" placeholder="英文例句">${esc(c ? c.example : '')}</textarea>
    </label>
    <label class="field"><span>例句翻译（可选）</span>
      <textarea name="exampleZh" rows="2" maxlength="300" placeholder="例句中文翻译">${esc(c ? c.exampleZh : '')}</textarea>
    </label>
    <label class="field"><span>标签（可选）</span>
      <input name="tags" type="text" placeholder="如：高频 动词" value="${esc(c ? (c.tags || []).join(' ') : '')}">
    </label>
  </div>`;

function deckFormModal(deck) {
  const isEdit = !!deck;
  openModal({
    title: isEdit ? '编辑卡组' : '新建卡组',
    body: DECK_FORM_TMPL(deck),
    actions: [
      {
        label: isEdit ? '保存' : '创建',
        cls: 'btn-primary',
        onClick: () => {
          const v = readForm(document.querySelector('.modal-overlay'));
          if (!v.name) {
            toast('请填写卡组名称', 'warn');
            return false;
          }
          const patch = {
            name: v.name,
            description: v.description,
            tags: parseTags(v.tags),
            cardsPerLevel: v.cardsPerLevel === '' ? null : Number(v.cardsPerLevel)
          };
          if (isEdit) {
            store.updateDeck(deck.id, patch);
            toast('卡组已更新');
            setTimeout(() => navigate(`#/deck/${deck.id}`), 160);
          } else {
            const nd = store.createDeck(patch);
            toast('卡组已创建');
            setTimeout(() => navigate(`#/deck/${nd.id}`), 160);
          }
          return true;
        }
      },
      { label: '取消', cls: 'btn-ghost' }
    ]
  });
}

/** 卡片表单弹窗（生词本整理页复用：单条编辑） */
export function cardFormModal(deck, card) {
  const isEdit = !!card;
  openModal({
    title: isEdit ? '编辑卡片' : '添加卡片',
    body: CARD_FORM_TMPL(card),
    actions: [
      {
        label: isEdit ? '保存' : '添加',
        cls: 'btn-primary',
        onClick: () => {
          const v = readForm(document.querySelector('.modal-overlay'));
          if (!v.front || !v.back) {
            toast('正面与背面都不能为空', 'warn');
            return false;
          }
          const patch = {
            front: v.front,
            back: v.back,
            example: v.example,
            exampleZh: v.exampleZh,
            tags: parseTags(v.tags)
          };
          if (isEdit) {
            store.updateCard(deck.id, card.id, patch);
            toast('卡片已更新');
          } else {
            store.addCard(deck.id, patch);
            toast('卡片已添加');
          }
          setTimeout(() => refresh(), 160);
          return true;
        }
      },
      { label: '取消', cls: 'btn-ghost' }
    ]
  });
}
/* ------------------------------ 内置词库导入 ------------------------------ */

/** 从 /data/ 拉取内置词库与易混关系，合并后导入为示范卡组 */
export async function importDemoDeck() {
  const [wordsResp, confResp] = await Promise.all([
    fetch('./data/words.json', { cache: 'no-cache' }),
    fetch('./data/confusables.json', { cache: 'no-cache' }).catch(() => null)
  ]);
  if (!wordsResp.ok) throw new Error('词库文件加载失败 HTTP ' + wordsResp.status);

  const payload = await wordsResp.json();
  const groupsMap = {};
  let extraDefs = {};
  if (confResp && confResp.ok) {
    try {
      const conf = await confResp.json();
      extraDefs = conf.extraDefs || {};
      for (const g of conf.groups || []) {
        for (const member of g.members || []) {
          if (!groupsMap[member]) groupsMap[member] = [];
          groupsMap[member].push(g.id);
        }
      }
    } catch (e) {
      console.warn('[mycard] confusables.json 解析失败，将退化为随机干扰项', e);
    }
  }
  return store.seedDemoDeck({ ...payload, groupsMap, extraDefs });
}

/**
 * v0.2 升级：为“已存在但缺分组”的示范卡组补标易混组/多释义（保留复习进度）。
 * 离线时若缓存缺失则静默跳过，下次联网自动补齐。
 */
export async function ensureDemoEnrichment() {
  const demo = store.getDb().decks.find((x) => x.demo);
  if (!demo) return false;
  const needsGroups = demo.cards.some((c) => !(c.groups || []).length);
  if (!needsGroups) return false;
  const resp = await fetch('./data/confusables.json', { cache: 'no-cache' }).catch(() => null);
  if (!resp || !resp.ok) return false;
  const conf = await resp.json().catch(() => null);
  if (!conf) return false;
  const groupsMap = {};
  for (const g of conf.groups || []) {
    for (const member of g.members || []) {
      if (!groupsMap[member]) groupsMap[member] = [];
      groupsMap[member].push(g.id);
    }
  }
  return store.attachConfusables(demo.id, { groupsMap, extraDefs: conf.extraDefs || {} });
}

/* ------------------------------ 卡组菜单 ------------------------------ */

function deckMenu(deckId) {
  const deck = store.getDeck(deckId);
  if (!deck) return;
  openModal({
    title: deck.name,
    body: `
      <div class="menu-list">
        <button class="menu-item" data-action="deck-edit" data-id="${esc(deck.id)}">${icon('edit', 18)} 编辑卡组</button>
        <button class="menu-item" data-action="deck-pause" data-id="${esc(deck.id)}">${icon(deck.paused ? 'play' : 'pause', 18)} ${deck.paused ? '恢复卡组' : '暂停卡组'}</button>
        <button class="menu-item" data-action="open-cards-from-menu" data-id="${esc(deck.id)}">${icon('cards', 18)} 管理卡片（${deck.cards.length} 张）</button>
        ${
          (store.getUserDeck() || {}).id === deck.id
            ? `<button class="menu-item" data-action="nav-words">${icon('layers', 18)} 整理生词本（去重 / 标签）</button>`
            : ''
        }
        <button class="menu-item" data-action="export-txt" data-id="${esc(deck.id)}">${icon('download', 18)} 导出为 txt 词表</button>
        <button class="menu-item" data-action="export-csv" data-id="${esc(deck.id)}">${icon('download', 18)} 导出为 CSV（带表头）</button>
        <button class="menu-item" data-action="export-md" data-id="${esc(deck.id)}">${icon('download', 18)} 导出为 Markdown</button>
        <button class="menu-item" data-action="export-json" data-id="${esc(deck.id)}">${icon('download', 18)} 导出为 JSON（含复习进度）</button>
        <button class="menu-item" data-action="export-apkg" data-id="${esc(deck.id)}">${icon('download', 18)} 导出为 Anki 卡包（.apkg）</button>
        <button class="menu-item danger-item" data-action="deck-delete" data-id="${esc(deck.id)}">${icon('trash', 18)} 删除卡组</button>
      </div>`
  });
}

/* ------------------------------ Action 注册 ------------------------------ */

on('nav-settings', () => navigate('#/settings'));

// 生词本批量整理（#/words）：去重合并 / 标签整理 / 多选批量 / 在线补查
on('nav-words', () => navigate('#/words'));

on('filter-tag', (el) => {
  activeTag = el.dataset.tag || '全部';
  try {
    localStorage.setItem(ACTIVE_TAG_KEY, activeTag);
  } catch (e) {}
  navigate('#/home');
});

on('new-deck', () => deckFormModal(null));

on('open-deck', (el) => {
  const id = el.dataset.id;
  if (id) navigate(`#/deck/${id}`);
});

on('deck-options', (el) => deckMenu(el.dataset.id));

on('deck-edit', (el) => {
  closeModal();
  deckFormModal(store.getDeck(el.dataset.id));
});

on('deck-pause', (el) => {
  closeModal();
  const d = store.togglePause(el.dataset.id);
  if (d) toast(d.paused ? '已暂停，不再参与复习提醒' : '已恢复学习');
  navigate(`#/deck/${el.dataset.id}`);
});

on('deck-delete', async (el) => {
  closeModal();
  const deck = store.getDeck(el.dataset.id);
  if (!deck) return;
  const ok = await confirmDialog(`确定删除卡组「${deck.name}」吗？共 ${deck.cards.length} 张卡片，删除后不可恢复。`, {
    title: '删除卡组',
    danger: true
  });
  if (ok) {
    store.deleteDeck(el.dataset.id);
    toast('卡组已删除');
    navigate('#/home');
  }
});

on('open-cards', (el) => {
  closeModal();
  navigate(`#/deck/${el.dataset.id}/cards`);
});
on('open-cards-from-menu', (el) => {
  closeModal();
  navigate(`#/deck/${el.dataset.id}/cards`);
});

on('add-card', (el) => {
  const deck = store.getDeck(el.dataset.id);
  if (!deck) return;
  cardFormModal(deck, null);
});
on('edit-card', (el) => {
  const deck = store.getDeck(el.dataset.id);
  const card = deck ? deck.cards.find((c) => c.id === el.dataset.card) : null;
  if (!deck || !card) return;
  cardFormModal(deck, card);
});

on('delete-card', async (el) => {
  const deck = store.getDeck(el.dataset.id);
  const card = deck?.cards.find((c) => c.id === el.dataset.card);
  if (!deck || !card) return;
  const ok = await confirmDialog(`删除卡片「${card.front}」？`, { title: '删除卡片', danger: true });
  if (ok) {
    store.deleteCard(deck.id, card.id);
    toast('卡片已删除');
    navigate(`#/deck/${deck.id}/cards`);
  }
});

/* 关卡动作 */
on('level-learn', (el) => navigate(`#/review/${el.dataset.id}/${el.dataset.level}?mode=learn`));
on('level-review', (el) => navigate(`#/review/${el.dataset.id}/${el.dataset.level}?mode=due`));
on('level-test', (el) => navigate(`#/test/${el.dataset.id}/${el.dataset.level}`));

/* 整卡组翻转记忆（顶部按钮）：洗牌全部卡片循环翻转 */
on('open-all-review', (el) => navigate(`#/review/${el.dataset.id}`));

/* 整卡组可配置测试（顶部按钮）：20~150 题 */
on('open-deck-test', (el) => navigate(`#/test/${el.dataset.id}`));

/* 明牌配对（通关 ≥ UNLOCK_LEVELS 关后出现）：把本关单词与释义两两配对的明牌小游戏 */
on('open-match', (el) => navigate(`#/match/${el.dataset.id}`));

/* 关卡分页（关卡数 > 15 时，每页 15 关；URL 为 1 基页号） */
on('deck-page', (el) => {
  const id = el.dataset.id;
  const page = Math.max(1, Number(el.dataset.page) || 1);
  if (id) navigate(`#/deck/${id}?page=${page}`);
});

/* 卡片分页（卡片数 > CARDS_PER_PAGE 时，每页 100 张） */
on('cards-page', (el) => {
  const id = el.dataset.id;
  const page = Math.max(1, Number(el.dataset.page) || 1);
  if (id) navigate(`#/deck/${id}/cards?page=${page}`);
});

/* 按难度重排关卡：难度分层 + 错峰 + 错题动态提前 */
on('rearrange-deck', (el) => {
  const deck = store.getDeck(el.dataset.id);
  if (!deck) return;
  const levels = lv.deckLevels(deck);
  const states = lv.levelStates(deck);
  const first = levels.find((l) => states[l.index] !== 'passed');
  const activeLevel = first ? first.index : 0;
  const res = store.rearrangeDeck(deck.id, {
    errorIds: te.getPriorityIds(deck.id),
    hardIds: hw.hardSet(deck.id),
    activeLevel,
    minGapLevels: 2
  });
  toast(`已重排 ${res.levels} 关 · ${res.moved} 张卡片位置更新`, 'good');
  navigate(`#/deck/${deck.id}?page=${Math.floor(activeLevel / lv.LEVELS_PER_PAGE) + 1}`);
});

/* 重新挑战：清测试会话（题目池重新洗牌）+ 清除通关标记（保留复习进度）+ 重刷计数 +1 */
on('level-retry', (el) => {
  const deckId = el.dataset.id;
  const level = Number(el.dataset.level);
  clearTestSession();
  store.unmarkLevelPassed(deckId, level);
  ls.bumpRetries(deckId, level);
  navigate(`#/test/${deckId}/${level}`);
});

/* 示范导入 */
on('import-demo', async (el) => {
  if (el.classList) el.classList.add('is-loading');
  try {
    const deck = await importDemoDeck();
    if (deck) {
      toast(`已导入「${deck.name}」${deck.cards.length} 张 · ${deck.cards.length ? '开始闯关吧！' : ''}`);
    } else {
      toast('已经导入过示范卡组了', 'warn');
    }
  } catch (e) {
    console.error(e);
    toast('导入失败：请检查网络后再试（需在线获取一次词库）', 'error');
  }
  if (el.classList) el.classList.remove('is-loading');
  navigate('#/home');
});

/** 供其它模块复用 */
export function refresh() {
  navigate(location.hash || '#/home');
}
