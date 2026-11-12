import {
  hashWords,
  type ResolvedEffect,
  type ResolvedShader,
  type ResolvedTransition,
} from "@kynimo/engine";
import type {
  FramePlan,
  PlannedAdjustmentLayer,
  PlannedLayer,
  PlannedMotionSample,
  RasterImage,
} from "../raster.js";
import { blendColor, blendPixel } from "./blend.js";
import { compiledShader, MAX_FRAME_SHADER_WORK } from "./custom-shader.js";
import {
  band,
  effectPadding,
  effectSamples,
  gaussianWeights,
  generatorSamples,
  MAX_FRAME_EFFECT_SAMPLES,
  smoothstep,
  transitionSamples,
} from "./effects.js";
import { renderGenerator } from "./generators.js";
import {
  type Affine,
  invert,
  LUMA,
  layerProjection,
  levelOfDetail,
  matteChain,
  maxLevel,
  type Projective,
  placement,
  precompUses,
  projectiveInvert,
  projectivePlacement,
  projectiveSample,
  samplePlacement,
} from "./pipeline.js";
import { transitionUniforms } from "./transition.js";

/** Premultiplied RGBA, 0..1, rows top to bottom. */
interface FloatImage {
  width: number;
  height: number;
  data: Float64Array;
}

const blank = (width: number, height: number): FloatImage => ({
  width,
  height,
  data: new Float64Array(width * height * 4),
});

/**
 * The compositor in plain JavaScript (ADR-0021): the specification the WebGL2 compositor is
 * tested against, and a way for Node tools and tests to see whole frames. Same pipeline as the
 * GPU, in float64 instead of RGBA16F. Bottom first, each layer runs raster × mask, effects,
 * placement (bilinear, trilinear between box-filtered mips when minifying), track matte, opacity,
 * then the blend mode. An adjustment filters the accumulated pixels below it. The root background
 * goes under the result, and the output is quantized to premultiplied sRGB RGBA8.
 */
export function compositeReference(plan: FramePlan): RasterImage {
  const acc = compositeFloat(plan, {
    cache: new Map(),
    uses: precompUses(plan),
    remaining: MAX_FRAME_EFFECT_SAMPLES,
    shaderWork: MAX_FRAME_SHADER_WORK,
  });
  const out = new Uint8Array(acc.data.length);
  const bg = plan.background;
  for (let i = 0; i < acc.data.length; i += 4) {
    const a = acc.data[i + 3] ?? 0;
    const under = bg === null ? [0, 0, 0, 0] : [bg.r * bg.a, bg.g * bg.a, bg.b * bg.a, bg.a];
    for (let k = 0; k < 4; k++) {
      const v = (acc.data[i + k] ?? 0) + (under[k] ?? 0) * (1 - a);
      out[i + k] = Math.round(Math.min(1, Math.max(0, v)) * 255);
    }
  }
  return { width: plan.width, height: plan.height, pixels: out };
}

/** Composited precomps, each dropped after its last read (as the GPU frees its target). */
type Nested = {
  cache: Map<FramePlan, FloatImage>;
  uses: Map<FramePlan, number>;
  remaining: number;
  shaderWork: number;
};

function compositeFloat(plan: FramePlan, nested: Nested): FloatImage {
  const acc = blank(plan.width, plan.height);
  const backdrop = new Float64Array(4);
  for (let i = plan.layers.length - 1; i >= 0; i--) {
    const layer = plan.layers[i];
    if (layer === undefined) continue;
    if (layer.type === "adjustment") {
      adjust(layer, acc, plan, nested);
      continue;
    }
    const transition = layer.transition ?? null;
    // At progress 0 the result is the backdrop: the layer is still placed (budgets and skip
    // reports stay the same) but not blended or charged for a transition pass.
    const drawn = transition !== null && transition.progress > 0 ? transition : null;
    if (drawn !== null)
      chargeSamples(
        nested,
        layer.id,
        plan.width * plan.height * transitionSamples(drawn.kind),
        "composition size or number of transitions",
      );
    const src = placed(layer, plan, nested);
    if (transition !== null && drawn === null) continue;
    const below = drawn === null ? null : { ...acc, data: acc.data.slice() };
    for (let p = 0; p < acc.data.length; p += 4) {
      backdrop.set(acc.data.subarray(p, p + 4));
      blendPixel(layer.blendMode, backdrop, src.data.subarray(p, p + 4), acc.data, p);
    }
    if (below !== null && drawn !== null) transit(below, acc, drawn);
  }
  return acc;
}

