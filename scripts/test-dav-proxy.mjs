#!/usr/bin/env node
// ============================================================================
// test-dav-proxy.mjs — 本机 WebDAV 代理（scripts/dav-proxy.py）功能测试
//   运行: node scripts/test-dav-proxy.mjs
// 覆盖：静态站点照常供出、/dav 转发（方法 / 路径 / 认证头 / Depth / 请求体）、
//       状态码与响应头回传（含 401 的 WWW-Authenticate）、OPTIONS 预检、目录穿越被拒、
//       目标不可达 → 502 且带可读原因。需要本机有 python3（没有则跳过并视为通过）。
// ============================================================================

import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

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
const PROXY = path.join(ROOT, 'scripts', 'dav-proxy.py');

/* ------------------------------ 假 WebDAV 服务端 ------------------------------ */
const seen = [];
let stubStatus = 207;
const stubFiles = new Map();

const stub = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (req.method === 'PUT') stubFiles.set(req.url, body);
    if (req.method === 'DELETE') stubFiles.delete(req.url);
    const status = req.url.includes('unauthorized') ? 401 : stubStatus;
    const headers = { 'Content-Type': 'application/xml; charset=utf-8', ETag: '"abc"' };
    if (status === 401) headers['WWW-Authenticate'] = 'Basic realm="stub"';
    res.writeHead(status, headers);
    res.end(req.method === 'GET' ? stubFiles.get(req.url) || 'stub-body' : 'ok');
  });
});

const startStub = () => new Promise((resolve) => stub.listen(0, '127.0.0.1', () => resolve(stub.address().port)));

/* ------------------------------ 启动被测代理 ------------------------------ */
function startProxy(target, port) {
  const proc = spawn('python3', [PROXY, '--target', target, '--port', String(port)], { cwd: ROOT });
  let out = '';
  proc.stdout.on('data', (d) => {
    out += String(d);
  });
  proc.stderr.on('data', (d) => {
    out += String(d);
  });
  proc.ready = new Promise((resolve) => {
    const t = setInterval(() => {
      if (/同步地址/.test(out)) {
        clearInterval(t);
        resolve(true);
      }
    }, 50);
    setTimeout(() => {
      clearInterval(t);
      resolve(false);
    }, 6000);
  });
  proc.logs = () => out;
  return proc;
}

