// ============================================================================
// keyboard.js — 移动端「英文字母键盘」（v0.7.0）
//
// 为什么需要：填字游戏 / 填空题的答案都是英文单词，手机上唤起系统输入法会弹出
// 中文候选框 / 拼音键盘，还会把页面顶飞；这里自绘一个 QWERTY 字母键盘，
// 用 inputmode="none" 抑制系统输入法，按键通过 Action 事件委托派发给「当前宿主」。
//
// 设计（沿用本项目「纯函数内核 + 薄 UI」与 Action 委托约定）：
//   · 单例底栏：`#kb-bar` 由本模块创建一次并挂到 <body>（不放进 #view —— 避免路由
//     重渲染时反复重建，也不受 .view 的 fadeUp transform 影响）；
//   · 宿主用 openKeyboard({ inputs, space, onKey, onBackspace, onSpace, onEnter })
//     声明「我要用键盘」+ 输入框选择器（`inputs`）；本模块负责把这些输入框的
//     inputmode 在 'none' / 'latin' 之间同步（展开 = 抑制系统输入法）；
//   · `hideKeyboard()`（「收起键盘」按钮）只隐藏、保留宿主配置，`showKeyboard()`
//     可由页面上的「⌨ 键盘」按钮再唤出；`closeKeyboard()`（路由切换 / 答题完成）
//     彻底清场；同一页内手动收起后不会因重渲染自动弹回（`dismissed`），重进页面复位。
// ============================================================================

import { on } from './ui.js';

/** 底栏元素 id（页面无需预置，本模块按需创建） */
export const BAR_ID = 'kb-bar';

/** 三行 QWERTY 布局（字符串顺序即键位顺序） */
export const KB_ROWS = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];

/** 特殊键的 data-key 值 */
export const BACK_KEY = 'BACK';
export const SPACE_KEY = 'SPACE';

let cfg = null; // { inputs, space, onKey, onBackspace, onSpace, onEnter }
let bar = null; // 单例底栏元素
let open = false; // 是否展开
let dismissed = false; // 用户手动收起过（同页内不再自动弹回）
let bound = false; // 视口监听只绑一次

/* ------------------------------- 环境判定 ------------------------------- */

/** 是否触屏设备（决定「是否默认弹出字母键盘」与格子尺寸下限） */
export function isTouchDevice() {
  try {
    if (typeof window === 'undefined') return false;
    const mm = window.matchMedia;
    if (typeof mm === 'function' && mm('(pointer: coarse)').matches) return true;
    const nav = window.navigator;
    if (nav && Number(nav.maxTouchPoints) > 0) return true;
    return 'ontouchstart' in window;
  } catch (e) {
    return false;
  }
}

/** 进入页面时是否应当自动弹出（触屏 + 本页没被手动收起过） */
export function shouldAutoOpen() {
  return isTouchDevice() && !dismissed;
}

/* ------------------------------- 状态 ------------------------------- */

export function isKeyboardOpen() {
  return open;
}

export function keyboardConfig() {
  return cfg;
}

/** 输入框当前应写的 inputmode（键盘展开就抑制系统输入法） */
export function inputMode() {
  return open ? 'none' : 'latin';
}

/* ------------------------------- 渲染 ------------------------------- */

function doc() {
  return typeof document !== 'undefined' ? document : null;
}

function keyHtml(key, extraCls = '') {
  const label = key === BACK_KEY ? '⌫' : key === SPACE_KEY ? '空格' : key;
  const aria = key === BACK_KEY ? '退格' : key === SPACE_KEY ? '空格' : `字母 ${key}`;
  const cls = extraCls ? ` ${extraCls}` : '';
  return `<button type="button" class="kb-key${cls}" data-action="kb-key" data-key="${key}" aria-label="${aria}">${label}</button>`;
}

/** 键盘内部 HTML（空格键只有填空题需要；导出以便测试直接断言键位） */
export function keyboardInnerHtml(space = false) {
  const rows = KB_ROWS.map((row, i) => {
    const keys = row.split('').map((ch) => keyHtml(ch)).join('');
    if (i !== KB_ROWS.length - 1) return `<div class="kb-row">${keys}</div>`;
    const spaceKey = space ? keyHtml(SPACE_KEY, 'kb-key-wide') : '';
    return `<div class="kb-row">${spaceKey}${keys}${keyHtml(BACK_KEY, 'kb-key-back')}</div>`;
  }).join('');
  return `${rows}
    <div class="kb-foot"><button type="button" class="kb-key kb-key-hide" data-action="kb-hide" aria-label="收起字母键盘">收起键盘</button></div>`;
}

/** 底栏完整 HTML（含容器外壳） */
export function keyboardHtml(space = false) {
  return `<div class="kb-bar" id="${BAR_ID}" role="group" aria-label="英文键盘">${keyboardInnerHtml(space)}</div>`;
}

