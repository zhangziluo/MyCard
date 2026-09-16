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

console.log('\n[明暗模式：档位与持久化]');
{
  ok(theme.MODE_KEY === 'mycard-mode', 'MODE_KEY = mycard-mode');
  ok(theme.MODE_IDS.join(',') === 'light,dark,system', '三档：light / dark / system', theme.MODE_IDS);
  ok(theme.MODES.map((m) => m.label).join(',') === '浅色,深色,跟随系统', '档位文案');
  ok(theme.DEFAULT_MODE === 'dark', '默认深色（与旧版观感一致）');
  ok(theme.loadMode() === 'dark', '无记录 → 默认深色');
  ok(theme.saveMode('light') === 'light' && theme.loadMode() === 'light', '保存 light 并读回');
  ok(theme.saveMode('system') === 'system' && theme.loadMode() === 'system', '保存 system 并读回');
  ok(theme.saveMode('zzz') === 'dark', '非法值 → 回退深色');
  mem[theme.MODE_KEY] = 'bogus';
  ok(theme.loadMode() === 'dark', '存储值非法 → 回退深色');
}

console.log('\n[明暗模式：解析与写入 <html>]');
{
  const el = { dataset: {}, style: { setProperty(k, v) { this[k] = v; } }, setAttribute(k, v) { this.dataset[k] = v; } };
  const colors = [];
  globalThis.document = {
    documentElement: el,
    querySelector(sel) {
      return sel === 'meta[name="theme-color"]' ? { setAttribute: (k, v) => colors.push(v) } : null;
    }
  };
  const mq = (matches) => ({ matches, addEventListener() {}, removeEventListener() {} });

  ok(theme.resolveMode('light') === 'light' && theme.resolveMode('dark') === 'dark', '显式档位直接生效');
  ok(theme.resolveMode('system', mq(true)) === 'dark', '跟随系统：系统深色 → dark');
  ok(theme.resolveMode('system', mq(false)) === 'light', '跟随系统：系统浅色 → light');
  ok(theme.resolveMode('nope') === 'dark', '非法档位 → 深色');

  ok(theme.applyMode('light', { mq: mq(true) }) === 'light', 'applyMode 返回实际生效模式');
  ok(el.dataset.theme === 'light', '<html data-theme="light">');
  ok(el.style['color-scheme'] === 'light', '写入 color-scheme: light');
  ok(colors[colors.length - 1] === '#f4f5fa', 'theme-color 跟随浅色', colors[colors.length - 1]);

  theme.applyMode('dark');
  ok(el.dataset.theme === 'dark' && el.style['color-scheme'] === 'dark', '切回深色');
  ok(colors[colors.length - 1] === '#0b0d17', 'theme-color 跟随深色', colors[colors.length - 1]);

  ok(theme.applyMode('system', { mq: mq(false) }) === 'light' && el.dataset.theme === 'light', '跟随系统（浅色）→ 实际写 light');

  ok(theme.setMode('light') === 'light' && theme.loadMode() === 'light', 'setMode 保存并应用');
  ok(theme.toggleMode() === 'dark', 'toggleMode：light → dark');
  ok(theme.loadMode() === 'dark' && el.dataset.theme === 'dark', 'toggle 结果已保存并应用');
  ok(theme.toggleMode() === 'light', 'toggleMode：dark → light');

  // 跟随系统时 toggle 视为其反色
  theme.setMode('system');
  ok(theme.toggleMode({ mq: mq(true) }) === 'light', 'system(系统深色) toggle → light');

  const initRes = theme.init();
  ok(!!initRes && initRes.mode === 'light' && initRes.applied === 'light', 'init 返回并应用已保存模式', initRes);
  ok(Object.keys(initRes.accent).includes('--accent'), 'init 同时返回主色变量');
  ok(el.dataset.theme === 'light', 'init 后 <html> 为已保存模式');
}

console.log('\n[跟随系统：监听与降级]');
{
  let bound = null;
  globalThis.matchMedia = (q) => ({ matches: true, addEventListener: (t, fn) => { bound = { q, t, fn }; } });
  ok(theme.bindSystemWatcher() === true, '有 matchMedia 时绑定成功');
  ok(!!bound && bound.t === 'change' && bound.q === '(prefers-color-scheme: dark)', '监听 prefers-color-scheme: dark 变化');
  ok(theme.bindSystemWatcher(() => {}) === false, '已绑定过 → 不重复绑定');
  delete globalThis.matchMedia;
  ok(theme.systemPrefersDark() === true, '无 matchMedia → 视为深色（安全降级）');
}

console.log(`\n主题色结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
