// ============================================================================
// app.js — 入口：路由分发、顶栏、设置页、SW 注册、首次启动导入示范词库
// ============================================================================

import * as store from './store.js';
import * as difficulty from './difficulty.js';
import * as engdefs from './engdefs.js';
import * as theme from './theme.js';
import { esc, on, bindDocument, navigate, toast, confirmDialog, announce, openModal } from './ui.js';
import * as decks from './decks.js';
import * as sync from './sync.js'; // v0.8.0 多端同步（WebDAV）
import * as webdav from './webdav.js';
import { renderReview, clearReviewSession } from './review.js';
import { renderTest, clearTestSession } from './test.js';
import { renderTableEditor } from './table-editor.js';
import { renderWordbook } from './wordbook-view.js'; // v0.5.9 生词本批量整理（#/words）
import { renderMatch, clearMatchSession } from './match.js'; // v0.5.12 明牌配对（#/match/{deck}）
import { renderCrossword, clearCrosswordSession } from './crossword.js'; // v0.6.0 填字游戏（#/crossword/{deck}）

const APP_VERSION = 'v0.9.2';

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
  // #/words?page=N → 生词本批量整理（去重合并 / 标签整理 / 补查）
  if (seg[0] === 'words') return { view: 'words', page: Number(q.get('page')) || 1, mode };
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
  // #/match/{deck} → 明牌配对游戏（通关 ≥1 关后解锁）
  if (seg[0] === 'match' && seg[1]) return { view: 'match', id: seg[1], level: null, mode };
  // #/crossword/{deck} → 填字游戏（通关 ≥1 关后解锁，按当前词库生成棋盘）
  if (seg[0] === 'crossword' && seg[1]) return { view: 'crossword', id: seg[1], level: null, mode };
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
    case 'match':
      showBack = true;
      backHref = route.id ? `#/deck/${route.id}` : '#/home';
      t = '明牌配对';
      break;
    case 'crossword':
      showBack = true;
      backHref = route.id ? `#/deck/${route.id}` : '#/home';
      t = '填字游戏';
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
    case 'words':
      showBack = true;
      backHref = '#/home';
      t = '生词本整理';
      break;
    default:
      t = 'Mycard';
  }

  back.style.visibility = showBack ? 'visible' : 'hidden';
  back.dataset.href = backHref || '';
  title.textContent = t;
  const sideEl = document.getElementById('appbar-side');
  sideEl.innerHTML = themeToggleHtml() + side;
  return t;
}

on('nav-back', (el) => {
  if (el.dataset && el.dataset.href) {
    navigate(el.dataset.href);
  } else {
    history.back();
  }
});

/* ------------------------------ 渲染入口 ------------------------------ */

let lastRouteKey = ''; // 只在「路由变化」时向读屏播报，避免每次重渲染都打扰

export function render() {
  const route = parseHash();
  const root = document.getElementById('view');
  root.dataset.flipped = '0';
  const pageTitle = renderAppbar(route);

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
  } else if (route.view === 'words') {
    renderWordbook(root);
  } else if (route.view === 'match') {
    renderMatch(root, route.id);
  } else if (route.view === 'crossword') {
    renderCrossword(root, route.id);
  } else {
    decks.renderHome(root);
  }
  document.getElementById('view').scrollTop = 0;
  window.scrollTo(0, 0);

  // 路由变化 → 读屏播报当前页面标题（同一路由的重复渲染不打扰）
  const routeKey = `${route.view}:${route.id || ''}:${route.level ?? ''}`;
  if (routeKey !== lastRouteKey) {
    lastRouteKey = routeKey;
    announce(pageTitle);
  }
}
/* ------------------------------ 设置页 ------------------------------ */

