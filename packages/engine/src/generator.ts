import {
  type Animatable,
  type FrameRate,
  type Generator,
  MAX_GENERATOR_EVOLUTION,
  MAX_GENERATOR_OFFSET,
  MAX_GENERATOR_POINT,
  MAX_NOISE_SCALE,
  MAX_PATTERN_ANGLE,
  MAX_PATTERN_SIZE,
  MIN_NOISE_SCALE,
  MIN_PATTERN_SIZE,
} from "@kynimo/scene";
import type { Rgba } from "./color.js";
import { hashWords } from "./hash.js";
import { samplePoint, sampleUnit } from "./properties.js";
import type { Point, ResolvedGradientStop } from "./resolved.js";
import { mixStops, sanitizeStops } from "./shape.js";
import { sampleColor, sampleNumber, sampleTrack } from "./track.js";

export type ResolvedGenerator =
  | {
      type: "gradient";
      kind: "linear" | "radial" | "conic";
      start: Point;
      end: Point;
      stops: ResolvedGradientStop[];
    }
  | {
      type: "noise";
      seed: number;
      scale: number;
      octaves: number;
      evolution: number;
      offset: Point;
      low: Rgba;
      high: Rgba;
    }
  | {
      type: "pattern";
      kind: "stripes" | "checker" | "dots" | "grid";
      size: number;
      thickness: number;
      /** `[cos, sin]` of the angle (clockwise on screen), computed in float64. */
      rotation: Point;
      offset: Point;
      foreground: Rgba;
      background: Rgba;
    }
  | {
      type: "aurora";
      colors: Rgba[];
      /** Color anchor points in layer pixels. */
      points: Point[];
      /** Falloff width in pixels. */
      sigma: number;
    };

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const unitOf = (hash: number) => hash / 4294967295;
const frac = (v: number) => v - Math.floor(v);

/**
 * Samples a generator in layer time, clamping easing overshoot to each field's domain. Everything
 * trigonometric or seed-derived is computed here in float64 and handed to the renderer as plain
 * numbers (ADR-0045). `width` and `height` are the layer's size.
 */
export function resolveGenerator(
  generator: Generator,
  frame: number,
  fps: FrameRate,
  width: number,
  height: number,
): ResolvedGenerator {
  const number = (track: Animatable<number>, min: number, max: number) =>
    clamp(sampleNumber(track, frame, fps), min, max);
  const color = (track: Animatable<string>) => sampleColor(track, frame, fps);
  const offset = (track: Animatable<[number, number]>): Point => {
    const [x, y] = samplePoint(track, frame, fps);
    return [
      clamp(x, -MAX_GENERATOR_OFFSET, MAX_GENERATOR_OFFSET),
      clamp(y, -MAX_GENERATOR_OFFSET, MAX_GENERATOR_OFFSET),
    ];
  };
  const point = (track: Animatable<[number, number]>): Point => {
    const [x, y] = samplePoint(track, frame, fps);
    return [
      clamp(x, -MAX_GENERATOR_POINT, MAX_GENERATOR_POINT),
      clamp(y, -MAX_GENERATOR_POINT, MAX_GENERATOR_POINT),
    ];
  };
  const evolution = (track: Animatable<number>) =>
    number(track, -MAX_GENERATOR_EVOLUTION, MAX_GENERATOR_EVOLUTION);

  switch (generator.type) {
    case "gradient":
      return {
        type: "gradient",
        kind: generator.kind,
        start: point(generator.start),
        end: point(generator.end),
        stops: sanitizeStops(sampleTrack(generator.stops, frame, fps, mixStops)),
      };
    case "noise":
      return {
        type: "noise",
        seed: generator.seed,
        scale: number(generator.scale, MIN_NOISE_SCALE, MAX_NOISE_SCALE),
        octaves: generator.octaves,
        evolution: evolution(generator.evolution),
        offset: offset(generator.offset),
        low: color(generator.low),
        high: color(generator.high),
      };
    case "pattern": {
      const angle =
        (number(generator.angle, -MAX_PATTERN_ANGLE, MAX_PATTERN_ANGLE) * Math.PI) / 180;
      return {
        type: "pattern",
        kind: generator.kind,
        size: number(generator.size, MIN_PATTERN_SIZE, MAX_PATTERN_SIZE),
        thickness: sampleUnit(generator.thickness, frame, fps),
        rotation: [Math.cos(angle), Math.sin(angle)],
        offset: offset(generator.offset),
        foreground: color(generator.foreground),
        background: color(generator.background),
      };
    }
    case "aurora": {
      const { seed } = generator;
      const colors = generator.colors.map(color);
      const n = colors.length;
      const e = evolution(generator.evolution);
      const m = Math.max(width, height);
      const u0 = unitOf(hashWords(seed, [99]));
      const points: Point[] = colors.map((_, i) => {
        const theta = 2 * Math.PI * (i / n + u0);
        const baseX = width / 2 + 0.3 * width * Math.cos(theta);
        const baseY = height / 2 + 0.3 * height * Math.sin(theta);
        const k1 = 1 + (hashWords(seed, [i, 1]) % 3);
        const k2 = 1 + (hashWords(seed, [i, 2]) % 3);
        const phi1 = unitOf(hashWords(seed, [i, 3]));
        const phi2 = unitOf(hashWords(seed, [i, 4]));
        return [
          baseX + 0.2 * width * Math.sin(2 * Math.PI * frac(e * k1 + phi1)),
          baseY + 0.2 * height * Math.cos(2 * Math.PI * frac(e * k2 + phi2)),
        ];
      });
      const softness = sampleUnit(generator.softness, frame, fps);
      return { type: "aurora", colors, points, sigma: (0.1 + 0.4 * softness) * m };
    }
  }
}
