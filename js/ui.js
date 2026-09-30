// ============================================================================
// ui.js — 通用 UI 工具：HTML 转义、Action 事件委托、toast、modal、导航
// ============================================================================

/* ------------------------------ 基础工具 ------------------------------ */

export function $(sel, root = document) {
  return root.querySelector(sel);
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[m]);
}

export function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function parseTags(text) {
  // 支持空格 / 逗号 / 顿号分隔
  return String(text || '')
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ------------------------------ 图标 ------------------------------ */

/**
 * 内联 SVG 图标（统一 24 视窗 / 1.8 描边）。
 * decks.js、wordbook-view.js 等页面模块共用，避免各自维护一份 path 表。
 */
export function icon(name, size = 18) {
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
    download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
    tag: '<path d="M12 2H2v10l9.3 9.3a2 2 0 0 0 2.8 0l7-7a2 2 0 0 0 0-2.8L12 2Z"/><circle cx="7.5" cy="7.5" r="1.2"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>'
  };
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
}

/* ---------------------------- Action 事件委托 ---------------------------- */

const registry = { click: {}, input: {}, change: {} };

/** 注册一个全局 action：data-action="name" */
export function on(action, handler, type = 'click') {
  if (!registry[type]) registry[type] = {};
  registry[type][action] = handler;
}

/** 由 app.js 挂载到 document 的统一事件入口 */
export function handleEvent(evt) {
  const map = registry[evt.type];
  if (!map) return;
  const el = evt.target && evt.target.closest ? evt.target.closest('[data-action]') : null;
  if (!el || !el.dataset.action) return;
  const fn = map[el.dataset.action];
  if (fn) {
    evt.preventDefault();
    fn(el, evt);
  }
}

/* ------------------- 键盘激活 role=button（v0.5.10） ------------------- */

/** 原生可交互标签：浏览器已处理 Enter / Space，无需再合成 click */
const NATIVE_ACTIVATABLE = { INPUT: 1, TEXTAREA: 1, SELECT: 1, BUTTON: 1, A: 1, OPTION: 1 };

/**
 * 让 <div role="button" tabindex="0" data-action="…">（卡组磁贴 / 拖拽区 / 翻卡等）
 * 也能用键盘操作：Enter / Space 触发一次合成 click（仍走事件委托）。
 * 返回 true 表示已处理；原生按钮 / 链接交给浏览器默认行为。
 */
export function activateOnKey(evt) {
  if (!evt || (evt.key !== 'Enter' && evt.key !== ' ' && evt.key !== 'Spacebar')) return false;
  const el = evt.target && evt.target.closest ? evt.target.closest('[data-action]') : null;
  if (!el) return false;
  if (NATIVE_ACTIVATABLE[el.tagName]) return false;
  if (el.getAttribute && el.getAttribute('role') !== 'button') return false;
  if (evt.preventDefault) evt.preventDefault(); // 拦截空格滚动页面
  if (typeof el.click === 'function') el.click();
  else if (typeof MouseEvent === 'function') el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return true;
}

export function bindDocument() {
  for (const type of Object.keys(registry)) {
    document.addEventListener(type, handleEvent, true);
  }
  // 键盘激活（Enter / Space）role=button 元素
  document.addEventListener('keydown', activateOnKey, true);
}

/* ------------------------------- 导航 ------------------------------- */

export function navigate(hash) {
  if (!hash.startsWith('#')) hash = '#' + hash;
  if (location.hash === hash) {
    // 相同 hash 不触发 hashchange，手动强制刷新
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    location.hash = hash;
  }
  window.scrollTo(0, 0);
}

/* ------------------------- 屏幕阅读器播报（v0.5.10） ------------------------- */

/** 向屏幕阅读器播报一句话（写入 index.html 里的 #sr-announce 实时区域） */
export function announce(msg) {
  if (!msg || typeof document === 'undefined' || !document.getElementById) return;
  const el = document.getElementById('sr-announce');
  if (!el) return;
  // 先清空再写入：重复播报同一句时也能被再次读出
  el.textContent = '';
  el.textContent = String(msg);
}

/* ------------------------------- Toast ------------------------------- */

let toastTimer = null;

export function toast(msg, type = 'info') {
  let host = $('#toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    // 以状态区域播报（读屏友好）：新增 toast 会被自动朗读
    if (host.setAttribute) {
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      host.setAttribute('aria-atomic', 'true');
    }
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 2200);
}

