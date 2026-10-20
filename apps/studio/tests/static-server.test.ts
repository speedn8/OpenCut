import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { Writable } from "node:stream";

const require = createRequire(import.meta.url);
const { createStaticHandler, STUDIO_ORIGIN, STUDIO_PORT } = require("../electron/server.cjs");

let fixture: string;
let dist: string;
let handler: Awaited<ReturnType<typeof createStaticHandler>>;
let linkedOutside = false;
const headers = { host: `127.0.0.1:${STUDIO_PORT}` };
const request = (url: string, method = "GET", extra = {}) => ({ method, url, headers: { ...headers, ...extra } });

// Exercise the actual HTTP adapter without binding a port or running an app.
class CapturedResponse extends Writable {
  statusCode = 0;
  headers: Record<string, string> = {};
  headersSent = false;
  chunks: Buffer[] = [];
  writeHead(status: number, values: Record<string, string>) {
    this.statusCode = status;
    this.headers = values;
    this.headersSent = true;
    return this;
  }
  _write(chunk: Buffer, _encoding: string, done: (error?: Error | null) => void) {
    this.chunks.push(Buffer.from(chunk));
    done();
  }
}

async function serve(url: string, method = "GET", extra = {}) {
  const response = new CapturedResponse();
  const finished = new Promise<void>((resolve, reject) => { response.once("finish", resolve); response.once("error", reject); });
  await handler.handle(request(url, method, extra), response);
  await finished;
  return { status: response.statusCode, headers: response.headers, body: Buffer.concat(response.chunks) };
}

beforeAll(async () => {
  fixture = await mkdtemp(path.join(tmpdir(), "opencut-static-test-"));
  dist = path.join(fixture, "dist");
  await mkdir(path.join(dist, "assets"), { recursive: true });
  await writeFile(path.join(dist, "index.html"), "<!doctype html><title>Studio fixture</title>");
  await writeFile(path.join(dist, "assets", "app.js"), "export const local = true;\n");
  await writeFile(path.join(dist, "assets", "ENGINE.WASM"), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  await writeFile(path.join(dist, "assets", "style.css"), "body { color: white; }");
  await writeFile(path.join(dist, "assets", "my font.woff2"), Buffer.from([1, 2, 3]));
  await writeFile(path.join(fixture, "private.txt"), "outside-dist-secret-fixture");
  await mkdir(path.join(fixture, "outside"));
  await writeFile(path.join(fixture, "outside", "hidden.txt"), "outside-dist-secret-fixture");
  try {
    await symlink(path.join(fixture, "outside"), path.join(dist, "linked"), process.platform === "win32" ? "junction" : "dir");
    linkedOutside = true;
  } catch (error) {
    // Windows file symlinks may require a privilege; directory junctions normally
    // do not. Only an explicitly reported platform limitation permits skipping.
    if (!(error && typeof error === "object" && "code" in error && ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code)))) throw error;
  }
  handler = await createStaticHandler(dist);
});

afterAll(async () => { if (fixture) await rm(fixture, { recursive: true, force: true }); });

