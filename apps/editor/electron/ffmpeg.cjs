"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const BUNDLED_MODEL_SHA256 = "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f";
function executable(value) { return typeof value === "string" && path.isAbsolute(value) && fs.existsSync(value) && fs.statSync(value).isFile() ? value : undefined; }
function parseFilters(output) {
  // Current FFmpeg uses two flags; older releases used three. Require the
  // stream mapping column so legend entries can never become filter names.
  return [...output.matchAll(/^\s*[A-Z.]{2,4}\s+([a-zA-Z0-9_]+)\s+\S+->\S+/gmu)].map((match) => match[1]);
}
function discoverExecutable(name, environment) {
  const selected = environment[name === "ffmpeg" ? "OPENCUT_FFMPEG_PATH" : "OPENCUT_FFPROBE_PATH"];
  if (selected) return executable(selected);
  const filename = process.platform === "win32" ? `${name}.exe` : name;
  for (const directory of (environment.PATH || environment.Path || "").split(path.delimiter).slice(0, 128)) {
    const found = executable(path.join(directory.replace(/^"|"$/gu, ""), filename)); if (found) return found;
  }
  if (process.platform !== "win32" || !environment.LOCALAPPDATA) return undefined;
  const packages = path.join(environment.LOCALAPPDATA, "Microsoft", "WinGet", "Packages");
  let roots;
  try { roots = fs.readdirSync(packages, { withFileTypes: true }).slice(0, 4096).filter((entry) => entry.isDirectory() && /ffmpeg/iu.test(entry.name)).slice(0, 32).map((entry) => path.join(packages, entry.name)); }
  catch { return undefined; }
  const pending = roots.map((directory) => ({ directory, depth: 0 }));
  for (let count = 0; pending.length && count < 192; count++) {
    const { directory, depth } = pending.shift();
    const found = executable(path.join(directory, filename)); if (found) return found;
    if (depth >= 3) continue;
    try { for (const entry of fs.readdirSync(directory, { withFileTypes: true }).slice(0, 64)) if (entry.isDirectory()) pending.push({ directory: path.join(directory, entry.name), depth: depth + 1 }); } catch { /* An unavailable package is not selected. */ }
  }
  return undefined;
}
function runProcess(binary, args, options = {}) {
  if (!binary || !path.isAbsolute(binary)) return Promise.reject(new Error("A configured local codec executable is required."));
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string" || value.includes("\0"))) return Promise.reject(new Error("Invalid native argument array."));
  if (options.signal?.aborted) return Promise.reject(new Error("Cancelled"));
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, shell: false, cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = Buffer.alloc(0), stderr = "", killedForLimit = false, timedOut = false, callbackFailure;
    const maxOutput = options.maxOutput ?? 8 * 1024 * 1024;
    const abort = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timeout = setTimeout(() => { timedOut = true; abort(); }, options.timeoutMs ?? 6 * 60 * 60 * 1000);
    timeout.unref();
    child.stdout.on("data", (chunk) => {
      try { options.onStdout?.(chunk); } catch (error) { callbackFailure = error; abort(); }
      if (options.captureStdout !== false) {
        if (stdout.length + chunk.length > maxOutput) { killedForLimit = true; abort(); }
        else stdout = Buffer.concat([stdout, chunk]);
      }
    });
    child.stderr.on("data", (chunk) => { const text = chunk.toString(); stderr = (stderr + text).slice(-262144); try { options.onStderr?.(text); } catch (error) { callbackFailure = error; abort(); } });
    child.once("error", (error) => { clearTimeout(timeout); options.signal?.removeEventListener("abort", abort); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timeout); options.signal?.removeEventListener("abort", abort);
      if (options.signal?.aborted) reject(new Error("Cancelled"));
      else if (callbackFailure) reject(callbackFailure);
      else if (timedOut) reject(new Error("The native codec operation reached its time limit."));
      else if (killedForLimit) reject(new Error("The native codec metadata exceeded its output limit."));
      else if (code !== 0) reject(new Error(`Native codec failed (${code}): ${stderr.slice(-3000)}`));
      else resolve({ stdout, stderr });
    });
  });
}

