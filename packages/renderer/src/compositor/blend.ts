import type { BlendMode } from "@kynimo/scene";

/**
 * The blend modes as pure functions of straight (unpremultiplied) sRGB-encoded colors, 0..1
 * (ADR-0021). This file is the specification: the GLSL in `shaders.ts` mirrors it, and tests check
 * the GPU against it. `b` is the backdrop, `s` the source (the layer being drawn).
 */
export type Rgb = readonly [number, number, number];

const clamp = (x: number) => Math.min(1, Math.max(0, x));

const multiply = (b: number, s: number) => b * s;
const screen = (b: number, s: number) => b + s - b * s;
const hardLight = (b: number, s: number) => (s <= 0.5 ? multiply(b, 2 * s) : screen(b, 2 * s - 1));

const colorDodge = (b: number, s: number) => {
  if (b <= 0) return 0;
  if (s >= 1) return 1;
  return Math.min(1, b / (1 - s));
};

const colorBurn = (b: number, s: number) => {
  if (b >= 1) return 1;
  if (s <= 0) return 0;
  return 1 - Math.min(1, (1 - b) / s);
};

/** W3C soft light. */
const softLight = (b: number, s: number) => {
  if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
  const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
  return b + (2 * s - 1) * (d - b);
};

/** Per-channel modes: W3C, then the Photoshop / After Effects extras, clamped to 0..1. */
export const SEPARABLE: Readonly<Record<string, (b: number, s: number) => number>> = {
  normal: (_b, s) => s,
  multiply,
  screen,
  overlay: (b, s) => hardLight(s, b),
  darken: Math.min,
  lighten: Math.max,
  "color-dodge": colorDodge,
  "color-burn": colorBurn,
  "hard-light": hardLight,
  "soft-light": softLight,
  difference: (b, s) => Math.abs(b - s),
  exclusion: (b, s) => b + s - 2 * b * s,
  add: (b, s) => clamp(b + s),
  subtract: (b, s) => clamp(b - s),
  divide: (b, s) => (s <= 0 ? (b <= 0 ? 0 : 1) : clamp(b / s)),
  "linear-burn": (b, s) => clamp(b + s - 1),
  "linear-light": (b, s) => clamp(b + 2 * s - 1),
  "vivid-light": (b, s) => (s <= 0.5 ? colorBurn(b, 2 * s) : colorDodge(b, 2 * s - 1)),
  "pin-light": (b, s) => (s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1)),
  "hard-mix": (b, s) => (b + s >= 1 ? 1 : 0),
};

// W3C non-separable helpers (Rec. 601 luma weights, as the spec defines them).
const lum = ([r, g, b]: Rgb) => 0.3 * r + 0.59 * g + 0.11 * b;

function clipColor(c: Rgb): Rgb {
  const l = lum(c);
  const n = Math.min(c[0], c[1], c[2]);
  const x = Math.max(c[0], c[1], c[2]);
  let out: [number, number, number] = [c[0], c[1], c[2]];
  if (n < 0) out = out.map((v) => l + ((v - l) * l) / (l - n)) as [number, number, number];
  if (x > 1) out = out.map((v) => l + ((v - l) * (1 - l)) / (x - l)) as [number, number, number];
  return out;
}

const setLum = (c: Rgb, l: number): Rgb => {
  const d = l - lum(c);
  return clipColor([c[0] + d, c[1] + d, c[2] + d]);
};

const sat = (c: Rgb) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);

function setSat(c: Rgb, s: number): Rgb {
  const x = Math.max(c[0], c[1], c[2]);
  const n = Math.min(c[0], c[1], c[2]);
  if (x <= n) return [0, 0, 0];
  return c.map((v) => ((v - n) * s) / (x - n)) as unknown as Rgb;
}

export const NON_SEPARABLE: Readonly<Record<string, (b: Rgb, s: Rgb) => Rgb>> = {
  hue: (b, s) => setLum(setSat(s, sat(b)), lum(b)),
  saturation: (b, s) => setLum(setSat(b, sat(s)), lum(b)),
  color: (b, s) => setLum(s, lum(b)),
  luminosity: (b, s) => setLum(b, lum(s)),
};

/** B(Cb, Cs) for any mode, on straight colors. */
export function blendColor(mode: BlendMode, b: Rgb, s: Rgb): Rgb {
  const ns = NON_SEPARABLE[mode];
  if (ns !== undefined) return ns(b, s);
  const f = SEPARABLE[mode];
  if (f === undefined) throw new RangeError(`unknown blend mode '${mode}'`);
  return [f(b[0], s[0]), f(b[1], s[1]), f(b[2], s[2])];
}

/**
 * W3C compositing of premultiplied source `s` over premultiplied backdrop `b` (RGBA, 0..1),
 * written into `out`: co = cs·(1 − αb) + cb·(1 − αs) + αs·αb·B(Cb, Cs), αo = αs + αb·(1 − αs).
 */
export function blendPixel(
  mode: BlendMode,
  b: ArrayLike<number>,
  s: ArrayLike<number>,
  out: Float64Array,
  at: number,
): void {
  const ab = b[3] ?? 0;
  const as = s[3] ?? 0;
  if (mode === "normal" || ab <= 0 || as <= 0) {
    for (let k = 0; k < 4; k++) out[at + k] = (s[k] ?? 0) + (b[k] ?? 0) * (1 - as);
    return;
  }
  const cb: Rgb = [(b[0] ?? 0) / ab, (b[1] ?? 0) / ab, (b[2] ?? 0) / ab];
  const cs: Rgb = [(s[0] ?? 0) / as, (s[1] ?? 0) / as, (s[2] ?? 0) / as];
  const mixed = blendColor(mode, cb.map(clamp) as unknown as Rgb, cs.map(clamp) as unknown as Rgb);
  for (let k = 0; k < 3; k++)
    out[at + k] = (s[k] ?? 0) * (1 - ab) + (b[k] ?? 0) * (1 - as) + as * ab * (mixed[k] ?? 0);
  out[at + 3] = as + ab * (1 - as);
}
