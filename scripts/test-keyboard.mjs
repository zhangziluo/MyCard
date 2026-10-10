#!/usr/bin/env node
// ============================================================================
// test-keyboard.mjs — 移动端英文字母键盘（v0.7.0，js/keyboard.js）
//   运行: node scripts/test-keyboard.mjs
// 覆盖：① 环境判定（pointer: coarse / maxTouchPoints / ontouchstart / 无 window）
//       ② 键位 HTML（26 字母 + 空格 + 退格 + 收起；原生 button + 中文 aria-label）
//       ③ 状态机（open / hide / show / close + shouldAutoOpen + inputMode）
//       ④ DOM 三态（展开 = 键盘 / 收起 = 迷你胶囊 / 无宿主 = 整条隐藏）
//       ⑤ syncInputs（把 inputmode 同步到宿主声明的输入框）
//       ⑥ 事件派发（字母 / 退格 / 空格 / 回车 / 非法键 / 未展开时不派发）
//       ⑦ 视口监听只绑一次（重开不重复绑定）
// ============================================================================

const mem = {};
const mkStorage = () => ({
  getItem: (k) => (k in mem ? mem[k] : null),
  setItem: (k, v) => {
    mem[k] = String(v);
  },
  removeItem: (k) => {
    delete mem[k];
  },
  clear: () => {
    for (const k of Object.keys(mem)) delete mem[k];
  }
});
globalThis.localStorage = mkStorage();
globalThis.sessionStorage = mkStorage();

