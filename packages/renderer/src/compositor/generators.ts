import { hashWords, type ResolvedGenerator, type Rgba } from "@kynimo/engine";
import { band } from "./effects.js";

/**
 * The float64 twin of the GENERATOR shader (ADR-0045): premultiplied RGBA, 0..1, rows top to
 * bottom, for a `width × height` layer-space source. Every value the GPU receives as a uniform is
 * rounded with `Math.fround` first, so both sides start from the same numbers. Change it together
 * with the shader.
 */
export function renderGenerator(
  width: number,
  height: number,
  generator: ResolvedGenerator,
): Float64Array {
  const data = new Float64Array(width * height * 4);
  const shade = shader(width, height, generator);
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      shade(x + 0.5, y + 0.5, out);
      const a = out[3];
      const i = (y * width + x) * 4;
      data[i] = out[0] * a;
      data[i + 1] = out[1] * a;
      data[i + 2] = out[2] * a;
      data[i + 3] = a;
    }
  return data;
}

type Straight = [number, number, number, number];
type Shader = (px: number, py: number, out: Straight) => void;

const f = Math.fround;
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const unit = (hash: number) => hash / 4294967295;
const rgba = ({ r, g, b, a }: Rgba): Straight => [f(r), f(g), f(b), f(a)];

function mixInto(out: Straight, a: Straight, b: Straight, t: number) {
  for (let k = 0; k < 4; k++) out[k] = mix(a[k] ?? 0, b[k] ?? 0, t);
}

function shader(width: number, height: number, g: ResolvedGenerator): Shader {
  switch (g.type) {
    case "gradient": {
      const sx = f(g.start[0]);
      const sy = f(g.start[1]);
      const dx = f(g.end[0]) - sx;
      const dy = f(g.end[1]) - sy;
      const l2 = dx * dx + dy * dy;
      const offsets = g.stops.map((s) => f(s.offset));
      const colors = g.stops.map((s) => rgba(s.color));
      const last = offsets.length - 1;
      return (px, py, out) => {
        const qx = px - sx;
        const qy = py - sy;
        let t: number;
        if (l2 < 1e-12) t = 1;
        else if (g.kind === "linear") t = (qx * dx + qy * dy) / l2;
        else if (g.kind === "radial") t = Math.hypot(qx, qy) / Math.sqrt(l2);
        else if (qx === 0 && qy === 0) t = 0;
        else {
          const turns = Math.atan2(dx * qy - dy * qx, qx * dx + qy * dy) / (2 * Math.PI);
          t = turns - Math.floor(turns);
        }
        t = Math.min(1, Math.max(0, t));
        if (t <= (offsets[0] ?? 0))
          return mixInto(out, colors[0] as Straight, colors[0] as Straight, 0);
        if (t >= (offsets[last] ?? 1))
          return mixInto(out, colors[last] as Straight, colors[last] as Straight, 0);
        for (let i = 0; i < last; i++) {
          const lo = offsets[i] ?? 0;
          const hi = offsets[i + 1] ?? 0;
          if (lo <= t && t <= hi && hi > lo)
            return mixInto(
              out,
              colors[i] as Straight,
              colors[i + 1] as Straight,
              (t - lo) / (hi - lo),
            );
        }
        return mixInto(out, colors[last] as Straight, colors[last] as Straight, 0);
      };
    }
    case "noise": {
      const { seed, octaves } = g;
      const scale = f(g.scale);
      const evolution = f(g.evolution);
      const ox = f(g.offset[0]);
      const oy = f(g.offset[1]);
      const low = rgba(g.low);
      const high = rgba(g.high);
      const fade = (u: number) => u * u * u * (u * (6 * u - 15) + 10);
      return (px, py, out) => {
        let sum = 0;
        let weights = 0;
        let amplitude = 1;
        for (let o = 0; o < octaves; o++) {
          const freq = 2 ** o;
          const qx = ((px - ox) / scale) * freq;
          const qy = ((py - oy) / scale) * freq;
          const qz = evolution * freq;
          const ix = Math.floor(qx);
          const iy = Math.floor(qy);
          const iz = Math.floor(qz);
          const ux = fade(qx - ix);
          const uy = fade(qy - iy);
          const uz = fade(qz - iz);
          const corner = (dx: number, dy: number, dz: number) =>
            unit(hashWords(seed, [o, ix + dx, iy + dy, iz + dz]));
          const plane = (dz: number) =>
            mix(
              mix(corner(0, 0, dz), corner(1, 0, dz), ux),
              mix(corner(0, 1, dz), corner(1, 1, dz), ux),
              uy,
            );
          sum += amplitude * mix(plane(0), plane(1), uz);
          weights += amplitude;
          amplitude *= 0.5;
        }
        mixInto(out, low, high, sum / weights);
      };
    }
    case "pattern": {
      const s = f(g.size);
      const thickness = f(g.thickness);
      const cos = f(g.rotation[0]);
      const sin = f(g.rotation[1]);
      const ox = f(g.offset[0]);
      const oy = f(g.offset[1]);
      const fg = rgba(g.foreground);
      const bg = rgba(g.background);
      const hw = (thickness * s) / 2;
      return (px, py, out) => {
        const rx = px - width / 2 - ox;
        const ry = py - height / 2 - oy;
        const qx = cos * rx + sin * ry;
        const qy = -sin * rx + cos * ry;
        let cov: number;
        switch (g.kind) {
          case "stripes":
            cov = band(qx, hw, s);
            break;
          case "grid": {
            const a = band(qx, hw, s);
            const b = band(qy, hw, s);
            cov = a + b - a * b;
            break;
          }
          case "checker": {
            const a = band(qx, s / 2, 2 * s);
            const b = band(qy, s / 2, 2 * s);
            cov = a * (1 - b) + b * (1 - a);
            break;
          }
          case "dots": {
            const cx = s * Math.floor(qx / s + 0.5);
            const cy = s * Math.floor(qy / s + 0.5);
            cov = Math.min(1, Math.max(0, hw + 0.5 - Math.hypot(qx - cx, qy - cy)));
            if (hw <= 0) cov = 0;
            break;
          }
        }
        mixInto(out, bg, fg, cov);
      };
    }
    case "aurora": {
      const colors = g.colors.map(rgba);
      const points = g.points.map(([x, y]) => [f(x), f(y)] as const);
      const sigma = f(g.sigma);
      const denominator = 2 * sigma * sigma;
      return (px, py, out) => {
        const d2 = points.map(([x, y]) => (px - x) ** 2 + (py - y) ** 2);
        const dmin = Math.min(...d2);
        let total = 0;
        const sum = [0, 0, 0, 0];
        d2.forEach((d, i) => {
          const w = Math.exp(-(d - dmin) / denominator);
          total += w;
          for (let k = 0; k < 4; k++)
            sum[k] = (sum[k] ?? 0) + w * ((colors[i] as Straight)[k] ?? 0);
        });
        for (let k = 0; k < 4; k++) out[k] = (sum[k] ?? 0) / total;
      };
    }
  }
}