/** 多端同步（WebDAV）设置区块（v0.9.0：增量传输 + 预览差异 + 本机专用卡组） */
function syncSectionHtml() {
  const cfg = sync.loadConfig();
  const st = sync.syncStatus();
  const last = st.lastResult;
  const lastAt = st.lastSyncAt ? fmtTime(st.lastSyncAt) : '—';
  const statusCls = !last ? '' : last.ok ? 'is-good' : 'is-bad';
  const statusText = !st.configured ? '未配置：填好地址 / 用户名 / 密码后即可同步' : sync.lastResultText(last);
  const passPlaceholder = cfg.pass ? '已保存（留空沿用）' : '应用密码 / 登录密码';
  const localOnly = sync.localOnlyDeckIds();
  const total = store.getDb().decks.length;
  return `
    <section class="panel glass">
      <h3 class="panel-title">多端同步（WebDAV）</h3>
      <p class="panel-desc">把<b>词库、学习进度与复习日志</b>同步到<b>你自己的</b> WebDAV 网盘（坚果云 / Nextcloud / Synology…），多台设备共用一份数据。合并规则：<b>内容看最后修改时间、学习进度看最后学习时间</b>（只进不退），删除也会同步过去。同步采用<b>按卡组分文件 + 只传变化</b>的方式，改一个卡组只传这个卡组；同步前可以<b>先预览差异</b>再决定。</p>
      <div class="sync-grid">
        <label class="field"><span>服务器地址</span>
          <input id="sync-url" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://dav.jianguoyun.com/dav/" value="${esc(cfg.url)}">
        </label>
        <div class="sync-row">
          <label class="field"><span>用户名</span>
            <input id="sync-user" type="text" autocomplete="username" spellcheck="false" value="${esc(cfg.user)}">
          </label>
          <label class="field"><span>密码</span>
            <input id="sync-pass" type="password" autocomplete="current-password" placeholder="${esc(passPlaceholder)}">
          </label>
        </div>
        <label class="field"><span>同步目录（不存在会自动创建）</span>
          <input id="sync-dir" type="text" autocomplete="off" spellcheck="false" placeholder="mycard" value="${esc(cfg.dir)}">
        </label>
        <label class="sync-check"><input id="sync-remember" type="checkbox" data-action="sync-toggle" data-field="remember" ${cfg.remember ? 'checked' : ''}><span>记住密码（明文保存在本机浏览器，公共设备请勿勾选）</span></label>
        <label class="sync-check"><input id="sync-auto-load" type="checkbox" data-action="sync-toggle" data-field="autoOnLoad" ${cfg.autoOnLoad ? 'checked' : ''}><span>打开应用时自动同步一次</span></label>
        <label class="sync-check"><input id="sync-auto-change" type="checkbox" data-action="sync-toggle" data-field="autoOnChange" ${cfg.autoOnChange ? 'checked' : ''}><span>数据变更后自动同步（每 5 分钟检查一次）</span></label>
      </div>
      <div class="sync-status ${statusCls}">
        <b>${esc(statusText)}</b>
        <span>上次同步：${esc(lastAt)}${cfg.device ? ` · 本机标识 ${esc(cfg.device)}` : ''}</span>
      </div>
      ${
        localOnly.length
          ? `<p class="sync-note">已排除 ${localOnly.length} / ${total} 个「本机专用」卡组：它们不上传，也不会被其他设备改动或删除（在卡组编辑弹窗里可以开关）。</p>`
          : ''
      }
      <div class="sync-actions">
        <button class="btn btn-primary" data-action="sync-now">立即同步</button>
        <button class="btn btn-ghost" data-action="sync-preview">预览差异</button>
        <button class="btn btn-ghost" data-action="sync-test">测试连接</button>
        <button class="btn btn-ghost" data-action="sync-diag">诊断连接</button>
        <button class="btn btn-ghost" data-action="sync-save">保存设置</button>
        <button class="btn btn-ghost" data-action="sync-clear">清除密码</button>
      </div>
      <p class="hint">网盘上的文件：<code>mycard-sync.json</code>（索引：每个卡组的摘要与指纹）＋ <code>mycard-decks/卡组id.json</code>（各卡组内容）＋ <code>mycard-sync.prev.json</code>（索引备份，可手工回滚）＋ <code>mycard-sync.lock.json</code>（同步锁，同步结束后自动删除）。<b>浏览器直连 WebDAV 需要网盘允许跨域</b>：连不上时点 <b>「诊断连接」</b>，它会逐步判断是「网络不通」「跨域被拦」还是「账号密码不对」，并给出可直接执行的建议（报告可复制，且不含密码）。坚果云示例：地址 <code>https://dav.jianguoyun.com/dav/</code>、用户名填<b>注册邮箱</b>、密码填「账户信息 → 安全选项 → 添加应用」生成的<b>应用密码</b>（登录密码无效）；Nextcloud 地址形如 <code>https://你的域名/remote.php/dav/files/用户名/</code>。</p>
    </section>`;
}

