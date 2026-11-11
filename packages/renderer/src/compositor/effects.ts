import type { ResolvedEffect } from "@kynimo/engine";

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
  }
}

/** Transparent pixels needed on each side so a stack's successive effects have room to spread. */
export function effectPadding(effects: readonly ResolvedEffect[]): [number, number] {
  let x = 0;
  let y = 0;
  for (const effect of effects) {
    if (!("radius" in effect) || !activeEffect(effect)) continue;
    const radius = Math.ceil(effect.radius);
    x += radius;
    y += radius;
    if (effect.type === "drop-shadow") {
      x += Math.ceil(Math.abs(effect.offset[0]));
      y += Math.ceil(Math.abs(effect.offset[1]));
    }
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
  const blur = "radius" in effect && effect.radius > 0 ? 2 * (1 + 2 * Math.ceil(effect.radius)) : 0;
  switch (effect.type) {
    case "gaussian-blur":
      return blur;
    case "drop-shadow":
      return blur + 5; // source + four bilinear samples from the shifted shadow
    case "glow":
      return blur + 2;
    default:
      return 1;
  }
}
