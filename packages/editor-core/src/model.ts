import type { Asset, Caption, Clip, FrameRate, Keyframe, Marker, Project, ProjectSettings, Track } from "./types";
import { TIMEBASE } from "./types";
import { ensure } from "./errors";
import { frameTicks, integer } from "./time";

export const newId = (): string => crypto.randomUUID();
const MAX_ITEMS = 100_000;

export function record(value: unknown, label: string, keys?: readonly string[]): Record<string, unknown> {
  ensure(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  ensure(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, `${label} must be a plain object`);
  if (keys) ensure(Object.keys(value).every((key) => keys.includes(key)), `${label} contains unsupported fields`);
  return value as Record<string, unknown>;
}
function list(value: unknown, label: string): unknown[] {
  ensure(Array.isArray(value) && value.length <= MAX_ITEMS, `${label} must be an array of at most ${MAX_ITEMS} items`);
  return value;
}
function text(value: unknown, label: string, nonempty = false): string {
  ensure(typeof value === "string" && value.length <= 1_000_000 && !value.includes("\0") && (!nonempty || value.trim().length > 0), `${label} must be ${nonempty ? "nonempty " : ""}text`);
  return value;
}
function finite(value: unknown, label: string, minimum = -Number.MAX_VALUE, maximum = Number.MAX_VALUE): number {
  ensure(typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum, `${label} must be finite in [${minimum}, ${maximum}]`);
  return value;
}
function tick(value: unknown, label: string, minimum = 0): number {
  integer(value, label); ensure(value >= minimum, `${label} must be >= ${minimum}`); return value;
}
function bool(value: unknown, label: string): boolean { ensure(typeof value === "boolean", `${label} must be boolean`); return value; }
function oneOf<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  ensure(typeof value === "string" && choices.includes(value as T), `${label} must be one of ${choices.join(", ")}`); return value as T;
}
function unique(values: readonly { id: string }[], label: string) { ensure(new Set(values.map((item) => item.id)).size === values.length, `${label} contains duplicate IDs`); }
function date(value: unknown, label: string): string {
  const result = text(value, label, true); ensure(/^\d{4}-\d\d-\d\dT/.test(result) && Number.isFinite(Date.parse(result)), `${label} must be an ISO timestamp`); return result;
}

