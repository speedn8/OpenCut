"use strict";

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const STUDIO_HOST = "127.0.0.1";
const STUDIO_PORT = 38841;
const STUDIO_ORIGIN = `http://${STUDIO_HOST}:${STUDIO_PORT}`;
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' blob: data:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob: data:",
  "font-src 'self' data:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join("; ");

const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Origin-Agent-Cluster": "?1",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=(), hid=()",
});

const MIME_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".pdf": "application/pdf",
});

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function textResponse(status, message, additionalHeaders = {}) {
  const body = Buffer.from(`${message}\n`, "utf8");
  return {
    status,
    headers: { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8", "Content-Length": String(body.length), ...additionalHeaders },
    body,
  };
}

function decodeRequestPath(target) {
  // Inspect the original path before URL normalization can erase traversal.
  if (typeof target !== "string" || target.length > 8192 || !target.startsWith("/") || target.startsWith("//") || target.includes("#")) {
    return { error: textResponse(400, "Invalid request path") };
  }
  let decoded;
  try {
    decoded = decodeURIComponent(target.split("?", 1)[0]);
  } catch {
    return { error: textResponse(400, "Invalid URL encoding") };
  }
  // Backslashes, ADS/drive syntax and Windows special filenames never name assets.
  if (/[\\\x00-\x1f\x7f<>:"|?*]/u.test(decoded)) {
    return { error: textResponse(400, "Invalid request path") };
  }
  const segments = decoded.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === ".." || segment.startsWith(".") || /[. ]$/u.test(segment))) {
    return { error: textResponse(403, "Path is not available") };
  }
  return { decoded, segments };
}

/** Pure request resolution plus a Node response adapter; construction never listens. */
async function createStaticHandler(distDirectory) {
  const root = await fsp.realpath(distDirectory);
  if (!(await fsp.stat(root)).isDirectory()) throw new Error("Studio dist must be a directory. Run the Studio build first.");
  const indexPath = await fsp.realpath(path.join(root, "index.html"));
  if (!isWithin(root, indexPath) || !(await fsp.stat(indexPath)).isFile()) {
    throw new Error("Studio dist/index.html must be a file inside the build directory.");
  }

  async function fileResponse(filePath) {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return textResponse(404, "Not found");
    return {
      status: 200,
      headers: { ...SECURITY_HEADERS, "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream", "Content-Length": String(stat.size) },
      filePath,
    };
  }

  async function resolve(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return textResponse(405, "Only GET and HEAD are supported", { Allow: "GET, HEAD" });
    }
    if (request.headers?.host !== `${STUDIO_HOST}:${STUDIO_PORT}`) return textResponse(421, "Unexpected host");
    const requestedOrigin = request.headers?.origin;
    if (requestedOrigin !== undefined && requestedOrigin !== STUDIO_ORIGIN) return textResponse(403, "Cross-origin requests are not supported");
    const parsed = decodeRequestPath(request.url);
    if (parsed.error) return parsed.error;
    const candidate = path.resolve(root, ...parsed.segments);
    if (!isWithin(root, candidate)) return textResponse(403, "Path is not available");
    try {
      const real = await fsp.realpath(candidate);
      if (!isWithin(root, real)) return textResponse(403, "Path is not available");
      if (real === root) return fileResponse(indexPath);
      return fileResponse(real);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      // SPA documents only. A missing JS/WASM/image must remain a real 404.
      const acceptsHtml = typeof request.headers?.accept === "string" && request.headers.accept.split(",").some((entry) => entry.trim().split(";", 1)[0] === "text/html");
      if (acceptsHtml && path.posix.extname(parsed.decoded) === "") return fileResponse(indexPath);
      return textResponse(404, "Not found");
    }
  }

  async function handle(request, response) {
    try {
      const resolved = await resolve(request);
      if (response.destroyed) return;
      response.writeHead(resolved.status, resolved.headers);
      if (request.method === "HEAD") { response.end(); return; }
      if (resolved.body) { response.end(resolved.body); return; }
      const stream = fs.createReadStream(resolved.filePath);
      stream.once("error", (error) => response.destroy(error));
      response.once("close", () => stream.destroy());
      stream.pipe(response);
    } catch {
      if (response.destroyed) return;
      if (response.headersSent) { response.destroy(); return; }
      const failed = textResponse(500, "Could not read the local application build");
      response.writeHead(failed.status, failed.headers);
      response.end(request.method === "HEAD" ? undefined : failed.body);
    }
  }
  return { resolve, handle };
}

/** Claim the fixed origin exclusively. Never probe or adopt an existing listener. */
async function startStaticServer(distDirectory) {
  const handler = await createStaticHandler(distDirectory);
  const server = http.createServer(handler.handle);
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;
  server.maxRequestsPerSocket = 100;
  await new Promise((resolve, reject) => {
    const onError = (cause) => {
      server.removeListener("listening", onListening);
      const message = cause.code === "EADDRINUSE"
        ? `OpenCut Studio could not claim ${STUDIO_ORIGIN}. Port ${STUDIO_PORT} is occupied. Close the other instance or application and try again. No existing server was opened.`
        : `OpenCut Studio could not start its local server: ${cause.message}`;
      const error = new Error(message, { cause });
      error.code = cause.code;
      reject(error);
    };
    const onListening = () => { server.removeListener("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: STUDIO_HOST, port: STUDIO_PORT, exclusive: true });
  });
  let closing;
  return {
    origin: STUDIO_ORIGIN,
    server,
    close() {
      if (closing) return closing;
      closing = new Promise((resolve, reject) => {
        if (!server.listening) { resolve(); return; }
        const force = setTimeout(() => server.closeAllConnections(), 2000);
        force.unref();
        server.close((error) => { clearTimeout(force); error ? reject(error) : resolve(); });
        server.closeIdleConnections();
      });
      return closing;
    },
  };
}

module.exports = { STUDIO_HOST, STUDIO_PORT, STUDIO_ORIGIN, CONTENT_SECURITY_POLICY, SECURITY_HEADERS, createStaticHandler, startStaticServer };
