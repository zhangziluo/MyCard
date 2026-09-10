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

export function bindDocument() {
  for (const type of Object.keys(registry)) {
    document.addEventListener(type, handleEvent, true);
  }
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

/* ------------------------------- Toast ------------------------------- */

let toastTimer = null;

export function toast(msg, type = 'info') {
  let host = $('#toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
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

export function openModal({ title = '', body = '', actions = [], onClose = null, wide = false }) {
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.dataset.ui = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal${wide ? ' modal-wide' : ''}" role="dialog" aria-modal="true">
      ${title ? `<div class="modal-title">${esc(title)}</div>` : ''}
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

  const cleanup = () => {
    overlay.remove();
    document.body.classList.remove('modal-open');
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };

  const onOverlayClick = (e) => {
    if (e.target === overlay) cleanup();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') cleanup();
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
