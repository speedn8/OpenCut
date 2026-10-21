"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { Writable } = require("node:stream");
const vm = require("node:vm");
const core = require("../core.cjs");
const { ProjectDatabase } = require("../persistence.cjs");
const { MediaRegistry, parseRange, mediaUrl } = require("../media.cjs");
const { JobQueue } = require("../jobs.cjs");
const { runProcess, filterPath, discoverExecutable, parseFilters } = require("../ffmpeg.cjs");
const { compileRenderPlan, tempoFilters, colorFilters, keyframeExpression } = require("../render.cjs");
const { assertSafeExportTarget } = require("../host.cjs");
const { createStaticHandler, ORIGIN } = require("../server.cjs");
async function fixture(t) { const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencut-next-native-")); t.after(async () => { const resolved = path.resolve(directory); assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); await fs.rm(resolved, { recursive: true, force: true }); }); return directory; }
function terminal(queue, id) { return new Promise((resolve) => { const listener = (job) => { if (job.id === id && ["completed", "failed", "cancelled"].includes(job.status)) { queue.off("job", listener); resolve(job); } }; queue.on("job", listener); }); }

test("SQLite CAS is transactional, journals each acknowledgement and survives reopening", async (t) => {
  const directory = await fixture(t), a = new ProjectDatabase(directory, core), b = new ProjectDatabase(directory, core);
  const project = core.createProject({ name: "Original" });
  assert.deepEqual(a.save({ project, expectedVersion: null }), { version: 1 });
  const stale = b.open(project.id);
  const updated = core.applyCommand(project, { type: "project.rename", name: "Saved version" });
  assert.deepEqual(a.save({ project: updated, expectedVersion: 1 }), { version: 2 });
  assert.throws(() => b.save({ project: { ...stale.project, name: "Stale overwrite" }, expectedVersion: 1 }), /changed in storage/u);
  assert.equal(a.open(project.id).project.name, "Saved version");
  assert.equal(a.db.prepare("SELECT count(*) AS count FROM revisions WHERE project_id=?").get(project.id).count, 2);
  assert.equal(a.list()[0].version, 2);
  assert.throws(() => a.save({ project: updated, expectedVersion: null }), /changed in storage/u);
  assert.throws(() => a.save({ project: { ...updated, unexpected: true }, expectedVersion: 2 }), /unsupported fields/u);
  a.close(); b.close();
  const reopened = new ProjectDatabase(directory, core); assert.equal(reopened.open(project.id).version, 2); assert.equal(reopened.open(project.id).project.revision, updated.revision); reopened.close();
});

test("opaque media protocol provides exact range bytes, CORS, HEAD and changed-source rejection", async (t) => {
  const directory = await fixture(t), file = path.join(directory, "chosen.mp4"); await fs.writeFile(file, Buffer.from(Array.from({ length: 100 }, (_, index) => index)));
  const info = await fs.stat(file), id = "selected-media", asset = { id, name: "chosen.mp4", kind: "video", duration: 240000, hasAudio: false, url: mediaUrl(id) };
  const record = { id, source: file, size: info.size, mtimeMs: info.mtimeMs, asset };
  const registry = new MediaRegistry({ getMedia(value) { if (value !== id) throw new Error("unknown"); return record; } }, directory, {});
  const response = await registry.response(new Request(mediaUrl(id), { headers: { Range: "bytes=10-19", Origin: ORIGIN } }));
  assert.equal(response.status, 206); assert.equal(response.headers.get("content-range"), "bytes 10-19/100"); assert.equal(response.headers.get("access-control-allow-origin"), ORIGIN);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([10,11,12,13,14,15,16,17,18,19]));
  const head = await registry.response(new Request(mediaUrl(id), { method: "HEAD", headers: { Range: "bytes=-7" } })); assert.equal(head.status, 206); assert.equal(head.headers.get("content-length"), "7"); assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await registry.response(new Request(mediaUrl(id), { headers: { Range: "bytes=100-" } }))).status, 416);
  assert.equal((await registry.response(new Request(mediaUrl(id), { headers: { Origin: "https://foreign.invalid" } }))).status, 403);
  assert.equal((await registry.response(new Request("app-media://media/C:/private"))).status, 400);
  assert.equal((await registry.response(new Request(mediaUrl(id), { method: "POST" }))).status, 405);
  await fs.appendFile(file, "changed"); assert.equal((await registry.response(new Request(mediaUrl(id)))).status, 404);
});