function mkEl(tag = 'div') {
  return {
    tagName: String(tag).toUpperCase(),
    id: '',
    className: '',
    innerHTML: '',
    textContent: '',
    hidden: false,
    offsetHeight: 0,
    style: {},
    dataset: {},
    _attrs: {},
    classList: {
      _s: new Set(),
      add(...c) {
        c.forEach((x) => this._s.add(x));
      },
      remove(...c) {
        c.forEach((x) => this._s.delete(x));
      },
      toggle(c, force) {
        const want = force === undefined ? !this._s.has(c) : !!force;
        if (want) this._s.add(c);
        else this._s.delete(c);
        return want;
      },
      contains(c) {
        return this._s.has(c);
      }
    },
    setAttribute(k, v) {
      this._attrs[k] = String(v);
    },
    getAttribute(k) {
      return k in this._attrs ? this._attrs[k] : null;
    },
    appendChild(c) {
      if (c && c.id === 'kb-bar') bar = c;
      return c;
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
    focus() {},
    remove() {}
  };
}

/** 键盘底栏单例（keyboard.js 会创建它并 appendChild 到 body） */
let bar = null;
/** 宿主输入框（syncInputs 的对象） */
const inputA = mkEl('input');
const inputB = mkEl('input');
const inputs = [inputA, inputB];
/** 视口级监听（验证只绑一次） */
const winListeners = {};

const htmlStyle = { _vars: {}, setProperty(k, v) { this._vars[k] = v; } };
const bodyEl = mkEl('body');
globalThis.document = {
  body: bodyEl,
  documentElement: { style: htmlStyle },
  addEventListener() {},
  removeEventListener() {},
  createElement: (t) => mkEl(t),
  getElementById: (id) => (id === 'kb-bar' ? bar : null),
  querySelector: () => null,
  querySelectorAll: (sel) => (sel === '.host-input' ? inputs.slice() : [])
};
let touch = false;
const winStub = {
  addEventListener(type, fn) {
    (winListeners[type] = winListeners[type] || []).push(fn);
  },
  matchMedia: (q) => ({ matches: touch && String(q).includes('coarse') }),
  navigator: { maxTouchPoints: 0 }
};
globalThis.window = winStub;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

/* ------------------------------ 载入模块 ------------------------------ */

const ui = await import('../js/ui.js');
const kb = await import('../js/keyboard.js');

let pass = 0;
let fail = 0;
const ok = (c, m, extra) => {
  if (c) {
    pass++;
    console.log('  ✓ ' + m);
  } else {
    fail++;
    console.error('  ✗ ' + m + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
};

/** 触发一次 data-action（走真实事件委托） */
function act(action, data = {}) {
  const el = {
    dataset: { action, ...data },
    classList: { add() {}, remove() {}, contains: () => false },
    closest: () => el
  };
  ui.handleEvent({ type: 'click', target: { closest: () => el }, preventDefault() {} });
  return el;
}

const shown = () => ({ open: kb.isKeyboardOpen(), hidden: bar ? bar.hidden : null, mini: bar ? bar.classList.contains('is-mini') : null });


/* ==========================================================================
 * ① 环境判定
 * ========================================================================== */

console.log('\n[环境判定 isTouchDevice]');
touch = false;
winStub.navigator.maxTouchPoints = 0;
ok(kb.isTouchDevice() === false, '无 pointer:coarse / 无触点 → 非触屏');
touch = true;
ok(kb.isTouchDevice() === true, 'pointer: coarse → 触屏');
touch = false;
winStub.navigator.maxTouchPoints = 5;
ok(kb.isTouchDevice() === true, 'maxTouchPoints > 0 → 触屏（老设备兜底）');
winStub.navigator.maxTouchPoints = 0;
winStub.matchMedia = undefined;
winStub.ontouchstart = null;
ok(kb.isTouchDevice() === true, '有 ontouchstart → 触屏');
delete winStub.ontouchstart;
ok(kb.isTouchDevice() === false, '两者都没有 → 非触屏（桌面）');
const savedWindow = globalThis.window;
delete globalThis.window;
ok(kb.isTouchDevice() === false && kb.shouldAutoOpen() === false, '无 window（Node 环境）→ 非触屏，不抛错');
globalThis.window = savedWindow;
winStub.matchMedia = (q) => ({ matches: touch && String(q).includes('coarse') });

/* ==========================================================================
 * ② 键位 HTML
 * ========================================================================== */

console.log('\n[键位 HTML]');
const plain = kb.keyboardInnerHtml(false);
const withSpace = kb.keyboardInnerHtml(true);
ok(kb.KB_ROWS.join('') === 'QWERTYUIOPASDFGHJKLZXCVBNM', '三行 QWERTY 覆盖 26 个字母');
ok(kb.KB_ROWS.map((r) => r.length).join() === '10,9,7', '行宽 10 / 9 / 7（拇指够得着）');
ok((plain.match(/data-key="/g) || []).length === 27 && !plain.includes('data-key="SPACE"'), '基础键盘 = 26 字母 + 退格（27 键，无空格）');
ok((withSpace.match(/data-key="/g) || []).length === 28 && withSpace.includes('data-key="SPACE"'), '填空题键盘多一个空格键（28 键）');
ok(plain.includes('data-action="kb-key"') && plain.includes('data-action="kb-hide"'), '键与「收起键盘」都走 Action 委托');
ok(
  /aria-label="字母 A"/.test(plain) && /aria-label="退格"/.test(plain) && /aria-label="空格"/.test(withSpace),
  '每个键都有中文 aria-label（读屏可懂）'
);
ok((plain.match(/<button type="button"/g) || []).length === 28, '全部键都是原生 <button>（Tab / Enter 天然可达）');
ok(kb.keyboardHtml(true).includes('role="group" aria-label="英文键盘"'), '底栏 role=group + aria-label');
ok(kb.keyboardMiniHtml().includes('data-action="kb-show"') && kb.keyboardMiniHtml().includes('⌨ 字母键盘'), '迷你胶囊带 kb-show 与文案');
ok(kb.BAR_ID === 'kb-bar' && kb.BACK_KEY === 'BACK' && kb.SPACE_KEY === 'SPACE', '常量：底栏 id / 退格键 / 空格键');

/* ==========================================================================
 * ③④⑤ 状态机 + DOM 三态 + syncInputs
 * ========================================================================== */

console.log('\n[状态机 + DOM 三态]');
touch = true;
winStub.navigator.maxTouchPoints = 0;
ok(kb.isKeyboardOpen() === false && kb.keyboardConfig() === null, '初始：未展开、无宿主配置');
ok(kb.shouldAutoOpen() === true, '触屏且未被收起 → 应当自动展开');

const calls = { keys: [], backs: 0, spaces: 0, enters: 0 };
kb.openKeyboard({
  inputs: '.host-input',
  space: true,
  onKey: (ch) => calls.keys.push(ch),
  onBackspace: () => {
    calls.backs++;
  },
  onSpace: () => {
    calls.spaces++;
  },
  onEnter: () => {
    calls.enters++;
  }
});
ok(kb.isKeyboardOpen() === true && kb.inputMode() === 'none', 'openKeyboard → 展开，inputMode = none（抑制系统输入法）');
ok(!!bar && bar.hidden === false && bar.classList.contains('is-open') && !bar.classList.contains('is-mini'), 'DOM：底栏显示为键盘态');
ok(bar.innerHTML.includes('data-key="SPACE"'), 'DOM：space:true → 渲染空格键');
ok(inputs.every((i) => i.getAttribute('inputmode') === 'none'), 'syncInputs：所有宿主输入框写成 inputmode=none');
ok(htmlStyle._vars['--kb-h'] === '190px', '未测到高度时 --kb-h 兜底 190px');
bar.offsetHeight = 210;
kb.showKeyboard();
ok(htmlStyle._vars['--kb-h'] === '210px', '展开时把实测高度写进 --kb-h（内容区据此留白）');
ok(document.body.classList.contains('kb-open'), 'body 标记 kb-open（CSS 用它给 #view 追加底部留白）');
ok(kb.syncInputs() === 2, 'syncInputs 返回同步到的输入框数量');

/* ==========================================================================
 * ⑥ 事件派发
 * ========================================================================== */

console.log('\n[事件派发]');
act('kb-key', { key: 'Q' });
act('kb-key', { key: 'A' });
ok(calls.keys.join('') === 'QA', '点字母键 → 回调收到大写字母');
act('kb-key', { key: 'back' });
act('kb-key', { key: 'ZZ' });
act('kb-key', {});
act('kb-key', { key: '1' });
ok(calls.keys.join() === 'Q,A', '小写 / 多字符 / 空键 / 非字母一律忽略');
act('kb-key', { key: 'BACK' });
ok(calls.backs === 1, '退格键 → onBackspace');
act('kb-key', { key: 'SPACE' });
ok(calls.spaces === 1 && calls.keys.length === 2, '空格键 → onSpace（不再走 onKey）');
act('kb-key', { key: 'ENTER' });
ok(calls.enters === 1, '回车键 → onEnter');

console.log('\n[收起 → 迷你胶囊 → 再唤出]');
act('kb-hide');
ok(kb.isKeyboardOpen() === false && kb.inputMode() === 'latin', '收起：inputMode 回到 latin（恢复系统键盘）');
ok(inputs.every((i) => i.getAttribute('inputmode') === 'latin'), '收起后输入框恢复 inputmode=latin');
ok(
  bar.hidden === false && bar.classList.contains('is-mini') && bar.innerHTML.includes('data-action="kb-show"'),
  'DOM：收起后只剩迷你胶囊（不是整条消失）'
);
ok(kb.shouldAutoOpen() === false, '手动收起过 → 同页内不再自动弹回');
ok(document.body.classList.contains('kb-open') === false, 'body 去掉 kb-open（不再留白）');
act('kb-key', { key: 'B' });
ok(calls.keys.length === 2, '未展开时点键不派发（避免幽灵输入）');
act('kb-show');
ok(kb.isKeyboardOpen() === true && bar.classList.contains('is-open') && !bar.innerHTML.includes('kb-mini'), '点胶囊 → 重新展开（换回键位）');
ok(kb.shouldAutoOpen() === true, '重新展开 → 自动弹出标记复位');


/* ==========================================================================
 * 彻底清场 / 宿主切换 / 只绑一次 / 降级
 * ========================================================================== */

console.log('\n[彻底清场 closeKeyboard]');
kb.closeKeyboard();
ok(kb.isKeyboardOpen() === false && kb.keyboardConfig() === null && kb.inputMode() === 'latin', 'closeKeyboard：收起 + 清掉宿主配置');
ok(inputs.every((i) => i.getAttribute('inputmode') === 'latin'), '清场后输入框还原为系统键盘');
ok(bar.hidden === true && bar.innerHTML === '', 'DOM：底栏整条隐藏并清空内容');
ok(kb.shouldAutoOpen() === true && kb.showKeyboard() === false, '清场后 kb-show 无效（需宿主重新 openKeyboard）');

console.log('\n[宿主切换 / 只绑一次 / 降级]');
kb.openKeyboard({ inputs: '.host-input', onKey: () => {} });
ok(kb.isKeyboardOpen() === true && kb.keyboardConfig().space === false, '重新声明宿主：默认无空格键');
kb.openKeyboard({ inputs: '.host-input', space: true, onKey: () => {} });
ok(bar.innerHTML.includes('data-key="SPACE"'), '换宿主时按新配置重画键位（补上空格键）');
const boundResize = (winListeners['resize'] || []).length;
kb.openKeyboard({ inputs: '.host-input', onKey: () => {} });
kb.showKeyboard();
kb.hideKeyboard();
kb.openKeyboard({ inputs: '.host-input', onKey: () => {} });
ok((winListeners['resize'] || []).length === boundResize, '视口监听只绑一次（反复开关不累积）');
ok((winListeners['orientationchange'] || []).length === boundResize, '横竖屏监听同样只绑一次');
kb.openKeyboard({ inputs: '', onKey: () => {} });
ok(kb.syncInputs() === 0, '未声明 inputs → syncInputs 无事可做（返回 0）');
ok(kb.isKeyboardOpen() === true && bar.innerHTML.includes('data-key="Q"'), '无 inputs 选择器也照常展开键盘');

const savedDoc = globalThis.document;
delete globalThis.document;
let threw = false;
try {
  kb.closeKeyboard();
  kb.openKeyboard({ inputs: '.x', onKey: () => {} });
  kb.syncInputs();
  kb.hideKeyboard();
} catch (e) {
  threw = true;
}
ok(threw === false, '无 document（Node 环境）下 open / close / sync / hide 均不抛错');
ok(kb.isKeyboardOpen() === false, '（无 DOM 时状态机仍正常推进）');
globalThis.document = savedDoc;
kb.closeKeyboard();
ok(kb.isKeyboardOpen() === false && kb.keyboardConfig() === null, '恢复 DOM 后清场收尾');

/* ==========================================================================
 * 汇总
 * ========================================================================== */

console.log(`\n字母键盘测试: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);

