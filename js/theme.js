// ============================================================================
// theme.js — 主题色（主色调）自定义
//
// 做法：把选中的颜色换算成一组 CSS 变量写在 <html> 上，覆盖 style.css 里
// :root 的默认值；CSS 中所有强调色都引用 var(--accent) / rgba(var(--accent-rgb), a)，
// 因此换色后按钮、进度条、徽标、氛围光等会全局跟随。
//
// 存储：localStorage['mycard-accent']（独立于卡组数据，清空数据不会重置主题）。
// ============================================================================

export const ACCENT_KEY = 'mycard-accent';
export const DEFAULT_ACCENT = '#6a7bff';

/** 预设主题色 */
export const ACCENT_PRESETS = [
  { name: '星蓝', color: '#6a7bff' },
  { name: '翠绿', color: '#34d399' },
  { name: '青碧', color: '#22d3ee' },
  { name: '紫罗兰', color: '#a78bfa' },
  { name: '樱粉', color: '#f472b6' },
  { name: '暖橙', color: '#ff9f45' },
  { name: '烈焰', color: '#ff6b81' },
  { name: '石墨', color: '#94a3b8' }
];

/** 归一化 #rgb / #rrggbb → #rrggbb（小写）；非法返回 null */
export function normalizeHex(hex) {
  const s = String(hex ?? '').trim();
  if (!/^#?[0-9a-fA-F]{3}$|^#?[0-9a-fA-F]{6}$/.test(s)) return null;
  let h = s.startsWith('#') ? s.slice(1) : s;
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return '#' + h.toLowerCase();
}

export function hexToRgb(hex) {
  const h = normalizeHex(hex) || DEFAULT_ACCENT;
  const n = parseInt(h.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex({ r, g, b }) {
  const to = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}

function rgbToHsl({ r, g, b }) {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rr) h = (gg - bb) / d + (gg < bb ? 6 : 0);
    else if (max === gg) h = (bb - rr) / d + 2;
    else h = (rr - gg) / d + 4;
    h *= 60;
  }
  return { h, s, l };
}

function hslToRgb({ h, s, l }) {
  const t = (((h % 360) + 360) % 360) / 360;
  const hue2rgb = (p, q, x) => {
    let v = x;
    if (v < 0) v += 1;
    if (v > 1) v -= 1;
    if (v < 1 / 6) return p + (q - p) * 6 * v;
    if (v < 1 / 2) return q;
    if (v < 2 / 3) return p + (q - p) * (2 / 3 - v) * 6;
    return p;
  };
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: hue2rgb(p, q, t + 1 / 3) * 255,
    g: hue2rgb(p, q, t) * 255,
    b: hue2rgb(p, q, t - 1 / 3) * 255
  };
}

/** 色相偏移（用于生成次强调色 --accent-2） */
export function shiftHue(hex, deg = 24) {
  const hsl = rgbToHsl(hexToRgb(hex));
  return rgbToHex(hslToRgb({ h: hsl.h + deg, s: hsl.s, l: hsl.l }));
}

/** 由主色推导全部主题 CSS 变量 */
export function accentVars(hex) {
  const main = normalizeHex(hex) || DEFAULT_ACCENT;
  const rgb = hexToRgb(main);
  const rgb2 = hexToRgb(shiftHue(main, 24));
  return {
    '--accent': main,
    '--accent-2': rgbToHex(rgb2),
    '--accent-soft': `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.16)`,
    '--accent-rgb': `${rgb.r}, ${rgb.g}, ${rgb.b}`,
    '--accent-2-rgb': `${rgb2.r}, ${rgb2.g}, ${rgb2.b}`
  };
}

/** 把主题色写入 CSS 变量（默认写到 <html>） */
export function applyAccent(hex, root = null) {
  const vars = accentVars(hex);
  const el = root || (typeof document !== 'undefined' ? document.documentElement : null);
  if (el && el.style && typeof el.style.setProperty === 'function') {
    for (const key of Object.keys(vars)) el.style.setProperty(key, vars[key]);
  }
  return vars;
}

/** 读取已保存主题色（无 / 非法 → 默认色） */
export function loadAccent() {
  try {
    return normalizeHex(localStorage.getItem(ACCENT_KEY)) || DEFAULT_ACCENT;
  } catch (e) {
    return DEFAULT_ACCENT;
  }
}

/** 保存主题色 */
export function saveAccent(hex) {
  const norm = normalizeHex(hex) || DEFAULT_ACCENT;
  try {
    localStorage.setItem(ACCENT_KEY, norm);
  } catch (e) {}
  return norm;
}

/** 保存并应用（UI 入口调用） */
export function setAccent(hex) {
  const norm = saveAccent(hex);
  applyAccent(norm);
  return norm;
}

/** 启动时应用已保存的主题色 */
export function init() {
  return applyAccent(loadAccent());
}

