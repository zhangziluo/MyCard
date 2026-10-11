// ============================================================================
// webdav.js — 极简 WebDAV 客户端（v0.8.0 起，零依赖，只用 fetch；v0.9.2 加「可诊断」）
//
// 只实现同步需要的 5 个动作：PROPFIND（探测）、MKCOL（递归建目录）、GET、PUT、DELETE，
// 外加 Basic 认证与统一的错误映射 —— 不引入任何第三方库。
//
// 设计要点：
//   · 出错统一抛 `WebdavError`（带 status）→ 上层（js/sync.js）按 status 决定
//     「提示 / 重试 / 中止」，不必解析网络细节；`explainError()` 给出中文可读原因；
//   · `baseUrl` 做规范化（补协议、去尾斜杠），路径段逐个 encodeURIComponent → 中文 / 空格目录可用；
//   · 支持超时（AbortController，缺省 20s）与「无 fetch 环境」的明确报错；
//   · **CORS 提醒**：浏览器直连 WebDAV 需要服务端允许跨域（Nextcloud 的 `remote.php/dav`、
//     坚果云的 `dav.jianguoyun.com/dav` 等都支持）；被拦时 fetch 只抛一句 "Failed to fetch"，
//     浏览器**不会**告诉我们是 DNS / 证书 / CORS / 插件拦的。
//
// v0.9.2「连不上也说得清」：
//   · `request()` 出错时保留**原始异常**（name + message）并分类（kind：timeout / offline /
//     mixed-content / network），不再把一切压成没有信息的 "request failed"；
//   · `explainError()` 会给出「哪一步 + 底层原始信息 + 该怎么办」，而不是一句英文；
//   · `diagnose()`：**逐步**探测（环境 → 简单请求 → CORS 预检 → 带认证 PROPFIND），
//     每步都不抛错，最后给出可执行结论（是网络问题、跨域被拦、还是账号/密码不对）；
//   · `diagnoseReport()` / `setupHints()`：把报告复制给他人求助 / 页面上的自查清单。
// ============================================================================

/** 缺省超时（ms） */
export const DEFAULT_TIMEOUT = 20000;

export class WebdavError extends Error {
  constructor(message, { status = 0, url = '', cause = null, kind = '' } = {}) {
    super(message);
    this.name = 'WebdavError';
    this.status = status;
    this.url = url;
    this.cause = cause;
    /** 'timeout' | 'offline' | 'mixed-content' | 'network' | ''（空 = 有 HTTP 状态，按状态解释） */
    this.kind = kind;
  }
}

/** 底层异常的可读细节：浏览器只给一句 "Failed to fetch"，能拿到的都带上 */
export function causeText(err) {
  const e = err && err.cause ? err.cause : err;
  if (!e) return '';
  const name = String(e.name || '');
  const msg = String(e.message || (typeof e === 'string' ? e : '') || '').trim();
  if (name && msg) return `${name}: ${msg}`;
  return msg || name;
}