test("range parser rejects multipart, negative/unsafe and empty ranges", () => {
  assert.deepEqual(parseRange("bytes=90-1000", 100), { start: 90, end: 99, partial: true });
  for (const value of ["bytes=0-1,3-4", "bytes=-0", "bytes=-", "bytes=9007199254740992-", "items=1-2", "bytes=4-2"]) assert.equal(parseRange(value, 100), null);
});

test("native queue serializes work and emits exactly one terminal state on cancellation", async () => {
  const queue = new JobQueue(), events = []; queue.on("job", (job) => events.push(job)); let active = 0, maximum = 0, secondRan = false;
  const first = queue.enqueue("proxy", async ({ signal }) => { maximum = Math.max(maximum, ++active); await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); active--; });
  const second = queue.enqueue("silence", async () => { secondRan = true; return { result: [] }; });
  const firstDone = terminal(queue, first.id), secondDone = terminal(queue, second.id);
  await new Promise((resolve) => setImmediate(resolve)); queue.cancel(second.id); queue.cancel(first.id);
  assert.equal((await firstDone).status, "cancelled"); assert.equal((await secondDone).status, "cancelled");
  assert.equal(secondRan, false); assert.equal(maximum, 1);
  for (const id of [first.id, second.id]) assert.equal(events.filter((job) => job.id === id && ["completed", "failed", "cancelled"].includes(job.status)).length, 1);
  const last = queue.enqueue("silence", async () => ({ result: [1,2] })); assert.equal((await terminal(queue, last.id)).status, "completed"); await queue.close();
});

test("native child cancellation waits for process termination without a shell", async () => {
  const controller = new AbortController();
  const task = runProcess(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { signal: controller.signal, timeoutMs: 5000 });
  setTimeout(() => controller.abort(), 50); await assert.rejects(task, /Cancelled/u);
});

test("render plan rejects unsupported animation and uses RGB multipliers with sample-accurate audio delay", async (t) => {
  const directory = await fixture(t), project = core.createProject({ width: 320, height: 180 });
  const asset = { id: "source", name: "Source", kind: "video", duration: 2400000, hasAudio: true, width: 320, height: 180, url: mediaUrl("source") };
  project.assets.source = asset;
  const clip = core.createClip({ asset, duration: 240000, start: 120000 }); clip.color.brightness = .6; clip.color.contrast = 1.1; clip.color.saturation = .5; clip.fadeIn = 12000; clip.fadeOut = 12000;
  project.tracks[0].clips.push(clip);
  const registry = { async record() { return { source: path.join(directory, "source name.mp4"), asset }; } };
  const result = await compileRenderPlan(core.buildRenderPlan(project), registry, { directory });
  assert.ok(result.graph.includes("colorchannelmixer=rr=0.6:gg=0.6:bb=0.6")); assert.ok(!result.graph.includes("eq=brightness")); assert.ok(result.graph.includes("adelay=24000S:all=1")); assert.ok(result.graph.includes("normalize=0"));
  clip.keyframes.push({ id: "key", time: 0, property: "scale", value: 9, easing: "linear" });
  await assert.rejects(compileRenderPlan(core.buildRenderPlan(project), registry, { directory }), /Unsupported animated scale/u);
  assert.deepEqual(tempoFilters(.25), ["atempo=0.5", "atempo=0.5"]); assert.deepEqual(colorFilters({ brightness: 1, contrast: 1, saturation: 1 }), []);
  assert.ok(filterPath("C:\\models\\tiny.en.bin").includes("C\\:/models/"));
});

