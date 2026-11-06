import type { Color } from "@kynimo/scene";
import { clampUnit, lerp } from "./mix.js";

/**
 * A resolved color: sRGB channels and straight (non-premultiplied) alpha, all floats in 0..1.
 * The engine keeps full precision; quantizing to 8 bits is the renderer's job.
 */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Parses a scene color (`#rrggbb` or `#rrggbbaa`, already validated by the schema). */
export function parseColor(hex: Color): Rgba {
  const channel = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16) / 255;
  return { r: channel(1), g: channel(3), b: channel(5), a: hex.length === 9 ? channel(7) : 1 };
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

type Lab = [number, number, number];

/** sRGB → OKLab (Björn Ottosson, 2020). */
function toOklab({ r, g, b }: Rgba): Lab {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab → sRGB, clipped to the sRGB gamut. */
function fromOklab([L, A, B]: Lab, alpha: number): Rgba {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return {
    r: clampUnit(toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    g: clampUnit(toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    b: clampUnit(toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
    a: alpha,
  };
}

/**
 * Mixes two colors in OKLab with premultiplied alpha (like CSS `color-mix`), so a fade from
 * transparent takes on the target's hue instead of darkening. `p` may overshoot; the result
 * is clipped to the sRGB gamut and alpha to 0..1. Exact at p = 0 and p = 1.
 */
export function mixColor(from: Rgba, to: Rgba, p: number): Rgba {
  if (p === 0) return from;
  if (p === 1) return to;
  const alpha = lerp(from.a, to.a, p);
  if (alpha <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  const a = toOklab(from);
  const b = toOklab(to);
  const mixed: Lab = [0, 1, 2].map(
    (i) => lerp((a[i] as number) * from.a, (b[i] as number) * to.a, p) / alpha,
  ) as Lab;
  return fromOklab(mixed, clampUnit(alpha));
}