/**
 * Replaces `b` (the layer composited over `a`) with the transition's output, in place. The twin
 * of the transition shaders in shaders.ts: uniforms are rounded to float32 as the GPU gets them,
 * pixel centres are (x + 0.5, y + 0.5), and displaced samples are bilinear and clamped to the
 * texel-centre range, so they never read transparent black from outside.
 */
function transit(a: FloatImage, b: FloatImage, transition: ResolvedTransition) {
  const { width, height } = a;
  const values = transitionUniforms(transition, width, height);
  const u = (name: string): number[] => (values[name] ?? []).map(Math.fround);
  const [p = 0] = u("p");
  const [dirX = 0, dirY = 0] = u("dir");
  const [centerX = 0, centerY = 0] = u("center");
  const [rangeMin = 0, rangeLength = 0] = u("range");
  const [feather = 0] = u("feather");
  const at = (img: FloatImage, x: number, y: number, k: number) =>
    bilinear(
      img,
      Math.min(width - 0.5, Math.max(0.5, x)),
      Math.min(height - 0.5, Math.max(0.5, y)),
      k,
    );
  const out = new Float64Array(a.data.length);
  /** Coverage of B at pixel centre (cx, cy), or null for the kinds that sample displaced. */
  let coverage: ((cx: number, cy: number) => number) | null = null;
  /** For the sampling kinds: writes the output pixel `o` from the inputs at (cx, cy). */
  let sample: ((cx: number, cy: number, o: number) => void) | null = null;
  const smooth = (e: number, v: number, f: number) => Math.min(1, Math.max(0, (e - v) / f));
  switch (transition.kind) {
    case "dissolve":
      coverage = () => p;
      break;
    case "noise-dissolve": {
      const [scale = 1] = u("scale");
      const seed = transition.seed;
      const lattice = (x: number, y: number) => hashWords(seed, [x, y, 0, 0]) / 4294967295;
      coverage = (cx, cy) => {
        const gx = cx / scale;
        const gy = cy / scale;
        const ix = Math.floor(gx);
        const iy = Math.floor(gy);
        const fade = (f: number) => f * f * f * (f * (f * 6 - 15) + 10);
        const ux = fade(gx - ix);
        const uy = fade(gy - iy);
        const n = mix(
          mix(lattice(ix, iy), lattice(ix + 1, iy), ux),
          mix(lattice(ix, iy + 1), lattice(ix + 1, iy + 1), ux),
          uy,
        );
        if (feather > 0) return smooth(p * (1 + feather), n, feather);
        return n < p ? 1 : 0;
      };
      break;
    }
    case "wipe":
      coverage = (cx, cy) =>
        smooth(rangeMin + p * (rangeLength + feather), cx * dirX + cy * dirY, feather);
      break;
    case "clock": {
      const [dx = 0, dy = 0] = u("dir0");
      const [turn = 1] = u("turn");
      coverage = (cx, cy) => {
        const vx = cx - centerX;
        const vy = cy - centerY;
        let phi = 0;
        if (vx !== 0 || vy !== 0) {
          const deg = Math.atan2(turn * (dx * vy - dy * vx), dx * vx + dy * vy) * (180 / Math.PI);
          phi = deg < 0 ? deg + 360 : deg;
        }
        if (feather > 0) return smooth(p * (360 + feather), phi, feather);
        return phi < p * 360 ? 1 : 0;
      };
      break;
    }
    case "iris": {
      const [rMax = 0] = u("rmax");
      const shape = transition.shape;
      coverage = (cx, cy) => {
        const vx = Math.abs(cx - centerX);
        const vy = Math.abs(cy - centerY);
        const r =
          shape === "circle"
            ? Math.hypot(vx, vy)
            : shape === "diamond"
              ? vx + vy
              : Math.max(vx, vy);
        return smooth(p * (rMax + feather), r, feather);
      };
      break;
    }
    case "blinds": {
      const [sMin = 0] = u("smin");
      const [period = 1] = u("period");
      coverage = (cx, cy) => {
        const s = cx * dirX + cy * dirY - sMin;
        const within = s - period * Math.floor(s / period);
        return smooth(p * (period + feather), within, feather);
      };
      break;
    }
    case "pixelate": {
      const [cell = 1] = u("cell");
      const [w = 0] = u("mix");
      sample = (cx, cy, o) => {
        const qx = (Math.floor(cx / cell) + 0.5) * cell;
        const qy = (Math.floor(cy / cell) + 0.5) * cell;
        for (let k = 0; k < 4; k++) out[o + k] = mix(at(a, qx, qy, k), at(b, qx, qy, k), w);
      };
      break;
    }
    case "push":
      sample = (cx, cy, o) => {
        const m = Math.min(
          1,
          Math.max(0, rangeMin + p * rangeLength - (cx * dirX + cy * dirY) + 0.5),
        );
        const ax = cx - p * rangeLength * dirX;
        const ay = cy - p * rangeLength * dirY;
        const bx = cx - (p - 1) * rangeLength * dirX;
        const by = cy - (p - 1) * rangeLength * dirY;
        for (let k = 0; k < 4; k++) out[o + k] = mix(at(a, ax, ay, k), at(b, bx, by, k), m);
      };
      break;
    case "zoom": {
      const [scaleA = 1, scaleB = 1] = u("scale");
      sample = (cx, cy, o) => {
        const vx = cx - centerX;
        const vy = cy - centerY;
        for (let k = 0; k < 4; k++)
          out[o + k] = mix(
            at(a, centerX + vx / scaleA, centerY + vy / scaleA, k),
            at(b, centerX + vx / scaleB, centerY + vy / scaleB, k),
            p,
          );
      };
      break;
    }
    case "glitch": {
      const [bands = 1] = u("bands");
      const [step = 0] = u("step");
      const [amp = 0] = u("amp");
      const seed = transition.seed;
      const unit = (row: number, word: number) =>
        hashWords(seed, [row, step, word, 0]) / 4294967295;
      sample = (cx, cy, o) => {
        const row = Math.floor((cy * bands) / height);
        const img = unit(row, 0) < p ? b : a;
        const x = cx + (2 * unit(row, 1) - 1) * amp;
        const ca = 0.25 * amp;
        const red = (k: number) => at(img, x + ca, cy, k);
        const green = (k: number) => at(img, x, cy, k);
        const blue = (k: number) => at(img, x - ca, cy, k);
        out[o] = red(0);
        out[o + 1] = green(1);
        out[o + 2] = blue(2);
        out[o + 3] = Math.max(red(3), green(3), blue(3));
      };
      break;
    }
  }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (sample !== null) sample(x + 0.5, y + 0.5, o);
      else if (coverage !== null) {
        const m = coverage(x + 0.5, y + 0.5);
        for (let k = 0; k < 4; k++) out[o + k] = mix(a.data[o + k] ?? 0, b.data[o + k] ?? 0, m);
      }
    }
  b.data.set(out);
}

