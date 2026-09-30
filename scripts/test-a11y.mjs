#!/usr/bin/env node
// ============================================================================
// test-a11y.mjs — 无障碍（v0.5.10）：键盘焦点环 / aria 覆盖 / 减少动效
//   运行: node scripts/test-a11y.mjs
// 覆盖：① CSS（:focus-visible 焦点环 / .sr-only / .skip-link / prefers-reduced-motion）
//       ② index.html（lang / 跳转链接 / main 可聚焦 / #sr-announce 实时区域）
//       ③ 各页面模块的 role / aria-*（磁贴 / 筛选 chips / 分页 / 进度条 / 表头 / 翻卡）
//       ④ ui.js 运行时行为（键盘激活 role=button / 弹窗 aria + 焦点陷阱 + 焦点还原 / 播报 / toast）
// ============================================================================

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const css = read('css/style.css');
const html = read('index.html');
const appSrc = read('js/app.js');
const uiSrc = read('js/ui.js');
const decksSrc = read('js/decks.js');
const wbViewSrc = read('js/wordbook-view.js');
const reviewSrc = read('js/review.js');
const impSrc = read('js/import-file.js');
const teSrc = read('js/table-editor.js');
const swSrc = read('sw.js');

let pass = 0;
let fail = 0;
function ok(cond, msg, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + msg);
  } else {
    fail++;
    console.error('  ✗ ' + msg + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
}

/* ---------- 浏览器全局桩（须在 import ui.js 前定义；ui.js 顶层不触碰 DOM） ---------- */
let doc;

function makeEl(tag) {
  return {
    tagName: tag,
    className: '',
    id: '',
    textContent: '',
    disabled: false,
    value: '',
    dataset: {},
    style: {},
    children: [],
    _html: '',
    _attrs: {},
    _listeners: {},
    _queryList: null,
    removed: false,
    focusCount: 0,
    clickCount: 0,
    classList: {
      _s: new Set(),
      add(...c) {
        c.forEach((x) => this._s.add(x));
      },
      remove(...c) {
        c.forEach((x) => this._s.delete(x));
      },
      contains(c) {
        return this._s.has(c);
      }
    },
    get innerHTML() {
      return this._html;
    },
    set innerHTML(v) {
      this._html = String(v);
    },
    setAttribute(k, v) {
      this._attrs[k] = String(v);
    },
    getAttribute(k) {
      return k in this._attrs ? this._attrs[k] : null;
    },
    hasAttribute(k) {
      return k in this._attrs;
    },
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    addEventListener(t, fn) {
      (this._listeners[t] = this._listeners[t] || []).push(fn);
    },
    removeEventListener(t, fn) {
      this._listeners[t] = (this._listeners[t] || []).filter((f) => f !== fn);
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return this._queryList || [];
    },
    closest() {
      return null;
    },
    remove() {
      this.removed = true;
      const i = doc.body.children.indexOf(this);
      if (i >= 0) doc.body.children.splice(i, 1);
    },
    focus() {
      this.focusCount++;
      doc.activeElement = this;
    },
    click() {
      this.clickCount++;
    }
  };
}

doc = {
  body: makeEl('BODY'),
  documentElement: makeEl('HTML'),
  activeElement: null,
  _ids: {},
  _listeners: {},
  addEventListener(t, fn) {
    (doc._listeners[t] = doc._listeners[t] || []).push(fn);
  },
  removeEventListener(t, fn) {
    doc._listeners[t] = (doc._listeners[t] || []).filter((f) => f !== fn);
  },
  querySelector(sel) {
    if (sel === '#toast-host') return doc.body.children.find((c) => c && c.id === 'toast-host') || null;
    if (sel === '.modal-overlay') return doc.body.children.find((c) => c && c.className === 'modal-overlay') || null;
    return null;
  },
  querySelectorAll() {
    return [];
  },
  getElementById(id) {
    return doc._ids[id] || null;
  },
  createElement(tag) {
    return makeEl(String(tag).toUpperCase());
  }
};
doc._ids['sr-announce'] = makeEl('DIV'); // 对应 index.html 里的实时区域

globalThis.document = doc;
globalThis.window = { addEventListener() {}, dispatchEvent() {}, scrollTo() {} };
globalThis.location = { hash: '', href: '' };
globalThis.setTimeout = () => 0; // toast 的自动消失定时器：测试里不需要真的等
globalThis.requestAnimationFrame = () => 0;

const ui = await import('../js/ui.js');

/** 合成键盘事件 */
function keyEvent(key, extra = {}) {
  return {
    key,
    shiftKey: false,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    ...extra
  };
}

/** 让 evt.target.closest('[data-action]') 命中指定元素 */
const targetOf = (el) => ({ closest: (sel) => (sel === '[data-action]' ? el : null) });
const docKeydowns = () => doc._listeners['keydown'] || [];

/* ==========================================================================
 * ① CSS：键盘焦点环 / 视觉隐藏 / 减少动效
 * ========================================================================== */

console.log('\n[CSS：键盘焦点环]');
ok(/\*:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent-tx\)/.test(css), '全局 :focus-visible 焦点环（跟随主题色）');
ok(
  (css.match(/:focus:not\(:focus-visible\)/g) || []).length >= 5,
  '输入框 / 单元格等把 outline:none 收敛到 :focus:not(:focus-visible)（不吞键盘焦点环）',
  (css.match(/:focus:not\(:focus-visible\)/g) || []).length
);
ok(
  (css.match(/:focus\s*\{[^}]*outline:\s*none/g) || []).length === 0,
  '不存在裸 `:focus { outline: none }`（会连键盘焦点环一起关掉）',
  css.match(/:focus\s*\{[^}]*outline:\s*none/g) || []
);
ok(
  /button\.tag\s*\{[^}]*cursor:\s*pointer/.test(css),
  '标签按钮有 cursor:pointer（span → button 后交互态不丢）'
);
ok(
  /\.wb-search-box:focus-within\s*\{[^}]*box-shadow:\s*0 0 0 3px/.test(css),
  '生词本搜索框：内层 input 去默认轮廓，但外层容器有可见焦点指示（focus-within 环）'
);