/** 收起后的迷你条：只留一个「⌨ 字母键盘」按钮（点它再唤出；由本模块渲染，页面不必管） */
export function keyboardMiniHtml() {
  return '<button type="button" class="kb-mini" data-action="kb-show" aria-label="显示字母键盘">⌨ 字母键盘</button>';
}

/** 确保底栏元素存在（单例） */
function ensureBar() {
  const d = doc();
  if (!d || !d.createElement) return null;
  if (!bar && d.getElementById) bar = d.getElementById(BAR_ID);
  if (!bar) {
    bar = d.createElement('div');
    bar.id = BAR_ID;
    bar.className = 'kb-bar';
    if (bar.setAttribute) {
      bar.setAttribute('role', 'group');
      bar.setAttribute('aria-label', '英文键盘');
    }
    if (d.body && d.body.appendChild) d.body.appendChild(bar);
  }
  return bar;
}

/** 把状态画到 DOM（三态：展开 = 键盘 / 收起 = 迷你条 / 无宿主 = 整条隐藏） */
function applyState() {
  const hasCfg = !!cfg;
  const mini = !open && hasCfg;
  const el = ensureBar();
  if (el) {
    if (el.classList) {
      el.classList.toggle('is-open', open);
      el.classList.toggle('is-mini', mini);
    }
    if (el.innerHTML !== undefined) el.innerHTML = open ? keyboardInnerHtml(!!(cfg && cfg.space)) : mini ? keyboardMiniHtml() : '';
    if ('hidden' in el) el.hidden = !open && !mini;
    if (open) {
      const d = doc();
      const style = d && d.documentElement && d.documentElement.style;
      if (style && typeof style.setProperty === 'function') {
        const h = Number(el.offsetHeight) || 0;
        style.setProperty('--kb-h', `${h || 190}px`);
      }
    }
  }
  const d = doc();
  if (d && d.body && d.body.classList) d.body.classList.toggle('kb-open', open);
  syncInputs();
}

/* ------------------------------- 公开操作 ------------------------------- */

/**
 * 展开键盘并（重新）绑定宿主回调。
 * @param {{ inputs?: string, space?: boolean, onKey?: Function, onBackspace?: Function,
 *           onSpace?: Function, onEnter?: Function }} next
 */
export function openKeyboard(next = {}) {
  cfg = {
    inputs: next.inputs || '',
    space: !!next.space,
    onKey: next.onKey || null,
    onBackspace: next.onBackspace || null,
    onSpace: next.onSpace || null,
    onEnter: next.onEnter || null
  };
  open = true;
  dismissed = false;
  bindViewportOnce();
  applyState();
}

/** 收起（保留宿主回调 → 页面上的「⌨ 键盘」按钮可再唤出） */
export function hideKeyboard() {
  if (!open) return;
  open = false;
  dismissed = true;
  applyState();
}

/** 重新唤出（宿主配置仍在时才有效）；返回是否真的展开 */
export function showKeyboard() {
  if (!cfg) return false;
  open = true;
  dismissed = false;
  applyState();
  return true;
}

/** 彻底清场：把输入框还原成系统键盘并清掉宿主配置（路由切换 / 答题完成） */
export function closeKeyboard() {
  const had = open;
  open = false;
  dismissed = false;
  syncInputs(); // 用旧 cfg 的选择器还原 inputmode
  cfg = null;
  if (had || bar) applyState();
}

/**
 * 把「展开 / 收起」同步到宿主声明的输入框（inputmode = none / latin）。
 * 宿主重渲染出新输入框后也应调用一次。
 * @returns 同步到的输入框数量
 */
export function syncInputs() {
  const sel = cfg && cfg.inputs;
  const d = doc();
  if (!sel || !d || typeof d.querySelectorAll !== 'function') return 0;
  const list = d.querySelectorAll(sel);
  let n = 0;
  for (const el of list) {
    if (!el || !el.setAttribute) continue;
    el.setAttribute('inputmode', open ? 'none' : 'latin');
    n++;
  }
  return n;
}

/* ------------------------------- 事件（Action 委托） ------------------------------- */

on('kb-key', (el) => {
  if (!cfg || !open) return;
  const key = el && el.dataset ? String(el.dataset.key || '') : '';
  if (!key) return;
  if (key === BACK_KEY) {
    if (cfg.onBackspace) cfg.onBackspace();
    return;
  }
  if (key === SPACE_KEY) {
    if (cfg.onSpace) cfg.onSpace();
    else if (cfg.onKey) cfg.onKey(' ');
    return;
  }
  if (key === 'ENTER') {
    if (cfg.onEnter) cfg.onEnter();
    return;
  }
  if (key.length === 1 && key >= 'A' && key <= 'Z') {
    if (cfg.onKey) cfg.onKey(key);
  }
});

on('kb-hide', () => hideKeyboard());
on('kb-show', () => showKeyboard());

/* ------------------------------- 视口变化 ------------------------------- */

/** 横竖屏切换 / 窗口尺寸变化：重新量一次底栏高度，刷新底部留白 */
function onResize() {
  if (open) applyState();
}

function bindViewportOnce() {
  if (bound) return;
  bound = true;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
}

