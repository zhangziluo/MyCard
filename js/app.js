// ============================================================================
// app.js — 入口：路由分发、顶栏、设置页、SW 注册、首次启动导入示范词库
// ============================================================================

import * as store from './store.js';
import { on, bindDocument, navigate, toast, confirmDialog } from './ui.js';
import * as decks from './decks.js';
import { renderReview, clearReviewSession } from './review.js';
import { renderTest, clearTestSession } from './test.js';

const APP_VERSION = 'v0.1.0';

/* ------------------------------ 路由解析 ------------------------------ */

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const seg = path.split('/').filter(Boolean);
  const q = new URLSearchParams(query);
  const mode = q.get('mode') || null;

  if (!seg.length || seg[0] === 'home') return { view: 'home', mode };
  if (seg[0] === 'settings') return { view: 'settings', mode };
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
      side = '<span class="appbar-ver">v0.1</span>';
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
    default:
      t = 'Mycard';
  }

  back.style.visibility = showBack ? 'visible' : 'hidden';
  back.dataset.href = backHref || '';
  title.textContent = t;
  const sideEl = document.getElementById('appbar-side');
  sideEl.innerHTML = side;
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
  const totalCards = db.decks.reduce((n, d) => n + d.cards.length, 0);
  let sizeKb = 0;
  try {
    const raw = localStorage.getItem(store.STORAGE_KEY) || '';
    sizeKb = (raw.length * 2) / 1024;
  } catch (e) {}

  root.innerHTML = `
  <div class="view settings-view">
    <section class="panel glass">
      <h3 class="panel-title">关卡设置</h3>
      <p class="panel-desc">每个卡组按「每关 15–30 张」自动划分关卡并顺序解锁。通关条件：学完本关全部卡片 + 测试正确率 ≥ 80%。</p>
      <div class="stepper-row">
        <button class="stepper-btn" data-action="set-per-minus" aria-label="减少">−</button>
        <div class="stepper-val">
          <b>${per}</b><span>张 / 关</span>
        </div>
        <button class="stepper-btn" data-action="set-per-plus" aria-label="增加">＋</button>
      </div>
      <p class="hint">当前设置作为新卡组 / 导入词库的默认每关卡片数，也可在每个卡组内单独调整。小于 30 张的小卡组始终作为单关卡。</p>
    </section>

    <section class="panel glass">
      <h3 class="panel-title">数据</h3>
      <ul class="data-list">
        <li><span>卡组数量</span><b>${db.decks.length}</b></li>
        <li><span>卡片总数</span><b>${totalCards}</b></li>
        <li><span>本地存储</span><b>${sizeKb.toFixed(1)} KB</b></li>
        <li><span>存储位置</span><b class="mono">mycard-v1</b></li>
      </ul>
      <button class="btn btn-danger btn-block" data-action="reset-all">清空全部数据并重置</button>
    </section>

    <section class="panel glass">
      <h3 class="panel-title">关于 Mycard</h3>
      <p class="panel-desc">基于艾宾浩斯遗忘曲线的间隔重复记忆卡片。翻转记忆 + 关卡闯关 + 离线可用。</p>
      <ul class="about-list">
        <li>版本：${APP_VERSION}（${db.seededDemo ? '已初始化示范词库' : '未导入示范词库'}）</li>
        <li>数据保存在本机浏览器 localStorage，不会上传任何服务器</li>
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

/* ------------------------------ 启动 ------------------------------ */

function boot() {
  bindDocument();

  // 首次启动自动导入内置词库（示范词库 + 考研词汇）；旧版示范卡组则补标 v0.2 易混数据
  (async () => {
    try {
      if (store.getDb().decks.length === 0) {
        // 任一失败只告警，不阻塞页面渲染（离线首次打开时提示稍后联网）
        const [demoRes, kaoyanRes] = await Promise.allSettled([
          decks.importDemoDeck(),
          decks.importKaoyanDeck()
        ]);
        if (demoRes.status === 'fulfilled' && demoRes.value) {
          console.log(`[mycard] 已自动导入示范卡组：${demoRes.value.name}（${demoRes.value.cards.length} 张）`);
        } else if (demoRes.status === 'rejected') {
          console.warn('[mycard] 示范词库自动导入失败', demoRes.reason);
        }
        if (kaoyanRes.status === 'fulfilled' && kaoyanRes.value) {
          console.log(`[mycard] 已自动导入考研卡组：${kaoyanRes.value.name}（${kaoyanRes.value.cards.length} 张）`);
        } else if (kaoyanRes.status === 'rejected') {
          console.warn('[mycard] 考研词库自动导入失败（需联网一次）', kaoyanRes.reason);
        }
      } else {
        const enriched = await decks.ensureDemoEnrichment();
        if (enriched) console.log('[mycard] 已为存量示范卡组补标易混分组/多释义');
      }
    } catch (e) {
      console.warn('[mycard] 首次自动导入/升级词库失败（需联网一次）', e);
    }
    render();
  })();

  window.addEventListener('hashchange', () => {
    clearReviewSession();
    clearTestSession(); // 同时清除测试会话与自动跳题定时器
    render();
  });

  // PWA：注册 Service Worker（install 阶段预缓存，使应用离线可用）
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('[mycard] SW 注册失败', e));
    });
  }
}

boot();
