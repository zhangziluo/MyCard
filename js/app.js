// ============================================================================
// app.js — 入口：路由分发、顶栏、设置页、SW 注册、首次启动导入示范词库
// ============================================================================

import * as store from './store.js';
import * as difficulty from './difficulty.js';
import * as engdefs from './engdefs.js';
import * as theme from './theme.js';
import { on, bindDocument, navigate, toast, confirmDialog } from './ui.js';
import * as decks from './decks.js';
import { renderReview, clearReviewSession } from './review.js';
import { renderTest, clearTestSession } from './test.js';
import { renderTableEditor } from './table-editor.js';

const APP_VERSION = 'v0.5.6';

/* ------------------------------ 路由解析 ------------------------------ */

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const seg = path.split('/').filter(Boolean);
  const q = new URLSearchParams(query);
  const mode = q.get('mode') || null;

  if (!seg.length || seg[0] === 'home') return { view: 'home', mode };
  if (seg[0] === 'settings') return { view: 'settings', mode };
  // #/editor → 表格编辑（在网页里按模版列填词表，再导入为卡组）
  if (seg[0] === 'editor') return { view: 'editor', mode };
  if (seg[0] === 'deck' && seg[1]) {
    if (seg[2] === 'cards') return { view: 'cards', id: seg[1], mode };
    return { view: 'deck', id: seg[1], mode };
  }
  if (seg[0] === 'review' && seg[1]) {
    // #/review/{deck}          → 整卡组翻转循环（突破关卡限制）
    // #/review/{deck}/{level}  → 按关卡翻转
    if (seg[2] == null) return { view: 'review', id: seg[1], level: null, mode: 'all' };
    return { view: 'review', id: seg[1], level: Number(seg[2]), mode: mode === 'due' ? 'due' : 'learn' };
  }
  if (seg[0] === 'test' && seg[1]) {
    // #/test/{deck}         → 整卡组可配置测试（20~150 题）
    // #/test/{deck}/{level} → 按关卡测试
    if (seg[2] == null) return { view: 'test', id: seg[1], level: null, mode };
    return { view: 'test', id: seg[1], level: Number(seg[2]), mode };
  }
  return { view: 'home', mode };
}

/* ------------------------------ 明暗模式 UI ------------------------------ */

/** 明暗模式图标：sun / moon / auto */
function modeIcon(name, size = 18) {
  const paths = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8Z"/>',
    auto: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18"/><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none"/>'
  };
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
}

/** 顶栏明暗快捷切换（图标 = 点击后会切换到的模式） */
function themeToggleHtml() {
  const effective = theme.resolveMode(theme.loadMode());
  const next = effective === 'dark' ? 'light' : 'dark';
  const label = next === 'light' ? '切换到浅色模式' : '切换到深色模式';
  return `<button class="icon-btn glass" data-action="toggle-mode" aria-label="${label}" title="${label}">${modeIcon(
    next === 'light' ? 'sun' : 'moon',
    19
  )}</button>`;
}

/* ------------------------------ 顶栏 ------------------------------ */

function renderAppbar(route) {
  const back = document.getElementById('appbar-back');
  const title = document.getElementById('appbar-title');
  const deck = route.id ? store.getDeck(route.id) : null;

  let backHref = '';
  let showBack = false;
  let t = 'Mycard';
  let side = '';

  switch (route.view) {
    case 'home':
      t = 'Mycard · 学习卡片';
      side = `<span class="appbar-ver">${APP_VERSION}</span>`;
      break;
    case 'deck':
      showBack = true;
      backHref = '#/home';
      t = deck ? deck.name : '卡组';
      break;
    case 'cards':
      showBack = true;
      backHref = route.id ? `#/deck/${route.id}` : '#/home';
      t = '管理卡片';
      break;
    case 'review':
      showBack = true;
      backHref = route.id ? `#/deck/${route.id}` : '#/home';
      t = route.mode === 'due' ? '复习' : '翻转记忆';
      break;
    case 'test':
      showBack = true;
      backHref = route.id ? `#/deck/${route.id}` : '#/home';
      t = route.level == null ? '整卡组测试' : '关卡测试';
      break;
    case 'settings':
      showBack = true;
      backHref = '#/home';
      t = '设置';
      break;
    case 'editor':
      showBack = true;
      backHref = '#/home';
      t = '表格编辑';
      break;
    default:
      t = 'Mycard';
  }

  back.style.visibility = showBack ? 'visible' : 'hidden';
  back.dataset.href = backHref || '';
  title.textContent = t;
  const sideEl = document.getElementById('appbar-side');
  sideEl.innerHTML = themeToggleHtml() + side;
}