console.log('\n[CSS：跳转链接 / 视觉隐藏]');
ok(/\.sr-only\s*\{[^}]*position:\s*absolute[^}]*clip:\s*rect\(0, 0, 0, 0\)/.test(css), '.sr-only（读屏可见、视觉隐藏）');
ok(/\.skip-link\s*\{[^}]*transform:\s*translateY\(-200%\)/.test(css), '.skip-link 默认移出视口');
ok(/\.skip-link:focus\s*\{[^}]*transform:\s*none/.test(css), '.skip-link 聚焦时滑入（键盘可见）');

console.log('\n[CSS：prefers-reduced-motion]');
const rmMatch = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(css);
const rmBody = rmMatch ? rmMatch[1] : '';
ok(!!rmMatch, '存在 @media (prefers-reduced-motion: reduce) 媒体查询');
ok(/animation:[^;]*infinite/.test(css), '确有无限循环动画（btnGlow / fill-speak-pulse），需要被降级');
ok(/animation-duration:\s*0\.001s\s*!important/.test(rmBody), '动画时长收敛为 ~0');
ok(/animation-iteration-count:\s*1\s*!important/.test(rmBody), '无限循环动画只跑一次（不闪烁）');
ok(/transition-duration:\s*0\.001s\s*!important/.test(rmBody), '过渡时长收敛为 ~0');
ok(/scroll-behavior:\s*auto\s*!important/.test(rmBody), '平滑滚动关闭（scroll-behavior: auto）');
ok(/\*,\s*\*::before,\s*\*::after/.test(rmBody), '覆盖元素及伪元素（::before / ::after 动画也不漏）');

/* ==========================================================================
 * ② index.html：语言 / 跳转链接 / main / 实时区域
 * ========================================================================== */

