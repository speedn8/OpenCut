import type { Clip, Command, Project, Track } from "./types";
import { EditorError, ensure } from "./errors";
import { compatible, newId, record, validateAsset, validateCaptions, validateClip, validateKeyframe, validateProject } from "./model";
import { integer } from "./time";

function trackById(project: Project, id: string): Track {
  const track = project.tracks.find((track) => track.id === id);
  if (!track) throw new EditorError("NOT_FOUND", `Track ${id} does not exist`);
  return track;
}
function clipById(project: Project, id: string): { track: Track; clip: Clip } {
  for (const track of project.tracks) { const clip = track.clips.find((clip) => clip.id === id); if (clip) return { track, clip }; }
  throw new EditorError("NOT_FOUND", `Clip ${id} does not exist`);
}
function unlocked(track: Track) { if (track.locked) throw new EditorError("LOCKED", `Track ${track.name} is locked`); }
function unusedClipId(project: Project, id: string) { ensure(typeof id === "string" && id.trim().length > 0, "new clip ID must be nonempty"); if (project.tracks.some((track) => track.clips.some((clip) => clip.id === id))) throw new EditorError("CONFLICT", `Clip ID ${id} already exists`); }
function fitFades(clip: Clip) { clip.fadeIn = Math.min(clip.fadeIn, clip.duration); clip.fadeOut = Math.min(clip.fadeOut, clip.duration - clip.fadeIn); }
function commandFields(command: Command, keys: string[]) { record(command, "command", ["type", ...keys]); }

