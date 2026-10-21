import type { Caption } from "./types";
import { TIMEBASE } from "./types";
import { ensure } from "./errors";
import { newId, validateCaptions } from "./model";

function parseTimestamp(value: string): number {
  const match = /^(\d{2,}):([0-5]\d):([0-5]\d)[,.](\d{3})$/.exec(value);
  ensure(match, `Invalid SRT timestamp: ${value}`);
  const ticks = (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * TIMEBASE + Number(match[4]) * (TIMEBASE / 1000);
  ensure(Number.isSafeInteger(ticks), "SRT timestamp exceeds the supported range"); return ticks;
}
export function parseSrt(text: string): Caption[] {
  ensure(typeof text === "string", "SRT input must be text");
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim(); if (!normalized) return [];
  const captions = normalized.split(/\n[\t ]*\n+/).map((block, index): Caption => {
    const lines = block.split("\n"); if (/^\d+$/.test(lines[0].trim())) lines.shift();
    const match = /^\s*(\d{2,}:[0-5]\d:[0-5]\d[,.]\d{3})\s+-->\s+(\d{2,}:[0-5]\d:[0-5]\d[,.]\d{3})\s*$/.exec(lines.shift() ?? "");
    ensure(match && lines.length > 0 && lines.some((line) => line.trim().length > 0), `Invalid SRT cue ${index + 1}`);
    return { id: newId(), start: parseTimestamp(match[1]), end: parseTimestamp(match[2]), text: lines.join("\n") };
  });
  return validateCaptions(captions).sort((a, b) => a.start - b.start);
}
function timestamp(milliseconds: number): string {
  const hours = Math.floor(milliseconds / 3_600_000), minutes = Math.floor(milliseconds / 60_000) % 60, seconds = Math.floor(milliseconds / 1000) % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(milliseconds % 1000).padStart(3, "0")}`;
}
export function toSrt(captions: Caption[]): string {
  return validateCaptions(captions).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id)).map((caption, index) => {
    const start = Math.round(caption.start * 1000 / TIMEBASE);
    // SRT has millisecond precision; retain a nonzero cue after quantization.
    const end = Math.max(start + 1, Math.round(caption.end * 1000 / TIMEBASE));
    ensure(caption.text.trim().length > 0 && !/\n[\t ]*\n/.test(caption.text), "SRT cue text must be nonempty without blank lines");
    return `${index + 1}\n${timestamp(start)} --> ${timestamp(end)}\n${caption.text}\n`;
  }).join("\n");
}