console.log('\n[index.html]');
ok(/<html lang="zh-CN">/.test(html), '<html lang> 已声明（读屏正确发音）');
ok(/<body>\s*\n\s*<a class="skip-link" href="#view">跳到主要内容<\/a>/.test(html), '「跳到主要内容」是 body 里第一个可聚焦元素');
ok(/<main id="view" tabindex="-1"><\/main>/.test(html), 'main#view 可被编程聚焦（路由切换 / 跳转链接落点）');
ok(!/<main[^>]*aria-live/.test(html), 'main 不再整页 aria-live（改由 #sr-announce 按需播报，避免整页重读）');
ok(/<div class="bg-glow" aria-hidden="true">/.test(html), '装饰性氛围光 aria-hidden（不进无障碍树）');
ok(
  /id="sr-announce" class="sr-only" role="status" aria-live="polite" aria-atomic="true"/.test(html),
  '#sr-announce 实时区域（role=status / aria-live=polite / aria-atomic）'
);

/* ==========================================================================
 * ③ 各模块：role / aria-*（静态检查源码，防回归）
 * ========================================================================== */

console.log('\n[ui.js：播报 / 弹窗 / 键盘]');
ok(/export function announce\(msg\)/.test(uiSrc) && /getElementById\('sr-announce'\)/.test(uiSrc), 'announce() 写入 #sr-announce 实时区域');
ok(/el\.textContent = '';\s*\n\s*el\.textContent = String\(msg\)/.test(uiSrc), '播报前先清空（同一句话可重复读出）');
ok(
  /setAttribute\('role', 'status'\)/.test(uiSrc) &&
    /setAttribute\('aria-live', 'polite'\)/.test(uiSrc) &&
    /setAttribute\('aria-atomic', 'true'\)/.test(uiSrc),
  'toast 容器 role=status + aria-live=polite + aria-atomic'
);
ok(/export function activateOnKey/.test(uiSrc), '导出 activateOnKey（键盘激活 role=button）');
ok(/document\.addEventListener\('keydown', activateOnKey, true\)/.test(uiSrc), 'bindDocument 全局注册 keydown → activateOnKey');
ok(
  /export function focusables/.test(uiSrc) && /function trapFocus/.test(uiSrc) && /trapFocus\(e, overlay\)/.test(uiSrc),
  '弹窗焦点陷阱（focusables / trapFocus）'
);
ok(
  /role="dialog" aria-modal="true"/.test(uiSrc) && /aria-labelledby="\$\{titleId\}"/.test(uiSrc) && /aria-label="对话框"/.test(uiSrc),
  '弹窗 role=dialog + aria-modal + 标题关联（无标题时回退 aria-label）'
);
ok(/初始焦点/.test(uiSrc) && /firstFocus\.focus\(\)/.test(uiSrc), '打开弹窗自动聚焦首个可聚焦元素');
ok(/prevFocus\.focus\(\)/.test(uiSrc), '关闭弹窗把焦点还给触发元素');