test("generated animation expressions preserve shared core hold/smooth interpolation outside clip context", () => {
  const clip = core.createTextClip();
  clip.keyframes = [{ id: "prior", time: -120000, property: "opacity", value: .1, easing: "smooth" }, { id: "middle", time: 120000, property: "opacity", value: .8, easing: "hold" }, { id: "after", time: 480000, property: "opacity", value: .3, easing: "linear" }];
  const expression = keyframeExpression(clip, "opacity", "t").replaceAll("if(", "choose(");
  for (const ticks of [-240000, 0, 60000, 120000, 240000, 480000, 720000]) {
    const value = vm.runInNewContext(expression, { t: ticks / 240000, choose: (condition, yes, no) => condition ? yes : no, lt: (a, b) => Number(a < b) });
    assert.ok(Math.abs(value - core.evaluateKeyframeProperty(clip, "opacity", ticks)) < 1e-8);
  }
});

test("export protection covers unused originals, junction aliases and hardlinks", async (t) => {
  const directory = await fixture(t), originals = path.join(directory, "originals"); await fs.mkdir(originals);
  const source = path.join(originals, "unused.mp4"); await fs.writeFile(source, "original-test-content");
  const records = [{ source }];
  await assert.rejects(assertSafeExportTarget(source, records), /registered original media/u);
  const linked = path.join(directory, "hardlinked.mp4"); await fs.link(source, linked);
  await assert.rejects(assertSafeExportTarget(linked, records), /registered original media/u);
  const alias = path.join(directory, "alias"); await fs.symlink(originals, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(assertSafeExportTarget(path.join(alias, "unused.mp4"), records), /registered original media/u);
  await assertSafeExportTarget(path.join(directory, "new-export.mp4"), records);
  assert.equal(await fs.readFile(source, "utf8"), "original-test-content");
});

test("codec discovery respects an explicit override and PATH without a machine-specific fallback", () => {
  assert.equal(discoverExecutable("ffmpeg", { OPENCUT_FFMPEG_PATH: process.execPath }), process.execPath);
  assert.equal(discoverExecutable("ffmpeg", { OPENCUT_FFMPEG_PATH: path.join(os.tmpdir(), "nonexistent-codec.exe") }), undefined);
});
test("filter capability parser handles current two-flag and older three-flag FFmpeg tables", () => {
  assert.deepEqual(parseFilters(" T. drawtext V->V Draw text\n .. whisper A->A Transcribe\n ... aevalsrc |->A Generate\n T.. = Timeline support\n"), ["drawtext", "whisper", "aevalsrc"]);
});

class ResponseCapture extends Writable {
  constructor() { super(); this.chunks = []; this.headersSent = false; }
  writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }
  _write(data, _encoding, done) { this.chunks.push(Buffer.from(data)); done(); }
}
test("static origin handler contains decoded paths and uses real SPA/asset MIME rules without listening", async (t) => {
  const directory = await fixture(t); await fs.writeFile(path.join(directory, "index.html"), "<title>Modern</title>"); await fs.writeFile(path.join(directory, "engine.wasm"), Buffer.from([0,97,115,109]));
  const handler = await createStaticHandler(directory);
  async function request(url, extra = {}) { const response = new ResponseCapture(); const done = new Promise((resolve, reject) => { response.once("finish", resolve); response.once("error", reject); }); await handler({ method: "GET", url, headers: { host: "127.0.0.1:38851", ...extra.headers }, ...extra }, response); await done; return response; }
  const wasm = await request("/engine.wasm"); assert.equal(wasm.status, 200); assert.equal(wasm.headers["Content-Type"], "application/wasm");
  const spa = await request("/editor/id", { headers: { host: "127.0.0.1:38851", accept: "text/html" } }); assert.equal(spa.status, 200);
  assert.equal((await request("/%2e%2e/private")).status, 403); assert.equal((await request("/..%5cprivate")).status, 403); assert.equal((await request("/%zz")).status, 400);
  assert.equal((await request("/missing.js", { headers: { host: "127.0.0.1:38851", accept: "text/html" } })).status, 404);
  assert.equal((await request("/", { method: "POST" })).status, 405);
  assert.equal((await request("/", { headers: { host: "foreign.invalid" } })).status, 421);
  assert.equal(wasm.headers["Cross-Origin-Embedder-Policy"], "require-corp"); assert.ok(wasm.headers["Content-Security-Policy"].includes("app-media:"));
});
