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
  ok(/^#[0-9a-f]{6}$/.test(vars['--tag-tx-dark']), '--tag-tx-dark 为合法 hex', vars['--tag-tx-dark']);
  ok(/^#[0-9a-f]{6}$/.test(vars['--tag-tx-light']), '--tag-tx-light 为合法 hex', vars['--tag-tx-light']);
  ok(
    theme.contrastRatio(vars['--tag-tx-dark'], theme.TEXT_BG.dark) >= 4.5,
    '--tag-tx-dark 对深底 ≥ 4.5:1',
    Math.round(theme.contrastRatio(vars['--tag-tx-dark'], theme.TEXT_BG.dark) * 100) / 100
  );
  ok(
    theme.contrastRatio(vars['--tag-tx-light'], theme.TEXT_BG.light) >= 4.5,
    '--tag-tx-light 对浅底 ≥ 4.5:1',
    Math.round(theme.contrastRatio(vars['--tag-tx-light'], theme.TEXT_BG.light) * 100) / 100
  );
  ok(Object.keys(vars).length === 7, '共 7 个主题变量（含 tag-tx 深/浅两档）', Object.keys(vars));
  ok(theme.accentVars('bad-input')['--tag-tx-light'] === theme.textOnLight(theme.DEFAULT_ACCENT), '非法颜色时派生色回退默认色');
}

console.log('\n[WCAG 相对亮度 / 对比度]');
{
  ok(theme.relativeLuminance('#000000') === 0, 'relativeLuminance(#000000) = 0');
  ok(theme.relativeLuminance('#ffffff') === 1, 'relativeLuminance(#ffffff) = 1');
  ok(Math.abs(theme.contrastRatio('#000000', '#ffffff') - 21) < 1e-9, '黑白对比度 = 21:1', theme.contrastRatio('#000000', '#ffffff'));
  ok(Math.abs(theme.contrastRatio('#f4f5fa', '#f4f5fa') - 1) < 1e-9, '同色对比度 = 1:1');
  ok(theme.contrastRatio('#ffffff', '#000000') === theme.contrastRatio('#000000', '#ffffff'), '对比度与顺序无关');
  ok(theme.TEXT_CONTRAST === 4.5, '目标对比度 = 4.5:1（WCAG AA 普通文本）');
  ok(theme.TEXT_BG.dark === '#070910' && theme.TEXT_BG.light === '#f4f5fa', '参考底色与 CSS --bg 一致');
  ok(typeof theme.ensureTextContrast === 'function' && typeof theme.mixHex === 'undefined', '已改为对比度求解（mixHex 移除）');
}

console.log('\n[ensureTextContrast：按对比度自动加深 / 提亮]');
{
  ok(theme.ensureTextContrast('#000000', '#f4f5fa') === '#000000', '已够深 → 原样返回');
  ok(theme.ensureTextContrast('#ffffff', '#070910') === '#ffffff', '已够亮 → 原样返回');
  ok(theme.textOnLight('#000000') === '#000000', 'textOnLight：黑色无需再加深');
  ok(theme.textOnDark('#ffffff') === '#ffffff', 'textOnDark：白色已到顶，提亮后仍为白');

  // 深色底「统一提亮一档」
  ok(theme.TEXT_LIGHTEN_STEP === 0.12, '深色底提亮步长 = 0.12（HSL 亮度）');
  ok(theme.lightenHex('#6a7bff', 0) === '#6a7bff', 'lightenHex(step=0) 不变');
  ok(theme.lightenHex('#000000', 0.5) === '#808080', 'lightenHex 提到 50% 亮度 → #808080', theme.lightenHex('#000000', 0.5));
  ok(theme.lightenHex('#ffffff', 0.2) === '#ffffff', 'lightenHex 不会超过白');
  ok(theme.relativeLuminance(theme.lightenHex('#6a7bff')) > theme.relativeLuminance('#6a7bff'), 'lightenHex 只会变亮');
  ok(theme.textOnDark('#6a7bff') !== '#6a7bff', 'textOnDark：深色底不再直接用原始主色');
  ok(
    theme.relativeLuminance(theme.textOnDark('#6a7bff')) > theme.relativeLuminance('#6a7bff'),
    'textOnDark：深色底一定提亮一档',
    theme.textOnDark('#6a7bff')
  );
  ok(theme.contrastRatio(theme.textOnDark('#6a7bff'), theme.TEXT_BG.dark) >= 4.5, '提亮后仍 ≥ 4.5:1');

  const sameLight = theme.ensureTextContrast('#f4f5fa', '#f4f5fa', 4.5, 'darken');
  ok(theme.contrastRatio(sameLight, '#f4f5fa') >= 4.5, '浅底同色被加深到 ≥ 4.5:1', sameLight);
  const sameDark = theme.ensureTextContrast('#070910', '#070910', 4.5, 'lighten');
  ok(theme.contrastRatio(sameDark, '#070910') >= 4.5, '深底同色被提亮到 ≥ 4.5:1', sameDark);

  const c3 = theme.ensureTextContrast('#999999', '#ffffff', 3, 'darken');
  const c45 = theme.ensureTextContrast('#999999', '#ffffff', 4.5, 'darken');
  ok(theme.contrastRatio(c3, '#ffffff') >= 3, 'target=3 时 ≥ 3:1', c3);
  ok(theme.contrastRatio(c45, '#ffffff') >= 4.5, 'target=4.5 时 ≥ 4.5:1', c45);
  ok(theme.relativeLuminance(c45) < theme.relativeLuminance(c3), '目标更高 → 颜色更深');

  // 保持色相与饱和度（只改亮度）
  const hslOf = (hex) => {
    const { r, g, b } = theme.hexToRgb(hex);
    const rr = r / 255;
    const gg = g / 255;
    const bb = b / 255;
    const mx = Math.max(rr, gg, bb);
    const mn = Math.min(rr, gg, bb);
    const l = (mx + mn) / 2;
    const d = mx - mn;
    let s = 0;
    let h = 0;
    if (d) {
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === rr) h = (gg - bb) / d + (gg < bb ? 6 : 0);
      else if (mx === gg) h = (bb - rr) / d + 2;
      else h = (rr - gg) / d + 4;
      h *= 60;
    }
    return { h, s, l };
  };
  const src = hslOf('#22d3ee');
  const out = hslOf(theme.textOnLight('#22d3ee'));
  ok(Math.round(out.s * 100) === Math.round(src.s * 100), '保持饱和度不变（仅改亮度）', [src.s, out.s]);
}