console.log('\n[decks.js：磁贴 / 筛选 / 分页 / 进度]');
ok(
  /class="deck-tile glass" data-action="open-deck" data-id="\$\{esc\(deck\.id\)\}" tabindex="0" role="button"/.test(decksSrc),
  '卡组磁贴：role=button + tabindex=0（键盘可打开）'
);
ok(
  /class="banner glass" data-action="import-demo" role="button" tabindex="0" aria-label=/.test(decksSrc),
  '示范卡组横幅：role=button + tabindex + aria-label'
);
ok(/tagBadges\(deck\.tags, '', false\)/.test(decksSrc), '磁贴内标签为纯标签（role=button 里不嵌套可聚焦控件）');
ok(/aria-label="按标签「\$\{esc\(/.test(decksSrc), '卡组详情标签为 <button> + aria-label（键盘可筛选）');
ok(/data-action="filter-tag" data-tag="\$\{esc\(t\)\}" aria-pressed=/.test(decksSrc), '标签 chips 带 aria-pressed（反映当前筛选）');
ok(/role="group" aria-label="按标签筛选卡组"/.test(decksSrc), 'chips 分组 role=group + aria-label');
ok(
  (decksSrc.match(/role="progressbar"[^>]*aria-valuemin="0" aria-valuemax="100" aria-valuenow="\$\{pct\}"/g) || []).length === 2,
  '两处进度条均 role=progressbar + aria-valuenow（磁贴 / 关卡卡）'
);
ok(/class="pager glass" role="navigation" aria-label="关卡分页"/.test(decksSrc), '关卡分页 role=navigation + aria-label');
ok(/class="pager glass" role="navigation" aria-label="卡片分页"/.test(decksSrc), '卡片分页 role=navigation + aria-label');
ok(/aria-label="上一页关卡"[\s\S]{0,400}aria-label="下一页关卡"/.test(decksSrc), '分页按钮有明确 aria-label（不靠 ‹ › 图标猜）');

console.log('\n[wordbook-view.js / review.js / 导入表格]');
ok(/id="wb-tag-chips" role="group" aria-label="按标签筛选"/.test(wbViewSrc), '生词本标签 chips 分组 + aria-label');
ok(/id="wb-src-chips" role="group" aria-label="按来源筛选"/.test(wbViewSrc), '生词本来源 chips 分组 + aria-label');
ok(/data-action="wb-tag" data-tag="\$\{wb\.ALL\}" aria-pressed=/.test(wbViewSrc), '生词本 chips 带 aria-pressed');
ok(/role="group" aria-label="生词本概览/.test(wbViewSrc), '生词本概览 role=group + aria-label');
ok(/data-action="wb-toggle-missing" aria-pressed=/.test(wbViewSrc), '「缺释义」过滤按钮带 aria-pressed');
ok(/class="pager glass" role="navigation" aria-label="生词本分页"/.test(wbViewSrc), '生词本分页 role=navigation + aria-label');
ok(
  /data-action="review-flip" role="button" tabindex="0"/.test(reviewSrc) &&
    /aria-label="\$\{flipped \? '回到问题面' : '翻到答案面'\}"/.test(reviewSrc),
  '翻卡：role=button + tabindex=0 + 动作名随正反面变化'
);
ok(
  /class="dropzone" data-dropzone="file-import" data-action="import-file" role="button" tabindex="0"/.test(impSrc) &&
    /aria-label="拖入 CSV \/ TSV \/ JSON \/ XLSX 文件导入词库（支持多个）"/.test(impSrc),
  '拖拽导入区：role=button + tabindex + aria-label'
);
ok(
  /<th class="csv-idx" scope="col">#<\/th>/.test(impSrc) && /<th scope="col">\$\{esc\(n\)\}<\/th>/.test(impSrc),
  'CSV 预览表头带 scope=col（读屏可对齐列）'
);
ok(teSrc.includes('<th scope="col">'), '表格编辑页表头带 scope=col');

console.log('\n[app.js / sw.js：播报接线与版本]');
ok(/import \{[^}]*\bannounce\b[^}]*\} from '\.\/ui\.js'/.test(appSrc), 'app.js 从 ui.js 引入 announce');
ok(/routeKey !== lastRouteKey/.test(appSrc), '仅路由变化时播报（同一路由重渲染不打扰读屏）');
ok(/const pageTitle = renderAppbar\(route\)/.test(appSrc) && /announce\(pageTitle\)/.test(appSrc), 'render() 用顶栏标题播报当前页面');
ok(/APP_VERSION = 'v0\.5\.12'/.test(appSrc), 'app.js 版本号 v0.5.12');
ok(/const VERSION = 'v1\.10\.2'/.test(swSrc), 'sw.js VERSION v1.10.2');

