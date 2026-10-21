import type { Caption, Clip } from "@core";
import { uid } from "./session";

/** Whole-source transcript ticks become current clip timeline ticks, never cached edit positions. */
export function mapTranscription(values: unknown[], clip?: Clip): Caption[] {
  return values.flatMap(value => {
    if (!value || typeof value !== "object" || !("text" in value) || !("start" in value) || !("end" in value) || typeof value.text !== "string" || typeof value.start !== "number" || typeof value.end !== "number" || !Number.isFinite(value.start) || !Number.isFinite(value.end)) return [];
    const sourceStart = clip?.sourceIn ?? 0;
    const speed = clip?.speed ?? 1;
    const timelineStart = clip?.start ?? 0;
    const start = Math.max(timelineStart, timelineStart + (value.start - sourceStart) / speed);
    const end = Math.min(clip ? clip.start + clip.duration : Infinity, timelineStart + (value.end - sourceStart) / speed);
    return end > start ? [{ id: uid(), text: value.text, start: Math.round(start), end: Math.round(end) }] : [];
  });
}