/** The layer in composition space with its matte and opacity applied, before blending. */
function placed(layer: PlannedLayer, comp: FramePlan, nested: Nested): FloatImage {
  const { chain, end } = matteChain(layer);
  let below: FloatImage | null = null; // the placed matte source of the layer being processed
  for (let i = chain.length - 1; i >= 0; i--) {
    const current = chain[i] as PlannedLayer;
    const padding = effectPadding(current.effects ?? []);
    const motion = current.motion ?? null;
    // Charged up front (width × height per sample) so a huge blur fails before any work is done.
    if (motion !== null)
      chargeSamples(
        nested,
        current.id,
        comp.width * comp.height * motion.length,
        "motion blur samples or number of blurred layers",
      );
    const src = source(current, nested, padding);
    // The source's mip chain, extended on demand and shared by every sample of this layer.
    const levels = [src];
    // A 3D layer is placed by its projection (per sample: the sample's), a 2D one by its matrix.
    const projective = layerProjection(current) !== null;
    const put = (sample: PlannedMotionSample | null) =>
      projective
        ? placeProjective(
            levels,
            projectiveInvert(projectivePlacement(current, padding, sample)),
            comp.width,
            comp.height,
          )
        : place(
            levels,
            sample === null
              ? placement(current, padding)
              : samplePlacement(current, sample, padding),
            comp.width,
            comp.height,
          );
    let img: FloatImage;
    if (motion === null) img = put(null);
    else {
      // One pass per shutter sample, summed (premultiplied, additive) with weight opacity / N.
      img = blank(comp.width, comp.height);
      for (const sample of motion) {
        const one = put(sample);
        const weight = sample.opacity / motion.length;
        for (let i = 0; i < img.data.length; i++)
          img.data[i] = (img.data[i] ?? 0) + (one.data[i] ?? 0) * weight;
      }
    }
    const matted = i === chain.length - 1 ? (end === "none" ? "none" : "empty") : "source";
    const mode = current.matte?.mode;
    for (let p = 0; p < img.data.length; p += 4) {
      // A blurred layer's own opacity is already in its samples.
      const factor =
        (motion === null ? current.opacity : 1) *
        matteCoverage(matted === "none" ? undefined : mode, matted === "empty" ? null : below, p);
      for (let k = 0; k < 4; k++) img.data[p + k] = (img.data[p + k] ?? 0) * factor;
    }
    below = img;
  }
  return below as FloatImage;
}