console.log('\n[明牌配对（#/match）的键盘可达性与标注]');
{
  const matchSrc = read('js/match.js');
  const bannerChunk = (decksSrc.match(/<button type="button" class="match-banner glass"[\s\S]*?<\/button>/) || [''])[0];
  const bannerInner = bannerChunk.replace(/^<button[^>]*>/, '');
  ok(
    bannerInner.includes('match-banner-body') && !/<button|<a |tabindex=/i.test(bannerInner),
    '入口横幅是原生 button，内部不嵌套可聚焦控件（ARIA 规范）'
  );
  ok(/<button type="button" class="\$\{cls\}" data-action="match-pick"/.test(matchSrc), '牌面是原生 <button>（Tab + Enter/空格天然可用）');
  ok(
    /aria-pressed="\$\{selected \? 'true' : 'false'\}"/.test(matchSrc) &&
      /setAttribute\('aria-pressed', chosen \? 'true' : 'false'\)/.test(matchSrc),
    '牌面带 aria-pressed（初始反映选中；已配对在爆炸前由 paintPick 置 true）'
  );
  ok(/aria-label="\$\{kindLabel\}「\$\{esc\(tile\.text\)\}」/.test(matchSrc), '牌面有中文 aria-label（单词 / 释义）');
  ok(
    /role="progressbar" aria-label="配对进度" aria-valuemin="0" aria-valuemax="100"/.test(matchSrc),
    '配对进度 role=progressbar + aria-valuemin/max/now'
  );
  ok(
    /role="group" aria-label="配对棋盘"/.test(matchSrc) && /role="group" aria-label="选择关卡"/.test(matchSrc),
    '棋盘 / 关卡 chips 均为 role=group + aria-label'
  );
  ok(/data-action="match-level" data-level="\$\{i\}" aria-pressed=/.test(matchSrc), '关卡 chips 带 aria-pressed（当前关为 true）');
  ok(
    /announce\(`配对成功，连击 ×\$\{S\.combo\}`\)/.test(matchSrc) && /announce\(`全部配对完成/.test(matchSrc),
    '配对成功 / 全部完成用 announce 播报（读屏可感知）'
  );
  ok(/focusNextPlayable\(/.test(matchSrc) && /btn\.focus\(\)/.test(matchSrc), '配对后焦点交给下一张可点的牌 / 「再玩一次」');
  const animBlock = css.slice(css.indexOf('.match-tile.is-matched'), css.indexOf('@keyframes match-shake'));
  ok(
    /@keyframes match-goldflash/.test(css) && animBlock && !/animation:[^;]*infinite/.test(animBlock),
    '配对动画均为一次性（时间被全局「减少动效」收敛，不会循环闪金光）'
  );
  ok(css.includes(".match-tile.is-matched::after"), "金色迸发挂在 ::after（同样被 reduced-motion 覆盖）");
  ok(
    matchSrc.includes(`class="match-round" data-match="round"`), // 轮次行
    '轮次行（第 R/T 轮 · 本轮还剩 N 对）随点击局部更新（data-match=round）'
  );
  ok(
    /class="match-combo" id="match-combo" aria-hidden="true"/.test(matchSrc),
    'combo✖️N 连击提示是纯装饰层（aria-hidden，读屏改由 announce 播报）'
  );
  ok(/role="button"/.test(matchSrc) === false, '牌面用原生 button，不重复造 role=button（无需 activateOnKey）');
}

/* ==========================================================================
 * ④ ui.js 运行时行为
 * ========================================================================== */

console.log('\n[键盘激活 role=button（activateOnKey）]');
{
  const tile = makeEl('DIV');
  tile.dataset.action = 'open-deck';
  tile._attrs.role = 'button';

  const evEnter = keyEvent('Enter', { target: targetOf(tile) });
  ok(ui.activateOnKey(evEnter) === true && tile.clickCount === 1 && evEnter.defaultPrevented, 'Enter 激活 div[role=button]（合成 click + preventDefault）');

  const evSpace = keyEvent(' ', { target: targetOf(tile) });
  ok(ui.activateOnKey(evSpace) === true && tile.clickCount === 2 && evSpace.defaultPrevented, '空格同样激活，并拦截页面滚动');

  const native = makeEl('BUTTON');
  native.dataset.action = 'open-deck';
  native._attrs.role = 'button';
  ok(ui.activateOnKey(keyEvent('Enter', { target: targetOf(native) })) === false && native.clickCount === 0, '原生 <button> 交给浏览器（不重复触发）');

  const plain = makeEl('DIV');
  plain.dataset.action = 'open-deck'; // 没有 role=button
  ok(ui.activateOnKey(keyEvent('Enter', { target: targetOf(plain) })) === false && plain.clickCount === 0, '非 role=button 的 div 不激活（避免误触）');

  ok(ui.activateOnKey(keyEvent('a', { target: targetOf(tile) })) === false, '其它按键不处理');
  ok(ui.activateOnKey({ key: 'Enter', target: { closest: () => null } }) === false, '没有 data-action 祖先时安全返回');
  ok(ui.activateOnKey(null) === false, '空事件安全返回');
}

console.log('\n[播报与 toast 状态区域]');
{
  ui.announce('我的卡组');
  ok(doc._ids['sr-announce'].textContent === '我的卡组', 'announce() 把页面名写进实时区域');
  ui.announce('');
  ok(doc._ids['sr-announce'].textContent === '我的卡组', '空消息不打断（忽略）');

  ui.toast('已保存');
  const host = doc.body.children.find((c) => c && c.id === 'toast-host');
  ok(!!host, 'toast 自动创建 #toast-host 容器');
  ok(
    host && host._attrs.role === 'status' && host._attrs['aria-live'] === 'polite' && host._attrs['aria-atomic'] === 'true',
    'toast 容器是 role=status 的礼貌播报区'
  );
  ok(host && host.children.length === 1 && host.children[0].textContent === '已保存', '提示文本进入状态区域（读屏自动朗读）');
}

console.log('\n[弹窗：aria / 焦点陷阱 / 焦点还原]');
{
  const opener = makeEl('BUTTON');
  opener.dataset.action = 'new-deck';
  doc.activeElement = opener;

  let closed = 0;
  const overlay = ui.openModal({ title: '新建卡组', body: '<p>内容</p>', onClose: () => closed++ });

  ok(/role="dialog"/.test(overlay.innerHTML) && /aria-modal="true"/.test(overlay.innerHTML), '弹窗标记 role=dialog + aria-modal=true');
  const labelled = /aria-labelledby="([^"]+)"/.exec(overlay.innerHTML);
  ok(!!labelled && overlay.innerHTML.includes(`id="${labelled[1]}"`), 'aria-labelledby 指向弹窗标题元素 id');
  ok(doc.body.classList.contains('modal-open'), '打开时锁定页面滚动（modal-open）');
  ok(docKeydowns().length === 1, 'openModal 在 document 上注册 keydown（Escape / Tab）');

  // 焦点陷阱：Tab 在最后一个可聚焦元素上 → 循环回第一个
  const first = makeEl('BUTTON');
  const last = makeEl('BUTTON');
  overlay._queryList = [first, last];
  overlay.contains = (el) => el === first || el === last;
  doc.activeElement = last;
  const tab = keyEvent('Tab');
  docKeydowns()[0](tab);
  ok(first.focusCount === 1 && tab.defaultPrevented, 'Tab 在末位 → 焦点循环回首位（不跑出弹窗）');

  doc.activeElement = first;
  const shiftTab = keyEvent('Tab', { shiftKey: true });
  docKeydowns()[0](shiftTab);
  ok(last.focusCount === 1 && shiftTab.defaultPrevented, 'Shift+Tab 在首位 → 焦点循环到末位');

  ok(ui.focusables(null).length === 0 && ui.focusables({}).length === 0, 'focusables() 对异常输入安全返回空数组');

  docKeydowns()[0](keyEvent('Escape'));
  ok(overlay.removed === true && closed === 1, 'Escape 关闭弹窗并回调 onClose');
  ok(opener.focusCount === 1, '关闭后焦点回到触发弹窗的元素');
  ok(!doc.body.classList.contains('modal-open') && docKeydowns().length === 0, '清理 modal-open 状态与 keydown 监听');

  const noTitle = ui.openModal({ body: '无标题' });
  ok(/aria-label="对话框"/.test(noTitle.innerHTML) && !/aria-labelledby/.test(noTitle.innerHTML), '无标题弹窗回退 aria-label="对话框"');
  docKeydowns()[0](keyEvent('Escape'));
  ok(noTitle.removed === true, '无标题弹窗同样可关闭');
}

console.log(`\n无障碍结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