/** 当前页面是否在本机（localhost / 127.0.0.1 / [::1]）——用于推荐「本机代理」这条零账号方案 */
export function isLocalPage() {
  let host = '';
  try {
    host = typeof location !== 'undefined' && location ? String(location.hostname || '') : '';
  } catch (e) {
    host = '';
  }
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

/** 当前页面是不是 HTTPS（混合内容判断用；非浏览器环境 → false） */
function pageIsHttps() {
  try {
    return typeof location !== 'undefined' && location && location.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

/** 设备是否明确处于离线（拿不到 navigator → 一律当在线） */
function deviceOffline() {
  try {
    return typeof navigator !== 'undefined' && navigator && navigator.onLine === false;
  } catch (e) {
    return false;
  }
}

/**
 * 认证 / 权限 / 网络问题的可读提示。
 * 网络类错误（kind）会带上 URL、底层原始信息与排查方向 —— 不再是一句 "request failed"。
 */
export function explainError(err) {
  const status = Number(err && err.status) || 0;
  const where = err && err.url ? `｜地址 ${err.url}` : '';
  const why = causeText(err);
  const tail = why ? `｜浏览器原始信息：${why}` : '';
  if (status === 401) return `认证失败：用户名 / 密码（或应用专用密码）不对${where}。坚果云要用「账号邮箱 + 应用密码」` + tail;
  if (status === 403) return `没有权限：账号能通过，但该目录不可读写${where}（坚果云请确认该文件夹未被设为只读）` + tail;
  if (status === 404) return `路径不存在${where}：检查服务器地址末尾是否少写了 /dav/ 或目录名拼错` + tail;
  if (status === 405) return `服务器不允许该操作${where}：确认地址指向支持 WebDAV 的目录` + tail;
  if (status === 409) return `父目录不存在或目录冲突${where}：检查目录路径` + tail;
  if (status === 412) return `资源已被其他设备修改${where}：稍后重试` + tail;
  if (status === 423) return `资源被锁定${where}：可能另一台设备正在同步，稍后再试` + tail;
  if (status === 507) return `服务器空间不足${where}：清理网盘后重试` + tail;
  if (status >= 500) return `服务器错误（${status}）${where}${tail}：稍后重试`;
  if (status) return `请求失败（HTTP ${status}）${where}${tail}`;
  if (err && err.kind === 'timeout') {
    return `连接超时${where}${tail}。可能是网络慢、网盘无响应，或请求被中间设备挂起 —— 换个网络 / 稍后重试，仍不行可点「诊断连接」` ;
  }
  if (err && err.kind === 'offline') return `当前设备处于离线状态${where}${tail}。连上网络后重试`;
  if (err && err.kind === 'mixed-content') {
    return `地址协议不匹配${where}：页面是 HTTPS，浏览器会直接拦截 http:// 的 WebDAV 地址 —— 请把服务器地址改成 https://`;
  }
  if (err && err.kind === 'network') {
    return (
      `连不上服务器${where}${tail}。浏览器出于安全限制不会说明具体原因，常见三类：` +
      `① 网络 / DNS / 证书不通；② 网盘未允许浏览器跨域（CORS 预检被拒）；③ 被广告拦截·隐私插件或公司代理拦下。` +
      `点「诊断连接」可逐步定位是哪一类`
    );
  }
  const raw = String((err && err.message) || err || '');
  if (/Failed to fetch|NetworkError|Load failed|fetch failed|request failed/i.test(raw)) {
    return `连不上服务器${where}${tail}：多为网络不可达或跨域被拦，点「诊断连接」可逐步定位`;
  }
  return raw || '未知错误';
}

/* ------------------------------ URL / 认证 ------------------------------ */

/** 规范化服务器地址：补 `https://`、去掉尾部 `/`（非法协议 → 报错） */
export function normalizeBase(raw) {
  let s = String(raw || '').trim();
  if (!s) throw new WebdavError('请填写 WebDAV 服务器地址');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  if (!/^https?:\/\/[^/]+/i.test(s)) throw new WebdavError('服务器地址格式不正确（示例：https://dav.jianguoyun.com/dav/）');
  return s.replace(/\/+$/, '');
}

/** 目录规范化：去掉首尾 `/`、折叠重复斜杠；空 → 根目录 */
export function normalizeDir(raw) {
  return String(raw == null ? '' : raw)
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/');
}

/** 拼接地址（逐段编码，中文 / 空格目录也可用） */
export function buildUrl(base, ...segments) {
  const root = normalizeBase(base);
  const parts = [];
  for (const seg of segments) {
    const s = String(seg == null ? '' : seg).trim();
    if (!s) continue;
    for (const piece of s.replace(/^\/+|\/+$/g, '').split('/')) {
      if (piece) parts.push(encodeURIComponent(piece));
    }
  }
  return parts.length ? `${root}/${parts.join('/')}` : root;
}

/** Basic 认证头（UTF-8 安全；无 btoa 环境返回空串） */
export function authHeader(user, pass) {
  if (!user) return '';
  const raw = `${user}:${pass == null ? '' : pass}`;
  let bin = raw;
  try {
    const bytes = new TextEncoder().encode(raw);
    bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
  } catch (e) {
    bin = raw;
  }
  try {
    return 'Basic ' + btoa(bin);
  } catch (e) {
    return '';
  }
}

/* ------------------------------ 请求 ------------------------------ */

function fetchImpl() {
  return typeof fetch === 'function' ? fetch : null;
}

/** 统一请求：注入认证 / 超时；网络异常 → WebdavError（保留原始异常 + 分类，便于解释与诊断） */
async function request(method, url, { headers = {}, body = null, timeout = DEFAULT_TIMEOUT, auth = null } = {}) {
  const doFetch = fetchImpl();
  if (!doFetch) throw new WebdavError('当前环境不支持 fetch，无法访问 WebDAV', { url, kind: 'network' });
  // 混合内容：HTTPS 页面请求 http:// 地址会被浏览器直接拦掉（fetch 都不会发出去）
  if (pageIsHttps() && /^http:\/\//i.test(String(url))) {
    throw new WebdavError('页面是 HTTPS，不能访问 http:// 的 WebDAV 地址（浏览器会直接拦截）', {
      url,
      kind: 'mixed-content'
    });
  }
  const h = { ...headers };
  if (auth && auth.user) {
    const token = authHeader(auth.user, auth.pass);
    if (token) h.Authorization = token;
  }
  let timer = null;
  let signal;
  try {
    if (typeof AbortController === 'function' && timeout > 0) {
      const ctl = new AbortController();
      signal = ctl.signal;
      timer = setTimeout(() => ctl.abort(), timeout);
    }
    return await doFetch(url, { method, headers: h, body, signal });
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
    const why = causeText(e);
    if (aborted) {
      throw new WebdavError(`请求超时（${Math.round(timeout / 1000)} 秒）：${method} ${url}`, { url, kind: 'timeout', cause: e });
    }
    throw new WebdavError(`连不上服务器（${method} ${url}）${why ? ` — ${why}` : ''}`, {
      url,
      kind: deviceOffline() ? 'offline' : 'network',
      cause: e
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function fail(res, url, expect) {
  return new WebdavError(`HTTP ${res.status}（${expect}）`, { status: res.status, url });
}

/* ------------------------------ 公开 API ------------------------------ */

/** 测试连接：PROPFIND Depth:0（207 / 200 视为可用） */
export async function probe(base, { auth = null, timeout = DEFAULT_TIMEOUT, dir = '' } = {}) {
  const url = buildUrl(base, dir);
  const res = await request('PROPFIND', url, {
    headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
    auth,
    timeout
  });
  if (res.status === 207 || res.status === 200) return { ok: true, status: res.status, url };
  throw fail(res, url, '期望 207 Multi-Status');
}

/** 递归建目录（已存在 405 也算成功；逐级 MKCOL 避免 409） */
export async function ensureCollection(base, dir, { auth = null, timeout = DEFAULT_TIMEOUT } = {}) {
  const clean = normalizeDir(dir);
  if (!clean) return { created: [], url: normalizeBase(base) };
  const created = [];
  const parts = clean.split('/');
  for (let i = 0; i < parts.length; i++) {
    const url = buildUrl(base, parts.slice(0, i + 1).join('/'));
    const res = await request('MKCOL', url, { auth, timeout });
    if (res.status === 201) created.push(parts[i]);
    else if ([200, 204, 405].includes(res.status)) continue; // 已存在 / 无需创建
    else throw fail(res, url, '期望 201 Created（或 405 已存在）');
  }
  return { created, url: buildUrl(base, clean) };
}

/**
 * 读文本文件。
 * @returns {{ exists: true, text: string, status: number } | { exists: false, text: null, status: 404 }}
 */
export async function getText(base, file, { auth = null, timeout = DEFAULT_TIMEOUT, dir = '' } = {}) {
  const url = buildUrl(base, dir, file);
  const res = await request('GET', url, { auth, timeout, headers: { Accept: 'application/json, text/plain, */*' } });
  if (res.status === 404) return { exists: false, text: null, status: 404 };
  if (res.status >= 200 && res.status < 300) {
    const text = typeof res.text === 'function' ? await res.text() : '';
    return { exists: true, text: String(text || ''), status: res.status };
  }
  throw fail(res, url, '期望 200');
}

/** 写文本文件（`createOnly` 时带 `If-None-Match: *`，用于抢锁） */
export async function putText(base, file, text, { auth = null, timeout = DEFAULT_TIMEOUT, dir = '', createOnly = false } = {}) {
  const url = buildUrl(base, dir, file);
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (createOnly) headers['If-None-Match'] = '*';
  const res = await request('PUT', url, { headers, body: text, auth, timeout });
  if ([200, 201, 204].includes(res.status)) return { ok: true, status: res.status, url };
  if (createOnly && (res.status === 412 || res.status === 409)) throw new WebdavError('资源已存在', { status: res.status, url });
  throw fail(res, url, '期望 200/201/204');
}

/** 删除文件（不存在也视为成功） */
export async function remove(base, file, { auth = null, timeout = DEFAULT_TIMEOUT, dir = '' } = {}) {
  const url = buildUrl(base, dir, file);
  const res = await request('DELETE', url, { auth, timeout });
  if ([200, 204, 404].includes(res.status)) return { ok: true, status: res.status, url };
  throw fail(res, url, '期望 204（或 404 已不存在）');
}

/* --------------------------- 连不上时的逐步诊断 --------------------------- */

/**
 * 「服务器到底可不可达」的黑盒探测（v0.9.3）。
 *
 * 原理：`mode: 'no-cors'` 的**简单** GET 不要求服务端给 CORS 头（响应是 opaque，读不到内容），
 * 于是能用「resolve / reject」把两类原因彻底分开：
 *   · **resolve** → 请求确实到达了服务器并拿到响应（DNS / TLS / 网络 / 插件都没问题）
 *     ⇒ 之前失败的原因就是**服务端没给浏览器跨域许可（CORS 响应头缺失）**；
 *   · **reject**  → 请求压根没完成（DNS / 证书 / 网络策略 / 内容拦截 / 代理）。
 * 这是浏览器环境下唯一能把「网络问题」与「CORS 问题」区分开的可靠手段
 * （普通 fetch 两者都只报 `TypeError: Failed to fetch` / Safari 的 `Load failed`）。
 */
export async function probeReachable(url, { timeout = DEFAULT_TIMEOUT } = {}) {
  const doFetch = fetchImpl();
  if (!doFetch) return { ok: false, reason: 'no-fetch' };
  if (pageIsHttps() && /^http:\/\//i.test(String(url))) return { ok: false, reason: 'mixed-content' };
  let timer = null;
  let signal;
  try {
    if (typeof AbortController === 'function' && timeout > 0) {
      const ctl = new AbortController();
      signal = ctl.signal;
      timer = setTimeout(() => ctl.abort(), timeout);
    }
    await doFetch(String(url), {
      method: 'GET',
      mode: 'no-cors',
      cache: 'no-store',
      redirect: 'follow',
      signal
    });
    return { ok: true };
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
    return { ok: false, reason: aborted ? 'timeout' : deviceOffline() ? 'offline' : 'unreachable', cause: e };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 自查清单（页面上展示 / 报告里附带）。
 * 浏览器不会告诉我们「为什么连不上」，所以把**最可能的几类原因**直接摆给用户。
 */
export function setupHints(base = '') {
  const jgy = /jianguoyun/i.test(String(base));
  const hints = [
    '地址要填 WebDAV 端点、不是网盘首页：坚果云 = https://dav.jianguoyun.com/dav/（末尾斜杠可有可无）',
    jgy
      ? '坚果云：用户名 = 你的注册邮箱；密码 = 「账户信息 → 安全选项 → 添加应用」生成的【应用密码】（登录密码连不上）'
      : '多数网盘要求「应用专用密码」而不是登录密码（坚果云 / Nextcloud / 群晖都有各自的应用密码）',
    '页面是 https 时，WebDAV 地址也必须 https（http 会被浏览器当混合内容直接拦掉）',
    '诊断里「基础连通性」通过而「跨域预检」失败 → 网盘没给浏览器跨域许可（CORS）：换支持跨域的网盘，或按 README 用一段 Cloudflare Worker 反代',
    '诊断里「服务器可达性」通过、但「基础连通性」失败 → 网络其实是通的，是服务端缺少跨域响应头（CORS），**不是你网络的问题**',
    '诊断里「服务器可达性」也失败 → 请求压根没完成：先在浏览器地址栏直接打开该地址；换网络（手机热点）；关掉内容拦截 / 隐私扩展（iOS「内容拦截器」·iCloud 私密代理、Android AdGuard、uBlock 等）；避开公司代理',
    '本机运行 Mycard 时（http://localhost:…）：可用 scripts/dav-proxy.py 做「同源代理」——零账号、免跨域，同时它就是个静态站点服务器（可替代 python3 -m http.server）',
    '坚果云在网页端「安全选项」里可查看/重置应用密码；同一个应用密码可多设备共用'
  ];
  return jgy ? hints : hints.filter((h) => !/坚果云在网页端/.test(h));
}

/**
 * 生成「Cloudflare Worker 反代」代码（v0.9.4）。
 *
 * 用途：网盘**不给浏览器跨域许可**（诊断里「服务器可达性 ✓、基础连通性 ✗」）时，
 * 用它把 WebDAV 包一层「允许跨域」的地址；几分钟部署完，之后照常填账号密码即可同步。
 * TARGET 从用户填的地址自动推导，用户无需改任何代码。
 */
export function workerProxyCode(base = '') {
  let host = 'https://dav.jianguoyun.com';
  try {
    host = new URL(normalizeBase(base)).origin;
  } catch (e) {
    /* 地址非法就用示例值 */
  }
  return `// Mycard · WebDAV CORS 反代（Cloudflare Worker，免费）
// 为什么需要它：很多网盘（坚果云等）不回 CORS 响应头，浏览器会直接拦住「网页 → 网盘」的请求。
// 这个 Worker 站中间：浏览器 → Worker（允许跨域）→ 网盘；认证头原样转发，密码不经过第三方。
//
// 部署（约 3 分钟）：
//   1) 打开 https://dash.cloudflare.com/ → Workers & Pages → 创建 Worker
//   2) 把本文件内容整段粘贴进去 → 部署
//   3) 回到 Mycard 设置页，「服务器地址」改成：https://<你的 Worker 域名>/dav
//      （Worker 地址 + 原来 /dav 这段路径前缀；「同步目录」仍填 mycard）
//   4) 用户名 / 应用密码照旧 → 点「测试连接」，应显示连接成功

const TARGET = '${host}'; // ← 你的 WebDAV 服务器（只到域名，不含 /dav 之后的路径）
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,PUT,DELETE,PROPFIND,MKCOL,OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type,Depth,If-None-Match,If-Match,Overwrite',
  'Access-Control-Expose-Headers': 'ETag,Content-Length',
  'Access-Control-Max-Age': '86400'
};

export default {
  async fetch(req) {
    const url = new URL(req.url);
    // 想再收紧一点可以打开下面这行（配合「服务器地址」里带 ?k=你的口令 使用）：
    // if (url.searchParams.get('k') !== '你的口令') return new Response('forbidden', { status: 403 });
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS }); // 跨域预检直接放行
    }
    const headers = new Headers(req.headers);
    ['host', 'origin', 'referer', 'cf-connecting-ip', 'cf-ray', 'cf-ipcountry'].forEach((h) => headers.delete(h));
    const res = await fetch(TARGET + url.pathname + url.search, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body
    });
    const out = new Headers(res.headers);
    Object.entries(CORS).forEach(([k, v]) => out.set(k, v));
    out.delete('set-cookie'); // 不必把网盘的 cookie 透给浏览器
    return new Response(res.body, { status: res.status, headers: out });
  }
};
`;
}

/**
 * 逐步诊断（**任何一步失败都不会抛错**，把「哪一步、得到什么、说明什么」如实列出）。
 * 顺序有讲究：
 *   ① 地址 / 环境（混合内容、离线）→ 本地就能判断的，先判掉；
 *   ② GET（**不带认证、不带自定义头** → 不触发 CORS 预检）：能拿到状态码 = 网络通 + 服务端允许简单跨域；
 *   ③ ②失败时用 `no-cors` 探测把「网络不通」与「缺 CORS 头」分开（v0.9.3）；
 *   ④ PROPFIND 不带认证（会触发预检）：若 ② 通过而 ④ 失败 → **预检被拒**（结论明确）；
 *   ⑤ 带认证的 PROPFIND = 「测试连接」本体：区分 401（账号/密码）与 403（权限）；
 * 最后给一句可执行结论 + 机器可读的 `reason`（供 UI 分支渲染「怎么修」）。
 * @returns {{ ok:boolean, verdict:string, reason:string, steps:Array<{id:string,label:string,status:'ok'|'fail'|'warn',detail:string}> }}
 */
export async function diagnose(base, { auth = null, dir = '', timeout = DEFAULT_TIMEOUT } = {}) {
  const steps = [];
  const add = (id, label, status, detail) => {
    steps.push({ id, label, status, detail });
    return steps[steps.length - 1];
  };
  /** 步骤里用的简短描述（完整解释留给 toast / 结论，弹窗才不会一屏都是同一段话） */
  const brief = (e) => {
    const kind = e && e.kind;
    const head =
      kind === 'timeout'
        ? '请求超时'
        : kind === 'offline'
          ? '设备离线'
          : kind === 'mixed-content'
            ? '混合内容被拦（HTTPS 页面 + http:// 地址）'
            : '连不上（浏览器未透露原因：网络 / CORS / 插件或代理）';
    const why = causeText(e);
    const where = e && e.url ? ` ${e.url}` : '';
    return `${head}${where}${why ? ` — ${why}` : ''}`;
  };
  let root = '';
  try {
    root = buildUrl(base, dir);
  } catch (e) {
    add('url', '解析服务器地址', 'fail', explainError(e));
    return { ok: false, verdict: '服务器地址填错了，先改对地址再试', reason: 'address', steps };
  }
  add('url', '解析服务器地址', 'ok', root);

  const https = pageIsHttps();
  if (https && /^http:\/\//i.test(root)) {
    add('env', '环境检查', 'fail', '当前页面是 HTTPS，不能访问 http:// 的 WebDAV 地址（浏览器会直接拦截）');
    return { ok: false, verdict: '混合内容被拦：请把服务器地址改成 https://', reason: 'mixed-content', steps };
  }
  if (deviceOffline()) {
    add('env', '环境检查', 'fail', '设备当前处于离线状态');
    return { ok: false, verdict: '设备离线：先连上网络再试', reason: 'offline', steps };
  }
  add('env', '环境检查', 'ok', `页面协议 ${https ? 'HTTPS' : 'HTTP'}，目标地址协议 ${/^https:/i.test(root) ? 'HTTPS' : 'HTTP'}`);

  // v0.9.6：非 HTTPS 页面 → 提醒后果（Service Worker / 剪贴板不可用），本机页面则直接指向本机代理脚本
  if (!https) {
    add(
      'secure',
      '页面安全性',
      'warn',
      isLocalPage()
        ? '页面通过 http://localhost 打开：Service Worker（离线 / 自动更新）与剪贴板 API 不可用（复制会走「手动复制」弹窗）。若正被「网盘不给跨域许可」卡住，跑 scripts/dav-proxy.py 是零账号的最省事方案'
        : '页面不是 HTTPS：Service Worker（离线 / 自动更新）与剪贴板 API 不可用，建议改用 https 打开（localhost 除外）'
    );
  }

  // ③ 简单请求（无认证、无自定义头 → 不触发预检）
  let simpleOk = false;
  let simpleStatus = 0;
  try {
    const res = await request('GET', root, { timeout });
    simpleOk = true;
    simpleStatus = res.status;
    const note = res.status === 401 || res.status === 403 ? '（要求认证，属于正常）' : '';
    add('simple', '基础连通性（GET，不带认证）', 'ok', `服务器有响应：HTTP ${res.status}${note}`);
  } catch (e) {
    add('simple', '基础连通性（GET，不带认证）', 'fail', brief(e));
  }

  // ③′ 简单请求失败时，用 no-cors 探测把「网络不通」与「缺 CORS 头」分开（v0.9.3）
  let reach = null;
  if (!simpleOk) {
    reach = await probeReachable(root, { timeout });
    const why = reach.ok ? '' : `（${reach.reason === 'timeout' ? '超时' : reach.reason === 'offline' ? '设备离线' : '请求未完成'}${causeText(reach.cause) ? `：${causeText(reach.cause)}` : ''}）`;
    add(
      'reach',
      '服务器可达性（no-cors 探测）',
      reach.ok ? 'ok' : 'fail',
      reach.ok
        ? '请求「到达了」服务器并拿到响应（no-cors 只要求连通、不要求跨域头）→ 网络与服务器都正常，缺的是跨域许可'
        : `请求没能完成${why}→ 属于网络 / DNS / 证书 / 拦截层面`
    );
  }

  // ④ 预检（PROPFIND 不在 CORS 简单方法里 → 一定先发 OPTIONS 预检）
  let preflightOk = false;
  let preflightStatus = 0;
  try {
    const res = await request('PROPFIND', root, { headers: { Depth: '0' }, timeout });
    preflightOk = true;
    preflightStatus = res.status;
    add('preflight', '跨域预检（PROPFIND，不带认证）', 'ok', `预检通过：HTTP ${res.status}`);
  } catch (e) {
    add('preflight', '跨域预检（PROPFIND，不带认证）', 'fail', brief(e));
  }

  // ④ 带认证的 PROPFIND（「测试连接」本体）
  let authOk = false;
  let authStatus = 0;
  try {
    const res = await request('PROPFIND', root, { headers: { Depth: '0' }, auth, timeout });
    authStatus = res.status;
    authOk = res.status === 207 || res.status === 200;
    add(
      'auth',
      '带认证的 PROPFIND（测试连接本体）',
      authOk ? 'ok' : 'fail',
      authOk ? `HTTP ${res.status}：目录可读，可以开始同步` : `HTTP ${res.status}：${explainError({ status: res.status, url: root })}`
    );
  } catch (e) {
    authStatus = Number(e && e.status) || 0;
    add('auth', '带认证的 PROPFIND（测试连接本体）', 'fail', brief(e));
  }

  let verdict;
  let reason = 'unknown';
  if (authOk) {
    verdict = '连接正常：填账号 → 点「立即同步」即可';
    reason = 'ok';
  } else if (!simpleOk && reach && reach.ok) {
    reason = 'cors';
    verdict =
      '服务器其实是「可达」的，只是它没有给浏览器跨域许可（响应缺少 CORS 头）——' +
      '所以浏览器直连这个地址会被拦死，换网络 / 关插件都没用。' +
      '出路：① 点弹窗里的「复制 Worker 反代代码」，按三步加一层中转（免费，几分钟）；② 或换支持跨域的 WebDAV（自建 Nextcloud 的 remote.php/dav）';
  } else if (!simpleOk) {
    reason = 'network';
    verdict =
      '这台设备根本到不了服务器（请求没完成）：DNS / 证书 / 网络策略 / 内容拦截插件 / 代理都可能 —— ' +
      '先在浏览器地址栏直接打开这个地址，再依次试：换网络（手机热点）、关掉内容拦截与隐私扩展、避开公司代理';
  } else if (!preflightOk) {
    reason = 'cors';
    verdict = '服务器拒绝了浏览器的跨域预检（CORS）——这台设备无法直连该 WebDAV 地址；换支持 CORS 的地址，或按 README 用 Cloudflare Worker 反代';
  } else if (authStatus === 401) {
    reason = 'auth';
    verdict = '跨域正常，是账号或密码不对：坚果云要用「账号邮箱 + 应用密码」（登录密码无效）';
  } else if (authStatus === 403) {
    reason = 'permission';
    verdict = '跨域与账号都正常，但该目录没有读写权限';
  } else if (authStatus === 404) {
    reason = 'path';
    verdict = '跨域与账号都正常，是路径不存在：检查服务器地址末尾（如坚果云要 /dav/）与「同步目录」';
  } else {
    reason = 'server';
    verdict = `跨域与账号基本正常，但服务器返回 HTTP ${authStatus || '未知'}：${steps[steps.length - 1].detail}`;
  }
  void simpleStatus;
  void preflightStatus;
  return { ok: authOk, verdict, reason, steps };
}

/** 把一个可执行结论转成「怎么修」的步骤文本（报告里要用，保证用户复制出去的是一份能照做的东西） */
export function fixSteps(rep, cfg = {}) {
  const r = rep || {};
  if (r.reason === 'cors') {
    if (isLocalPage()) {
      return [
        '①（推荐，零账号）在 Mycard 目录里运行：python3 scripts/dav-proxy.py',
        '② 用它给的地址打开 Mycard：http://localhost:8080/（该脚本同时就是静态站点服务器，可直接替代 python3 -m http.server）',
        `③ 设置页「服务器地址」填 http://localhost:8080/dav（与页面同源 → 浏览器不做跨域检查），用户名 / 应用密码照旧，目录仍填 ${cfg.dir || 'mycard'}`,
        '④ 不想在本机跑脚本时：点「复制 Worker 反代代码」部署到 Cloudflare Workers（免费），再把地址换成 Worker 的地址',
        '（也可以换成本身支持跨域的 WebDAV，如自建 Nextcloud 的 remote.php/dav）'
      ];
    }
    return [
      '① 点亮「复制 Worker 反代代码」（或在诊断报告末尾取用），到 https://dash.cloudflare.com/ 新建一个 Worker，整段粘贴后部署（免费）',
      `② 回到 Mycard 设置页，把「服务器地址」改成 https://你的worker.workers.dev/dav（即在 Worker 地址后保留原来的 /dav 前缀；同步目录仍填 ${cfg.dir || 'mycard'}）`,
      '③ 用户名 / 应用密码照旧 →「测试连接」应显示成功 →「立即同步」',
      '（也可以换成本身支持跨域的 WebDAV，如自建 Nextcloud 的 remote.php/dav）'
    ];
  }
  if (r.reason === 'network') {
    return [
      '① 先在浏览器地址栏直接打开这个地址，确认能不能打开',
      '② 换网络（手机热点）再试；关掉内容拦截 / 隐私扩展（iOS「内容拦截器」·iCloud 私密代理、AdGuard、uBlock 等）',
      '③ 避开公司 / 校园代理；确认没有开启全局 VPN 或自定义 DNS 拦截'
    ];
  }
  if (r.reason === 'auth') {
    return ['① 用户名填网盘「注册邮箱」（不是昵称）；② 密码用「应用专用密码」，坚果云在「账户信息 → 安全选项 → 添加应用」生成'];
  }
  if (r.reason === 'permission') return ['① 该目录不可读写：换成有读写权限的目录，或检查网盘里的文件夹权限设置'];
  if (r.reason === 'path') return ['① 检查服务器地址末尾（坚果云要 /dav/）；② 检查「同步目录」名字是否拼错'];
  if (r.reason === 'mixed-content') return ['① 把服务器地址改成 https://（HTTPS 页面不能访问 http 地址）'];
  if (r.reason === 'offline') return ['① 先连上网络再试'];
  if (r.reason === 'address') return ['① 服务器地址填 WebDAV 端点，例：https://dav.jianguoyun.com/dav/'];
  if (r.ok) return ['连接正常：直接点「立即同步」即可'];
  return [];
}

/** 把诊断结果拼成一段可复制的纯文本报告（**绝不含密码**；结论里直接带「怎么修」，必要时附 Worker 代码） */
export function diagnoseReport(rep, cfg = {}) {
  const lines = [];
  lines.push('Mycard 同步诊断报告');
  lines.push(`时间：${new Date().toISOString()}`);
  lines.push(`地址：${cfg.url || ''}`);
  lines.push(`目录：${cfg.dir || ''}`);
  lines.push(`用户名：${cfg.user || '(未填)'}${cfg.pass ? '（已填密码，出于安全未包含在报告中）' : '（未填密码）'}`);
  lines.push(`页面协议：${typeof location !== 'undefined' && location ? location.protocol : '(未知)'}`);
  lines.push(`浏览器：${typeof navigator !== 'undefined' && navigator ? String(navigator.userAgent || '') : '(未知)'}`);
  lines.push('');
  lines.push(`结论：${(rep && rep.verdict) || '(无)'}`);
  const steps = fixSteps(rep, cfg);
  if (steps.length) {
    lines.push('');
    lines.push('怎么修：');
    steps.forEach((s) => lines.push(`  ${s}`));
  }
  lines.push('');
  lines.push('步骤：');
  for (const s of (rep && rep.steps) || []) {
    const mark = s.status === 'ok' ? '✓' : s.status === 'warn' ? '!' : '✗';
    lines.push(`  [${mark}] ${s.label}：${s.detail}`);
  }
  lines.push('');
  lines.push('自查清单：');
  setupHints(cfg.url).forEach((h, i) => lines.push(`  ${i + 1}. ${h}`));
  if (rep && rep.reason === 'cors') {
    lines.push('');
    lines.push('附：修好它的 Worker 反代代码（整段粘到 Cloudflare Workers 新建的 Worker 里，部署即可）');
    lines.push('');
    lines.push(workerProxyCode(cfg.url));
  }
  return lines.join('\n');
}

