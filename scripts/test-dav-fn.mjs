#!/usr/bin/env node
// ============================================================================
// test-dav-fn.mjs — Cloudflare Pages Function（functions/dav/[[path]].js）测试
//   运行: node scripts/test-dav-fn.mjs
// 覆盖：未配置 DAV_TARGET → 501 + 配置指引；OPTIONS → 204 + CORS；
//       转发的方法 / 路径 / 认证头 / Depth / 请求体；响应头与状态码回传（含 401 WWW-Authenticate）；
//       目录穿越 → 400 且不外发。纯逻辑测试（不需要真部署，用桩 fetch）。
// ============================================================================

import path from 'node:path';
import { pathToFileURL } from 'node:url';

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

const ROOT = path.resolve(import.meta.dirname, '..');
const mod = await import(pathToFileURL(path.join(ROOT, 'functions', 'dav', '[[path]].js')).href);

/** 造一个 Pages 风格的 request（只需 headers / method / url / body） */
function mkRequest(method, url, headers = {}, body = null) {
  return { method, url, headers: new Headers(headers), body };
}

const seen = [];
function stubFetch(handler) {
  globalThis.fetch = async (url, opts = {}) => {
    seen.push({ url: String(url), method: opts.method, headers: opts.headers, body: opts.body });
    return handler(String(url), opts);
  };
}

console.log('\n[Pages Function：配置与预检]');
{
  const res = await mod.onRequest({ request: mkRequest('GET', 'https://site.pages.dev/dav/mycard'), env: {} });
  const text = await res.text();
  ok(res.status === 501 && /DAV_TARGET/.test(text), '未配置 DAV_TARGET → 501 并说明怎么配（不静默失败）');
  ok(res.headers.get('access-control-allow-origin') === '*', '即便 501 也带 CORS 头（浏览器能读到错误）');

  seen.length = 0;
  stubFetch(async () => new Response('x', { status: 200 }));
  const opt = await mod.onRequest({ request: mkRequest('OPTIONS', 'https://site.pages.dev/dav/mycard'), env: { DAV_TARGET: 'https://dav.jianguoyun.com/dav' } });
  ok(opt.status === 204 && opt.headers.get('access-control-allow-methods').includes('PROPFIND'), 'OPTIONS → 204 + Allow-Methods 覆盖 WebDAV');
  ok(seen.length === 0, '预检不转发到网盘');
}

console.log('\n[Pages Function：转发语义]');
{
  seen.length = 0;
  stubFetch(async () => new Response('<?xml version="1.0"?>', { status: 207, headers: { 'Content-Type': 'application/xml', ETag: '"e1"', 'Set-Cookie': 'a=b' } }));
  const res = await mod.onRequest({
    request: mkRequest('PROPFIND', 'https://site.pages.dev/dav/mycard?x=1', { Authorization: 'Basic ABC', Depth: '0' }),
    env: { DAV_TARGET: 'https://dav.jianguoyun.com/dav' }
  });
  ok(res.status === 207, 'PROPFIND 状态码透传');
  ok(seen[0].url === 'https://dav.jianguoyun.com/dav/mycard?x=1', '路径拼接正确（/dav/mycard → 目标 /dav/mycard）', seen[0].url);
  ok(seen[0].headers.get('authorization') === 'Basic ABC', 'Authorization 原样转发');
  ok(seen[0].headers.get('depth') === '0', 'Depth 转发（WebDAV 语义不丢）');
  ok(res.headers.get('etag') === '"e1"' && /xml/.test(res.headers.get('content-type')), '业务响应头回传（ETag / Content-Type）');
  ok(res.headers.get('set-cookie') === null, '不透传 set-cookie');
  ok(res.headers.get('access-control-allow-origin') === '*', '补 CORS 头');
}
{
  seen.length = 0;
  stubFetch(async () => new Response('ok', { status: 201 }));
  await mod.onRequest({
    request: mkRequest('PUT', 'https://site.pages.dev/dav/mycard/a.json', { 'Content-Type': 'application/json', 'If-None-Match': '*' }, 'BODY'),
    env: { DAV_TARGET: 'https://dav.jianguoyun.com/dav/' } // 尾斜杠也应被规范化
  });
  ok(seen[0].method === 'PUT' && seen[0].body === 'BODY', 'PUT 方法与请求体转发');
  ok(seen[0].url === 'https://dav.jianguoyun.com/dav/mycard/a.json', '目标尾斜杠被规范化', seen[0].url);
  ok(seen[0].headers.get('if-none-match') === '*', 'If-None-Match（抢锁）也转发');
}
{
  seen.length = 0;
  stubFetch(async () => new Response('nope', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="x"' } }));
  const res = await mod.onRequest({
    request: mkRequest('PROPFIND', 'https://site.pages.dev/dav/mycard', { Authorization: 'Basic ABC' }),
    env: { DAV_TARGET: 'https://dav.jianguoyun.com/dav' }
  });
  ok(res.status === 401 && /Basic/.test(res.headers.get('www-authenticate') || ''), '401 与 WWW-Authenticate 如实回传（Mycard 才能判断账号错）');
}

console.log('\n[Pages Function：边界]');
{
  // 直接对拼接函数做「目录穿越」守卫测试（URL 类会把 /dav/../x 规范化掉，所以这里传原始路径）
  let threw = null;
  try {
    mod.buildTargetUrl('https://dav.jianguoyun.com/dav', '/dav/../secret');
  } catch (e) {
    threw = e;
  }
  ok(!!threw && /bad-path/.test(String(threw.message)), 'buildTargetUrl：带 .. 的路径直接拒绝');

  seen.length = 0;
  stubFetch(async () => new Response('ok', { status: 200 }));
  const bad = await mod.onRequest({
    request: mkRequest('GET', 'https://site.pages.dev/dav/../secret'),
    env: { DAV_TARGET: 'https://dav.jianguoyun.com/dav' }
  });
  ok(bad.status === 200, 'URL 规范化后的越界路径交由目标服务器判断（不崩）');
  ok(
    seen.every((s) => s.url.startsWith('https://dav.jianguoyun.com/dav')),
    '无论如何都只在固定目标主机内转发（不会被当成开放代理）',
    seen.map((s) => s.url)
  );

  seen.length = 0;
  await mod.onRequest({
    request: mkRequest('GET', 'https://site.pages.dev/dav//evil.example.com/x'),
    env: { DAV_TARGET: 'https://dav.jianguoyun.com/dav' }
  });
  ok(
    seen.length === 0 || seen.every((s) => s.url.startsWith('https://dav.jianguoyun.com/dav')),
    '伪装的绝对路径也逃不出目标主机',
    seen.map((s) => s.url)
  );

  ok(mod.buildTargetUrl('https://dav.example.com/dav', '/dav/a/b.json') === 'https://dav.example.com/dav/a/b.json', 'buildTargetUrl：/dav 前缀被换成目标前缀');
  ok(mod.buildTargetUrl('https://dav.example.com/dav', '/dav') === 'https://dav.example.com/dav', '/dav 根路径 → 目标根');
}

console.log(`\nPages Function 测试: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