/** The layer's raster (or composited precomp) times its mask, in its raster space. */
function source(layer: PlannedLayer, nested: Nested, [x, y]: [number, number]): FloatImage {
  let img: FloatImage;
  if (layer.type === "precomp") {
    let frame = nested.cache.get(layer.frame);
    if (frame === undefined) {
      frame = compositeFloat(layer.frame, nested);
      nested.cache.set(layer.frame, frame);
    }
    const left = (nested.uses.get(layer.frame) ?? 1) - 1;
    nested.uses.set(layer.frame, left);
    if (left <= 0) nested.cache.delete(layer.frame);
    img = { width: frame.width, height: frame.height, data: frame.data.slice() };
  } else if (layer.type === "generator") {
    const { width, height, generator } = layer;
    chargeSamples(nested, layer.id, width * height * generatorSamples(generator), "layer size");
    img =
      generator.type === "custom-shader"
        ? drawShader(nested, layer.id, width, height, generator)
        : { width, height, data: renderGenerator(width, height, generator) };
  } else {
    const { width, height, pixels } = layer.raster;
    img = blank(width, height);
    for (let i = 0; i < pixels.length; i++) img.data[i] = (pixels[i] ?? 0) / 255;
  }
  const mask = layer.mask;
  if (mask !== null)
    for (let i = 0; i < mask.coverage.length; i++) {
      const c = (mask.coverage[i] ?? 0) / 255;
      for (let k = i * 4; k < i * 4 + 4; k++) img.data[k] = (img.data[k] ?? 0) * c;
    }
  const effects = layer.effects ?? [];
  if (effects.length === 0) return img;
  const width = img.width + 2 * x;
  const height = img.height + 2 * y;
  charge(nested, layer.id, effects, width, height);
  if (x > 0 || y > 0) {
    const padded = blank(width, height);
    for (let row = 0; row < img.height; row++) {
      const start = row * img.width * 4;
      padded.data.set(img.data.subarray(start, start + img.width * 4), ((row + y) * width + x) * 4);
    }
    img = padded;
  }
  return effects.reduce((acc, effect) => applyEffect(acc, effect, [x, y], nested, layer.id), img);
}

function charge(
  nested: Nested,
  id: string,
  effects: readonly ResolvedEffect[],
  width: number,
  height: number,
) {
  chargeSamples(
    nested,
    id,
    width * height * effects.reduce((sum, effect) => sum + effectSamples(effect), 0),
    "radius, layer size or number of effects",
  );
}