/** 时间戳 → `MM-DD HH:mm`（设置页同步状态用） */
function fmtTime(ts) {
  try {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch (e) {
    return '—';
  }
}

/** 读设置页同步表单 */
function readSyncForm() {
  const el = (id) => (typeof document !== 'undefined' && document.getElementById ? document.getElementById(id) : null);
  const val = (id) => {
    const node = el(id);
    return node && 'value' in node ? String(node.value || '').trim() : '';
  };
  const raw = (id) => {
    const node = el(id);
    return node && 'value' in node ? String(node.value || '') : '';
  };
  const chk = (id) => {
    const node = el(id);
    return !!(node && node.checked);
  };
  return {
    url: val('sync-url'),
    user: val('sync-user'),
    pass: raw('sync-pass'),
    dir: val('sync-dir'),
    remember: chk('sync-remember'),
    autoOnLoad: chk('sync-auto-load'),
    autoOnChange: chk('sync-auto-change')
  };
}

/** 保存同步表单（密码仅在填了新值时覆盖；勾「记住密码」才落本机） */
function saveSyncForm() {
  const f = readSyncForm();
  const cur = sync.loadConfig();
  const patch = {
    url: f.url,
    user: f.user,
    dir: f.dir,
    remember: f.remember,
    autoOnLoad: f.autoOnLoad,
    autoOnChange: f.autoOnChange
  };
  if (f.pass) patch.pass = f.pass;
  else if (!cur.pass) patch.pass = '';
  const next = sync.saveConfig(patch);
  sync.initAutoSync({ runNow: false }); // 开关变化 → 立刻按新配置重挂定时器（不在保存时抢跑同步）
  return next;
}

/** 一个卡组在预览里的变化文案 */
function syncChangeText(d) {
  if (d.status === 'added') return `远端新增卡组（${d.cardsAdded} 张卡${d.revlogs ? `、${d.revlogs} 条日志` : ''}）`;
  if (d.status === 'removed') return `删除卡组（${d.cardsRemoved} 张卡）`;
  const parts = [];
  if (d.cardsAdded) parts.push(`新增 ${d.cardsAdded} 张`);
  if (d.cardsUpdated) parts.push(`更新 ${d.cardsUpdated} 张`);
  if (d.cardsRemoved) parts.push(`删除 ${d.cardsRemoved} 张`);
  if (d.revlogs) parts.push(`日志 +${d.revlogs}`);
  return parts.length ? parts.join('、') : '无变化';
}

/** 冲突明细（同一张卡两端都改过：内容看修改时间、进度看学习时间） */
function syncConflictText(list) {
  if (!list || !list.length) return '—';
  const shown = list.slice(0, 4).map((c) => {
    const bits = [];
    if (c.contentFrom) bits.push(`内容取${c.contentFrom === 'local' ? '本机' : '远端'}`);
    if (c.progressFrom) bits.push(`进度取${c.progressFrom === 'local' ? '本机' : '远端'}`);
    return `<li>「${esc(c.front || c.cardId)}」${esc(bits.join('，'))}</li>`;
  });
  if (list.length > 4) shown.push(`<li>…等 ${list.length} 张</li>`);
  return `<ul class="sync-conflict-list">${shown.join('')}</ul>`;
}

/** 同步预览弹窗（只读对比；确认后再执行同步） */
function syncPreviewModal(pv) {
  const c = pv.counts;
  const rep = pv.report || { decks: [], conflicts: 0 };
  const rows = rep.decks.filter((d) => d.status !== 'unchanged' || d.conflicts.length);
  const remoteLine = pv.remoteExists
    ? `远端已有数据${pv.remoteDevice ? `（来自 ${pv.remoteDevice}` : '（'}${
        pv.remoteSavedAt ? `${pv.remoteDevice ? '，' : ''}${fmtTime(pv.remoteSavedAt)}` : ''
      }）；只下载了 ${pv.fetched.length} 个卡组文件。`
    : '远端还没有同步文件，本次会新建（首次同步 = 全量上传）。';
  const body = `
    <p class="panel-desc">${esc(sync.previewText(pv))}</p>
    <div class="sync-counts">
      <div><span>本机</span><b>${c.local.decks} 组 / ${c.local.cards} 卡 / ${c.local.revlogs} 日志</b></div>
      <div><span>网盘</span><b>${c.remote.decks} 组 / ${c.remote.cards} 卡 / ${c.remote.revlogs} 日志</b></div>
      <div><span>合并后</span><b>${c.merged.decks} 组 / ${c.merged.cards} 卡 / ${c.merged.revlogs} 日志</b></div>
    </div>
    <p class="hint">${esc(remoteLine)}${pv.legacy ? ' 检测到旧版单文件快照，本次会升级为「索引 + 分卡组」的新布局。' : ''}</p>
    ${
      rows.length
        ? `<table class="sync-table">
            <thead><tr><th scope="col">卡组</th><th scope="col">本次变化</th><th scope="col">冲突（采用）</th></tr></thead>
            <tbody>${rows
              .map(
                (d) =>
                  `<tr><td>${esc(d.name || d.id)}</td><td>${esc(syncChangeText(d))}</td><td>${syncConflictText(
                    d.conflicts
                  )}</td></tr>`
              )
              .join('')}</tbody>
          </table>`
        : '<p class="hint">两边内容完全一致，不需要传输任何卡组文件（只会刷新索引）。</p>'
    }
    <p class="hint">网络传输：下载 ${pv.fetched.length} 个卡组，上传 ${pv.toUpload.length} 个卡组${
      pv.toRemove.length ? `，删除远端 ${pv.toRemove.length} 个卡组文件` : ''
    }；冲突 ${rep.conflicts} 处（合并后多端内容一致）。${
      pv.localOnly && pv.localOnly.length ? `${pv.localOnly.length} 个「本机专用」卡组不参与本次同步。` : ''
    }</p>
    <p class="hint">预览是只读的：只读取了网盘上的文件，没有写入、也没有改动本机数据。</p>`;
  openModal({
    title: '同步预览（未改动任何数据）',
    wide: true,
    body,
    actions: [
      {
        label: '开始同步',
        cls: 'btn-primary',
        onClick: () => {
          runSync();
          return true;
        }
      },
      { label: '取消', cls: 'btn-ghost' }
    ]
  });
}

/** 诊断结果弹窗：逐步结果 + 结论 + 自查清单 + 「复制诊断信息」（连不上时给用户可行动的东西） */
function syncDiagModal(rep, cfg) {
  const steps = (rep && rep.steps) || [];
  const okCount = steps.filter((s) => s.status === 'ok').length;
  const rows = steps
    .map(
      (s) => `
      <li class="diag-step is-${s.status}">
        <span class="diag-mark" aria-hidden="true">${s.status === 'ok' ? '✓' : s.status === 'warn' ? '!' : '✗'}</span>
        <span class="diag-body"><b>${esc(s.label)}</b><span>${esc(s.detail)}</span></span>
      </li>`
    )
    .join('');
  const hints = webdav
    .setupHints(cfg.url)
    .map((h) => `<li>${esc(h)}</li>`)
    .join('');
  const body = `
    <p class="sync-status ${rep && rep.ok ? 'is-good' : 'is-bad'}">
      <b>${esc((rep && rep.verdict) || '诊断未得出结论')}</b>
      <span>地址 ${esc(cfg.url || '(未填)')}${cfg.dir ? ` · 目录 ${esc(cfg.dir)}` : ''} · ${okCount}/${steps.length} 步通过</span>
    </p>
    <ul class="diag-list">${rows || '<li class="diag-step">没有可显示的步骤（地址未填？）</li>'}</ul>
    <details class="weight-box" open>
      <summary>常见原因自查清单</summary>
      <ul class="diag-hints">${hints}</ul>
    </details>
    <p class="hint">诊断只做<b>只读</b>请求（GET / PROPFIND），不会修改网盘上的任何文件，也不会改动本机数据；报告里<b>不包含密码</b>，可放心复制。</p>`;
  openModal({
    title: '同步诊断（连不上的原因）',
    wide: true,
    body,
    actions: [
      {
        label: '复制诊断信息',
        cls: 'btn-ghost',
        onClick: () => {
          copyText(webdav.diagnoseReport(rep, cfg));
          return false; // 复制后保持弹窗打开，方便继续看清单
        }
      },
      { label: '关闭', cls: 'btn-primary' }
    ]
  });
}

/** 复制文本（不支持剪贴板 API 时降级为提示手选） */
function copyText(text) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => toast('诊断信息已复制，可直接粘贴给他人排查', 'good'),
        () => toast('复制失败：请手动选中弹窗里的文字复制', 'warn')
      );
      return;
    }
  } catch (e) {}
  toast('当前环境不支持自动复制：请手动选中弹窗里的文字复制', 'warn');
}

