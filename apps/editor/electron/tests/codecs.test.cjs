"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const core = require("../core.cjs");
const { CodecTools, runProcess } = require("../ffmpeg.cjs");
const { compileRenderPlan } = require("../render.cjs");
const { EditorNativeHost } = require("../host.cjs");
const codecs = new CodecTools();
async function fixture(t, beforeCleanup) { const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencut-next-codec-")); t.after(async () => { await beforeCleanup?.(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); }); return directory; }
function complete(queue, id) { return new Promise((resolve) => { const listener = (value) => { if (value.id === id && ["completed", "failed", "cancelled"].includes(value.status)) { queue.off("job", listener); resolve(value); } }; queue.on("job", listener); }); }

test("real CPU H264 and VP9 exports compile layered multiclips, color, fades, mixed audio and text/captions", { skip: !codecs.ffmpeg || !codecs.ffprobe, timeout: 120000 }, async (t) => {
  const directory = await fixture(t), source = path.join(directory, "source with spaces.mp4"), image = path.join(directory, "overlay.png");
  await runProcess(codecs.ffmpeg, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", source], { timeoutMs: 30000 });
  await runProcess(codecs.ffmpeg, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=80x80", "-frames:v", "1", image], { timeoutMs: 30000 });
  const project = core.createProject({ width: 320, height: 180, name: "Native fixture" });
  const video = { id: "source", name: "Source", kind: "video", duration: 720000, hasAudio: true, url: "app-media://media/source", width: 320, height: 180 };
  const still = { id: "overlay", name: "Overlay", kind: "image", duration: 1200000, hasAudio: false, url: "app-media://media/overlay", width: 80, height: 80 };
  project.assets.source = video; project.assets.overlay = still;
  const first = core.createClip({ asset: video, start: 0, duration: 240000 }); first.fadeIn = 24000;
  const second = core.createClip({ asset: video, start: 240000, duration: 240000 }); second.sourceIn = 240000; second.speed = .75;
  project.tracks[0].clips.push(first, second);
  const overlay = core.createClip({ asset: still, start: 60000, duration: 300000 }); overlay.opacity = .4; overlay.transform = { x: 20, y: -10, scale: .35, rotation: 15 }; overlay.color = { brightness: .8, contrast: 1.1, saturation: .5 }; overlay.fadeIn = 24000; overlay.fadeOut = 24000;
  project.tracks.splice(1, 0, { id: "layer", name: "Layer", kind: "video", muted: false, locked: false, clips: [overlay] });
  const audio = core.createClip({ asset: { ...video, id: "audio", kind: "audio", width: undefined, height: undefined }, start: 0, duration: 480000 });
  const audioAsset = { id: "audio", name: "Audio", kind: "audio", duration: video.duration, hasAudio: true, url: "app-media://media/audio" }; project.assets.audio = audioAsset; audio.volume = .2; project.tracks.find((track) => track.kind === "audio").clips.push(audio);
  const text = core.createTextClip({ text: "Modern\nLocal", duration: 480000 }); text.text.fontSize = 20; project.tracks.find((track) => track.kind === "text").clips.push(text);
  project.captions = [{ id: "caption", start: 48000, end: 180000, text: "CPU fixture\nSecond line" }];
  const registry = { async record(id) { return { source: id === "overlay" ? image : source, asset: project.assets[id] }; } };
  const compiled = await compileRenderPlan(core.buildRenderPlan(project), registry, { directory });
  for (const [name, videoEncoder, audioEncoder] of [["mp4", "libx264", "aac"], ["webm", "libvpx-vp9", "libopus"]]) {
    const output = path.join(directory, `rendered.${name}`);
    await codecs.execute([...compiled.args, "-c:v", videoEncoder, "-c:a", audioEncoder, "-threads", "2", output], { timeoutMs: 60000, captureStdout: false });
    const info = await codecs.probe(output);
    assert.equal(info.streams.find((stream) => stream.codec_type === "video").width, 320); assert.equal(info.streams.find((stream) => stream.codec_type === "video").height, 180);
    assert.ok(info.streams.some((stream) => stream.codec_type === "audio")); assert.ok(Math.abs(Number(info.format.duration) - 2) < .1);
    assert.ok((await fs.stat(output)).size > 1000);
  }
});

test("real native import/save/proxy/silence/transcription uses local selected source and Windows filter paths", { skip: !codecs.ffmpeg || !codecs.ffprobe || !process.env.OPENCUT_TEST_SPEECH, timeout: 180000 }, async (t) => {
  let host;
  const directory = await fixture(t, async () => host?.close());
  host = new EditorNativeHost({ profile: directory, core, version: "native-test", dialogs: { async openMedia() { return [process.env.OPENCUT_TEST_SPEECH]; } } });
  const assets = await host.importMedia(); assert.equal(assets.length, 1); assert.equal(assets[0].kind, "audio"); assert.equal(assets[0].peaks.length, 512); assert.ok(assets[0].url.startsWith("app-media://media/"));
  const project = core.createProject({ name: "Speech fixture" }); project.assets[assets[0].id] = assets[0];
  project.tracks.find((track) => track.kind === "audio").clips.push(core.createClip({ asset: assets[0] }));
  assert.deepEqual(await host.saveProject({ project, expectedVersion: null }), { version: 1 }); assert.equal((await host.openProject(project.id)).version, 1);
  const proxy = await host.createProxy(assets[0].id), proxyResult = await complete(host.jobs, proxy.id); assert.equal(proxyResult.status, "completed", proxyResult.message); assert.ok(proxyResult.output.endsWith("/proxy")); assert.equal(proxyResult.result.asset.proxyUrl, proxyResult.output); assert.equal(proxyResult.result.asset.url, assets[0].url);
  assert.equal((await host.openProject(project.id)).project.assets[assets[0].id].proxyUrl, proxyResult.output);
  const silence = await host.analyzeSilence(assets[0].id), silenceResult = await complete(host.jobs, silence.id); assert.equal(silenceResult.status, "completed", silenceResult.message); assert.equal(silenceResult.result.timebase, 240000);
  const environment = await host.getEnvironment();
  if (!environment.localTranscription) { t.diagnostic("Local model/whisper unavailable; transcription is explicitly disabled."); return; }
  const job = await host.transcribeAsset(assets[0].id), result = await complete(host.jobs, job.id); assert.equal(result.status, "completed", result.message); assert.ok(Array.isArray(result.result)); assert.ok(result.result.length > 0);
  for (const caption of result.result) { assert.ok(Number.isSafeInteger(caption.start)); assert.ok(caption.end > caption.start); }
  t.diagnostic(`Transcription fixture: ${result.result.map((caption) => caption.text).join(" ")}`);
});

test("decoded native animation changes position, smooth opacity and audio gain", { skip: !codecs.ffmpeg || !codecs.ffprobe, timeout: 60000 }, async (t) => {
  const directory = await fixture(t), image = path.join(directory, "red.png"), sound = path.join(directory, "tone.wav"), output = path.join(directory, "animation.mp4");
  await runProcess(codecs.ffmpeg, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=32x32", "-frames:v", "1", image]);
  await runProcess(codecs.ffmpeg, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1", sound]);
  const project = core.createProject({ width: 128, height: 96 }); project.settings.background = "#000000";
  const visual = { id: "red", name: "Red", kind: "image", duration: 240000, width: 32, height: 32, hasAudio: false, url: "app-media://media/red" };
  const audible = { id: "tone", name: "Tone", kind: "audio", duration: 240000, hasAudio: true, url: "app-media://media/tone" };
  project.assets.red = visual; project.assets.tone = audible;
  const clip = core.createClip({ asset: visual, duration: 240000 }); clip.transform.scale = .25;
  clip.keyframes = [
    { id: "x0", property: "x", time: 0, value: -30, easing: "linear" }, { id: "x1", property: "x", time: 240000, value: 30, easing: "linear" },
    { id: "y0", property: "y", time: 0, value: -15, easing: "hold" }, { id: "y1", property: "y", time: 120000, value: 15, easing: "linear" },
    { id: "o0", property: "opacity", time: 0, value: .2, easing: "smooth" }, { id: "o1", property: "opacity", time: 240000, value: 1, easing: "linear" },
  ];
  project.tracks[0].clips.push(clip);
  const audio = core.createClip({ asset: audible, duration: 240000 }); audio.keyframes = [{ id: "v0", property: "volume", time: 0, value: .1, easing: "linear" }, { id: "v1", property: "volume", time: 240000, value: .9, easing: "linear" }];
  project.tracks.find((track) => track.kind === "audio").clips.push(audio);
  const registry = { async record(id) { return { source: id === "red" ? image : sound, asset: project.assets[id] }; } };
  const compiled = await compileRenderPlan(core.buildRenderPlan(project), registry, { directory });
  await codecs.execute([...compiled.args, "-c:v", "libx264", "-crf", "16", "-c:a", "aac", output], { captureStdout: false, timeoutMs: 30000 });
  async function frame(time) {
    const result = await runProcess(codecs.ffmpeg, ["-v", "error", "-ss", String(time), "-i", output, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]);
    let x = 0, y = 0, red = 0, count = 0;
    for (let pixel = 0; pixel < 128 * 96; pixel++) { const offset = pixel * 3; if (result.stdout[offset] > 35 && result.stdout[offset+1] < 25 && result.stdout[offset+2] < 25) { x += pixel % 128; y += Math.floor(pixel / 128); red += result.stdout[offset]; count++; } }
    assert.ok(count > 100); return { x: x/count, y: y/count, red: red/count };
  }
  const early = await frame(.2), late = await frame(.8);
  assert.ok(late.x - early.x > 25, JSON.stringify({ early, late })); assert.ok(late.y - early.y > 20, JSON.stringify({ early, late })); assert.ok(late.red - early.red > 80, JSON.stringify({ early, late }));
  async function rms(time) { const value = await runProcess(codecs.ffmpeg, ["-v", "error", "-ss", String(time), "-i", output, "-t", "0.1", "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"]); let sum = 0; for (let offset=0; offset+4<=value.stdout.length; offset+=4) sum += value.stdout.readFloatLE(offset)**2; return Math.sqrt(sum / (value.stdout.length/4)); }
  const quiet = await rms(.15), loud = await rms(.75); assert.ok(loud > quiet * 2, JSON.stringify({ quiet, loud }));
  t.diagnostic(`Decoded animation: ${JSON.stringify({ early, late, quiet, loud })}`);
});

test("decoded scale/rotation keys preserve colored corners, hold boundary and transparent exterior", { skip: !codecs.ffmpeg || !codecs.ffprobe, timeout: 60000 }, async (t) => {
  const directory = await fixture(t), image = path.join(directory, "corners.png"), output = path.join(directory, "geometry.mp4");
  await runProcess(codecs.ffmpeg, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=80x40", "-vf", "drawbox=x=0:y=0:w=20:h=20:c=blue:t=fill,drawbox=x=60:y=0:w=20:h=20:c=lime:t=fill,drawbox=x=0:y=20:w=20:h=20:c=yellow:t=fill", "-frames:v", "1", image]);
  const project = core.createProject({ width: 128, height: 128 }); project.settings.background = "#000000";
  const asset = { id: "corners", name: "Corners", kind: "image", duration: 240000, width: 80, height: 40, hasAudio: false, url: "app-media://media/corners" }; project.assets.corners = asset;
  const clip = core.createClip({ asset, duration: 240000 }); clip.keyframes = [
    { id: "s0", property: "scale", time: 0, value: .25, easing: "linear" }, { id: "s1", property: "scale", time: 240000, value: .5, easing: "linear" },
    { id: "r0", property: "rotation", time: 0, value: 0, easing: "hold" }, { id: "r1", property: "rotation", time: 120000, value: 90, easing: "smooth" }, { id: "r2", property: "rotation", time: 240000, value: 180, easing: "linear" },
  ]; project.tracks[0].clips.push(clip);
  const registry = { async record() { return { source: image, asset }; } };
  const compiled = await compileRenderPlan(core.buildRenderPlan(project), registry, { directory });
  assert.ok(compiled.graph.includes("perspective=")); assert.ok(compiled.graph.includes("on-1"));
  await codecs.execute([...compiled.args, "-c:v", "libx264", "-crf", "12", "-c:a", "aac", output], { captureStdout: false, timeoutMs: 30000 });
  async function inspect(frameNumber) {
    const value = await runProcess(codecs.ffmpeg, ["-v", "error", "-i", output, "-vf", `select=eq(n\\,${frameNumber})`, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"]);
    const sets = { blue: [], green: [], yellow: [] };
    for (let pixel=0; pixel<128*128; pixel++) {
      const [r,g,b] = value.stdout.subarray(pixel*3,pixel*3+3), point = { x: pixel%128, y: Math.floor(pixel/128) };
      if (b>90 && r<60 && g<70) sets.blue.push(point);
      if (g>90 && r<70 && b<70) sets.green.push(point);
      if (r>90 && g>90 && b<70) sets.yellow.push(point);
    }
    const center = (points) => { assert.ok(points.length > 4, `Missing colored corner in frame ${frameNumber}`); return { x: points.reduce((sum,p)=>sum+p.x,0)/points.length, y: points.reduce((sum,p)=>sum+p.y,0)/points.length }; };
    const blue = center(sets.blue), green = center(sets.green), yellow = center(sets.yellow);
    const angle = Math.atan2(green.y-blue.y,green.x-blue.x)*180/Math.PI;
    const width = Math.hypot(green.x-blue.x,green.y-blue.y);
    for (const pixel of [129,254,16257,16382]) assert.ok(Math.max(...value.stdout.subarray(pixel*3,pixel*3+3)) < 12, `Opaque/clamped exterior in frame ${frameNumber}`);
    return { blue, green, yellow, angle, width };
  }
  const early = await inspect(6), late = await inspect(24), beforeHold = await inspect(14), atHold = await inspect(15);
  assert.ok(late.width > early.width * 1.3, JSON.stringify({ early, late }));
  assert.ok(Math.abs(early.angle) < 5); assert.ok(late.angle > 130 && late.angle < 170, JSON.stringify(late));
  assert.ok(Math.abs(beforeHold.angle) < 5, JSON.stringify(beforeHold)); assert.ok(Math.abs(atHold.angle - 90) < 5, JSON.stringify(atHold));
  // Positive canvas rotation moves the original bottom-left yellow corner to
  // the upper-left of blue after a 90-degree turn.
  assert.ok(atHold.yellow.x < atHold.blue.x - 5, JSON.stringify(atHold));
  t.diagnostic(`Decoded geometry: ${JSON.stringify({ early, late, beforeHold, atHold })}`);
});
