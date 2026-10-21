"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { ProjectDatabase, requireId } = require("./persistence.cjs");
const { CodecTools, filterPath } = require("./ffmpeg.cjs");
const { MediaRegistry, mediaUrl } = require("./media.cjs");
const { JobQueue } = require("./jobs.cjs");
const { compileRenderPlan } = require("./render.cjs");
const TB = 240000;
async function assertSafeExportTarget(output, records) {
  const destination = path.join(await fs.realpath(path.dirname(output)), path.basename(output));
  let realDestination = destination, destinationInfo;
  try { realDestination = await fs.realpath(destination); destinationInfo = await fs.stat(destination); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const canonical = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  for (const record of records) {
    let source, info;
    try { source = await fs.realpath(record.source); info = await fs.stat(source); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (canonical(source) === canonical(realDestination) || canonical(source) === canonical(destination) || (destinationInfo && info.ino !== 0 && info.dev === destinationInfo.dev && info.ino === destinationInfo.ino)) throw new Error("Export must not overwrite any registered original media, including unused library assets or filesystem aliases.");
  }
}

class EditorNativeHost {
  constructor({ profile, core, dialogs, environment, version }) {
    this.profile = profile; this.core = core; this.dialogs = dialogs; this.version = version;
    this.database = new ProjectDatabase(profile, core);
    this.codecs = new CodecTools(environment);
    this.media = new MediaRegistry(this.database, profile, this.codecs);
    this.jobs = new JobQueue();
  }
  async getEnvironment() {
    const info = await this.codecs.inspect();
    const modelReady = await this.codecs.verifyModel().catch(() => false);
    return { ffmpeg: info.ffmpeg, ffprobe: info.ffprobe, version: `${this.version}; ${info.version}`, profile: this.profile, encoders: info.encoders,
      localTranscription: Boolean(info.filters.includes("whisper") && modelReady), transcriptionModel: modelReady ? path.basename(this.codecs.model) : undefined };
  }
  async listProjects() { return this.database.list(); }
  async openProject(id) { const result = this.database.open(requireId(id)); result.project = await this.media.normalizeProject(result.project); return result; }
  async saveProject(input) {
    if (!input || typeof input !== "object") throw new Error("Invalid save request.");
    const project = await this.media.normalizeProject(this.database.validate(input.project));
    return this.database.save({ project, expectedVersion: input.expectedVersion });
  }
  async importMedia() {
    const files = await this.dialogs.openMedia();
    if (!files.length) return [];
    if (files.length > 64) throw new Error("Import at most 64 media files at a time.");
    return this.jobs.internal(async (context) => {
      const imported = [];
      for (const file of files) { if (context.signal.aborted) throw new Error("Cancelled"); imported.push(await this.media.import(file, context)); }
      return imported;
    });
  }
  async importCaptions() {
    const file = await this.dialogs.openCaptions(); if (!file) return [];
    const info = await fs.stat(file); if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error("Choose an SRT file of at most 2 MiB.");
    return this.core.parseSrt(await fs.readFile(file, "utf8"));
  }
  async jobDirectory() { const directory = path.join(this.profile, "jobs", randomUUID()); await fs.mkdir(directory, { recursive: true }); return directory; }
  async exportProject(input) {
    if (!input || !["mp4-h264", "webm-vp9"].includes(input.preset)) throw new Error("Unsupported export preset.");
    const project = this.database.validate(await this.media.normalizeProject(this.database.validate(input.project)));
    const plan = this.core.buildRenderPlan(project);
    const extension = input.preset === "mp4-h264" ? "mp4" : "webm";
    const output = await this.dialogs.saveExport({ name: project.name, extension }); if (!output) return null;
    if (path.extname(output).toLowerCase() !== `.${extension}`) throw new Error(`Choose an output filename ending in .${extension}.`);
    return this.jobs.enqueue("export", async (context) => {
      const directory = await this.jobDirectory();
      const compiled = await compileRenderPlan(plan, this.media, { directory });
      await assertSafeExportTarget(output, this.database.allMedia());
      const capabilities = await this.codecs.inspect();
      const videoEncoder = extension === "mp4" ? "libx264" : "libvpx-vp9";
      const audioEncoder = extension === "mp4" ? "aac" : "libopus";
      if (!capabilities.encoders.includes(videoEncoder) || !capabilities.encoders.includes(audioEncoder)) throw new Error(`The installed FFmpeg requires ${videoEncoder} and ${audioEncoder} encoders for this preset.`);
      if (compiled.hasText && !capabilities.filters.includes("drawtext")) throw new Error("This FFmpeg build does not include the local drawtext filter.");
      const staged = path.join(path.dirname(output), `.opencut-${randomUUID()}.${extension}`);
      try {
        const encoding = extension === "mp4" ? ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-movflags", "+faststart", "-c:a", "aac", "-b:a", "192k"] : ["-c:v", "libvpx-vp9", "-crf", "30", "-b:v", "0", "-row-mt", "1", "-c:a", "libopus", "-b:a", "160k"];
        await this.codecs.execute(["-n", ...compiled.args, ...encoding, "-threads", "2", staged], { ...context, captureStdout: false, durationSeconds: compiled.durationSeconds });
        if (context.signal.aborted) throw new Error("Cancelled");
        await assertSafeExportTarget(output, this.database.allMedia());
        for (const segment of plan.segments) if (segment.asset) await this.media.record(segment.asset.id);
        await fs.rename(staged, output);
        return { output: path.basename(output), message: "Export saved to the selected file." };
      } finally { await fs.rm(staged, { force: true }).catch(() => {}); }
    });
  }
  async createProxy(assetId) {
    requireId(assetId);
    return this.jobs.enqueue("proxy", async (context) => {
      const record = await this.media.record(assetId);
      if (record.asset.kind === "image") throw new Error("Still images do not require a video proxy.");
      const directory = path.join(this.media.directory, record.id); await fs.mkdir(directory, { recursive: true });
      const proxy = path.join(directory, record.asset.kind === "audio" ? "proxy.m4a" : "proxy.mp4");
      const temporary = path.join(directory, `proxy-${randomUUID()}${path.extname(proxy)}`);
      try {
        const encoding = record.asset.kind === "audio" ? ["-vn", "-c:a", "aac", "-ar", "48000"] : ["-vf", "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", "-c:v", "libx264", "-preset", "fast", "-crf", "26", "-c:a", "aac", "-ar", "48000"];
        await this.codecs.execute(["-n", "-protocol_whitelist", "file,pipe", "-i", record.source, ...encoding, "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", temporary], { ...context, captureStdout: false, durationSeconds: record.asset.duration / TB });
        if (context.signal.aborted) throw new Error("Cancelled");
        await fs.rename(temporary, proxy); record.proxy = proxy; this.database.addMedia(record);
        return { output: mediaUrl(assetId, "proxy"), result: { asset: this.media.asset(record) }, message: "Local proxy is ready." };
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    });
  }
  async analyzeSilence(assetId) {
    requireId(assetId);
    return this.jobs.enqueue("silence", async (context) => {
      const record = await this.media.record(assetId); if (!record.asset.hasAudio) throw new Error("This asset has no audio stream.");
      const ranges = []; let start;
      let pending = "";
      await this.codecs.execute(["-loglevel", "info", "-protocol_whitelist", "file,pipe", "-i", record.source, "-vn", "-af", "silencedetect=noise=-35dB:d=0.5", "-progress", "pipe:1", "-nostats", "-f", "null", "-"], { ...context, captureStdout: false, durationSeconds: record.asset.duration / TB,
        onStderr: (chunk) => { pending += chunk; const lines = pending.split(/\r?\n/u); pending = lines.pop().slice(-4096); for (const line of lines) for (const match of line.matchAll(/silence_(start|end):\s*([0-9.]+)/gu)) { const value = Math.round(Number(match[2]) * TB); if (match[1] === "start") start = value; else if (start !== undefined) { if (ranges.length >= 100000) throw new Error("Silence analysis exceeded 100000 ranges."); ranges.push({ start, end: Math.min(record.asset.duration, value) }); start = undefined; } } },
      });
      if (start !== undefined) ranges.push({ start, end: record.asset.duration });
      return { result: { assetId, timebase: TB, thresholdDb: -35, minimumDuration: TB / 2, ranges }, message: `Found ${ranges.length} source silence ranges.` };
    });
  }
  async transcribeAsset(assetId) {
    requireId(assetId);
    return this.jobs.enqueue("transcription", async (context) => {
      const record = await this.media.record(assetId); if (!record.asset.hasAudio) throw new Error("This asset has no audio stream.");
      const capabilities = await this.codecs.inspect();
      if (!await this.codecs.verifyModel() || !capabilities.filters.includes("whisper")) throw new Error("Local transcription requires an installed FFmpeg whisper filter and a verified bundled model or OPENCUT_WHISPER_MODEL. No model is downloaded by the application.");
      const directory = await this.jobDirectory(); const destination = path.join(directory, "transcript.srt");
      const filter = `whisper=model='${filterPath(this.codecs.model)}':language=auto:queue=20:use_gpu=false:destination='${filterPath(destination)}':format=srt`;
      await this.codecs.execute(["-protocol_whitelist", "file,pipe", "-i", record.source, "-vn", "-af", filter, "-progress", "pipe:1", "-nostats", "-f", "null", "-"], { ...context, captureStdout: false, durationSeconds: record.asset.duration / TB });
      const info = await fs.stat(destination); if (info.size > 2 * 1024 * 1024) throw new Error("Transcript exceeds the 2 MiB caption import bound.");
      const captions = this.core.parseSrt(await fs.readFile(destination, "utf8"));
      return { result: captions, message: `Generated ${captions.length} source-time captions locally.` };
    });
  }
  async cancelJob(id) { this.jobs.cancel(requireId(id)); }
  async close() { await this.jobs.close(); this.database.close(); }
}
module.exports = { EditorNativeHost, assertSafeExportTarget };