/** 跑一次逐步诊断并弹窗（测试连接失败时自动跑，也可手动点「诊断连接」） */
async function runDiagnose(cfg) {
  if (!sync.isConfigured(cfg)) {
    toast('请先填好服务器地址、用户名与密码', 'bad');
    return;
  }
  toast('正在诊断…');
  try {
    const rep = await webdav.diagnose(cfg.url, {
      auth: { user: cfg.user, pass: cfg.pass },
      dir: cfg.dir
    });
    syncDiagModal(rep, cfg);
  } catch (e) {
    // diagnose 本身设计为不抛错；真出意外也只提示，不打断用户
    toast(`诊断失败：${webdav.explainError(e)}`, 'bad');
  }
}

/** 执行一次同步（「立即同步」与预览弹窗的「开始同步」共用） */
async function runSync() {
  const cfg = saveSyncForm();
  if (!sync.isConfigured(cfg)) {
    toast('请先填好服务器地址、用户名与密码', 'bad');
    return;
  }
  toast('正在同步…');
  try {
    const res = await sync.syncNow();
    const extra = res.uploaded ? `（上传 ${res.uploaded} 个卡组）` : '';
    toast(`同步完成：${sync.statsText(res.stats)}${extra}`, 'good');
  } catch (e) {
    toast(`同步失败：${webdav.explainError(e)}`, 'bad');
    // 网络类失败（没有 HTTP 状态）时顺手把逐步诊断打开——用户不用自己找原因
    if (!Number(e && e.status)) await runDiagnose(cfg);
  }
  render();
}

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

    ${syncSectionHtml()}

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
        <li>数据保存在本机浏览器（IndexedDB + localStorage）；<b>默认不上传任何服务器</b>，只有你自己在设置页开启「多端同步（WebDAV）」后，才会把数据写到你的网盘</li>
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

