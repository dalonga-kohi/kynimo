import {
  type Animatable,
  type Effect,
  type Generator,
  MAX_GENERATOR_OFFSET,
  MAX_NOISE_SCALE,
  MAX_PATTERN_SIZE,
  MIN_NOISE_SCALE,
  MIN_PATTERN_SIZE,
  type Vec2,
} from "@kynimo/scene";
import { defineComponent } from "../define.js";
import {
  generatorLayer,
  grainEffect,
  key,
  keys,
  LINEAR,
  round3,
  scanlinesEffect,
  still,
  vec,
  vignetteEffect,
} from "./kit.js";

const KINDS = [
  "aurora",
  "gradient",
  "radial",
  "conic",
  "noise",
  "stripes",
  "grid",
  "dots",
  "checker",
  "mesh",
] as const;
type Kind = (typeof KINDS)[number];
const DETAILS = ["fine", "base", "coarse"] as const;
type Detail = (typeof DETAILS)[number];

/** Pixels per noise cell and per pattern period at the reference size, by detail. */
const NOISE_CELL: Record<Detail, number> = { fine: 64, base: 192, coarse: 512 };
const PATTERN_PERIOD: Record<Detail, number> = { fine: 24, base: 48, coarse: 96 };
const THICKNESS: Record<"stripes" | "grid" | "dots" | "checker", number> = {
  stripes: 0.18,
  grid: 0.18,
  dots: 0.5,
  checker: 0.5,
};
/** Gradients are sampled at least this many times per turn, and at least this many over the span. */
const KEYS_PER_TURN = 16;
const MIN_SEGMENTS = 32;
const MAX_SEGMENTS = 512;
const PULSE = 0.08;
const RAD = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const background = defineComponent({
  id: "background",
  version: "1.0.0",
  title: "Background",
  description:
    "A full-frame animated background: an aurora, gradient, noise, pattern or mesh drawn by generator layers, with optional vignette, grain and scanlines. It runs from the first to the last frame of the instance and drifts `loops` times over it, so a whole number of loops repeats seamlessly (noise drifts on).",
  props: {
    kind: {
      type: "enum",
      description:
        "The look: aurora, gradient, radial, conic, noise, stripes, grid, dots, checker or mesh (aurora under a soft noise overlay).",
      values: [...KINDS],
      default: "aurora",
    },
    colorA: {
      type: "color",
      description:
        "The base color: the first gradient stop, the noise's low color, a pattern's gaps.",
      default: { role: "background" },
    },
    colorB: {
      type: "color",
      description: "The second color: the noise's high color and a pattern's marks.",
      default: { role: "accent" },
    },
    colorC: {
      type: "color",
      description:
        "The third color of aurora, mesh, gradient, radial and conic; set it equal to colorB for two colors.",
      default: { role: "accentAlt" },
    },
    colorD: {
      type: "color",
      description: "The fourth color of the same kinds when useFourth is on.",
      default: { role: "surface" },
    },
    useFourth: {
      type: "boolean",
      description: "Whether aurora, mesh, gradient, radial and conic also use colorD.",
      default: false,
    },
    loops: {
      type: "number",
      description:
        "How many times the motion repeats over the instance, from 0 (still) to 8; whole numbers loop seamlessly.",
      default: 1,
      min: 0,
      max: 8,
    },
    angle: {
      type: "number",
      description:
        "Degrees clockwise: the gradient's direction (it turns once per loop), the conic's start and the pattern's tilt.",
      default: 30,
      min: -360,
      max: 360,
    },
    origin: {
      type: "point",
      description: "Where radial and conic gradients center, as an offset from the frame center.",
      default: [0, 0],
    },
    detail: {
      type: "enum",
      description:
        "How coarse noise and patterns are: fine, base or coarse (scaled with the frame).",
      values: [...DETAILS],
      default: "base",
    },
    seed: {
      type: "number",
      description:
        "Varies aurora and noise; instances with the same seed still differ, each stays the same every time.",
      default: 0,
      min: 0,
      max: 1_000_000,
      integer: true,
    },
    vignette: {
      type: "boolean",
      description: "Whether the edges darken slightly.",
      default: true,
    },
    grain: {
      type: "boolean",
      description: "Whether fine animated film grain lies over the background.",
      default: true,
    },
    scanlines: {
      type: "boolean",
      description: "Whether faint horizontal scanlines lie over the background.",
      default: false,
    },
  },
  evaluate(props, ctx) {
    const { style } = ctx;
    const kind = props.kind as Kind;
    const detail = props.detail as Detail;
    const W = ctx.width;
    const H = ctx.height;
    const span = Math.max(1, ctx.durationFrames);
    const loops = props.loops as number;
    const angle = props.angle as number;
    const [ox, oy] = props.origin as Vec2;
    const cx = W / 2;
    const cy = H / 2;
    // Two instances with the same seed differ (the random number comes from the instance), and
    // each one is the same every time.
    const seed = ((props.seed as number) + Math.floor(ctx.random() * 2 ** 31)) % 2 ** 31;

    const colors = [props.colorA, props.colorB, props.colorC] as string[];
    if (props.useFourth === true) colors.push(props.colorD as string);
    const colorA = props.colorA as string;
    const colorB = props.colorB as string;

    /** A property that follows `at(turns)`, the progress in loops (0 at frame 0, `loops` at frame `span`). */
    const sampled = <T>(at: (turns: number) => T): Animatable<T> => {
      if (loops === 0) return still(at(0));
      const segments = clamp(Math.ceil(KEYS_PER_TURN * loops), MIN_SEGMENTS, MAX_SEGMENTS);
      const step = Math.max(1, Math.ceil(span / segments));
      const frames: number[] = [];
      for (let f = 0; f < span - 1; f += step) frames.push(f);
      frames.push(span - 1);
      return keys(...frames.map((f) => key(f, at((loops * f) / span), LINEAR)));
    };
    /** A property that goes from 0 to `loops` over the span; frame `span` would be `loops`. */
    const linear = (): Animatable<number> =>
      loops === 0 ? still(0) : keys(key(0, 0, LINEAR), key(span, loops)); // frame `span` is one past the last

    const spread = (list: string[], seam: boolean) => {
      const all = seam ? [...list, list[0] as string] : list;
      return all.map((color, i) => ({ offset: round3(i / (all.length - 1)), color }));
    };
    const farthest = (x: number, y: number) => Math.hypot(Math.max(x, W - x), Math.max(y, H - y));
    const turn = (turns: number) => (angle + 360 * turns) * RAD;
    const noiseScale = clamp(
      round3(NOISE_CELL[detail] * style.scale),
      MIN_NOISE_SCALE,
      MAX_NOISE_SCALE,
    );

    function aurora(softness: number, seedValue: number): Generator {
      return {
        type: "aurora",
        seed: seedValue,
        colors: colors.map((c) => still(c)),
        evolution: linear(),
        softness: still(softness),
      };
    }
    function noise(low: string, high: string, seedValue: number): Generator {
      return {
        type: "noise",
        seed: seedValue,
        scale: still(noiseScale),
        octaves: 4,
        evolution: linear(),
        offset: still<Vec2>([0, 0]),
        low: still(low),
        high: still(high),
      };
    }

    let generator: Generator;
    let overlay: Generator | null = null;
    switch (kind) {
      case "aurora":
        generator = aurora(0.6, seed);
        break;
      case "mesh":
        generator = aurora(1, seed);
        overlay = noise("#000000", "#ffffff", (seed + 1) % 2 ** 31);
        break;
      case "gradient":
        generator = {
          type: "gradient",
          kind: "linear",
          // The line runs corner to corner of the frame along the angle, whatever the angle.
          start: sampled((turns) => {
            const a = turn(turns);
            const length = Math.abs(W * Math.cos(a)) + Math.abs(H * Math.sin(a));
            return vec(cx - (Math.cos(a) * length) / 2, cy - (Math.sin(a) * length) / 2);
          }),
          end: sampled((turns) => {
            const a = turn(turns);
            const length = Math.abs(W * Math.cos(a)) + Math.abs(H * Math.sin(a));
            return vec(cx + (Math.cos(a) * length) / 2, cy + (Math.sin(a) * length) / 2);
          }),
          stops: still(spread(colors, false)),
        };
        break;
      case "radial": {
        const x = cx + ox;
        const y = cy + oy;
        const radius = Math.max(1, farthest(x, y));
        generator = {
          type: "gradient",
          kind: "radial",
          start: still(vec(x, y)),
          // Breathes by 8% once per loop.
          end: sampled((turns) => vec(x + radius * (1 + PULSE * Math.sin(2 * Math.PI * turns)), y)),
          stops: still(spread(colors, false)),
        };
        break;
      }
      case "conic":
        generator = {
          type: "gradient",
          kind: "conic",
          start: still(vec(cx + ox, cy + oy)),
          end: sampled((turns) =>
            vec(cx + ox + 100 * Math.cos(turn(turns)), cy + oy + 100 * Math.sin(turn(turns))),
          ),
          // The last stop is the first color again, so the seam where the angle wraps is invisible.
          stops: still(spread(colors, true)),
        };
        break;
      case "noise":
        generator = noise(colorA, colorB, seed);
        break;
      case "stripes":
      case "grid":
      case "dots":
      case "checker": {
        const size = clamp(
          round3(PATTERN_PERIOD[detail] * style.scale),
          MIN_PATTERN_SIZE,
          MAX_PATTERN_SIZE,
        );
        // A checker repeats every two cells, the others every cell. The pattern slides one period
        // per loop along its own x axis, so a whole number of loops ends where it began.
        const period = kind === "checker" ? 2 * size : size;
        const turns = Math.min(loops, Math.floor(MAX_GENERATOR_OFFSET / period));
        const a = angle * RAD;
        generator = {
          type: "pattern",
          kind,
          size: still(size),
          thickness: still(THICKNESS[kind]),
          angle: still(angle),
          offset:
            turns === 0
              ? still<Vec2>([0, 0])
              : keys(
                  key(0, [0, 0] as Vec2, LINEAR),
                  key(span, vec(turns * period * Math.cos(a), turns * period * Math.sin(a))),
                ),
          foreground: still(colorB),
          background: still(colorA),
        };
        break;
      }
    }

    const effects: Effect[] = [];
    if (props.vignette === true)
      effects.push(
        vignetteEffect("vignette", { amount: 0.35, radius: 0.7, feather: 0.9, color: "#000000" }),
      );
    if (props.grain === true)
      effects.push(
        grainEffect("grain", {
          amount: 0.06,
          size: clamp(Math.round(style.scale), 1, 8),
          seed,
          animated: true,
          monochrome: true,
        }),
      );
    if (props.scanlines === true)
      effects.push(
        scanlinesEffect("scanlines", {
          amount: 0.12,
          spacing: clamp(Math.round(4 * style.scale), 2, 64),
          thickness: 0.5,
          color: "#000000",
        }),
      );

    const base = { span, width: W, height: H };
    const layers =
      overlay === null
        ? [generatorLayer({ ...base, id: "background", name: "Background", generator, effects })]
        : [
            generatorLayer({
              ...base,
              id: "overlay",
              name: "Background overlay",
              generator: overlay,
              blendMode: "overlay",
              transform: { opacity: still(0.4) },
              effects,
            }),
            generatorLayer({ ...base, id: "background", name: "Background", generator }),
          ];
    return { width: W, height: H, background: null, layers };
  },
});
