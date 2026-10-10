// ============================================================================
// webdav.js — 极简 WebDAV 客户端（v0.8.0，零依赖，只用 fetch）
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
//     坚果云的 `dav.jianguoyun.com/dav` 等都支持）；被拦时 fetch 直接抛错，
//     `explainError()` 会给出「多为跨域限制」的可读提示。
// ============================================================================

/** 缺省超时（ms） */
export const DEFAULT_TIMEOUT = 20000;

export class WebdavError extends Error {
  constructor(message, { status = 0, url = '', cause = null } = {}) {
    super(message);
    this.name = 'WebdavError';
    this.status = status;
    this.url = url;
    this.cause = cause;
  }
}

/** 认证 / 权限 / 网络问题的可读提示 */
export function explainError(err) {
  const status = Number(err && err.status) || 0;
  if (status === 401) return '认证失败：用户名 / 密码（或应用专用密码）不正确';
  if (status === 403) return '没有权限：请检查该目录的读写权限';
  if (status === 404) return '路径不存在：请检查服务器地址与目录名';
  if (status === 405) return '服务器不允许该操作：确认地址指向支持 WebDAV 的目录';
  if (status === 409) return '父目录不存在或目录冲突：请检查目录路径';
  if (status === 412) return '资源已被其他设备修改：请稍后重试';
  if (status === 423) return '资源被锁定：可能另一台设备正在同步，请稍后再试';
  if (status === 507) return '服务器空间不足：清理网盘后重试';
  if (status >= 500) return `服务器错误（${status}）：请稍后重试`;
  if (status) return `请求失败（HTTP ${status}）`;
  const raw = String((err && err.message) || err || '');
  if (/Failed to fetch|NetworkError|Load failed|fetch failed/i.test(raw)) {
    return '网络失败 / 跨域被拦：请确认地址可访问，并允许浏览器跨域（多数网盘需在 WebDAV 地址上支持 CORS）';
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

/** 统一请求：注入认证 / 超时，网络异常 → WebdavError */
async function request(method, url, { headers = {}, body = null, timeout = DEFAULT_TIMEOUT, auth = null } = {}) {
  const doFetch = fetchImpl();
  if (!doFetch) throw new WebdavError('当前环境不支持 fetch，无法访问 WebDAV', { url });
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
    throw new WebdavError(aborted ? `请求超时（${Math.round(timeout / 1000)} 秒）` : 'request failed', {
      url,
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

