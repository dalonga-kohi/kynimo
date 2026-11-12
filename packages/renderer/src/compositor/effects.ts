import type { ResolvedEffect, ResolvedGenerator } from "@kynimo/engine";
import type { TransitionKind } from "@kynimo/scene";

/** Per-frame texture samples, including repeated matte sources and nested compositions. */
export const MAX_FRAME_EFFECT_SAMPLES = 500_000_000;

export function activeEffect(effect: ResolvedEffect): boolean {
  switch (effect.type) {
    case "gaussian-blur":
      return effect.radius > 0;
    case "drop-shadow":
      return effect.opacity * effect.color.a > 0;
    case "glow":
      return effect.radius > 0 && effect.intensity * effect.color.a > 0;
    case "brightness-contrast":
      return effect.brightness !== 0 || effect.contrast !== 0;
    case "hue-saturation":
      return effect.hue % 360 !== 0 || effect.saturation !== 0;
    case "tint":
      return effect.amount > 0 && (effect.black.a > 0 || effect.white.a > 0);
    case "fill":
      return effect.amount * effect.color.a > 0;
    case "vignette":
      return effect.amount * effect.color.a > 0;
    case "grain":
      return effect.amount > 0;
    case "chromatic-aberration":
      return effect.amount > 0;
    case "posterize":
    case "custom-shader":
      return true;
    case "scanlines":
      return effect.amount * effect.color.a > 0 && effect.thickness > 0;
  }
}

/** The blur radius of the effects that blur (the vignette's `radius` is something else). */
export function blurRadius(effect: ResolvedEffect): number {
  return effect.type === "gaussian-blur" || effect.type === "drop-shadow" || effect.type === "glow"
    ? effect.radius
    : 0;
}

/** How far one effect spreads content beyond the raster's edge, per axis. */
function effectReach(effect: ResolvedEffect): [number, number] {
  if (effect.type === "chromatic-aberration") {
    const reach = Math.ceil(effect.amount);
    return [reach, reach];
  }
  const radius = Math.ceil(blurRadius(effect));
  if (effect.type === "drop-shadow")
    return [
      radius + Math.ceil(Math.abs(effect.offset[0])),
      radius + Math.ceil(Math.abs(effect.offset[1])),
    ];
  return [radius, radius];
}

/** Transparent pixels needed on each side so a stack's successive effects have room to spread. */
export function effectPadding(effects: readonly ResolvedEffect[]): [number, number] {
  let x = 0;
  let y = 0;
  for (const effect of effects) {
    if (!activeEffect(effect)) continue;
    const [dx, dy] = effectReach(effect);
    x += dx;
    y += dy;
  }
  return [x, y];
}

/** Gaussian σ = radius/3. Fade in the outermost tap continuously as the radius grows. */
export function gaussianWeights(radius: number): number[] {
  const taps = Math.ceil(radius);
  const weights = [1];
  let total = 1;
  for (let i = 1; i <= taps; i++) {
    const weight = Math.exp(-0.5 * ((3 * i) / radius) ** 2) * Math.min(1, radius + 1 - i);
    weights.push(weight);
    total += 2 * weight;
  }
  return weights.map((weight) => weight / total);
}

export function effectSamples(effect: ResolvedEffect): number {
  const radius = blurRadius(effect);
  const blur = radius > 0 ? 2 * (1 + 2 * Math.ceil(radius)) : 0;
  switch (effect.type) {
    case "gaussian-blur":
      return blur;
    case "drop-shadow":
      return blur + 5; // source + four bilinear samples from the shifted shadow
    case "glow":
      return blur + 2;
    case "chromatic-aberration":
      return 9; // the source plus a bilinear sample (four reads) for each of two shifted channels
    default:
      return 1;
  }
}

/**
 * Samples per pixel a built-in transition costs, charged like effects against the frame budget:
 * the two inputs for the mask-style kinds, four reads per bilinear sample for the displacing ones.
 */
export function transitionSamples(kind: TransitionKind): number {
  switch (kind) {
    case "pixelate":
    case "push":
    case "zoom":
      return 8;
    case "glitch":
      return 12;
    default:
      return 2;
  }
}

/** Samples per pixel a generator costs, charged like effects against the frame budget. */
export function generatorSamples(generator: ResolvedGenerator): number {
  switch (generator.type) {
    case "gradient":
    case "pattern":
    case "custom-shader":
      return 1;
    case "aurora":
      return generator.colors.length;
    case "noise":
      return 8 * generator.octaves;
  }
}

/**
 * Coverage of a 1-px box filter centered at `x` over periodic bands of half width `hw` centered at
 * multiples of `period` (>= 2). The JS twin of the shaders' `band`; change them together.
 */
export function band(x: number, hw: number, period: number): number {
  const overlap = (v: number) => Math.max(0, Math.min(v + 0.5, hw) - Math.max(v - 0.5, -hw));
  const u = x - period * Math.floor(x / period + 0.5);
  return Math.min(1, overlap(u) + overlap(Math.abs(u) - period));
}

/** GLSL `smoothstep` for `edge0 < edge1`. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