export function validateFrameRate(value: unknown): FrameRate {
  const v = record(value, "frameRate", ["numerator", "denominator"]);
  const result = { numerator: tick(v.numerator, "frameRate.numerator", 1), denominator: tick(v.denominator, "frameRate.denominator", 1) };
  frameTicks(result); return result;
}
function validateSourceFrameRate(value: unknown): FrameRate {
  const v = record(value, "source frameRate", ["numerator", "denominator"]);
  const result = { numerator: tick(v.numerator, "source frameRate.numerator", 1), denominator: tick(v.denominator, "source frameRate.denominator", 1) };
  const framesPerSecond = result.numerator / result.denominator;
  ensure(Number.isFinite(framesPerSecond) && framesPerSecond > 0 && framesPerSecond <= 1000, "source frameRate must be positive and at most 1000 fps");
  // A measured VFR average describes the source; it is not the project's edit
  // grid and need not have an integral frame duration at the timeline timebase.
  return result;
}
export function validateSettings(value: unknown): ProjectSettings {
  const v = record(value, "settings", ["width", "height", "frameRate", "sampleRate", "background"]);
  ensure(v.sampleRate === 48000, "sampleRate must be 48000");
  const width = tick(v.width, "width", 1), height = tick(v.height, "height", 1);
  ensure(width <= 32768 && height <= 32768, "canvas dimensions exceed 32768");
  return { width, height, frameRate: validateFrameRate(v.frameRate), sampleRate: 48000, background: text(v.background, "background", true) };
}
export function validateAsset(value: unknown): Asset {
  const v = record(value, "asset", ["id", "name", "kind", "duration", "width", "height", "frameRate", "hasAudio", "url", "proxyUrl", "thumbnail", "peaks"]);
  const kind = oneOf(v.kind, ["video", "audio", "image"], "asset.kind");
  const result: Asset = { id: text(v.id, "asset.id", true), name: text(v.name, "asset.name", true), kind, duration: tick(v.duration, "asset.duration", kind === "image" ? 0 : 1), hasAudio: bool(v.hasAudio, "asset.hasAudio"), url: text(v.url, "asset.url", true) };
  if (v.width !== undefined) result.width = tick(v.width, "asset.width", 1);
  if (v.height !== undefined) result.height = tick(v.height, "asset.height", 1);
  if (v.frameRate !== undefined) result.frameRate = validateSourceFrameRate(v.frameRate);
  if (v.proxyUrl !== undefined) result.proxyUrl = text(v.proxyUrl, "asset.proxyUrl", true);
  if (v.thumbnail !== undefined) result.thumbnail = text(v.thumbnail, "asset.thumbnail");
  if (v.peaks !== undefined) result.peaks = list(v.peaks, "asset.peaks").map((value) => finite(value, "peak", -1, 1));
  return result;
}
export function validateKeyframe(value: unknown): Keyframe {
  const v = record(value, "keyframe", ["id", "time", "property", "value", "easing"]);
  const property = oneOf(v.property, ["x", "y", "scale", "rotation", "opacity", "volume"], "keyframe.property");
  // Keys outside visible clip bounds retain interpolation context after cuts.
  const time = tick(v.time, "keyframe.time", -Number.MAX_SAFE_INTEGER);
  const result = finite(v.value, "keyframe.value", property === "opacity" || property === "volume" ? 0 : property === "scale" ? Number.MIN_VALUE : -Number.MAX_VALUE, property === "opacity" ? 1 : property === "volume" ? 2 : Number.MAX_VALUE);
  return { id: text(v.id, "keyframe.id", true), time, property, value: result, easing: oneOf(v.easing, ["linear", "hold", "smooth"], "keyframe.easing") };
}
export function validateClip(value: unknown): Clip {
  const v = record(value, "clip", ["id", "name", "kind", "assetId", "start", "duration", "sourceIn", "speed", "volume", "opacity", "transform", "color", "fadeIn", "fadeOut", "text", "keyframes"]);
  const transform = record(v.transform, "transform", ["x", "y", "scale", "rotation"]), color = record(v.color, "color", ["brightness", "contrast", "saturation"]);
  const result: Clip = {
    id: text(v.id, "clip.id", true), name: text(v.name, "clip.name", true), kind: oneOf(v.kind, ["video", "audio", "image", "text"], "clip.kind"),
    start: tick(v.start, "clip.start"), duration: tick(v.duration, "clip.duration", 1), sourceIn: tick(v.sourceIn, "clip.sourceIn"), speed: finite(v.speed, "clip.speed", Number.MIN_VALUE),
    volume: finite(v.volume, "clip.volume", 0, 2), opacity: finite(v.opacity, "clip.opacity", 0, 1),
    transform: { x: finite(transform.x, "x"), y: finite(transform.y, "y"), scale: finite(transform.scale, "scale", Number.MIN_VALUE), rotation: finite(transform.rotation, "rotation") },
    color: { brightness: finite(color.brightness, "brightness", 0, 2), contrast: finite(color.contrast, "contrast", 0, 2), saturation: finite(color.saturation, "saturation", 0, 2) },
    fadeIn: tick(v.fadeIn, "fadeIn"), fadeOut: tick(v.fadeOut, "fadeOut"), keyframes: list(v.keyframes, "keyframes").map(validateKeyframe),
  };
  integer(result.start + result.duration, "clip end");
  ensure(result.fadeIn + result.fadeOut <= result.duration, "clip fades exceed duration");
  unique(result.keyframes, "keyframes");
  const keyPositions = result.keyframes.map((key) => `${key.property}:${key.time}`);
  ensure(new Set(keyPositions).size === keyPositions.length, "keyframe property/time must be unique");
  if (v.assetId !== undefined) result.assetId = text(v.assetId, "clip.assetId", true);
  if (v.text !== undefined) {
    const t = record(v.text, "text", ["content", "fontFamily", "fontSize", "color", "background", "align"]);
    result.text = { content: text(t.content, "text.content"), fontFamily: text(t.fontFamily, "fontFamily", true), fontSize: finite(t.fontSize, "fontSize", 1, 4096), color: text(t.color, "text.color", true), background: text(t.background, "text.background", true), align: oneOf(t.align, ["left", "center", "right"], "text.align") };
  }
  ensure(result.kind === "text" ? result.text !== undefined && result.assetId === undefined && result.sourceIn === 0 : result.assetId !== undefined && result.text === undefined, "clip source/text fields do not match its kind");
  return result;
}
export function validateCaptions(value: unknown): Caption[] {
  const result = list(value, "captions").map((item): Caption => {
    const v = record(item, "caption", ["id", "start", "end", "text", "words"]);
    const caption: Caption = { id: text(v.id, "caption.id", true), start: tick(v.start, "caption.start"), end: tick(v.end, "caption.end"), text: text(v.text, "caption.text") };
    ensure(caption.end > caption.start, "caption end must follow start");
    if (v.words !== undefined) caption.words = list(v.words, "caption.words").map((item) => {
      const w = record(item, "word", ["text", "start", "end"]);
      const word = { text: text(w.text, "word.text"), start: tick(w.start, "word.start"), end: tick(w.end, "word.end") };
      ensure(word.start >= caption.start && word.end > word.start && word.end <= caption.end, "caption word exceeds caption bounds"); return word;
    });
    return caption;
  });
  unique(result, "captions"); return result;
}
export function compatible(track: Track, clip: Clip): boolean { return track.kind === "audio" ? clip.kind === "audio" : track.kind === "text" ? clip.kind === "text" : clip.kind === "video" || clip.kind === "image"; }

