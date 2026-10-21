"use strict";
const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const { Readable } = require("node:stream");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { requireId } = require("./persistence.cjs");
const { ORIGIN } = require("./server.cjs");
const TICKS = 240000;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".avif", ".tif", ".tiff"]);
const MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus"]);
const CONTENT_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp", ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/mp4", ".webm": "video/webm", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg", ".opus": "audio/ogg" };
const mediaUrl = (id, variant) => `app-media://media/${requireId(id)}${variant ? `/${variant}` : ""}`;
function parseRange(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  let start, end;
  if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) return null; start = Math.max(0, size - suffix); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Math.min(size - 1, Number(match[2])) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
  return { start, end, partial: true };
}
function probeToAsset(id, name, probe) {
  if (!probe || !Array.isArray(probe.streams)) throw new Error("ffprobe did not return a media stream inventory.");
  const video = probe.streams.find((stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1);
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  if (!video && !audio) throw new Error("The selected file has no supported audio or video stream.");
  const kind = video ? IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()) ? "image" : "video" : "audio";
  const seconds = kind === "image" ? 5 : Number(probe.format?.duration || video?.duration || audio?.duration);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) throw new Error("Media duration must be known and at most 24 hours.");
  const asset = { id, name, kind, duration: Math.round(seconds * TICKS), hasAudio: Boolean(audio), url: mediaUrl(id) };
  if (video) {
    if (!Number.isInteger(video.width) || !Number.isInteger(video.height) || video.width < 1 || video.height < 1 || video.width > 16384 || video.height > 16384) throw new Error("Unsupported media dimensions.");
    asset.width = video.width; asset.height = video.height;
    const rate = /^(\d+)\/(\d+)$/u.exec(video.avg_frame_rate || "");
    if (rate && Number(rate[1]) > 0 && Number(rate[2]) > 0) asset.frameRate = { numerator: Number(rate[1]), denominator: Number(rate[2]) };
  }
  return asset;
}
class MediaRegistry {
  constructor(database, profile, codecs) { this.database = database; this.directory = path.join(profile, "media-cache"); this.codecs = codecs; }
  asset(record) { return { ...record.asset, url: mediaUrl(record.id), ...(record.thumbnail ? { thumbnail: mediaUrl(record.id, "thumbnail") } : {}), ...(record.proxy ? { proxyUrl: mediaUrl(record.id, "proxy") } : {}) }; }
  async record(id) {
    const record = this.database.getMedia(requireId(id));
    const stat = await fs.stat(record.source);
    if (!stat.isFile() || stat.size !== record.size || stat.mtimeMs !== record.mtimeMs) throw new Error(`Imported media changed or moved: ${record.asset.name}. Import the source again.`);
    return record;
  }
  async import(file, context) {
    if (!MEDIA_EXTENSIONS.has(path.extname(file).toLowerCase())) throw new Error("Choose a supported local video, audio or still-image file.");
    const source = await fs.realpath(file); const stat = await fs.stat(source);
    if (!stat.isFile() || stat.size < 1) throw new Error("The selected media must be a nonempty regular file.");
    const id = randomUUID(); const probe = await this.codecs.probe(source, context.signal);
    const asset = probeToAsset(id, path.basename(source), probe);
    const record = { id, source, size: stat.size, mtimeMs: stat.mtimeMs, asset };
    const directory = path.join(this.directory, id); await fs.mkdir(directory, { recursive: true });
    if (asset.kind !== "audio" && this.codecs.ffmpeg) {
      const thumbnail = path.join(directory, "thumbnail.png");
      try { await this.codecs.execute(["-y", "-protocol_whitelist", "file,pipe", "-i", source, "-frames:v", "1", "-vf", "scale=320:320:force_original_aspect_ratio=decrease", "-an", thumbnail], { signal: context.signal, timeoutMs: 60000 }); record.thumbnail = thumbnail; }
      catch (error) { if (context.signal.aborted) throw error; record.thumbnailError = "Local thumbnail generation failed."; }
    }
    if (asset.hasAudio && this.codecs.ffmpeg) {
      const peaks = new Array(512).fill(0); let sample = 0, remainder = Buffer.alloc(0);
      const totalSamples = Math.max(1, Math.ceil(asset.duration / TICKS * 4000));
      try {
        await this.codecs.execute(["-protocol_whitelist", "file,pipe", "-i", source, "-vn", "-ac", "1", "-ar", "4000", "-f", "s16le", "pipe:1"], {
          signal: context.signal, captureStdout: false, timeoutMs: 5 * 60 * 1000,
          onStdout: (chunk) => { const bytes = Buffer.concat([remainder, chunk]); const complete = bytes.length - bytes.length % 2; for (let i = 0; i < complete; i += 2) { const bin = Math.min(511, Math.floor(sample++ / totalSamples * 512)); peaks[bin] = Math.max(peaks[bin], Math.abs(bytes.readInt16LE(i)) / 32768); } remainder = bytes.subarray(complete); },
        });
        asset.peaks = peaks;
      } catch (error) { if (context.signal.aborted) throw error; record.waveformError = "Local waveform generation failed."; }
    }
    this.database.addMedia(record); return this.asset(record);
  }
  async normalizeProject(project) {
    const result = structuredClone(project);
    for (const [id] of Object.entries(result.assets)) result.assets[id] = this.asset(this.database.getMedia(id));
    return result;
  }
  async response(request) {
    const safeHeaders = { "Access-Control-Allow-Origin": ORIGIN, "Cross-Origin-Resource-Policy": "cross-origin", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Accept-Ranges": "bytes" };
    const fail = (message, status, extra = {}) => new Response(request.method === "HEAD" ? null : message, { status, headers: { ...safeHeaders, ...extra } });
    if (!["GET", "HEAD"].includes(request.method)) return fail("Method not allowed", 405, { Allow: "GET, HEAD" });
    const origin = request.headers.get("origin"); if (origin && origin !== ORIGIN) return fail("Foreign origin", 403);
    try {
      const url = new URL(request.url);
      const match = /^\/([a-zA-Z0-9_-]{1,128})(?:\/(thumbnail|proxy))?$/u.exec(url.pathname);
      if (url.protocol !== "app-media:" || url.host !== "media" || url.username || url.password || url.search || url.hash || !match) return fail("Invalid media identifier", 400);
      const record = await this.record(match[1]);
      const file = match[2] ? record[match[2]] : record.source;
      if (!file) return fail("Requested media derivative does not exist", 404);
      if (match[2]) { const real = await fs.realpath(file); const relative = path.relative(await fs.realpath(this.directory), real); if (relative.startsWith("..") || path.isAbsolute(relative)) return fail("Invalid derivative", 403); }
      const stat = await fs.stat(file); const range = parseRange(request.headers.get("range"), stat.size);
      if (!range) return fail("Range not satisfiable", 416, { "Content-Range": `bytes */${stat.size}` });
      const headers = { ...safeHeaders, "Content-Type": CONTENT_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "Content-Length": String(range.end - range.start + 1) };
      if (range.partial) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${stat.size}`;
      const body = request.method === "HEAD" ? null : Readable.toWeb(createReadStream(file, { start: range.start, end: range.end }));
      return new Response(body, { status: range.partial ? 206 : 200, headers });
    } catch { return fail("Registered media is unavailable. Reimport a moved or changed source.", 404); }
  }
}
module.exports = { MediaRegistry, parseRange, probeToAsset, mediaUrl };
