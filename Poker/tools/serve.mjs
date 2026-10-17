// 零依赖本地静态服务器：node tools/serve.mjs
// 必须通过 http:// 打开，否则浏览器会拦截 ES Module 与 WebCrypto。

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.argv[2] || process.env.PORT || 8080);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".otf": "font/otf",
  ".ttf": "font/ttf"
};

const rootPath = root.endsWith(sep) ? root : root + sep;

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const relative = pathname.replace(/^[/\\]+/, "");
    // URL 解析已经处理过 .. 段，这里再挡一次编码后的越权路径
    if (relative.includes("..")) {
      response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("403 Forbidden");
      return;
    }
    const candidate = join(root, relative || "index.html");
    if (!candidate.startsWith(rootPath)) {
      response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("403 Forbidden");
      return;
    }
    const info = await stat(candidate).catch(() => null);
    const file = info?.isDirectory() ? join(candidate, "index.html") : candidate;
    const body = await readFile(file);
    response.writeHead(200, {
      "Content-Type": TYPES[extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("404 Not Found");
  }
});

server.listen(port, () => {
  console.log(`RiverGuard 本地预览已启动：http://localhost:${port}`);
  console.log("请用浏览器打开上面的 http:// 地址（不要双击 index.html）。按 Ctrl+C 停止。");
});
