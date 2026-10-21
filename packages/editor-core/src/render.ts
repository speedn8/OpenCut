import type { Clip, Keyframe, Project, RenderPlan } from "./types";
import { projectDuration, validateClip, validateProject } from "./model";
import { integer } from "./time";

function baseValue(clip: Clip, property: Keyframe["property"]): number { return property === "opacity" || property === "volume" ? clip[property] : clip.transform[property]; }
export function evaluateKeyframeProperty(clip: Clip, property: Keyframe["property"], time: number): number {
  const keys = clip.keyframes.filter((key) => key.property === property).sort((a, b) => a.time - b.time);
  if (!keys.length) return baseValue(clip, property);
  if (time <= keys[0].time) return keys[0].value;
  for (let index = 1; index < keys.length; index++) {
    const right = keys[index], left = keys[index - 1];
    if (time === right.time) return right.value;
    if (time < right.time) {
      const progress = (time - left.time) / (right.time - left.time);
      const weight = left.easing === "hold" ? 0 : left.easing === "smooth" ? progress * progress * (3 - 2 * progress) : progress;
      // Weighted endpoints avoid overflow when two finite values have a
      // difference outside the finite-number range.
      return (1 - weight) * left.value + weight * right.value;
    }
  }
  return keys.at(-1)!.value;
}
export function evaluateClip(clip: Clip, timeRelativeToClip: number): Clip {
  integer(timeRelativeToClip, "clip-local time");
  const result = validateClip(clip), time = Math.max(0, Math.min(clip.duration, timeRelativeToClip));
  for (const property of ["x", "y", "scale", "rotation"] as const) result.transform[property] = evaluateKeyframeProperty(clip, property, time);
  result.opacity = evaluateKeyframeProperty(clip, "opacity", time); result.volume = evaluateKeyframeProperty(clip, "volume", time);
  const gain = Math.min(1, clip.fadeIn > 0 ? time / clip.fadeIn : 1, clip.fadeOut > 0 ? (clip.duration - time) / clip.fadeOut : 1);
  result.opacity *= gain; result.volume *= gain;
  return result;
}
export function buildRenderPlan(project: Project): RenderPlan {
  const source = validateProject(project);
  return { schemaVersion: 1, settings: source.settings, duration: projectDuration(source), captions: source.captions.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id)), segments: source.tracks.flatMap((track, trackIndex) => track.clips.map((clip) => ({ trackId: track.id, trackIndex, clip: track.muted ? { ...clip, volume: 0, keyframes: clip.keyframes.map((key) => key.property === "volume" ? { ...key, value: 0 } : key) } : clip, ...(clip.assetId ? { asset: source.assets[clip.assetId] } : {}) }))).sort((a, b) => a.trackIndex - b.trackIndex || a.clip.start - b.clip.start || a.clip.id.localeCompare(b.clip.id)) };
}