async function waitPort(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/manifest.json`);
      return true;
    } catch (e) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return false;
}

const hasPython = await new Promise((resolve) => {
  const p = spawn('python3', ['--version']);
  p.on('error', () => resolve(false));
  p.on('close', (code) => resolve(code === 0));
});
if (!existsSync(PROXY)) {
  console.error('找不到 scripts/dav-proxy.py');
  process.exit(1);
}
if (!hasPython) {
  console.log('未检测到 python3 —— 跳过本机代理测试（视为通过）');
  process.exit(0);
}

console.log('\n[本机代理：静态站点 + /dav 转发]');
const stubPort = await startStub();
const proxyPort = stubPort + 1;
const proxy = startProxy(`http://127.0.0.1:${stubPort}/dav`, proxyPort);
const ready = await proxy.ready;
ok(ready && (await waitPort(proxyPort)), '代理启动并监听');
ok(/同步地址/.test(proxy.logs()), '启动信息里给出「填进设置页的服务器地址」');

const base = `http://127.0.0.1:${proxyPort}`;
const auth = 'Basic ' + Buffer.from('me@example.com:app-pw').toString('base64');

console.log('\n[静态站点照常供出（页面与 /dav 同源）]');
{
  const res = await fetch(`${base}/manifest.json`);
  const text = await res.text();
  ok(res.status === 200 && text.includes('"name": "Mycard'), '静态文件仍由本机服务器提供（200 + manifest 内容）', { status: res.status, head: text.slice(0, 60) });
  ok(!seen.some((s) => s.method === 'GET' && s.url === '/manifest.json'), '静态请求不会被转发到网盘');
}

console.log('\n[/dav 转发：方法 / 路径 / 认证头 / Depth / 请求体]');
{
  seen.length = 0;
  stubStatus = 207;
  const res = await fetch(`${base}/dav/mycard`, { method: 'PROPFIND', headers: { Authorization: auth, Depth: '0' } });
  ok(res.status === 207, 'PROPFIND 透传状态码 207');
  const hit = seen.find((s) => s.method === 'PROPFIND');
  ok(!!hit && hit.url === '/dav/mycard', '路径原样拼接（/dav/mycard）', hit && hit.url);
  ok(hit && hit.headers.authorization === auth, 'Authorization 头原样转发');
  ok(hit && hit.headers.depth === '0', 'Depth 头转发（WebDAV 语义不丢）');
  ok(res.headers.get('access-control-allow-origin') === '*', '响应带 CORS 头（即使换源打开页面也能用）');
}
{
  seen.length = 0;
  const res = await fetch(`${base}/dav/mycard/mycard-sync.json`, {
    method: 'PUT',
    headers: { Authorization: auth, 'Content-Type': 'application/json', 'If-None-Match': '*' },
    body: '{"hello":1}'
  });
  ok(res.status === 207, 'PUT 状态码透传');
  const hit = seen.find((s) => s.method === 'PUT');
  ok(hit && hit.body === '{"hello":1}', '请求体原样转发');
  ok(hit && hit.headers['if-none-match'] === '*', 'If-None-Match（抢锁用）也转发');
  const back = await (await fetch(`${base}/dav/mycard/mycard-sync.json`, { headers: { Authorization: auth } })).text();
  ok(back === '{"hello":1}', '写进去的内容能读回来');
}
{
  seen.length = 0;
  await fetch(`${base}/dav/mycard/old.json`, { method: 'DELETE', headers: { Authorization: auth } });
  ok(seen.some((s) => s.method === 'DELETE'), 'DELETE 也走代理');
  stubStatus = 201;
  await fetch(`${base}/dav/mycard/a/b`, { method: 'MKCOL', headers: { Authorization: auth } });
  ok(seen.some((s) => s.method === 'MKCOL'), 'MKCOL 也走代理（递归建目录可用）');
  stubStatus = 207;
}

console.log('\n[错误与边界]');
{
  seen.length = 0;
  const opt = await fetch(`${base}/dav/mycard`, { method: 'OPTIONS' });
  ok(opt.status === 204 && (opt.headers.get('access-control-allow-methods') || '').includes('PROPFIND'), 'OPTIONS 由代理直接 204 响应（预检不打扰网盘）');
  ok(!seen.some((s) => s.method === 'OPTIONS'), '预检不会被转发到网盘');

  const bad = await fetch(`${base}/dav/../secret`);
  ok(bad.status === 400 || bad.status === 404, '带 .. 的路径被拒绝（不做目录穿越）', bad.status);
  ok(!seen.some((s) => /secret/.test(s.url)), '穿越请求没有被转发出去');

  const unauth = await fetch(`${base}/dav/unauthorized`, { headers: { Authorization: auth } });
  ok(unauth.status === 401 && /Basic/.test(unauth.headers.get('www-authenticate') || ''), '401 与 WWW-Authenticate 如实回传（Mycard 才能判断账号错）');
}

console.log('\n[目标不可达时给出可读原因]');
{
  const dead = startProxy('http://127.0.0.1:9', proxyPort + 1);
  await dead.ready;
  await waitPort(proxyPort + 1, 10);
  const res = await fetch(`http://127.0.0.1:${proxyPort + 1}/dav/mycard`);
  const text = await res.text();
  ok(res.status === 502 && /代理转发失败/.test(text), '网盘不可达 → 502 + 可读原因', { status: res.status, text: text.slice(0, 60) });
  dead.kill('SIGTERM');
}

proxy.kill('SIGTERM');
stub.close();
await new Promise((r) => setTimeout(r, 150));

console.log(`\n本机代理测试: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