export function validateProject(value: unknown): Project {
  const v = record(value, "project", ["schemaVersion", "id", "name", "revision", "createdAt", "updatedAt", "settings", "assets", "tracks", "captions", "markers"]);
  ensure(v.schemaVersion === 1, "unsupported project schemaVersion");
  const assets: Record<string, Asset> = Object.create(null);
  const rawAssets = record(v.assets, "assets"); ensure(Object.keys(rawAssets).length <= MAX_ITEMS, "too many assets");
  for (const [id, value] of Object.entries(rawAssets)) { const asset = validateAsset(value); ensure(id === asset.id, "asset record key must equal asset.id"); assets[id] = asset; }
  const tracks = list(v.tracks, "tracks").map((item): Track => {
    const t = record(item, "track", ["id", "name", "kind", "muted", "locked", "clips"]);
    const track: Track = { id: text(t.id, "track.id", true), name: text(t.name, "track.name", true), kind: oneOf(t.kind, ["video", "audio", "text"], "track.kind"), muted: bool(t.muted, "track.muted"), locked: bool(t.locked, "track.locked"), clips: list(t.clips, "clips").map(validateClip) };
    for (const clip of track.clips) {
      ensure(compatible(track, clip), "clip is incompatible with its track");
      if (clip.assetId !== undefined) {
        const asset = assets[clip.assetId]; ensure(asset && asset.kind === clip.kind, "clip references a missing or incompatible asset");
        // Source bounds are conservative: fractional source ticks consume the
        // containing tick rather than allowing an overrun rounded down to zero.
        const span = Math.ceil(clip.duration * clip.speed); integer(span, "source span");
        if (asset.kind !== "image") ensure(clip.sourceIn + span <= asset.duration, "clip exceeds source duration");
      }
    }
    return track;
  });
  unique(tracks, "tracks"); unique(tracks.flatMap((track) => track.clips), "clips");
  const markers = list(v.markers, "markers").map((item): Marker => { const m = record(item, "marker", ["id", "time", "label", "color"]); return { id: text(m.id, "marker.id", true), time: tick(m.time, "marker.time"), label: text(m.label, "marker.label"), color: text(m.color, "marker.color", true) }; });
  unique(markers, "markers");
  return { schemaVersion: 1, id: text(v.id, "project.id", true), name: text(v.name, "project.name", true), revision: tick(v.revision, "project.revision"), createdAt: date(v.createdAt, "createdAt"), updatedAt: date(v.updatedAt, "updatedAt"), settings: validateSettings(v.settings), assets, tracks, captions: validateCaptions(v.captions), markers };
}

export function createProject(options: { id?: string; name?: string; width?: number; height?: number; frameRate?: FrameRate } = {}): Project {
  const now = new Date().toISOString();
  return validateProject({ schemaVersion: 1, id: options.id ?? newId(), name: options.name ?? "Untitled project", revision: 0, createdAt: now, updatedAt: now, settings: { width: options.width ?? 1920, height: options.height ?? 1080, frameRate: options.frameRate ?? { numerator: 30, denominator: 1 }, sampleRate: 48000, background: "#111318" }, assets: {}, tracks: [ { id: newId(), name: "Video 1", kind: "video", muted: false, locked: false, clips: [] }, { id: newId(), name: "Audio 1", kind: "audio", muted: false, locked: false, clips: [] }, { id: newId(), name: "Text 1", kind: "text", muted: false, locked: false, clips: [] } ], captions: [], markers: [] });
}
function baseClip(id: string, name: string, kind: Clip["kind"], start: number, duration: number): Clip {
  return { id, name, kind, start, duration, sourceIn: 0, speed: 1, volume: 1, opacity: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, color: { brightness: 1, contrast: 1, saturation: 1 }, fadeIn: 0, fadeOut: 0, keyframes: [] };
}
export function createClip({ id = newId(), asset, start = 0, duration }: { id?: string; asset: Asset; start?: number; duration?: number }): Clip {
  const source = validateAsset(asset);
  const clip = validateClip({ ...baseClip(id, source.name, source.kind, start, duration ?? (source.kind === "image" ? TIMEBASE * 5 : source.duration)), assetId: source.id });
  ensure(source.kind === "image" || clip.duration <= source.duration, "clip exceeds source duration"); return clip;
}
export function createTextClip({ id = newId(), text: content = "Your text", start = 0, duration = TIMEBASE * 5 }: { id?: string; text?: string; start?: number; duration?: number } = {}): Clip {
  return validateClip({ ...baseClip(id, content.trim() || "Text", "text", start, duration), text: { content, fontFamily: "Arial", fontSize: 64, color: "#ffffff", background: "transparent", align: "center" } });
}
export function projectDuration(project: Project): number {
  let duration = 0;
  for (const track of project.tracks) for (const clip of track.clips) duration = Math.max(duration, clip.start + clip.duration);
  for (const caption of project.captions) duration = Math.max(duration, caption.end);
  return duration;
}
