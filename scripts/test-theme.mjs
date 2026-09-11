#!/usr/bin/env node
// ============================================================================
// test-theme.mjs — 主题色自定义（问题 3）单元测试
//   运行: node scripts/test-theme.mjs
// ============================================================================

const mem = {};
globalThis.localStorage = {
  getItem(k) { return k in mem ? mem[k] : null; },
  setItem(k, v) { mem[k] = String(v); },
  removeItem(k) { delete mem[k]; }
};

const theme = await import('../js/theme.js');

let pass = 0;
let fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

console.log('\n[颜色解析]');
ok(theme.normalizeHex('#abc') === '#aabbcc', '#abc → #aabbcc');
ok(theme.normalizeHex('ABC') === '#aabbcc', '无 # 与大小写归一');
ok(theme.normalizeHex('  #6A7BFF  ') === '#6a7bff', '带空格 + 大写 → 小写', theme.normalizeHex('  #6A7BFF  '));
ok(theme.normalizeHex('zzz') === null, '非法输入 → null');
ok(theme.normalizeHex('') === null, '空字符串 → null');
{
  const rgb = theme.hexToRgb('#6a7bff');
  ok(rgb.r === 106 && rgb.g === 123 && rgb.b === 255, 'hexToRgb 正确', rgb);
  ok(theme.rgbToHex(rgb) === '#6a7bff', 'rgbToHex 往返一致');
}

console.log('\n[色相偏移 → 次强调色]');
ok(theme.shiftHue('#6a7bff', 0) === '#6a7bff', '偏移 0° 不变');
ok(theme.shiftHue('#6a7bff', 24) !== '#6a7bff', '偏移 24° 得到不同颜色', theme.shiftHue('#6a7bff', 24));
ok(/^#[0-9a-f]{6}$/.test(theme.shiftHue('#34d399', 24)), '偏移结果仍是合法 hex');

console.log('\n[主题变量推导]');
{
  const vars = theme.accentVars('#6a7bff');
  ok(vars['--accent'] === '#6a7bff', '--accent = 主色');
  ok(vars['--accent-rgb'] === '106, 123, 255', '--accent-rgb 用于 rgba()', vars['--accent-rgb']);
  const rgb2 = theme.hexToRgb(vars['--accent-2']);
  ok(vars['--accent-2'] !== vars['--accent'], '--accent-2 = 偏移后的次强调色', vars['--accent-2']);
  ok(vars['--accent-2-rgb'] === `${rgb2.r}, ${rgb2.g}, ${rgb2.b}`, '--accent-2-rgb 与 --accent-2 一致', vars['--accent-2-rgb']);
  ok(vars['--accent-soft'] === 'rgba(106, 123, 255, 0.16)', '--accent-soft 带 0.16 透明度');
  ok(theme.accentVars('bad-input')['--accent'] === theme.DEFAULT_ACCENT, '非法颜色回退默认色');
}

console.log('\n[写入 CSS 变量]');
{
  const written = {};
  const fakeRoot = { style: { setProperty: (k, v) => { written[k] = v; } } };
  theme.applyAccent('#34d399', fakeRoot);
  ok(written['--accent'] === '#34d399', 'applyAccent 写入 --accent');
  ok(written['--accent-rgb'] === '52, 211, 153', 'applyAccent 写入 --accent-rgb', written['--accent-rgb']);
  ok(Object.keys(written).length === 5, '共写入 5 个变量（accent/-2/-soft/-rgb/-2-rgb）', Object.keys(written));
}

console.log('\n[持久化]');
{
  ok(theme.loadAccent() === theme.DEFAULT_ACCENT, '首次读取 → 默认色');
  const saved = theme.setAccent('#ff9f45');
  ok(saved === '#ff9f45', 'setAccent 归一化并返回');
  ok(mem[theme.ACCENT_KEY] === '#ff9f45', '写入 localStorage');
  ok(theme.loadAccent() === '#ff9f45', '重新读取为已保存颜色');
  mem[theme.ACCENT_KEY] = 'not-a-color';
  ok(theme.loadAccent() === theme.DEFAULT_ACCENT, '存储值非法 → 回退默认色');
}

console.log('\n[预设]');
ok(theme.ACCENT_PRESETS.length >= 6, '预设 ≥ 6 个', theme.ACCENT_PRESETS.length);
ok(theme.ACCENT_PRESETS.every((p) => theme.normalizeHex(p.color) === p.color), '预设均为合法 hex');
ok(new Set(theme.ACCENT_PRESETS.map((p) => p.color)).size === theme.ACCENT_PRESETS.length, '预设不重复');
ok(theme.ACCENT_PRESETS.every((p) => p.name), '预设均有名称');

console.log(`\n主题色结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
