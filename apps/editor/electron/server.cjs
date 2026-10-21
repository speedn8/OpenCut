"use strict";
const http = require("node:http");
const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const path = require("node:path");
const ORIGIN = "http://127.0.0.1:38851";
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' app-media: blob:; img-src 'self' app-media: blob: data:; media-src 'self' app-media: blob:; font-src 'self' data:; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const HEADERS = { "Content-Security-Policy": CSP, "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cross-Origin-Resource-Policy": "same-origin", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" };
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".ico": "image/x-icon" };
const contains = (root, value) => { const relative = path.relative(root, value); return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)); };
async function createStaticHandler(directory) {
  const root = await fs.realpath(directory);
  const index = await fs.realpath(path.join(root, "index.html"));
  if (!contains(root, index) || !(await fs.stat(index)).isFile()) throw new Error("Build index must be inside dist.");
  return async (request, response) => {
    const send = (status, message, extra = {}) => { const body = Buffer.from(message); response.writeHead(status, { ...HEADERS, "Content-Type": "text/plain", "Content-Length": body.length, ...extra }); response.end(request.method === "HEAD" ? undefined : body); };
    try {
      if (!["GET", "HEAD"].includes(request.method)) { send(405, "Only GET and HEAD", { Allow: "GET, HEAD" }); return; }
      if (request.headers.host !== "127.0.0.1:38851") { send(421, "Unexpected host"); return; }
      if (request.headers.origin && request.headers.origin !== ORIGIN) { send(403, "Foreign origin"); return; }
      let decoded;
      try { if (!request.url?.startsWith("/") || request.url.startsWith("//") || request.url.length > 8192) throw new Error(); decoded = decodeURIComponent(request.url.split("?")[0]); }
      catch { send(400, "Invalid path encoding"); return; }
      const segments = decoded.split("/").filter(Boolean);
      if (/[\\\x00-\x1f<>:"|?#*]/u.test(decoded) || segments.some((item) => item.startsWith(".") || /[. ]$/u.test(item))) { send(403, "Invalid asset path"); return; }
      let file;
      try { file = await fs.realpath(path.join(root, ...segments)); if (file === root) file = index; }
      catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; if (!path.extname(decoded) && request.headers.accept?.includes("text/html")) file = index; else { send(404, "Not found"); return; } }
      if (!contains(root, file)) { send(403, "Asset outside build"); return; }
      const info = await fs.stat(file); if (!info.isFile()) { send(404, "Not found"); return; }
      response.writeHead(200, { ...HEADERS, "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "Content-Length": info.size });
      if (request.method === "HEAD") { response.end(); return; }
      const stream = createReadStream(file); stream.on("error", () => response.destroy()); response.once("close", () => stream.destroy()); stream.pipe(response);
    } catch { if (response.headersSent) response.destroy(); else send(500, "Local build could not be read"); }
  };
}
async function startServer(directory) {
  const handle = await createStaticHandler(directory);
  const server = http.createServer(handle);
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 1000;
  await new Promise((resolve, reject) => { server.once("error", (error) => reject(new Error(error.code === "EADDRINUSE" ? "Port 38851 is occupied. OpenCut Next will not connect to an existing server." : error.message))); server.listen({ port: 38851, host: "127.0.0.1", exclusive: true }, resolve); });
  let closing;
  return { server, close: () => closing ||= new Promise((resolve) => { const timer = setTimeout(() => server.closeAllConnections(), 1500); timer.unref(); server.close(() => { clearTimeout(timer); resolve(); }); server.closeIdleConnections(); }) };
}
module.exports = { ORIGIN, CSP, HEADERS, createStaticHandler, startServer };