console.log('\n[强调文字色：8 预设 + 极端自定义色均 ≥ 4.5:1]');
{
  const hue = (hex) => {
    const { r, g, b } = theme.hexToRgb(hex);
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    if (mx === mn) return -1;
    const d = mx - mn;
    let h;
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return h * 60;
  };
  const EXTRA = ['#ffff00', '#f0f0f0', '#111111', '#808080', '#00ff00', '#ff0000'];
  const cases = [...theme.ACCENT_PRESETS.map((p) => ({ name: p.name, color: p.color })), ...EXTRA.map((c) => ({ name: c, color: c }))];
  let minLight = 99;
  let minDark = 99;
  for (const p of cases) {
    const cLight = theme.contrastRatio(theme.textOnLight(p.color), theme.TEXT_BG.light);
    const cDark = theme.contrastRatio(theme.textOnDark(p.color), theme.TEXT_BG.dark);
    minLight = Math.min(minLight, cLight);
    minDark = Math.min(minDark, cDark);
    ok(cLight >= 4.5, `浅色底「${p.name}」≥ 4.5:1`, Math.round(cLight * 100) / 100);
    ok(cDark >= 4.5, `深色底「${p.name}」≥ 4.5:1`, Math.round(cDark * 100) / 100);
    ok(
      /^#[0-9a-f]{6}$/.test(theme.textOnLight(p.color)) && /^#[0-9a-f]{6}$/.test(theme.textOnDark(p.color)),
      `「${p.name}」派生结果均为合法 hex`
    );
    const ph = hue(p.color);
    if (ph >= 0) {
      const dh = hue(theme.textOnLight(p.color));
      let diff = dh < 0 ? 0 : Math.abs(dh - ph);
      if (diff > 180) diff = 360 - diff;
      ok(diff <= 6, `浅色派生色保持「${p.name}」色相（±6°）`, Math.round(diff));
    }
  }
  ok(
    minLight >= 4.5 && minDark >= 4.5,
    '全部颜色两种底色均达 WCAG 4.5:1',
    { minLight: Math.round(minLight * 100) / 100, minDark: Math.round(minDark * 100) / 100 }
  );
  ok(theme.textOnLight('#ffff00') !== theme.textOnDark('#ffff00'), '亮黄：浅底加深、深底提亮（跟随主色）');
  ok(
    theme.contrastRatio(theme.textOnDark('#111111'), theme.TEXT_BG.dark) >= 4.5 &&
      theme.relativeLuminance(theme.textOnDark('#111111')) > theme.relativeLuminance(theme.lightenHex('#111111')),
    '近黑：先提亮一档仍不够 → 继续提亮到达标',
    theme.textOnDark('#111111')
  );
}

console.log('\n[写入 CSS 变量]');
{
  const written = {};
  const fakeRoot = { style: { setProperty: (k, v) => { written[k] = v; } } };
  theme.applyAccent('#34d399', fakeRoot);
  ok(written['--accent'] === '#34d399', 'applyAccent 写入 --accent');
  ok(written['--accent-rgb'] === '52, 211, 153', 'applyAccent 写入 --accent-rgb', written['--accent-rgb']);
  ok(
    Object.keys(written).length === 7,
    '共写入 7 个变量（accent/-2/-soft/-rgb/-2-rgb + tag-tx-dark/light）',
    Object.keys(written)
  );
  ok(written['--tag-tx-dark'] === theme.textOnDark('#34d399'), 'applyAccent 写入 --tag-tx-dark', written['--tag-tx-dark']);
  ok(written['--tag-tx-light'] === theme.textOnLight('#34d399'), 'applyAccent 写入 --tag-tx-light', written['--tag-tx-light']);
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