function chargeSamples(nested: Nested, id: string, samples: number, reduce: string) {
  nested.remaining -= samples;
  if (nested.remaining < 0)
    throw new RangeError(
      `layer '${id}' exceeds the frame budget of ${MAX_FRAME_EFFECT_SAMPLES} effect samples; reduce the ${reduce}`,
    );
}

function matteCoverage(
  mode: NonNullable<PlannedLayer["matte"]>["mode"] | undefined,
  matte: FloatImage | null,
  p: number,
): number {
  if (mode === undefined) return 1;
  const m = matte?.data;
  const value =
    m === undefined
      ? 0
      : mode === "alpha" || mode === "alpha-inverted"
        ? (m[p + 3] ?? 0)
        : LUMA[0] * (m[p] ?? 0) + LUMA[1] * (m[p + 1] ?? 0) + LUMA[2] * (m[p + 2] ?? 0);
  return mode.endsWith("inverted") ? 1 - value : value;
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (x: number) => Math.min(1, Math.max(0, x));
const straight = (data: Float64Array, p: number, a: number): [number, number, number] => [
  clamp((data[p] ?? 0) / a),
  clamp((data[p + 1] ?? 0) / a),
  clamp((data[p + 2] ?? 0) / a),
];

function adjust(layer: PlannedAdjustmentLayer, acc: FloatImage, plan: FramePlan, nested: Nested) {
  if (layer.effects.length === 0) return;
  charge(nested, layer.id, layer.effects, acc.width, acc.height);
  const filtered = layer.effects.reduce(
    (img, effect) => applyEffect(img, effect, [0, 0], nested, layer.id),
    acc,
  );
  const source = layer.matte?.source;
  const matte = source == null ? null : placed(source, plan, nested);
  for (let p = 0; p < acc.data.length; p += 4) {
    const coverage = layer.mask === null ? 1 : (layer.mask.coverage[p / 4] ?? 0) / 255;
    const amount = coverage * layer.opacity * matteCoverage(layer.matte?.mode, matte, p);
    const a = acc.data[p + 3] ?? 0;
    const b = filtered.data[p + 3] ?? 0;
    const mixed =
      layer.blendMode === "normal" || a <= 0 || b <= 0
        ? null
        : blendColor(layer.blendMode, straight(acc.data, p, a), straight(filtered.data, p, b));
    for (let k = 0; k < 4; k++) {
      const c = filtered.data[p + k] ?? 0;
      acc.data[p + k] = mix(
        acc.data[p + k] ?? 0,
        mixed === null || k === 3 ? c : mix(c, b * (mixed[k] ?? 0), a),
        amount,
      );
    }
  }
}

function gaussian(src: FloatImage, radius: number): FloatImage {
  if (radius === 0) return src;
  const weights = gaussianWeights(radius);
  const pass = (image: FloatImage, dx: number, dy: number) => {
    const out = blank(image.width, image.height);
    for (let y = 0; y < image.height; y++)
      for (let x = 0; x < image.width; x++)
        for (let k = 0; k < 4; k++) {
          let v = texel(image, x, y, k) * (weights[0] ?? 1);
          for (let i = 1; i < weights.length; i++)
            v +=
              (texel(image, x - dx * i, y - dy * i, k) + texel(image, x + dx * i, y + dy * i, k)) *
              (weights[i] ?? 0);
          out.data[(y * image.width + x) * 4 + k] = v;
        }
    return out;
  };
  return pass(pass(src, 1, 0), 0, 1);
}

function drawShader(
  nested: Nested,
  id: string,
  width: number,
  height: number,
  shader: ResolvedShader,
  src?: FloatImage,
): FloatImage {
  const compiled = compiledShader(shader.definition);
  nested.shaderWork -= width * height * compiled.work;
  if (nested.shaderWork < 0)
    throw new RangeError(
      `layer '${id}' exceeds the frame budget of ${MAX_FRAME_SHADER_WORK} custom shader work units`,
    );
  const out = blank(width, height);
  const shade = compiled.reference(
    { width, height, ...shader },
    src === undefined
      ? undefined
      : (u, v, data, offset) => {
          const x = Math.min(width - 1, Math.floor(Math.fround(clamp(u) * width)));
          const y = Math.min(height - 1, Math.floor(Math.fround(clamp(v) * height)));
          const p = (y * width + x) * 4;
          const alpha = src.data[p + 3] ?? 0;
          for (let lane = 0; lane < 3; lane++)
            data[offset + lane] = alpha <= 0 ? 0 : clamp((src.data[p + lane] ?? 0) / alpha);
          data[offset + 3] = alpha;
        },
  );
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) shade(x, y, out.data, (y * width + x) * 4);
  return out;
}

