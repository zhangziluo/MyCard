#!/usr/bin/env python3
# ============================================================================
# dav-proxy.py — 本机「同源」WebDAV 代理 + 静态站点服务器（v0.9.6）
#
# 为什么需要它：很多网盘（坚果云等）**不给浏览器跨域许可（缺 CORS 头）**，
#   浏览器会直接拦住「网页 → 网盘」的请求（诊断里表现为「服务器可达性 ✓、基础连通性 ✗」）。
# 最省事的绕过方式：**让页面和 WebDAV 同源** —— 本脚本一边把当前目录当静态站点供出去，
#   一边把 `<本机地址>/dav/...` 转发到真正的 WebDAV 服务器（认证头原样转发）。
#
# 用法（零依赖，只用 Python 3 标准库）：
#   python3 scripts/dav-proxy.py                                       # 目标默认 https://dav.jianguoyun.com/dav
#   python3 scripts/dav-proxy.py --target https://cloud.example.com/remote.php/dav/files/me
#   python3 scripts/dav-proxy.py --target http://192.168.1.5:5005/dav   # 局域网 NAS
#
#   `--target` 就是你**原来填在 Mycard「服务器地址」里的那个地址**（含 /dav 这类路径前缀）；
#   本机同步地址固定是 `http://localhost:8080/dav`（端口可用 --port 改）。
#
# 然后把 Mycard 设置页填成：
#   服务器地址：http://localhost:8080/dav      ← 与页面同源，浏览器不再做跨域检查
#   用户名 / 密码：你的网盘账号（坚果云 = 注册邮箱 + 应用密码）
#   同步目录：mycard
#
# 安全说明：代理只把请求转发到 `--target` 指定的**一个**主机（不接受任意目标），
#   并且拒绝带 `..` 的路径；密码只在「你的浏览器 → 本机进程 → 网盘」之间流动。
# ============================================================================

import argparse
import ssl
import sys
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PROXY_PREFIX = "/dav"
DEFAULT_TARGET = "https://dav.jianguoyun.com/dav"  # = 原来填在 Mycard「服务器地址」里的那个地址

# 转发时保留的请求头（认证 + WebDAV 语义 + 内容类型）
FORWARD_HEADERS = (
    "authorization",
    "depth",
    "content-type",
    "content-length",
    "if-none-match",
    "if-match",
    "overwrite",
    "destination",
    "timeout",
    "accept",
)
# 回给浏览器时保留的响应头
KEEP_RESPONSE_HEADERS = (
    "content-type",
    "etag",
    "last-modified",
    "www-authenticate",
    "content-length",
    "dav",
    "allow",
)
CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,PUT,DELETE,PROPFIND,MKCOL,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type,Depth,If-None-Match,If-Match,Overwrite",
    "Access-Control-Expose-Headers": "ETag,Content-Length",
    "Access-Control-Max-Age": "86400",
}


def build_target_url(target: str, path: str, query: str = "") -> str:
    """把代理路径（/dav/…）映射到目标服务器（/dav/…），拒绝目录穿越"""
    clean = path[len(PROXY_PREFIX):] if path.startswith(PROXY_PREFIX) else path
    if ".." in clean.split("/"):
        raise ValueError("路径包含 .. ，已拒绝")
    url = target.rstrip("/") + clean
    if query:
        url += "?" + query
    return url


class DavProxyHandler(SimpleHTTPRequestHandler):
    target = DEFAULT_TARGET
    server_version = "MycardDavProxy/1.0"
    protocol_version = "HTTP/1.1"

    # ---- 静态站点（当前目录）＋ /dav 转发 ----

    def is_proxy_path(self) -> bool:
        return self.path == PROXY_PREFIX or self.path.startswith(PROXY_PREFIX + "/")

    def log_message(self, fmt, *args):  # 默认日志太吵，只留一行简洁输出
        sys.stderr.write("  %s %s\n" % (self.command, self.path))

    def _send(self, status=200, body=b"", headers=None):
        self.send_response(status)
        for k, v in CORS_HEADERS.items():
            self.send_header(k, v)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802（跨域预检 / 能力探测）
        self._send(status=204)

    def _proxy(self, method: str):
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else None
        try:
            url = build_target_url(self.target, self.path)
        except ValueError as e:
            self._send(status=400, body=str(e).encode("utf-8"))
            return
        req = urllib.request.Request(url, data=body, method=method)
        for h in FORWARD_HEADERS:
            val = self.headers.get(h)
            if val is not None:
                req.add_header(h, val)
        ctx = ssl.create_default_context()
        try:
            with urllib.request.urlopen(req, context=ctx, timeout=30) as resp:
                data = resp.read()
                out = {k: v for k, v in resp.headers.items() if k.lower() in KEEP_RESPONSE_HEADERS}
                self._send(status=resp.status, body=data, headers=out)
        except urllib.error.HTTPError as e:  # 4xx/5xx 也如实回给浏览器（含 401 的 WWW-Authenticate）
            data = e.read()
            out = {k: v for k, v in (e.headers or {}).items() if k.lower() in KEEP_RESPONSE_HEADERS}
            self._send(status=e.code, body=data, headers=out)
        except Exception as e:  # 连不上 / 超时 / 证书：给一句可读的原因
            msg = "代理转发失败：%s: %s" % (type(e).__name__, e)
            self._send(status=502, body=msg.encode("utf-8"))

    def do_GET(self):  # noqa: N802
        if self.is_proxy_path():
            self._proxy("GET")
            return
        super().do_GET()

    def do_HEAD(self):  # noqa: N802
        if self.is_proxy_path():
            self._proxy("HEAD")
            return
        super().do_HEAD()

    def do_PUT(self):  # noqa: N802
        self._proxy("PUT")

    def do_DELETE(self):  # noqa: N802
        self._proxy("DELETE")

    def do_PROPFIND(self):  # noqa: N802
        self._proxy("PROPFIND")

    def do_MKCOL(self):  # noqa: N802
        self._proxy("MKCOL")


def main():
    ap = argparse.ArgumentParser(description="Mycard 本机 WebDAV 代理（同源，绕过网盘的跨域限制）")
    ap.add_argument("--target", default=DEFAULT_TARGET, help="真正的 WebDAV 基地址（= 原来填在「服务器地址」里的那个），如 https://dav.jianguoyun.com/dav")
    ap.add_argument("--port", type=int, default=8080, help="本机端口（默认 8080）")
    ap.add_argument("--bind", default="127.0.0.1", help="监听地址（默认仅本机 127.0.0.1）")
    args = ap.parse_args()

    if not args.target.lower().startswith(("http://", "https://")):
        print("--target 必须是 http(s) 地址，例如 https://dav.jianguoyun.com")
        return 2

    DavProxyHandler.target = args.target.rstrip("/")
    httpd = ThreadingHTTPServer((args.bind, args.port), DavProxyHandler)
    host = "localhost" if args.bind in ("127.0.0.1", "0.0.0.0") else args.bind
    base = "http://%s:%d" % (host, args.port)
    print("Mycard 本机代理已启动", flush=True)
    print("  站点：      %s/            ← 用它打开 Mycard" % base, flush=True)
    print("  同步地址：  %s%s         ← 填进设置页「服务器地址」" % (base, PROXY_PREFIX), flush=True)
    print("  转发目标：  %s" % DavProxyHandler.target, flush=True)
    print("  停止：      Ctrl + C", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    return 0


if __name__ == "__main__":
    sys.exit(main())
