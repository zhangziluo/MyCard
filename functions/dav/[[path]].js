// ============================================================================
// functions/dav/[[path]].js — Cloudflare Pages Function：把 /dav/* 反代到你的 WebDAV
//
// 为什么需要它：很多网盘（坚果云等）不给浏览器跨域许可（缺 CORS 头），
//   浏览器会直接拦住「网页 → 网盘」。而 **Pages 上的这个函数与页面同源** ——
//   同源请求根本不做跨域检查，于是网盘给不给 CORS 头都无所谓。
//
// 用法（Mycard 部署在 Cloudflare Pages 上时，零第三方服务）：
//   1) 把这个文件一起部署（放在仓库根的 functions/dav/[[path]].js，Pages 会自动识别）
//   2) Pages → 项目 → Settings → Environment variables 加一个变量：
//        DAV_TARGET = https://dav.jianguoyun.com/dav      ← 就是你原来填在「服务器地址」里的地址
//   3) 重新部署后，Mycard 设置页「服务器地址」填：https://<你的站点域名>/dav
//      用户名 / 应用密码 / 同步目录照旧即可
//
// 安全：只转发到 DAV_TARGET 这一个主机；拒绝带 .. 的路径；Authorization 头原样转发
//   （密码只在「浏览器 → 你自己的 Pages 函数 → 网盘」之间，不经第三方）。
// 未配置 DAV_TARGET 时返回 501 并说明怎么配（不会静默失败）。
// ============================================================================

const FORWARD_HEADERS = [
  'authorization',
  'depth',
  'content-type',
  'content-length',
  'if-none-match',
  'if-match',
  'overwrite',
  'destination',
  'timeout',
  'accept'
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,PUT,DELETE,PROPFIND,MKCOL,OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type,Depth,If-None-Match,If-Match,Overwrite',
  'Access-Control-Expose-Headers': 'ETag,Content-Length',
  'Access-Control-Max-Age': '86400'
};

const withCors = (headers = {}) => ({ ...CORS, ...headers });

/** 拼转发地址：/dav/xxx → <target>/xxx（拒绝目录穿越） */
export function buildTargetUrl(target, pathname, search = '') {
  const sub = String(pathname || '').replace(/^\/dav/, '');
  if (sub.split('/').includes('..')) throw new Error('bad-path');
  return String(target).replace(/\/+$/, '') + sub + (search || '');
}

export async function onRequest(context) {
  const { request, env } = context || {};
  const target = String((env && env.DAV_TARGET) || '').replace(/\/+$/, '');
  if (!target) {
    return new Response('未配置 DAV_TARGET：Pages → 项目 → Settings → Environment variables 里加一个 DAV_TARGET = https://dav.jianguoyun.com/dav，然后重新部署', {
      status: 501,
      headers: withCors({ 'Content-Type': 'text/plain; charset=utf-8' })
    });
  }
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: withCors() });

  const url = new URL(request.url);
  let dest = '';
  try {
    dest = buildTargetUrl(target, url.pathname, url.search);
  } catch (e) {
    return new Response('路径不合法', { status: 400, headers: withCors({ 'Content-Type': 'text/plain; charset=utf-8' }) });
  }

  const headers = new Headers();
  for (const key of FORWARD_HEADERS) {
    const val = request.headers.get(key);
    if (val !== null) headers.set(key, val);
  }
  const method = request.method;
  const res = await fetch(dest, {
    method,
    headers,
    body: ['GET', 'HEAD'].includes(method) ? undefined : request.body
  });
  const out = new Headers();
  for (const [k, v] of res.headers) {
    if (/^(content-type|etag|last-modified|www-authenticate|content-length|dav|allow)$/i.test(k)) out.set(k, v);
  }
  for (const [k, v] of Object.entries(CORS)) out.set(k, v);
  out.delete('set-cookie');
  return new Response(res.body, { status: res.status, headers: out });
}