/* ------------------------------ 多端同步（WebDAV） ------------------------------ */

on('sync-save', () => {
  saveSyncForm();
  toast('同步设置已保存');
  render();
});

on('sync-toggle', (el) => {
  const field = (el && el.dataset && el.dataset.field) || '';
  if (!field) return;
  const checked = !!(el && el.checked);
  const patch = { [field]: checked };
  if (field === 'remember' && !checked) patch.pass = ''; // 取消「记住密码」→ 立刻清掉本机明文密码
  sync.saveConfig(patch);
  sync.initAutoSync({ runNow: false });
  render();
});

on('sync-clear', () => {
  sync.clearCredentials();
  toast('已清除本机保存的同步密码');
  render();
});

on('sync-test', async () => {
  const cfg = saveSyncForm();
  if (!sync.isConfigured(cfg)) {
    toast('请先填好服务器地址、用户名与密码', 'bad');
    return;
  }
  toast('正在测试连接…');
  try {
    await webdav.probe(cfg.url, { auth: { user: cfg.user, pass: cfg.pass }, dir: cfg.dir });
    toast('连接成功：目录可读写，可以开始同步了', 'good');
  } catch (e) {
    // v0.9.2：失败不能只说「request failed」——把原因说清，并自动跑一遍逐步诊断
    toast(`连接失败：${webdav.explainError(e)}`, 'bad');
    await runDiagnose(cfg);
  }
  render();
});

/* v0.9.2：随时可点的「诊断连接」（逐步探测：连通性 → 跨域预检 → 账号密码） */
on('sync-diag', async () => {
  await runDiagnose(saveSyncForm());
  render();
});

on('sync-now', () => {
  runSync();
});

on('sync-preview', async () => {
  const cfg = saveSyncForm();
  if (!sync.isConfigured(cfg)) {
    toast('请先填好服务器地址、用户名与密码', 'bad');
    return;
  }
  toast('正在对比…');
  try {
    const pv = await sync.previewSync({ cfg });
    syncPreviewModal(pv);
  } catch (e) {
    toast(`预览失败：${webdav.explainError(e)}`, 'bad');
    if (!Number(e && e.status)) await runDiagnose(cfg);
  }
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
    clearMatchSession();
    clearCrosswordSession();
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

    // 多端同步（WebDAV）：配了「自动同步」就按配置挂上（进 App 同步一次 + 定期检查变更）
    try {
      sync.initAutoSync();
    } catch (e) {
      console.warn('[mycard] 自动同步初始化失败', e);
    }
  })();

  // 离开页面前把待写数据落盘（IndexedDB 写入是防抖批量的）
  window.addEventListener('pagehide', () => {
    try {
      store.flushPending();
    } catch (e) {}
    try {
      sync.notifyDataChanged(); // 「变更后自动同步」：关页面时尝试推一次（不阻塞）
    } catch (e) {}
  });

  window.addEventListener('hashchange', () => {
    clearReviewSession();
    clearTestSession(); // 同时清除测试会话与自动跳题定时器
    clearMatchSession(); // 同时清除配对棋局与计时器
    clearCrosswordSession(); // 同时清除填字棋盘与计时器
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
