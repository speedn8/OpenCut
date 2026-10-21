"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { filterPath } = require("./ffmpeg.cjs");
const { evaluateKeyframeProperty } = require("./core.cjs");
const TB = 240000;
const FONT_FILES = { Arial: "arial.ttf", "Segoe UI": "segoeui.ttf", "Times New Roman": "times.ttf", Consolas: "consola.ttf", Calibri: "calibri.ttf" };
function number(value, label, min = -1e8, max = 1e8) {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Unsupported ${label}: expected ${min}..${max}.`);
  return Number(value.toFixed(9)).toString();
}
const seconds = (ticks) => number(ticks / TB, "time", 0, 21600);
function keyframeExpression(clip, property, timeVariable) {
  const keys = clip.keyframes.filter((key) => key.property === property).sort((a, b) => a.time - b.time);
  if (keys.length > 256) throw new Error("Native export supports at most 256 keys per animated property.");
  const base = property === "volume" || property === "opacity" ? clip[property] : clip.transform[property];
  if (!keys.length) return number(base, property);
  let expression = number(keys.at(-1).value, property);
  for (let index = keys.length - 1; index > 0; index--) {
    const left = keys[index - 1], right = keys[index];
    const leftTime = number(left.time / TB, "key time", -1e9, 1e9), rightTime = number(right.time / TB, "key time", -1e9, 1e9);
    const progress = `((${timeVariable})-(${leftTime}))/(${number((right.time - left.time) / TB, "key interval", 1e-9, 1e9)})`;
    const weight = left.easing === "smooth" ? `((${progress})*(${progress})*(3-2*(${progress})))` : `(${progress})`;
    const value = left.easing === "hold" ? number(left.value, property) : `(${number(left.value, property)}+(${number(right.value-left.value, "key delta")})*${weight})`;
    expression = `if(lt((${timeVariable}),${rightTime}),${value},${expression})`;
  }
  return `if(lt((${timeVariable}),${number(keys[0].time / TB, "key time", -1e9, 1e9)}),${number(keys[0].value, property)},${expression})`;
}
function animatedGeometry(clip, width, height, frameRate) {
  const scaleKeys = clip.keyframes.filter((key) => key.property === "scale");
  const maximumScale = Math.max(Number(number(clip.transform.scale, "scale", .01, 8)), ...scaleKeys.map((key) => Number(number(key.value, "animated scale", .01, 8))));
  for (const key of clip.keyframes.filter((item) => item.property === "rotation")) number(key.value, "animated rotation", -36000, 36000);
  const fittedWidth = Math.max(2, Math.round(width * maximumScale / 2) * 2), fittedHeight = Math.max(2, Math.round(height * maximumScale / 2) * 2);
  const side = Math.ceil((Math.hypot(fittedWidth, fittedHeight) + 4) / 2) * 2;
  if (side > 8192) throw new Error("Animated geometry requires a transparent working surface larger than the 8192-pixel native limit.");
  // FFmpeg 4348bde2d2 vf_perspective uses one-based output counters. Every
  // imported visual is reset to PTS=0 and conformed to the project frame rate.
  const time = `((on-1)*${frameRate.denominator}/${frameRate.numerator})`;
  const scale = `((${keyframeExpression(clip, "scale", time)})/${maximumScale})`;
  const angle = `((${keyframeExpression(clip, "rotation", time)})*PI/180)`;
  const coordinates = [];
  for (const [index, dx, dy] of [[0,-side/2,-side/2],[1,side/2,-side/2],[2,-side/2,side/2],[3,side/2,side/2]]) {
    coordinates.push(`x${index}='W/2+${scale}*((${dx})*cos(${angle})-(${dy})*sin(${angle}))'`);
    coordinates.push(`y${index}='H/2+${scale}*((${dx})*sin(${angle})+(${dy})*cos(${angle}))'`);
  }
  return {
    fit: [`scale=${fittedWidth}:${fittedHeight}:force_original_aspect_ratio=decrease`, `pad=${side}:${side}:(ow-iw)/2:(oh-ih)/2:color=black@0`, "setsar=1"],
    warp: ["format=gbrap", "premultiply=inplace=1", `perspective=${coordinates.join(":")}:sense=destination:eval=frame:interpolation=linear`, "unpremultiply=inplace=1", "format=rgba"],
  };
}
function ffColor(value) {
  if (value === "transparent") return "black@0";
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/iu.exec(value || "");
  if (!match) throw new Error("Native export supports #RRGGBB/#RRGGBBAA colors and transparent only.");
  return `0x${match[1]}${match[2] ? `@${parseInt(match[2], 16) / 255}` : ""}`;
}
function tempoFilters(speed) {
  number(speed, "speed", 0.1, 16);
  const values = [];
  while (speed > 2) { values.push("atempo=2"); speed /= 2; }
  while (speed < 0.5) { values.push("atempo=0.5"); speed /= 0.5; }
  if (Math.abs(speed - 1) > 1e-10) values.push(`atempo=${number(speed, "speed")}`);
  return values;
}
function colorFilters(color) {
  const b = Number(number(color.brightness, "brightness", 0, 2));
  const c = Number(number(color.contrast, "contrast", 0, 2));
  const s = Number(number(color.saturation, "saturation", 0, 2));
  const filters = [];
  if (b !== 1) filters.push(`colorchannelmixer=rr=${b}:gg=${b}:bb=${b}`);
  if (c !== 1) filters.push(`lutrgb=r='clip((val-127.5)*${c}+127.5,0,255)':g='clip((val-127.5)*${c}+127.5,0,255)':b='clip((val-127.5)*${c}+127.5,0,255)'`);
  if (s !== 1) {
    const matrix = { rr: .213 + .787 * s, rg: .715 * (1 - s), rb: .072 * (1 - s), gr: .213 * (1 - s), gg: .715 + .285 * s, gb: .072 * (1 - s), br: .213 * (1 - s), bg: .715 * (1 - s), bb: .072 + .928 * s };
    filters.push(`colorchannelmixer=${Object.entries(matrix).map(([key, value]) => `${key}=${number(value, "saturation coefficient", -2, 2)}`).join(":")}`);
  }
  return filters;
}
async function fontFile(family, fontDirectory) {
  if (!Object.hasOwn(FONT_FILES, family)) throw new Error(`Native text export does not support font '${family}'. Choose ${Object.keys(FONT_FILES).join(", ")}.`);
  const file = path.join(fontDirectory || path.join(process.env.WINDIR || "C:\\Windows", "Fonts"), FONT_FILES[family]);
  if (!(await fs.stat(file)).isFile()) throw new Error(`The local ${family} font is unavailable.`);
  return file;
}
async function compileRenderPlan(plan, registry, options) {
  if (plan.schemaVersion !== 1 || !Array.isArray(plan.segments) || !Array.isArray(plan.captions)) throw new Error("Invalid render plan.");
  const { width, height, frameRate } = plan.settings;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width % 2 || height % 2) throw new Error("Native H.264/VP9 export currently requires even canvas dimensions.");
  number(width, "width", 2, 4096); number(height, "height", 2, 4096);
  number(frameRate.numerator / frameRate.denominator, "frame rate", 1, 120);
  if (plan.duration <= 0 || plan.duration > 21600 * TB) throw new Error("Export a nonempty timeline of at most six hours.");
  if (plan.segments.length > 128 || plan.captions.length > 5000) throw new Error("Native export currently supports at most 128 clips and 5000 captions per job.");
  if (plan.settings.sampleRate !== 48000) throw new Error("Native rendering requires 48 kHz project audio.");
  const fps = `${frameRate.numerator}/${frameRate.denominator}`;
  const duration = seconds(plan.duration);
  const inputs = [], graph = [], audio = ["silence"], sourcePaths = [];
  graph.push(`color=c=${ffColor(plan.settings.background)}:s=${width}x${height}:r=${fps}:d=${duration},format=rgba[canvas0]`);
  graph.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${duration}[silence]`);
  let input = 0, layer = 0, textCount = 0;
  for (let index = 0; index < plan.segments.length; index++) {
    const { clip, asset } = plan.segments[index];
    if (clip.fadeIn + clip.fadeOut > clip.duration) throw new Error(`Overlapping fades are not supported in native export (${clip.name}).`);
    const start = seconds(clip.start), length = seconds(clip.duration), speed = number(clip.speed, "speed", 0.1, 16);
    let visual;
    if (clip.kind === "text") {
      if (!clip.text || clip.text.content.length > 10000) throw new Error("Text content is missing or exceeds the native export limit.");
      const font = await fontFile(clip.text.fontFamily, options.fontDirectory);
      textCount++;
      const fontSize = number(clip.text.fontSize, "font size", 1, 1000);
      const x = clip.text.align === "left" ? "w/2" : clip.text.align === "right" ? "w/2-text_w" : "(w-text_w)/2";
      if (clip.text.background !== "transparent" && !/^#[0-9a-f]{6}00$/iu.test(clip.text.background)) throw new Error("Native export does not yet support text background boxes with matching preview metrics. Set the text background to transparent.");
      const lines = clip.text.content.split("\n"), drawing = [];
      for (let line = 0; line < lines.length; line++) {
        const text = path.join(options.directory, `text-${index}-${line}.txt`); await fs.writeFile(text, lines[line] || " ", "utf8");
        const offset = (line - (lines.length - 1) / 2) * Number(fontSize) * 1.25;
        drawing.push(`drawtext=fontfile='${filterPath(font)}':textfile='${filterPath(text)}':expansion=none:fontsize=${fontSize}:fontcolor=${ffColor(clip.text.color)}:x='${x}':y='(h-text_h)/2+${number(offset, "text line offset")}'`);
      }
      graph.push(`color=c=black@0:s=${width}x${height}:r=${fps}:d=${length},format=rgba,${drawing.join(",")}[raw${index}]`);
      visual = `raw${index}`;
    } else {
      if (!asset || asset.id !== clip.assetId) throw new Error("Render plan has an unresolved media asset.");
      const record = await registry.record(asset.id); sourcePaths.push(record.source);
      if (record.asset.kind !== clip.kind) throw new Error("The registered media kind differs from the project.");
      const sourceEnd = clip.sourceIn + clip.duration * clip.speed;
      if (clip.kind !== "image" && sourceEnd > record.asset.duration + 1) throw new Error(`Clip exceeds its registered source bounds: ${clip.name}.`);
      if (clip.kind === "image") inputs.push("-loop", "1", "-framerate", fps);
      inputs.push("-protocol_whitelist", "file,pipe", "-i", record.source);
      const n = input++;
      if (clip.kind !== "audio") {
        graph.push(`[${n}:v]trim=start=${clip.kind === "image" ? "0" : seconds(clip.sourceIn)}:duration=${seconds(clip.duration * clip.speed)},setpts=(PTS-STARTPTS)/${speed},fps=${fps},format=rgba[raw${index}]`);
        visual = `raw${index}`;
      }
      if (record.asset.hasAudio && clip.kind !== "image" && (clip.volume > 0 || clip.keyframes.some((key) => key.property === "volume" && key.value > 0))) {
        const volume = clip.keyframes.some((key) => key.property === "volume") ? `volume='if(isnan(t),${number(evaluateKeyframeProperty(clip, "volume", 0), "initial volume")},${keyframeExpression(clip, "volume", "t")})':eval=frame` : `volume=${number(clip.volume, "volume", 0, 2)}`;
        const filters = [`atrim=start=${seconds(clip.sourceIn)}:duration=${seconds(clip.duration * clip.speed)}`, "asetpts=PTS-STARTPTS", ...tempoFilters(clip.speed), "aresample=48000", "aformat=sample_fmts=fltp:channel_layouts=stereo", volume];
        if (clip.fadeIn) filters.push(`afade=t=in:st=0:d=${seconds(clip.fadeIn)}`);
        if (clip.fadeOut) filters.push(`afade=t=out:st=${seconds(clip.duration - clip.fadeOut)}:d=${seconds(clip.fadeOut)}`);
        filters.push(`adelay=${Math.round(clip.start / 5)}S:all=1`);
        const label = `audio${index}`; graph.push(`[${n}:a]${filters.join(",")}[${label}]`); audio.push(label);
      }
    }
    if (visual) {
      const geometryKeys = clip.keyframes.some((key) => key.property === "scale" || key.property === "rotation");
      const geometry = geometryKeys ? animatedGeometry(clip, width, height, frameRate) : undefined;
      const scale = Number(number(clip.transform.scale, "scale", .01, 8));
      const fittedWidth = Math.max(2, Math.round(width * scale / 2) * 2), fittedHeight = Math.max(2, Math.round(height * scale / 2) * 2);
      if (!geometry && (fittedWidth > 8192 || fittedHeight > 8192)) throw new Error("Scaled native render surfaces cannot exceed 8192 pixels per side.");
      const alpha = clip.keyframes.some((key) => key.property === "opacity") ? `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${keyframeExpression(clip, "opacity", "T")})'` : `colorchannelmixer=aa=${number(clip.opacity, "opacity", 0, 1)}`;
      const filters = [...(geometry?.fit || [`scale=${fittedWidth}:${fittedHeight}:force_original_aspect_ratio=decrease`, "setsar=1"]), ...colorFilters(clip.color), alpha];
      if (geometry) filters.push(...geometry.warp);
      else if (clip.transform.rotation) { const angle = `${number(clip.transform.rotation, "rotation", -36000, 36000)}*PI/180`; filters.push(`rotate=${angle}:ow=rotw(${angle}):oh=roth(${angle}):c=none`); }
      if (clip.fadeIn) filters.push(`fade=t=in:st=0:d=${seconds(clip.fadeIn)}:alpha=1`);
      if (clip.fadeOut) filters.push(`fade=t=out:st=${seconds(clip.duration - clip.fadeOut)}:d=${seconds(clip.fadeOut)}:alpha=1`);
      filters.push(`setpts=PTS+${start}/TB`);
      graph.push(`[${visual}]${filters.join(",")}[visual${index}]`);
      const x = keyframeExpression(clip, "x", `(t-${start})`), y = keyframeExpression(clip, "y", `(t-${start})`);
      graph.push(`[canvas${layer}][visual${index}]overlay=x='(W-w)/2+(${x})':y='(H-h)/2+(${y})':eval=frame:enable='gte(t,${start})*lt(t,${seconds(clip.start + clip.duration)})':eof_action=pass:repeatlast=0:format=auto[canvas${++layer}]`);
    }
  }
  for (let index = 0; index < plan.captions.length; index++) {
    const caption = plan.captions[index];
    if (caption.text.length > 10000) throw new Error("Caption text exceeds the native export limit.");
    const font = await fontFile("Arial", options.fontDirectory);
    const fontSize = Math.max(20, height * .042), drawing = [];
    const lines = caption.text.split("\n");
    for (let line = 0; line < lines.length; line++) {
      const text = path.join(options.directory, `caption-${index}-${line}.txt`); await fs.writeFile(text, lines[line] || " ", "utf8");
      // Canvas strokes are centered on the glyph outline; drawtext's border
      // extends outward, so half the canvas lineWidth is used here.
      drawing.push(`drawtext=fontfile='${filterPath(font)}':textfile='${filterPath(text)}':expansion=none:fontsize=${number(fontSize, "caption size")}:fontcolor=white:bordercolor=0x101018:borderw=${number(fontSize * .075, "caption stroke")}:x='(w-text_w)/2':y='${number(height * .88 + line * fontSize * 1.22, "caption baseline")}-text_h/2':enable='gte(t,${seconds(caption.start)})*lt(t,${seconds(caption.end)})'`);
    }
    graph.push(`[canvas${layer}]${drawing.join(",")}[canvas${++layer}]`);
  }
  graph.push(`[canvas${layer}]format=yuv420p[video]`);
  graph.push(`${audio.map((label) => `[${label}]`).join("")}amix=inputs=${audio.length}:duration=longest:dropout_transition=0:normalize=0,atrim=duration=${duration}[audio]`);
  const graphPath = path.join(options.directory, "render.ffgraph"); await fs.writeFile(graphPath, graph.join(";\n"), "utf8");
  return { args: [...inputs, "-filter_complex_threads", "1", "-filter_complex_script", graphPath, "-map", "[video]", "-map", "[audio]", "-t", duration, "-r", fps, "-ar", "48000", "-progress", "pipe:1", "-nostats"], durationSeconds: plan.duration / TB, sourcePaths, graph: graph.join(";\n"), hasText: textCount > 0 || plan.captions.length > 0 };
}
module.exports = { compileRenderPlan, tempoFilters, colorFilters, ffColor, fontFile, keyframeExpression };