function applyEffect(
  src: FloatImage,
  effect: ResolvedEffect,
  pad: readonly [number, number],
  nested: Nested,
  id: string,
): FloatImage {
  if (effect.type === "custom-shader")
    return drawShader(nested, id, src.width, src.height, effect, src);
  if (effect.type === "gaussian-blur") return gaussian(src, effect.radius);
  const out = blank(src.width, src.height);
  if (effect.type === "drop-shadow" || effect.type === "glow") {
    const blurred = gaussian(src, effect.radius);
    const { color } = effect;
    const tint = [color.r, color.g, color.b, 1];
    for (let y = 0; y < src.height; y++)
      for (let x = 0; x < src.width; x++) {
        const p = (y * src.width + x) * 4;
        const under =
          effect.type === "drop-shadow"
            ? bilinear(blurred, x + 0.5 - effect.offset[0], y + 0.5 - effect.offset[1], 3) *
              effect.opacity
            : texel(blurred, x, y, 3) * effect.intensity;
        const a = under * color.a * (1 - (src.data[p + 3] ?? 0));
        for (let k = 0; k < 4; k++) out.data[p + k] = (src.data[p + k] ?? 0) + a * (tint[k] ?? 0);
      }
    return out;
  }
  if (effect.type === "chromatic-aberration") return aberrate(src, effect.amount);
  const look = lookShader(src, effect, pad);
  for (let p = 0; p < src.data.length; p += 4) {
    const a = src.data[p + 3] ?? 0;
    if (a <= 0) continue;
    const rgb = straight(src.data, p, a);
    let adjusted: number[];
    switch (effect.type) {
      case "brightness-contrast":
        adjusted = rgb.map((c) => (c - 0.5) * (1 + effect.contrast) + 0.5 + effect.brightness);
        break;
      case "hue-saturation": {
        const [r, g, b] = rgb;
        const hi = Math.max(r, g, b);
        const d = hi - Math.min(r, g, b);
        if (d <= 0) {
          adjusted = rgb;
          break;
        }
        const h =
          (hi === r ? (g - b) / d : hi === g ? 2 + (b - r) / d : 4 + (r - g) / d) + effect.hue / 60;
        adjusted = [0, 4, 2].map((offset) => {
          const k = (((h + offset) % 6) + 6) % 6;
          const wheel = clamp(Math.abs(k - 3) - 1);
          return hi - Math.min(hi, d * (1 + effect.saturation)) * (1 - wheel);
        });
        break;
      }
      case "tint": {
        const luma = rgb[0] * LUMA[0] + rgb[1] * LUMA[1] + rgb[2] * LUMA[2];
        const { black, white } = effect;
        const strength = effect.amount * mix(black.a, white.a, luma);
        adjusted = [
          mix(rgb[0], mix(black.r, white.r, luma), strength),
          mix(rgb[1], mix(black.g, white.g, luma), strength),
          mix(rgb[2], mix(black.b, white.b, luma), strength),
        ];
        break;
      }
      case "fill":
        adjusted = [effect.color.r, effect.color.g, effect.color.b].map((v, k) =>
          mix(rgb[k] ?? 0, v, effect.amount * effect.color.a),
        );
        break;
      default:
        adjusted = look?.((p / 4) % src.width, Math.floor(p / 4 / src.width), rgb) ?? rgb;
        break;
    }
    for (let k = 0; k < 3; k++) out.data[p + k] = a * clamp(adjusted[k] ?? 0);
    out.data[p + 3] = a;
  }
  return out;
}