/* ------------------------------- Modal ------------------------------- */

let modalUid = 0;

/** 弹窗内可聚焦元素选择器（焦点陷阱用） */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 返回容器内当前可聚焦的元素列表 */
export function focusables(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  return Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
    (el) => el && !el.disabled && !(el.hasAttribute && el.hasAttribute('hidden'))
  );
}

/** Tab / Shift+Tab 在弹窗内循环（焦点陷阱，避免 Tab 跑到弹窗后的页面） */
function trapFocus(evt, overlay) {
  const list = focusables(overlay);
  if (!list.length) return;
  const first = list[0];
  const last = list[list.length - 1];
  const doc = overlay.ownerDocument || (typeof document !== 'undefined' ? document : null);
  const active = doc && doc.activeElement;
  const inside = typeof overlay.contains === 'function' ? overlay.contains(active) : true;
  if (evt.shiftKey) {
    if (active === first || !inside) {
      evt.preventDefault();
      if (last.focus) last.focus();
    }
  } else if (active === last || !inside) {
    evt.preventDefault();
    if (first.focus) first.focus();
  }
}

export function openModal({ title = '', body = '', actions = [], onClose = null, wide = false }) {
  closeModal();
  const uid = ++modalUid;
  const titleId = `modal-title-${uid}`;
  const prevFocus = (typeof document !== 'undefined' && document.activeElement) || null;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.dataset.ui = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal${wide ? ' modal-wide' : ''}" role="dialog" aria-modal="true"${
      title ? ` aria-labelledby="${titleId}"` : ' aria-label="对话框"'
    }>
      ${title ? `<div class="modal-title" id="${titleId}">${esc(title)}</div>` : ''}
      <div class="modal-body">${body}</div>
      ${actions.length ? `<div class="modal-actions">${actions
        .map(
          (a, i) =>
            `<button type="button" class="btn ${a.cls || 'btn-primary'}" data-ui="modal-act" data-idx="${i}">${esc(a.label)}</button>`
        )
        .join('')}</div>` : ''}
    </div>`;

  document.body.appendChild(overlay);
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => overlay.classList.add('show'));

  // 初始焦点：弹窗内第一个可聚焦元素（键盘 / 读屏用户不迷路）
  const firstFocus = focusables(overlay)[0];
  if (firstFocus && firstFocus.focus) {
    try {
      firstFocus.focus();
    } catch (e) {}
  }

  const cleanup = () => {
    overlay.remove();
    document.body.classList.remove('modal-open');
    document.removeEventListener('keydown', onKey);
    // 关闭后把焦点还给触发弹窗的元素（键盘 / 读屏连续性）
    if (prevFocus && typeof prevFocus.focus === 'function' && prevFocus.isConnected !== false) {
      try {
        prevFocus.focus();
      } catch (e) {}
    }
    if (onClose) onClose();
  };

  const onOverlayClick = (e) => {
    if (e.target === overlay) cleanup();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      cleanup();
      return;
    }
    if (e.key === 'Tab') trapFocus(e, overlay); // 焦点陷阱
  };
  overlay.addEventListener('click', onOverlayClick);
  document.addEventListener('keydown', onKey);

  overlay.querySelectorAll('[data-ui="modal-act"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = actions[Number(btn.dataset.idx)];
      const res = act && act.onClick ? act.onClick() : undefined;
      if (res === undefined || res === true) cleanup();
    });
  });
  return overlay;
}

export function closeModal() {
  const ov = document.querySelector('.modal-overlay');
  if (ov) ov.remove();
  document.body.classList.remove('modal-open');
}

/** 确认弹窗 → Promise<boolean> */
export function confirmDialog(message, { title = '确认', danger = false } = {}) {
  return new Promise((resolve) => {
    openModal({
      title,
      body: `<p class="confirm-text">${esc(message)}</p>`,
      actions: [
        { label: '取消', cls: 'btn-ghost', onClick: () => resolve(false) },
        { label: '确定', cls: danger ? 'btn-danger' : 'btn-primary', onClick: () => resolve(true) }
      ]
    });
  });
}

/** 读取弹窗内表单值（按 name） */
export function readForm(overlayOrRoot) {
  const out = {};
  overlayOrRoot.querySelectorAll('[name]').forEach((field) => {
    out[field.name] = field.type === 'checkbox' ? field.checked : field.value.trim();
  });
  return out;
}