class CodecTools {
  constructor(environment = process.env) {
    this.ffmpeg = discoverExecutable("ffmpeg", environment);
    this.ffprobe = discoverExecutable("ffprobe", environment);
    const bundled = [process.resourcesPath && path.join(process.resourcesPath, "models", "ggml-tiny.en.bin"), path.join(__dirname, "..", "resources", "models", "ggml-tiny.en.bin")].filter(Boolean);
    this.customModel = Boolean(environment.OPENCUT_WHISPER_MODEL);
    this.model = this.customModel ? executable(environment.OPENCUT_WHISPER_MODEL) : bundled.map(executable).find(Boolean);
    this.inspection = undefined;
  }
  async verifyModel() {
    if (!this.model) return false;
    if (this.customModel) return true;
    return this.modelVerification ||= new Promise((resolve, reject) => {
      const hash = createHash("sha256"), stream = fs.createReadStream(this.model);
      stream.on("data", (chunk) => hash.update(chunk)); stream.once("error", reject);
      stream.once("end", () => hash.digest("hex") === BUNDLED_MODEL_SHA256 ? resolve(true) : reject(new Error("The bundled transcription model failed its SHA-256 identity check.")));
    });
  }
  async inspect() {
    if (this.inspection) return this.inspection;
    this.inspection = (async () => {
      if (!this.ffmpeg) return { ffmpeg: false, ffprobe: Boolean(this.ffprobe), version: "FFmpeg not configured", encoders: [], filters: [] };
      const [version, encoders, filters] = await Promise.all([
        runProcess(this.ffmpeg, ["-version"], { timeoutMs: 10000 }),
        runProcess(this.ffmpeg, ["-hide_banner", "-encoders"], { timeoutMs: 10000 }),
        runProcess(this.ffmpeg, ["-hide_banner", "-filters"], { timeoutMs: 10000 }),
      ]);
      return { ffmpeg: true, ffprobe: Boolean(this.ffprobe), version: version.stdout.toString().split(/\r?\n/u)[0],
        encoders: [...encoders.stdout.toString().matchAll(/^\s*[VAS][A-Z.]{5}\s+([A-Za-z0-9_]+)/gmu)].map((match) => match[1]),
        filters: parseFilters(filters.stdout.toString()) };
    })();
    return this.inspection;
  }
  async probe(file, signal) {
    if (!this.ffprobe) throw new Error("Configure OPENCUT_FFPROBE_PATH with an installed local ffprobe executable.");
    const result = await runProcess(this.ffprobe, ["-v", "error", "-protocol_whitelist", "file,pipe", "-probesize", "20000000", "-analyzeduration", "20000000", "-show_format", "-show_streams", "-of", "json", "-i", file], { signal, timeoutMs: 60000 });
    return JSON.parse(result.stdout.toString());
  }
  execute(args, context = {}) {
    if (!this.ffmpeg) return Promise.reject(new Error("Configure OPENCUT_FFMPEG_PATH with an installed local FFmpeg executable."));
    let pending = "";
    return runProcess(this.ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "warning", ...args], {
      ...context,
      onStdout: (data) => {
        context.onStdout?.(data);
        if (!context.durationSeconds || !context.update) return;
        pending = (pending + data.toString()).slice(-8192);
        const lines = pending.split(/\r?\n/u); pending = lines.pop();
        for (const line of lines) { const match = /^out_time_us=(\d+)$/u.exec(line); if (match) context.update(Number(match[1]) / 1e6 / context.durationSeconds, "Processing locally"); }
      },
    });
  }
}
// Filter-script values need filter escaping, never shell quoting. Backslashes are
// doubled before drive colons; text itself is supplied through private UTF-8 files.
function filterPath(value) { return value.replaceAll("\\", "/").replaceAll(":", "\\:").replaceAll("'", "'\\''").replaceAll(",", "\\,").replaceAll("[", "\\[").replaceAll("]", "\\]").replaceAll(";", "\\;"); }
module.exports = { CodecTools, runProcess, filterPath, discoverExecutable, parseFilters };
