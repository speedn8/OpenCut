import { TIMEBASE, type FrameRate, type Tick } from "./types";
import { ensure } from "./errors";

export function integer(value: unknown, label = "ticks"): asserts value is number {
  ensure(typeof value === "number" && Number.isSafeInteger(value), `${label} must be a safe integer`);
}

export function frameTicks(rate: FrameRate): Tick {
  ensure(rate !== null && typeof rate === "object", "frameRate must be an object");
  integer(rate.numerator, "frameRate.numerator");
  integer(rate.denominator, "frameRate.denominator");
  ensure(rate.numerator > 0 && rate.denominator > 0, "frameRate must be positive");
  const dividend = BigInt(TIMEBASE) * BigInt(rate.denominator);
  const divisor = BigInt(rate.numerator);
  ensure(dividend % divisor === 0n, "frameRate must have integral frame ticks at 240000 Hz");
  const result = Number(dividend / divisor);
  integer(result, "frame duration");
  ensure(result > 0, "frame duration must be positive");
  return result;
}

function rounded(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

export function secondsToTicks(seconds: number): Tick {
  ensure(Number.isFinite(seconds), "seconds must be finite");
  const result = rounded(seconds * TIMEBASE);
  integer(result);
  return result === 0 ? 0 : result;
}

export function ticksToSeconds(ticks: Tick): number {
  integer(ticks);
  return ticks / TIMEBASE;
}

export function snapToFrame(ticks: Tick, rate: FrameRate): Tick {
  integer(ticks);
  const frame = BigInt(frameTicks(rate));
  const magnitude = BigInt(Math.abs(ticks));
  const snapped = ((magnitude + frame / 2n) / frame) * frame;
  const result = Number(ticks < 0 ? -snapped : snapped);
  integer(result, "snapped time");
  return result === 0 ? 0 : result;
}