describe("isolated Studio static server", () => {
  test("serves built assets with MIME and exact bytes", async () => {
    const wasm = await serve("/assets/ENGINE.WASM?v=1");
    expect(wasm.status).toBe(200);
    expect(wasm.headers["Content-Type"]).toBe("application/wasm");
    expect(wasm.body).toEqual(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
    expect((await serve("/assets/app.js")).headers["Content-Type"]).toBe("text/javascript; charset=utf-8");
    expect((await serve("/assets/style.css")).headers["Content-Type"]).toBe("text/css; charset=utf-8");
    expect((await serve("/assets/my%20font.woff2")).headers["Content-Type"]).toBe("font/woff2");
  });

  test("HEAD has the GET metadata without a response body", async () => {
    const get = await serve("/assets/app.js");
    const head = await serve("/assets/app.js", "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers).toEqual(get.headers);
    expect(head.headers["Content-Length"]).toBe(String(get.body.length));
    expect(head.body.length).toBe(0);
    expect((await serve("/missing.wasm", "HEAD")).body.length).toBe(0);
  });

  test("SPA fallback serves documents but never missing assets", async () => {
    const index = await readFile(path.join(dist, "index.html"));
    expect((await serve("/")).body).toEqual(index);
    expect((await serve("/editor/project-123?tab=timeline", "GET", { accept: "text/html,application/xhtml+xml" })).body).toEqual(index);
    expect((await serve("/editor/project-123", "HEAD", { accept: "text/html" })).status).toBe(200);
    expect((await serve("/assets/missing.wasm", "GET", { accept: "text/html" })).status).toBe(404);
    expect((await serve("/missing-api", "GET", { accept: "application/json" })).status).toBe(404);
    expect((await serve("/assets/")).status).toBe(404);
  });

  test.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT"])("rejects %s before any file handling", async (method) => {
    const response = await serve("/", method);
    expect(response.status).toBe(405);
    expect(response.headers.Allow).toBe("GET, HEAD");
    expect(response.body.toString()).not.toContain("Studio fixture");
  });

  test.each(["/../private.txt", "/%2e%2e/private.txt", "/assets/%2e%2e/%2e%2e/private.txt", "/%2e%2e%2fprivate.txt", "/.env", "/assets/.. /private.txt"])("rejects traversal or hidden paths: %s", async (target) => {
    const response = await serve(target, "GET", { accept: "text/html" });
    expect(response.status).toBe(403);
    expect(response.body.toString()).not.toContain("outside-dist-secret-fixture");
  });

  test.each(["/%zz", "/%c0%afprivate.txt", "/%00", "/..%5cprivate.txt", "/C:%5cprivate.txt", "/assets/app.js:secret", "//example.com/asset", "http://example.com/asset", "/assets/app.js#fragment"])("rejects malformed or Windows-special path: %s", async (target) => {
    expect((await serve(target)).status).toBe(400);
  });

  test("encoded percent signs cannot trigger a second traversal decode", async () => {
    const response = await serve("/%252e%252e/private.txt");
    expect(response.status).toBe(404);
    expect(response.body.toString()).not.toContain("outside-dist-secret-fixture");
  });

  test("realpath containment rejects an outside directory link", async () => {
    if (!linkedOutside) { console.warn("Symlink/junction containment test unavailable: platform denied link creation."); return; }
    expect((await serve("/linked/hidden.txt")).status).toBe(403);
  });

  test("rejects foreign Host and Origin headers", async () => {
    expect((await serve("/", "GET", { host: "localhost:38841" })).status).toBe(421);
    expect((await serve("/", "GET", { host: "attacker.invalid:38841" })).status).toBe(421);
    expect((await serve("/", "GET", { origin: "https://attacker.invalid" })).status).toBe(403);
    expect((await serve("/", "GET", { origin: STUDIO_ORIGIN })).status).toBe(200);
  });

  test("success and errors retain isolation and a local-only CSP", async () => {
    for (const target of ["/", "/missing.wasm", "/%00"]) {
      const response = await serve(target);
      expect(response.headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
      expect(response.headers["Cross-Origin-Embedder-Policy"]).toBe("require-corp");
      expect(response.headers["Cross-Origin-Resource-Policy"]).toBe("same-origin");
      expect(response.headers["X-Content-Type-Options"]).toBe("nosniff");
      const csp = response.headers["Content-Security-Policy"];
      expect(csp).toContain("'wasm-unsafe-eval'");
      expect(csp).toContain("worker-src 'self' blob:");
      expect(csp).toContain("connect-src 'self' blob: data:");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain("https:");
      expect(csp).not.toContain("'unsafe-eval'");
    }
  });

  test("missing build or index fails before startup", async () => {
    await expect(createStaticHandler(path.join(fixture, "no-build"))).rejects.toThrow();
    const noIndex = path.join(fixture, "no-index");
    await mkdir(noIndex);
    await expect(createStaticHandler(noIndex)).rejects.toThrow();
  });
});