/** Chromatic aberration: red and blue sampled from opposite shifts that grow towards the edge. */
function aberrate(src: FloatImage, amount: number): FloatImage {
  const out = blank(src.width, src.height);
  const strength = Math.fround(amount);
  const cx = src.width / 2;
  const cy = src.height / 2;
  const scale = 0.5 * Math.max(src.width, src.height);
  // The shifted position stays on the raster: past the edge it would fetch transparent black.
  const edge = (x: number, y: number): [number, number] => [
    Math.min(src.width - 0.5, Math.max(0.5, x)),
    Math.min(src.height - 0.5, Math.max(0.5, y)),
  ];
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++) {
      const ox = ((x + 0.5 - cx) / scale) * strength;
      const oy = ((y + 0.5 - cy) / scale) * strength;
      const p = (y * src.width + x) * 4;
      const [rx, ry] = edge(x + 0.5 + ox, y + 0.5 + oy);
      const [bx, by] = edge(x + 0.5 - ox, y + 0.5 - oy);
      const red = bilinear(src, rx, ry, 0);
      const blue = bilinear(src, bx, by, 2);
      out.data[p] = red;
      out.data[p + 1] = texel(src, x, y, 1);
      out.data[p + 2] = blue;
      out.data[p + 3] = Math.max(
        bilinear(src, rx, ry, 3),
        texel(src, x, y, 3),
        bilinear(src, bx, by, 3),
      );
    }
  return out;
}

/**
 * The per-pixel color looks (the twin of the EFFECT shader's modes 7, 8, 10 and 11) for the raster
 * `src`, or `null` for any other effect: maps the straight color at texel (x, y) to the new color. Uniform values are rounded to
 * float32 first, as the GPU receives them.
 */
function lookShader(
  src: FloatImage,
  effect: ResolvedEffect,
  [padX, padY]: readonly [number, number],
): ((x: number, y: number, rgb: [number, number, number]) => number[]) | null {
  const f = Math.fround;
  switch (effect.type) {
    case "vignette": {
      const amount = f(effect.amount);
      const radius = f(effect.radius);
      const feather = f(effect.feather);
      const { color } = effect;
      const c = [f(color.r), f(color.g), f(color.b)];
      const strength = amount * f(color.a);
      const halfW = (src.width - 2 * padX) / 2;
      const halfH = (src.height - 2 * padY) / 2;
      return (x, y, rgb) => {
        const d = Math.hypot((x + 0.5 - halfW - padX) / halfW, (y + 0.5 - halfH - padY) / halfH);
        const k = smoothstep(radius, radius + feather, d);
        return rgb.map((v, i) => mix(v, c[i] ?? 0, strength * k));
      };
    }
    case "grain": {
      const amount = f(effect.amount);
      const { seed, frame, size, monochrome } = effect;
      return (x, y, rgb) => {
        const cx = Math.floor((x - padX) / size);
        const cy = Math.floor((y - padY) / size);
        return rgb.map((v, ch) => {
          const n = (hashWords(seed, [frame, cx, cy, monochrome ? 0 : ch]) / 4294967295) * 2 - 1;
          return Math.min(1, Math.max(0, v + amount * 0.5 * n));
        });
      };
    }
    case "posterize": {
      const steps = f(effect.levels) - 1;
      return (_x, _y, rgb) => rgb.map((v) => Math.floor(v * steps + 0.5) / steps);
    }
    case "scanlines": {
      const spacing = f(effect.spacing);
      const offset = f(effect.offset);
      const hw = (f(effect.thickness) * spacing) / 2;
      const { color } = effect;
      const c = [f(color.r), f(color.g), f(color.b)];
      const strength = f(effect.amount) * f(color.a);
      return (_x, y, rgb) => {
        const k = band(y - padY + 0.5 - offset, hw, spacing);
        return rgb.map((v, i) => mix(v, c[i] ?? 0, strength * k));
      };
    }
    default:
      return null;
  }
}