on('nav-back', (el) => {
  if (el.dataset && el.dataset.href) {
    navigate(el.dataset.href);
  } else {
    history.back();
  }
});

/* ------------------------------ 渲染入口 ------------------------------ */

export function render() {
  const route = parseHash();
  const root = document.getElementById('view');
  root.dataset.flipped = '0';
  renderAppbar(route);

  if (route.view === 'home') {
    decks.renderHome(root);
  } else if (route.view === 'deck') {
    decks.renderDeck(root, route.id);
  } else if (route.view === 'cards') {
    decks.renderCards(root, route.id);
  } else if (route.view === 'review') {
    renderReview(root, route.id, route.level, route.mode);
  } else if (route.view === 'test') {
    renderTest(root, route.id, route.level);
  } else if (route.view === 'settings') {
    renderSettings(root);
  } else if (route.view === 'editor') {
    renderTableEditor(root);
  } else {
    decks.renderHome(root);
  }
  document.getElementById('view').scrollTop = 0;
  window.scrollTo(0, 0);
}
/* ------------------------------ 设置页 ------------------------------ */

function renderSettings(root) {
  const db = store.getDb();
  const per = db.settings.cardsPerLevel;
  const info = store.storageInfo();
  const sizeKb = info.localBytes / 1024;
  const accent = theme.loadAccent();
  const mode = theme.loadMode();

  root.innerHTML = `
  <div class="view settings-view">
    <section class="panel glass">
      <h3 class="panel-title">外观</h3>
      <p class="panel-desc">浅色 / 深色主题，或跟随系统设置自动切换；选择保存在本机（清空数据不会重置）。</p>
      <div class="segmented" role="group" aria-label="明暗模式">
        ${theme.MODES.map(
          (m) =>
            `<button class="seg-btn${mode === m.id ? ' is-active' : ''}" data-action="set-mode" data-mode="${m.id}" aria-pressed="${
              mode === m.id ? 'true' : 'false'
            }">${modeIcon(m.icon, 16)}<span>${m.label}</span></button>`
        ).join('')}
      </div>
    </section>

    <section class="panel glass">
      <h3 class="panel-title">主题色</h3>
      <p class="panel-desc">选择网页主色调，按钮、进度条、徽标、氛围光会全局跟随；选择保存在本机（清空数据不会重置）。</p>
      <div class="theme-swatches">
        ${theme.ACCENT_PRESETS.map(
          (p) =>
            `<button class="swatch${accent === p.color ? ' is-active' : ''}" style="background:${p.color}" data-action="set-accent" data-color="${p.color}" aria-label="${p.name}" title="${p.name}"></button>`
        ).join('')}
      </div>
      <label class="theme-custom">自定义颜色
        <input type="color" data-action="accent-input" name="accent" value="${accent}" aria-label="自定义主题色">
      </label>
    </section>

    <section class="panel glass">
      <h3 class="panel-title">关卡设置</h3>
      <p class="panel-desc">每个卡组按「每关 15–30 张」自动划分关卡并顺序解锁。导入内置词库时会按难度自动编排：前几关高频短词打基础，后续逐步混入长难词；形近/同根词错峰出现；错题会动态提前。</p>
      <div class="stepper-row">
        <button class="stepper-btn" data-action="set-per-minus" aria-label="减少">−</button>
        <div class="stepper-val">
          <b>${per}</b><span>张 / 关</span>
        </div>
        <button class="stepper-btn" data-action="set-per-plus" aria-label="增加">＋</button>
      </div>
      <p class="hint">修改后会立即按新词数重新划分「跟随全局设置」的卡组（每关词汇数即时更新）；给卡组单独设置过词数的，请在卡组编辑里单独调整。小于 30 张的小卡组始终作为单关卡；关卡超过 15 关时按页显示（每页 15 关）。</p>
    </section>

    <section class="panel glass">
      <h3 class="panel-title">数据</h3>
      <ul class="data-list">
        <li><span>卡组数量</span><b>${info.decks}</b></li>
        <li><span>卡片总数</span><b>${info.cards}</b></li>
        <li><span>存储方式</span><b>${info.mode === 'indexeddb' ? 'IndexedDB（推荐）' : 'localStorage（回退）'}</b></li>
        <li><span>元数据占用</span><b>${sizeKb.toFixed(1)} KB</b></li>
        <li><span>本地存储键</span><b class="mono">mycard-meta</b></li>
      </ul>
      <p class="hint">卡片正文与学习进度保存在浏览器 IndexedDB，可容纳多本大词库；localStorage 只保留设置与卡组清单。</p>
      <button class="btn btn-danger btn-block" data-action="reset-all">清空全部数据并重置</button>
      <button class="btn btn-ghost btn-block" data-action="hard-refresh">强制刷新到最新版（清理离线缓存）</button>
    </section>

    <section class="panel glass">
      <h3 class="panel-title">关于 Mycard</h3>
      <p class="panel-desc">基于艾宾浩斯遗忘曲线的间隔重复记忆卡片。翻转记忆 + 关卡闯关 + 离线可用。</p>
      <ul class="about-list">
        <li>版本：${APP_VERSION}（${db.seededDemo ? '已初始化示范词库' : '未导入示范词库'}）</li>
        <li>数据保存在本机浏览器（IndexedDB + localStorage），不会上传任何服务器</li>
        <li>离线可用：Service Worker 已缓存应用与内置词库</li>
        <li>推荐：从浏览器菜单选择「添加到主屏幕」安装为 App</li>
      </ul>
    </section>
  </div>`;
}

on('set-per-minus', () => {
  const d = store.getDb();
  store.setSetting('cardsPerLevel', Math.max(15, d.settings.cardsPerLevel - 1));
  render();
});
on('set-per-plus', () => {
  const d = store.getDb();
  store.setSetting('cardsPerLevel', Math.min(30, d.settings.cardsPerLevel + 1));
  render();
});

/* ------------------------------ 主题色 ------------------------------ */

on('set-accent', (el) => {
  const color = el.dataset && el.dataset.color;
  if (!color) return;
  theme.setAccent(color);
  render();
});

/* 设置页「外观」：浅色 / 深色 / 跟随系统 */
on('set-mode', (el) => {
  const m = el.dataset && el.dataset.mode;
  if (!m) return;
  theme.setMode(m);
  render();
});

/* 顶栏：明暗快捷切换（浅色 ⇄ 深色） */
on('toggle-mode', () => {
  theme.toggleMode();
  render();
});
/* 拖动取色时即时生效（不重渲染，避免打断系统取色器） */
on(
  'accent-input',
  (el) => {
    if (el && el.value) theme.setAccent(el.value);
  },
  'input'
);
/* 取色结束后同步色块高亮状态 */
on(
  'accent-input',
  () => {
    render();
  },
  'change'
);

on('reset-all', async () => {
  const ok = await confirmDialog('确定清空全部数据吗？所有卡组与学习进度都会被删除。', {
    title: '清空数据',
    danger: true
  });
  if (ok) {
    store.resetAll();
    clearReviewSession();
    clearTestSession();
    toast('已重置，将重新初始化');
    setTimeout(() => {
      location.hash = '#/home';
      location.reload();
    }, 500);
  }
});

/* 强制刷新到最新版：清掉 Service Worker 缓存与注册后再加载
   （用于浏览器/PWA 仍在使用旧缓存页面、看不到新功能时） */
on('hard-refresh', async () => {
  try {
    if (typeof caches !== 'undefined' && caches.keys) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch (e) {
    console.warn('[mycard] 清理离线缓存失败', e);
  }
  toast('已清理离线缓存，正在重新加载…');
  setTimeout(() => location.reload(), 400);
});

/* ------------------------------ 启动 ------------------------------ */

function boot() {
  // 主题色：尽早写入 CSS 变量，避免首屏闪回默认色
  try {
    theme.init(() => render());
  } catch (e) {}

  bindDocument();

  // 启动流程：初始化存储（IndexedDB 优先，自动迁移旧版 localStorage 数据）
  //  → 首次启动自动导入示范词库 → 加载词频表 → 渲染
  (async () => {
    try {
      const info = await store.init();
      console.log(`[mycard] 存储就绪：${info.idb ? 'IndexedDB' : 'localStorage 回退'}`, info);
    } catch (e) {
      console.warn('[mycard] 存储初始化失败，使用内存模式', e);
    }

    try {
      if (store.getDb().decks.length === 0) {
        // 失败只告警，不阻塞页面渲染（离线首次打开时提示稍后联网）
        const demoDeck = await decks.importDemoDeck();
        if (demoDeck) {
          console.log(`[mycard] 已自动导入示范卡组：${demoDeck.name}（${demoDeck.cards.length} 张）`);
        }
      } else {
        const enriched = await decks.ensureDemoEnrichment();
        if (enriched) console.log('[mycard] 已为存量示范卡组补标易混分组/多释义');
      }
    } catch (e) {
      console.warn('[mycard] 首次自动导入/升级词库失败（需联网一次）', e);
    }

    // 旧版本内置的考试词库（考研等）已下线：清理浏览器里遗留的历史卡组
    try {
      const purged = store.purgeRemovedBuiltins();
      if (purged.count) {
        console.log(`[mycard] 已清理 ${purged.count} 个已下线词库：${purged.names.join('、')}`);
        toast(`已清理 ${purged.count} 个已下线词库：${purged.names.join('、')}`, 'info');
      }
    } catch (e) {
      console.warn('[mycard] 清理旧内置词库失败', e);
    }

    // 词频表（难度判定的外部数据）：失败不影响使用，按中低频兜底
    try {
      const n = await difficulty.loadFrequency();
      if (n) console.log(`[mycard] 已加载词频表（${n} 词）`);
    } catch (e) {}

    // GCIDE 英文释义表（英英选择 / 多义多选题型用）：失败不影响其它题型
    try {
      const map = await engdefs.ensureLoaded();
      console.log(`[mycard] 已加载 GCIDE 英文释义（${map.size} 词）`);
    } catch (e) {
      console.warn('[mycard] GCIDE 英文释义加载失败（英英题/多义题将暂不可用）', e);
    }

    render();
  })();

  // 离开页面前把待写数据落盘（IndexedDB 写入是防抖批量的）
  window.addEventListener('pagehide', () => {
    try {
      store.flushPending();
    } catch (e) {}
  });

  window.addEventListener('hashchange', () => {
    clearReviewSession();
    clearTestSession(); // 同时清除测试会话与自动跳题定时器
    render();
  });

  // PWA：注册 Service Worker（install 阶段预缓存，使应用离线可用）
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('[mycard] SW 注册失败', e));
    });
    // 新版本 SW 接管后自动刷新一次，避免用户停留在旧缓存页面看不到新功能
    // （仅在「此前已有 SW 控制」时刷新，首次安装不会多刷）
    let refreshed = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || refreshed) return;
      refreshed = true;
      location.reload();
    });
  }
}

boot();