function execute(project: Project, command: Command, depth = 0, budget = { remaining: 10_000 }): void {
  record(command, "command"); ensure(depth < 32, "batch nesting exceeds 32"); ensure(budget.remaining-- > 0, "batch exceeds 10000 total commands");
  switch (command.type) {
    case "asset.add": {
      commandFields(command, ["assets"]); ensure(Array.isArray(command.assets) && command.assets.length > 0, "assets must be a nonempty array");
      for (const value of command.assets) { const asset = validateAsset(value); if (Object.hasOwn(project.assets, asset.id)) throw new EditorError("CONFLICT", `Asset ${asset.id} already exists`); project.assets[asset.id] = asset; }
      break;
    }
    case "asset.update": {
      commandFields(command, ["assetId", "patch"]);
      if (!Object.hasOwn(project.assets, command.assetId)) throw new EditorError("NOT_FOUND", `Asset ${command.assetId} does not exist`);
      const patch = record(command.patch, "asset patch", ["name", "kind", "duration", "width", "height", "frameRate", "hasAudio", "url", "proxyUrl", "thumbnail", "peaks"]);
      project.assets[command.assetId] = validateAsset({ ...project.assets[command.assetId], ...patch });
      break;
    }
    case "track.add": {
      commandFields(command, ["track"]); const input = record(command.track, "track");
      if (project.tracks.some((track) => track.id === input.id)) throw new EditorError("CONFLICT", "Track ID already exists");
      project.tracks.push(structuredClone(command.track)); break;
    }
    case "track.update": {
      commandFields(command, ["trackId", "patch"]); const track = trackById(project, command.trackId);
      Object.assign(track, record(command.patch, "track patch", ["name", "muted", "locked"])); break;
    }
    case "clip.add": {
      commandFields(command, ["trackId", "clip"]); const track = trackById(project, command.trackId); unlocked(track);
      const clip = validateClip(command.clip); unusedClipId(project, clip.id); ensure(compatible(track, clip), "clip is incompatible with destination track"); track.clips.push(clip); break;
    }
    case "clip.remove": {
      commandFields(command, ["clipIds", "ripple"]); ensure(Array.isArray(command.clipIds) && command.clipIds.length > 0 && new Set(command.clipIds).size === command.clipIds.length, "clipIds must be nonempty and unique");
      if (command.ripple !== undefined) ensure(typeof command.ripple === "boolean", "ripple must be boolean");
      const selected = command.clipIds.map((id) => clipById(project, id)); for (const item of selected) unlocked(item.track);
      const ids = new Set(command.clipIds);
      for (const track of project.tracks) {
        const removed = track.clips.filter((clip) => ids.has(clip.id)); if (!removed.length) continue;
        const intervals = removed.map((clip) => [clip.start, clip.start + clip.duration] as [number, number]).sort((a, b) => a[0] - b[0]);
        const union: [number, number][] = [];
        for (const interval of intervals) { const previous = union.at(-1); if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1]); else union.push([...interval]); }
        track.clips = track.clips.filter((clip) => !ids.has(clip.id)).map((clip) => {
          if (command.ripple) clip.start -= union.reduce((sum, [start, end]) => sum + Math.max(0, Math.min(clip.start, end) - start), 0);
          return clip;
        });
      }
      break;
    }
    case "clip.move": {
      commandFields(command, ["clipId", "trackId", "start"]); const source = clipById(project, command.clipId), destination = trackById(project, command.trackId); unlocked(source.track); unlocked(destination);
      integer(command.start, "clip start"); ensure(command.start >= 0 && compatible(destination, source.clip), "invalid clip destination");
      source.track.clips = source.track.clips.filter((clip) => clip.id !== command.clipId); source.clip.start = command.start; destination.clips.push(source.clip); break;
    }
    case "clip.split": {
      commandFields(command, ["clipId", "time", "rightId"]); const { track, clip } = clipById(project, command.clipId); unlocked(track); unusedClipId(project, command.rightId); integer(command.time, "split time");
      const offset = command.time - clip.start; if (offset <= 0 || offset >= clip.duration) throw new EditorError("BOUNDS", "Split must lie strictly inside the clip");
      const right: Clip = structuredClone(clip); right.id = command.rightId; right.start = command.time; right.duration -= offset;
      // An integer sourceIn uses the preceding source tick. Together with
      // ceil(source span) validation this keeps both halves inside the source,
      // including a split at a fractional-speed boundary (error < one tick).
      if (clip.kind !== "text" && clip.kind !== "image") right.sourceIn += Math.floor(offset * clip.speed);
      right.keyframes = right.keyframes.map((key) => ({ ...key, id: newId(), time: key.time - offset }));
      // Fades belong to outer clip edges; a split never adds a fade at the cut.
      right.fadeIn = 0; clip.fadeOut = 0; clip.duration = offset; fitFades(clip); fitFades(right); track.clips.push(right); break;
    }
    case "clip.trim": {
      commandFields(command, ["clipId", "edge", "time"]); const { track, clip } = clipById(project, command.clipId); unlocked(track); integer(command.time, "trim time"); ensure(command.edge === "in" || command.edge === "out", "invalid trim edge");
      if (command.edge === "in") {
        const offset = command.time - clip.start, nextDuration = clip.duration - offset;
        if (command.time < 0 || nextDuration <= 0) throw new EditorError("BOUNDS", "Invalid in trim boundary");
        if (clip.kind !== "text" && clip.kind !== "image") clip.sourceIn += Math.floor(offset * clip.speed);
        clip.start = command.time; clip.duration = nextDuration; clip.keyframes = clip.keyframes.map((key) => ({ ...key, time: key.time - offset }));
      } else { if (command.time <= clip.start) throw new EditorError("BOUNDS", "Out trim must follow clip start"); clip.duration = command.time - clip.start; }
      fitFades(clip); break;
    }
    case "clip.update": {
      commandFields(command, ["clipId", "patch"]); const { track, clip } = clipById(project, command.clipId); unlocked(track);
      Object.assign(clip, structuredClone(record(command.patch, "clip patch", ["name", "start", "duration", "sourceIn", "speed", "volume", "opacity", "transform", "color", "fadeIn", "fadeOut", "text", "keyframes"]))); break;
    }
    case "clip.duplicate": {
      commandFields(command, ["clipId", "newId", "start"]); const { track, clip } = clipById(project, command.clipId); unlocked(track); unusedClipId(project, command.newId);
      const copy = structuredClone(clip); copy.id = command.newId; copy.start = command.start ?? clip.start + clip.duration; copy.keyframes = copy.keyframes.map((key) => ({ ...key, id: newId() })); track.clips.push(copy); break;
    }
    case "project.rename": commandFields(command, ["name"]); project.name = command.name; break;
    case "project.settings": commandFields(command, ["patch"]); Object.assign(project.settings, structuredClone(record(command.patch, "settings patch", ["width", "height", "frameRate", "sampleRate", "background"]))); break;
    case "captions.replace": commandFields(command, ["captions"]); project.captions = validateCaptions(command.captions); break;
    case "caption.update": {
      commandFields(command, ["captionId", "patch"]); const caption = project.captions.find((caption) => caption.id === command.captionId); if (!caption) throw new EditorError("NOT_FOUND", `Caption ${command.captionId} does not exist`);
      Object.assign(caption, record(command.patch, "caption patch", ["text", "start", "end"])); break;
    }
    case "marker.add": commandFields(command, ["marker"]); project.markers.push(structuredClone(command.marker)); break;
    case "keyframe.set": {
      commandFields(command, ["clipId", "keyframe"]); const { track, clip } = clipById(project, command.clipId); unlocked(track); const key = validateKeyframe(command.keyframe);
      clip.keyframes = clip.keyframes.filter((candidate) => candidate.id !== key.id && !(candidate.property === key.property && candidate.time === key.time)); clip.keyframes.push(key); clip.keyframes.sort((a, b) => a.time - b.time || a.property.localeCompare(b.property)); break;
    }
    case "batch": commandFields(command, ["commands", "label"]); ensure(Array.isArray(command.commands) && command.commands.length > 0 && command.commands.length <= 10_000, "batch must contain 1..10000 commands"); for (const child of command.commands) execute(project, child, depth + 1, budget); break;
    default: throw new EditorError("UNSUPPORTED", "Unknown command type");
  }
}

export function applyCommand(project: Project, command: Command): Project {
  const working = validateProject(project);
  execute(working, command);
  working.revision = project.revision + 1; working.updatedAt = new Date().toISOString();
  return validateProject(working);
}
