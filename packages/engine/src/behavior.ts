import type {
  Animatable,
  FrameRate,
  InertiaBehavior,
  Interpolation,
  Keyframe,
  LoopBehavior,
  OscillateBehavior,
  PositionTrack,
  SpatialHandles,
  Vec2,
  WiggleBehavior,
} from "@kynimo/scene";
import { murmurStep } from "./hash.js";
import { cubicPath } from "./path.js";
import { sampleNumber, samplePosition } from "./track.js";

/**
 * Pure evaluation of behaviors (ADR-0039). Every function depends only on its arguments: no state,
 * no other frames sampled for velocity, randomness only from the behavior's `seed`.
 * Values are component arrays: one entry for a number property, two for `[x, y]`.
 */

type Components = readonly number[];

// ---------------------------------------------------------------------------------------------
// Noise (wiggle)
// ---------------------------------------------------------------------------------------------

/**
 * Integer hash of (seed, axis, octave, lattice index) to an unsigned 32-bit value: murmur3's block
 * and finalizer steps over four words. The lattice index arrives as two 32-bit words so negative
 * and very large indices (up to 2^53) never collide through wrap-around. Integer math only.
 */
export function hashLattice(seed: number, axis: number, octave: number, index: number): number {
  const lo = index >>> 0;
  const hi = Math.floor(index / 4294967296) | 0;
  let h = seed >>> 0;
  h = murmurStep(h, ((axis & 1) << 4) | (octave & 15));
  h = murmurStep(h, lo);
  h = murmurStep(h, hi);
  h ^= 16; // total length in bytes, as murmur3 does
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The lattice value at an integer index, in [-1, 1]. */
const lattice = (seed: number, axis: number, octave: number, index: number): number =>
  (hashLattice(seed, axis, octave, index) / 4294967295) * 2 - 1;

/** Value noise in [-1, 1]: lattice values at `floor(x)` and the next, blended by the quintic smoothstep. */
export function noise1d(seed: number, axis: number, octave: number, x: number): number {
  const i = Math.floor(x);
  const u = x - i;
  const a = lattice(seed, axis, octave, i);
  const b = lattice(seed, axis, octave, i + 1);
  const s = u * u * u * (u * (6 * u - 15) + 10);
  return a + (b - a) * s;
}

/**
 * Wiggle noise in [-1, 1] at time `t` seconds: `octaves` octaves of {@link noise1d} at
 * `t · frequency · 2^o`, weighted `0.5^o` and divided by the total weight.
 */
export function wiggleNoise(
  seed: number,
  axis: number,
  octaves: number,
  t: number,
  frequency: number,
): number {
  let sum = 0;
  let weights = 0;
  for (let o = 0; o < octaves; o++) {
    const weight = 1 / (1 << o);
    sum += weight * noise1d(seed, axis, o, t * frequency * (1 << o));
    weights += weight;
  }
  return sum / weights;
}

/** The wiggle's offset for each component: noise per axis (axis 0 for all when `linked`) times the amplitude. */
export function wiggleOffset(
  b: Pick<WiggleBehavior, "seed" | "octaves" | "linked">,
  amplitude: Components,
  t: number,
  frequency: number,
): number[] {
  return amplitude.map((a, axis) => {
    const noiseAxis = b.linked || axis > 1 ? 0 : axis;
    return wiggleNoise(b.seed, noiseAxis, b.octaves, t, frequency) * a;
  });
}

// ---------------------------------------------------------------------------------------------
// Oscillate
// ---------------------------------------------------------------------------------------------

const frac = (x: number): number => x - Math.floor(x);

/** A waveform in [-1, 1] at time `t` seconds. */
export function waveform(
  kind: OscillateBehavior["waveform"],
  frequency: number,
  phaseDegrees: number,
  t: number,
): number {
  const theta = 2 * Math.PI * frequency * t + (phaseDegrees * Math.PI) / 180;
  switch (kind) {
    case "sine":
      return Math.sin(theta);
    case "triangle":
      return (2 / Math.PI) * Math.asin(Math.sin(theta));
    case "square":
      return Math.sin(theta) >= 0 ? 1 : -1;
    case "sawtooth":
      return 2 * frac(theta / (2 * Math.PI)) - 1;
  }
}

// ---------------------------------------------------------------------------------------------
// Keyframe groups: what loop and inertia see of a track
// ---------------------------------------------------------------------------------------------

/** Any transform property track. */
export type PropertyTrack = Animatable<number> | Animatable<Vec2> | PositionTrack;

/**
 * Keyframes that share timing, plus a sampler. Most tracks are one group; a position split into
 * separate X and Y tracks is two single-component groups, each with its own keyframes (as separated
 * dimensions are separate properties in After Effects). A constant track has no keyframes.
 */
export interface TrackGroup {
  readonly frames: readonly number[];
  readonly interpolations: readonly Interpolation[];
  readonly values: readonly Components[];
  /** Position keyframes' spatial handles, aligned with `frames`. */
  readonly spatial: readonly (SpatialHandles | undefined)[];
  sample(frame: number, fps: FrameRate): Components;
}

function groupOf<K extends Keyframe<unknown> & { spatial?: SpatialHandles }>(
  keyframes: readonly K[],
  toComponents: (value: K["value"]) => Components,
  sample: (frame: number, fps: FrameRate) => Components,
): TrackGroup {
  return {
    frames: keyframes.map((k) => k.frame),
    interpolations: keyframes.map((k) => k.interpolation),
    values: keyframes.map((k) => toComponents(k.value)),
    spatial: keyframes.map((k) => k.spatial),
    sample,
  };
}

const numberGroup = (track: Animatable<number>): TrackGroup =>
  groupOf<Keyframe<number>>(
    "keyframes" in track ? track.keyframes : [],
    (v) => [v],
    (frame, fps) => [sampleNumber(track, frame, fps)],
  );

const vectorGroup = (track: PositionTrack): TrackGroup =>
  groupOf(
    "keyframes" in track ? track.keyframes : [],
    (v: Vec2) => v,
    (frame, fps) => samplePosition(track, frame, fps),
  );

/**
 * Groups built per track object. Building one copies every keyframe (up to the schema's cap), and
 * evaluation asks again for every (layer, property, frame), so without this each ask would cost
 * O(keyframes). Safe because documents are immutable while evaluated and the key is the track's
 * identity: an edited document has new track objects, so a stale entry is never read, and the
 * WeakMap lets old documents' entries go. `vector` is fixed by the property a track belongs to.
 */
const groupCache = new WeakMap<object, TrackGroup[]>();

/** The groups of a property's track; `vector` is true for `[x, y]` properties. */
export function trackGroups(track: PropertyTrack, vector: boolean): TrackGroup[] {
  const cached = groupCache.get(track);
  if (cached !== undefined) return cached;
  const groups =
    "separate" in track
      ? [numberGroup(track.separate.x), numberGroup(track.separate.y)]
      : [vector ? vectorGroup(track as PositionTrack) : numberGroup(track as Animatable<number>)];
  groupCache.set(track, groups);
  return groups;
}

// ---------------------------------------------------------------------------------------------
// Velocity
// ---------------------------------------------------------------------------------------------

const MAX_SLOPE = 10;
const clampSlope = (s: number): number => Math.min(MAX_SLOPE, Math.max(-MAX_SLOPE, s));

/**
 * The easing's derivative at the segment's end (`atEnd`) or start: 1 for linear; 0 for hold and
 * spring; for a bezier `(1 - y2) / (1 - x2)` at the end and `y1 / x1` at the start, 0 when the
 * denominator is 0 and the numerator is too, otherwise ±10. Always within ±10.
 */
export function easingSlope(interpolation: Interpolation, atEnd: boolean): number {
  switch (interpolation.type) {
    case "linear":
      return 1;
    case "hold":
    case "spring":
      return 0;
    case "bezier": {
      const numerator = atEnd ? 1 - interpolation.y2 : interpolation.y1;
      const denominator = atEnd ? 1 - interpolation.x2 : interpolation.x1;
      if (denominator === 0) return numerator === 0 ? 0 : numerator > 0 ? MAX_SLOPE : -MAX_SLOPE;
      return clampSlope(numerator / denominator);
    }
  }
}

const isZero = (v: Components) => v.every((x) => x === 0);

/** Velocity (units per second) at one end of the segment `from → to` (keyframe indices). */
function segmentVelocity(
  group: TrackGroup,
  from: number,
  fps: FrameRate,
  atEnd: boolean,
): number[] {
  const to = from + 1;
  const a = group.values[from] as Components;
  const b = group.values[to] as Components;
  const seconds =
    (((group.frames[to] as number) - (group.frames[from] as number)) * fps.den) / fps.num;
  const slope = easingSlope(group.interpolations[from] as Interpolation, atEnd);
  const out = group.spatial[from]?.outTangent ?? [0, 0];
  const inn = group.spatial[to]?.inTangent ?? [0, 0];
  if (a.length === 2 && !(isZero(out) && isZero(inn))) {
    const path = cubicPath(
      [a[0] as number, a[1] as number],
      [(a[0] as number) + out[0], (a[1] as number) + out[1]],
      [(b[0] as number) + inn[0], (b[1] as number) + inn[1]],
      [b[0] as number, b[1] as number],
    );
    const dir = atEnd ? path.endDir : path.startDir;
    return dir.map((d) => (d * path.length * slope) / seconds);
  }
  return b.map((x, i) => ((x - (a[i] as number)) * slope) / seconds);
}

/** Velocity the track arrives at keyframe `k` (k ≥ 1) with, in units per second. */
export const incomingVelocity = (group: TrackGroup, k: number, fps: FrameRate): number[] =>
  segmentVelocity(group, k - 1, fps, true);

/** Velocity the track leaves the first keyframe with, in units per second. */
export const outgoingVelocity = (group: TrackGroup, fps: FrameRate): number[] =>
  segmentVelocity(group, 0, fps, false);

// ---------------------------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------------------------

/** What a loop does to a frame: sample the base track elsewhere, or extrapolate from an end. */
export type LoopMap =
  | { kind: "none" }
  | {
      kind: "sample";
      /** The integer frame to sample the base track at. */
      frame: number;
      /** Whole cycles to add `(value(end) - value(start))` for, offset mode only; else 0. */
      cycles: number;
      /** The looped range `[start, end]`. */
      start: number;
      end: number;
    }
  | {
      kind: "continue";
      direction: "in" | "out";
      /** The keyframe frame the extrapolation starts from. */
      anchor: number;
      /** Frames from the anchor (negative for `in`). */
      elapsed: number;
    };

/** `a mod m` in [0, m), also for negative `a`. */
const mod = (a: number, m: number): number => ((a % m) + m) % m;

/**
 * Maps `frame` through a loop over keyframes at `frames` (at least two). `out` acts after the last
 * keyframe, `in` before the first; `span` segments at that end are repeated (0, or more than there
 * are, means all). Frames inside the track are untouched.
 */
export function loopMap(
  frames: readonly number[],
  loop: Pick<LoopBehavior, "direction" | "mode" | "span">,
  frame: number,
): LoopMap {
  const last = frames.length - 1;
  if (last < 1) return { kind: "none" };
  const segments = loop.span === 0 || loop.span > last ? last : loop.span;
  const out = loop.direction === "out";
  const start = frames[out ? last - segments : 0] as number;
  const end = frames[out ? last : segments] as number;
  if (out ? frame <= end : frame >= start) return { kind: "none" };
  if (loop.mode === "continue") {
    const anchor = out ? end : start;
    return { kind: "continue", direction: loop.direction, anchor, elapsed: frame - anchor };
  }
  const period = end - start;
  if (loop.mode === "pingpong") {
    const m = mod(frame - start, 2 * period);
    return {
      kind: "sample",
      frame: start + (m <= period ? m : 2 * period - m),
      cycles: 0,
      start,
      end,
    };
  }
  return {
    kind: "sample",
    frame: start + mod(frame - start, period),
    cycles: loop.mode === "offset" ? Math.floor((frame - start) / period) : 0,
    start,
    end,
  };
}

// ---------------------------------------------------------------------------------------------
// Base track + loop + inertia
// ---------------------------------------------------------------------------------------------

const plus = (a: Components, b: Components): number[] => a.map((x, i) => x + (b[i] as number));

/** Index of the latest keyframe with `frames[k] <= frame`, or -1. */
function latestKeyframe(frames: readonly number[], frame: number): number {
  let lo = -1;
  let hi = frames.length;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((frames[mid] as number) <= frame) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * A group's value at `frame` with its enabled loops applied (the first one that acts wins), then
 * its inertia behaviors added. A group with fewer than two keyframes is just sampled: loops and
 * inertia need a segment to work from.
 */
export function evaluateGroup(
  group: TrackGroup,
  loops: readonly LoopBehavior[],
  inertias: readonly InertiaBehavior[],
  frame: number,
  fps: FrameRate,
): Components {
  const frames = group.frames;
  if (frames.length < 2) return group.sample(frame, fps);

  let map: LoopMap = { kind: "none" };
  for (const loop of loops) {
    map = loopMap(frames, loop, frame);
    if (map.kind !== "none") break;
  }

  let value: Components;
  let at = frame; // the frame inertia is measured on
  const seconds = (elapsed: number) => (elapsed * fps.den) / fps.num;
  if (map.kind === "sample") {
    at = map.frame;
    value = group.sample(map.frame, fps);
    if (map.cycles !== 0) {
      const first = group.sample(map.start, fps);
      const delta = group.sample(map.end, fps).map((x, i) => x - (first[i] as number));
      value = value.map((x, i) => x + map.cycles * (delta[i] as number));
    }
  } else if (map.kind === "continue") {
    const anchorValue = group.sample(map.anchor, fps);
    const velocity =
      map.direction === "out"
        ? incomingVelocity(group, frames.length - 1, fps)
        : outgoingVelocity(group, fps);
    value = anchorValue.map((x, i) => x + (velocity[i] as number) * seconds(map.elapsed));
  } else {
    value = group.sample(frame, fps);
  }

  if (inertias.length === 0) return value;
  const k = latestKeyframe(frames, at);
  if (k < 1) return value;
  const velocity = incomingVelocity(group, k, fps);
  const t = seconds(at - (frames[k] as number));
  for (const inertia of inertias) {
    const factor =
      (inertia.amplitude * Math.sin(2 * Math.PI * inertia.frequency * t)) /
      Math.exp(inertia.decay * t);
    value = plus(
      value,
      velocity.map((v) => v * factor),
    );
  }
  return value;
}
