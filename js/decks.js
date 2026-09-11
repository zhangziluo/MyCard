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
import { importFileButtonHtml, dropzoneHtml, bindDropzone } from './import-file.js';
import { esc, on, navigate, openModal, closeModal, readForm, toast, confirmDialog, parseTags } from './ui.js';

const ACTIVE_TAG_KEY = 'mycard-active-tag';
let activeTag = localStorage.getItem(ACTIVE_TAG_KEY) || '全部';

/* ------------------------------- 图标 ------------------------------- */

function icon(name, size = 18) {
  const paths = {
    gear: '<path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1h.1a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
    trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M10 11v6M14 11v6"/>',
    edit: '<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3Z"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
    cards: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M7 21h10M10 21h4"/>',
    pause: '<rect x="7" y="4" width="3" height="16" rx="1.5"/><rect x="14" y="4" width="3" height="16" rx="1.5"/>',
    play: '<path d="M7 5.5v13l11-6.5L7 5.5Z"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3.5V9h-5.5"/>',
    card: '<rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M9 8h6M9 12h6"/>',
    tag: '<path d="M12 2H2v10l9.3 9.3a2 2 0 0 0 2.8 0l7-7a2 2 0 0 0 0-2.8L12 2Z"/><circle cx="7.5" cy="7.5" r="1.2"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>'
  };
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] || ''}</svg>`;
}

function tagBadges(tags, cls = '') {
  return (tags || [])
    .map((t) => `<span class="tag ${cls}" data-action="filter-tag" data-tag="${esc(t)}">${esc(t)}</span>`)
    .join('');
}

/* ------------------------------ 首页 / 卡组列表 ------------------------------ */

function levelProgressSummary(deck) {
  const levels = lv.deckLevels(deck);
  if (!levels.length) return { levels: 0, passed: 0 };
  const states = lv.levelStates(deck);
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
    <div class="tag-row">${tagBadges(deck.tags)}</div>
    <div class="deck-progress">
      <div class="progress-track"><i class="progress-fill" style="width:${pct}%"></i></div>
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
        `<button class="chip${t === activeTag ? ' chip-on' : ''}" data-action="filter-tag" data-tag="${esc(t)}">${esc(t)}${t === '全部' ? ` (${db.decks.length})` : ''}</button>`
    )
    .join('');

  const demoBanner = !hasDemo
    ? `<div class="banner glass" data-action="import-demo">
         <span class="banner-icon">${icon('card', 22)}</span>
         <div><b>导入示范卡组</b><p>内置「英语高频词」约 60 词，分 3 关，体验关卡闯关模式</p></div>
         <span class="banner-go">${icon('back', 18)}</span>
       </div>`
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
          ${importFileButtonHtml()}
          <button class="icon-btn glass" data-action="nav-settings" aria-label="设置">${icon('gear', 20)}</button>
        </div>
      </div>
      ${dropzoneHtml()}
      ${tags.length ? `<div class="chips scroll-x">${chips}</div>` : ''}
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
    <div class="progress-track"><i class="progress-fill" style="width:${pct}%"></i></div>
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
  <div class="pager glass">
    <button class="pager-btn" data-action="deck-page" data-id="${esc(deckId)}" data-page="${page}" ${page <= 0 ? 'disabled' : ''}>‹ 上一页</button>
    <div class="pager-info"><b>${lv.levelPageLabel(page, totalLevels)}</b><span>第 ${from}–${to} 关 / 共 ${totalLevels} 关</span></div>
    <button class="pager-btn" data-action="deck-page" data-id="${esc(deckId)}" data-page="${page + 2}" ${page >= total - 1 ? 'disabled' : ''}>下一页 ›</button>
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
  const states = lv.levelStates(deck);
  const stats = lv.deckStats(deck, now);
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
          <div><b>${levels.filter((l) => states[l.index] === 'passed').length}/${levels.length}</b><span>通关关卡</span></div>
        </div>
        ${stats.total ? `<div class="hero-actions">
          <button class="btn btn-primary btn-block hero-flip-btn" data-action="open-all-review" data-id="${esc(deck.id)}">${icon('refresh', 18)} 翻转记忆 · 整卡组循环${hw.hardCount(deck.id) ? `（困难词 ${hw.hardCount(deck.id)}）` : ''}</button>
          <button class="btn btn-test btn-block" data-action="open-deck-test" data-id="${esc(deck.id)}">${icon('card', 18)} 整卡组测试 · 20~150 题</button>
          <button class="btn btn-ghost btn-block" data-action="rearrange-deck" data-id="${esc(deck.id)}">${icon('refresh', 16)} 按难度重排关卡（错题提前）</button>
        </div>` : ''}
      </div>
      <div class="levels-wrap">${levelsHtml}</div>
      <button class="btn btn-ghost btn-block manage-btn" data-action="open-cards" data-id="${esc(deck.id)}">${icon('cards', 16)} 管理卡片（${stats.total} 张）</button>
    </div>`;
}
/* ------------------------------ 卡片管理 ------------------------------ */

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
  const cards = [...deck.cards].sort((a, b) => (a.level ?? 0) - (b.level ?? 0) || a.createdAt - b.createdAt);
  const rows = cards.length
    ? cards.map((c) => cardRowHtml(deck, c)).join('')
    : `<div class="empty glass"><div class="empty-icon">${icon('card', 26)}</div><h3>这个卡组还是空的</h3><p>点击下方按钮添加第一张学习卡片。</p></div>`;

  root.innerHTML = `
    <div class="view view-cards">
      <div class="section-head">
        <h2 class="screen-title">卡片管理</h2>
        <span class="sub-note">${esc(deck.name)} · ${cards.length} 张</span>
      </div>
      <div class="cards-list">${rows}</div>
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

function cardFormModal(deck, card) {
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
        <button class="menu-item danger-item" data-action="deck-delete" data-id="${esc(deck.id)}">${icon('trash', 18)} 删除卡组</button>
      </div>`
  });
}

/* ------------------------------ Action 注册 ------------------------------ */

on('nav-settings', () => navigate('#/settings'));

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

/* 关卡分页（关卡数 > 15 时，每页 15 关；URL 为 1 基页号） */
on('deck-page', (el) => {
  const id = el.dataset.id;
  const page = Math.max(1, Number(el.dataset.page) || 1);
  if (id) navigate(`#/deck/${id}?page=${page}`);
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
