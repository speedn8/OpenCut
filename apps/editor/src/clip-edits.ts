import { frameTicks, ticksToSeconds } from "@core";
import type { Asset, Clip, FrameRate, Project, Track } from "@core";

/** Peak envelope for the edited source window, with max aggregation preserving transients. */
export function clipPeaks(asset: Pick<Asset, "duration" | "peaks"> | undefined, clip: Pick<Clip, "sourceIn" | "duration" | "speed">, maxBins = 120): number[] {
  if (!asset?.peaks?.length || asset.duration <= 0) return [];
  const start = Math.max(0, Math.min(asset.duration, clip.sourceIn));
  const end = Math.max(start, Math.min(asset.duration, clip.sourceIn + clip.duration * clip.speed));
  if (end <= start) return [];
  const count = asset.peaks.length;
  const limit = Number.isFinite(maxBins) ? Math.max(1, Math.min(2048, Math.floor(maxBins))) : 120;
  const bins = Math.min(limit, Math.max(1, Math.ceil(end / asset.duration * count) - Math.floor(start / asset.duration * count)));
  return Array.from({ length: bins }, (_, bin) => {
    const from = Math.floor((start + (end - start) * bin / bins) / asset.duration * count);
    const to = Math.min(count, Math.ceil((start + (end - start) * (bin + 1) / bins) / asset.duration * count));
    let peak = 0;
    for (let i = from; i < to; i++) peak = Math.max(peak, Math.min(1, Math.abs(asset.peaks![i])));
    return peak;
  });
}

export function availableTrack(project: Project, kind: Track["kind"], start: number, duration: number, preferredId?: string, excludeClipId?: string): Track | undefined {
  return project.tracks.find(track => (!preferredId || track.id === preferredId) && track.kind === kind && !track.locked && !track.clips.some(clip => clip.id !== excludeClipId && start < clip.start + clip.duration && start + duration > clip.start));
}

export function speedPatch(clip: Clip, speed: number, rate: FrameRate): Partial<Clip> {
  const frame = frameTicks(rate);
  // Round down to a frame so speeding a clip up cannot reveal past source EOF.
  const duration = Math.max(1, Math.floor(clip.duration * clip.speed / speed / frame) * frame);
  const factor = clip.speed / speed;
  const fadeIn = Math.min(duration, Math.floor(clip.fadeIn * factor));
  const fadeOut = Math.min(duration - fadeIn, Math.floor(clip.fadeOut * factor));
  return { speed, duration, fadeIn, fadeOut, keyframes: clip.keyframes.map(key => ({ ...key, time: Math.round(key.time * factor) })) };
}

export function sourceSeconds(clip: Clip, timelineTime: number): number {
  return ticksToSeconds(Math.max(0, Math.round(clip.sourceIn + (timelineTime - clip.start) * clip.speed)));
}