/** Next mip level: each texel is the mean of a 2×2 block; texels past the edge count as transparent. */
function downsample(src: FloatImage): FloatImage {
  const width = Math.ceil(src.width / 2);
  const height = Math.ceil(src.height / 2);
  const out = blank(width, height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let k = 0; k < 4; k++) {
        let sum = 0;
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) sum += texel(src, 2 * x + dx, 2 * y + dy, k);
        out.data[(y * width + x) * 4 + k] = sum / 4;
      }
  return out;
}

const texel = (img: FloatImage, x: number, y: number, k: number) =>
  x < 0 || y < 0 || x >= img.width || y >= img.height
    ? 0
    : (img.data[(y * img.width + x) * 4 + k] ?? 0);

/** Bilinear sample at texel-space point (x, y) (texel centers at i + 0.5), transparent outside. */
function bilinear(img: FloatImage, x: number, y: number, k: number): number {
  const u = x - 0.5;
  const v = y - 0.5;
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const fx = u - x0;
  const fy = v - y0;
  const top = texel(img, x0, y0, k) * (1 - fx) + texel(img, x0 + 1, y0, k) * fx;
  const bottom = texel(img, x0, y0 + 1, k) * (1 - fx) + texel(img, x0 + 1, y0 + 1, k) * fx;
  return top * (1 - fy) + bottom * fy;
}

/**
 * Resamples `levels[0]` into a `width × height` composition through the projective placement whose
 * true inverse is `inv` (`null`: singular, covers nothing). Pixels behind the near plane stay
 * transparent. Per pixel it picks the level of detail from the projective Jacobian (see
 * `projectiveSample`) and then blends exactly like `place`; `levels` is extended to the deepest
 * level any pixel needs.
 */
function placeProjective(
  levels: FloatImage[],
  inv: Projective | null,
  width: number,
  height: number,
): FloatImage {
  const src = levels[0] as FloatImage;
  const out = blank(width, height);
  if (inv === null) return out;
  const deepest = maxLevel(src.width, src.height);
  const level = (n: number): FloatImage => {
    for (let i = levels.length; i <= n; i++) levels.push(downsample(levels[i - 1] as FloatImage));
    return levels[n] as FloatImage;
  };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = projectiveSample(inv, x, y, src.width, src.height);
      if (at === null) continue;
      const k = Math.floor(at.lod);
      const t = at.lod - k;
      const top = Math.min(k + 1, deepest);
      const lo = level(k);
      const hi = t > 0 ? level(top) : lo;
      const sLo = 2 ** -k;
      const sHi = 2 ** -top;
      for (let c = 0; c < 4; c++) {
        const a = bilinear(lo, at.qx * sLo, at.qy * sLo, c);
        out.data[(y * width + x) * 4 + c] =
          t > 0 ? a * (1 - t) + bilinear(hi, at.qx * sHi, at.qy * sHi, c) * t : a;
      }
    }
  return out;
}

/** Resamples `src` into a `width × height` composition through `matrix` (source → composition). */
function place(levels: FloatImage[], matrix: Affine, width: number, height: number): FloatImage {
  const src = levels[0] as FloatImage;
  const out = blank(width, height);
  const inv = invert(matrix);
  if (inv === null) return out; // a degenerate transform covers no area
  const lod = levelOfDetail(inv, src.width, src.height);
  const k = Math.floor(lod);
  const t = lod - k;
  for (let n = levels.length; n <= Math.min(k + 1, maxLevel(src.width, src.height)); n++)
    levels.push(downsample(levels[n - 1] as FloatImage));
  const lo = levels[k] as FloatImage;
  const topLevel = Math.min(k + 1, maxLevel(src.width, src.height));
  const hi = levels[topLevel] as FloatImage;
  const sLo = 2 ** -k;
  const sHi = 2 ** -topLevel;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const qx = inv[0] * px + inv[2] * py + inv[4];
      const qy = inv[1] * px + inv[3] * py + inv[5];
      for (let c = 0; c < 4; c++) {
        const a = bilinear(lo, qx * sLo, qy * sLo, c);
        out.data[(y * width + x) * 4 + c] =
          t > 0 ? a * (1 - t) + bilinear(hi, qx * sHi, qy * sHi, c) * t : a;
      }
    }
  return out;
}
