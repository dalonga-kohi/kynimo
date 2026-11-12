import type { Animatable, BezierPath, Interpolation, Layer, Vec2 } from "@kynimo/scene";
import { defineComponent } from "../define.js";
import {
  ellipseItem,
  ellipsePath,
  fillItem,
  key,
  keys,
  LINEAR,
  pathMask,
  round3,
  shapeLayer,
  solidLayer,
  still,
  vec,
} from "./kit.js";

const KINDS = [
  "wipe",
  "panels",
  "iris",
  "dip",
  "split",
  "diagonal",
  "blinds",
  "shutter",
  "circles",
  "slide",
] as const;
type Kind = (typeof KINDS)[number];
const DIRECTIONS = ["left", "right", "up", "down"] as const;
type Direction = (typeof DIRECTIONS)[number];

const TILT = 20;

/** The two phases of the instance: covering the frame up to `coverEnd`, uncovering from `uncoverStart`. */
interface Phases {
  /** Frames from the first to the last frame of the instance. */
  last: number;
  /** The frame the frame is fully covered by the end of the cover phase. */
  coverEnd: number;
  /** The frame the uncover phase starts on; the frame is covered from `coverEnd` to here. */
  uncoverStart: number;
}

/**
 * The midpoint is `floor((span - 1) / 2)`; `hold` frames are held covered around it (the first
 * `floor(hold / 2)` before it, the rest after). Each phase keeps at least one frame, so a hold that
 * is too long shrinks. Instances of one or two frames have no room: they are covered from frame 0.
 */
function phasesOf(span: number, hold: number): Phases {
  const last = span - 1;
  const mid = Math.floor(last / 2);
  const before = Math.min(Math.floor(hold / 2), Math.max(0, mid - 1));
  const after = Math.min(Math.ceil(hold / 2), Math.max(0, last - mid - 1));
  return { last, coverEnd: mid - before, uncoverStart: mid + after };
}

/** How long each item's motion lasts in one phase when item delays spread over `spread` frames. */
interface Plan {
  coverSpread: number;
  uncoverSpread: number;
}

/** The delay between neighbors that fits `items` in a phase of `len` frames, one frame at least left for each. */
const stepFor = (len: number, items: number, wanted: number): number =>
  items > 1 && len > 1 ? Math.min(wanted, Math.floor((len - 1) / (items - 1))) : 0;

interface ItemTiming {
  /** Delay of the item in the cover phase and in the uncover phase, in frames. */
  inDelay: number;
  outDelay: number;
}

export const transition = defineComponent({
  id: "transition",
  version: "1.0.0",
  title: "Transition",
  description:
    "A cover transition: shapes sweep over the frame, hide it fully at the midpoint of the instance, then uncover it again by the last frame. The instance's duration is the transition; it draws only its own shapes, so cut your shots at the midpoint.",
  props: {
    kind: {
      type: "enum",
      description:
        "The look: wipe, panels, iris, dip, split, diagonal, blinds, shutter, circles or slide.",
      values: [...KINDS],
      default: "wipe",
    },
    direction: {
      type: "enum",
      description:
        "The direction of travel: left, right, up or down (split, blinds and shutter use only its axis).",
      values: [...DIRECTIONS],
      default: "right",
    },
    count: {
      type: "number",
      description:
        "How many strips panels, blinds and shutter have, and the circles across the longer side of circles; 2 to 24.",
      default: 6,
      min: 2,
      max: 24,
      integer: true,
    },
    color: {
      type: "color",
      description: "The main color of the shapes; a hex color or a color role of the style pack.",
      default: { role: "accent" },
    },
    secondaryColor: {
      type: "color",
      description: "The second color: every other panel, and the first layer of slide.",
      default: { role: "surface" },
    },
    origin: {
      type: "point",
      description: "Where iris opens and circles start from, as an offset from the frame center.",
      default: [0, 0],
    },
    hold: {
      type: "number",
      description:
        "Frames the frame stays fully covered around the midpoint, from 0 to 120; shortened to leave a frame for each phase.",
      default: 0,
      min: 0,
      max: 120,
      integer: true,
    },
  },
  evaluate(props, ctx) {
    const { style } = ctx;
    const kind = props.kind as Kind;
    const direction = props.direction as Direction;
    const count = props.count as number;
    const color = props.color as string;
    const secondary = props.secondaryColor as string;
    const [ox, oy] = props.origin as Vec2;
    const W = ctx.width;
    const H = ctx.height;
    const span = Math.max(1, ctx.durationFrames);
    const p = phasesOf(span, props.hold as number);
    const move = style.easing("move");
    const tight = style.stagger("tight");

    // The direction of travel as a unit vector; the axis its strips and halves are laid along.
    const dirX = direction === "right" ? 1 : direction === "left" ? -1 : 0;
    const dirY = direction === "down" ? 1 : direction === "up" ? -1 : 0;
    const horizontal = dirX !== 0;
    const extent = horizontal ? W : H;

    const track = <T>(
      timing: ItemTiming,
      plan: Plan,
      v: { start: T; cover: T; end: T; easeIn?: Interpolation; easeOut?: Interpolation },
    ): Animatable<T> => {
      if (p.last === 0) return still(v.cover);
      const coverDur = p.coverEnd - plan.coverSpread;
      const uncoverDur = p.last - p.uncoverStart - plan.uncoverSpread;
      const out = p.uncoverStart + timing.outDelay;
      return keys(
        key(timing.inDelay, v.start, v.easeIn ?? move),
        key(timing.inDelay + coverDur, v.cover, LINEAR),
        key(out, v.cover, v.easeOut ?? move),
        key(out + uncoverDur, v.end),
      );
    };
    const noPlan: Plan = { coverSpread: 0, uncoverSpread: 0 };
    const together: ItemTiming = { inDelay: 0, outDelay: 0 };
    /** A plan and the per-item delays for `n` items staggered one after another by the tight step. */
    const staggered = (n: number, reverseOut = false) => {
      const inStep = stepFor(p.coverEnd, n, tight);
      const outStep = stepFor(p.last - p.uncoverStart, n, tight);
      const plan: Plan = { coverSpread: (n - 1) * inStep, uncoverSpread: (n - 1) * outStep };
      const timing = (i: number): ItemTiming => ({
        inDelay: i * inStep,
        outDelay: (reverseOut ? n - 1 - i : i) * outStep,
      });
      return { plan, timing };
    };

    /** A solid of `w` × `h` centered on `at`, with its anchor in the middle so it moves and scales from there. */
    const solid = (
      id: string,
      name: string,
      w: number,
      h: number,
      fill: string,
      t: {
        position: Animatable<Vec2>;
        scale?: Animatable<Vec2>;
        rotation?: number;
      },
    ): Layer =>
      solidLayer({
        id,
        name,
        span,
        width: w,
        height: h,
        color: fill,
        transform: {
          anchorPoint: still(vec(Math.max(1, Math.round(w)) / 2, Math.max(1, Math.round(h)) / 2)),
          position: t.position,
          ...(t.scale === undefined ? {} : { scale: t.scale }),
          ...(t.rotation === undefined ? {} : { rotation: still(t.rotation) }),
        },
      });

    const pos = (x: number, y: number): Vec2 => vec(x, y);
    /** A position track sliding along the travel axis from one side of `rest` to the other. */
    const slide = (
      rest: Vec2,
      sign: number,
      distance: number,
      timing: ItemTiming,
      plan: Plan,
    ): Animatable<Vec2> =>
      track(timing, plan, {
        start: pos(rest[0] - sign * dirX * distance, rest[1] - sign * dirY * distance),
        cover: rest,
        end: pos(rest[0] + sign * dirX * distance, rest[1] + sign * dirY * distance),
      });

    /** Cut points that tile `total` pixels into `n` whole-pixel strips. */
    const cuts = (total: number, n: number): number[] =>
      Array.from({ length: n + 1 }, (_, i) => Math.round((i * total) / n));
    /** `n` strips tiling the frame, each full length along the travel axis (or across it when `across`). */
    const strips = (n: number, alongTravel: boolean) => {
      const stack = alongTravel ? !horizontal : horizontal;
      const edges = cuts(stack ? W : H, n);
      return Array.from({ length: n }, (_, i) => {
        const a = edges[i] ?? 0;
        const b = edges[i + 1] ?? 0;
        const thickness = Math.max(1, b - a);
        const mid = (a + b) / 2;
        return stack
          ? { w: thickness, h: H, center: pos(mid, H / 2), thickness }
          : { w: W, h: thickness, center: pos(W / 2, mid), thickness };
      });
    };

    const layers: Layer[] = [];
    switch (kind) {
      case "wipe":
        layers.push(
          solid("wipe", "Wipe", W, H, color, {
            position: slide(pos(W / 2, H / 2), 1, extent, together, noPlan),
          }),
        );
        break;
      case "panels": {
        const { plan, timing } = staggered(count);
        strips(count, true).forEach((s, i) => {
          layers.push(
            solid(`panel-${i}`, `Panel ${i + 1}`, s.w, s.h, i % 2 === 0 ? color : secondary, {
              position: slide(s.center, 1, extent, timing(i), plan),
            }),
          );
        });
        break;
      }
      case "iris": {
        const cx = W / 2 + ox;
        const cy = H / 2 + oy;
        const reach = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy)) * 1.01 + 2;
        const circle = (r: number): BezierPath => ellipsePath(cx, cy, r, r);
        const grow = track(together, noPlan, {
          start: circle(0),
          cover: circle(reach),
          end: circle(reach),
        });
        // The hole stays closed until the uncover phase starts, then opens to the same radius.
        const open: Animatable<BezierPath> =
          p.last === 0
            ? still(circle(0))
            : keys(
                key(0, circle(0), LINEAR),
                key(p.uncoverStart, circle(0), move),
                key(p.last, circle(reach)),
              );
        const layer = solidLayer({
          id: "iris",
          name: "Iris",
          span,
          width: W,
          height: H,
          color,
          masks: [pathMask("grow", grow, "add"), pathMask("open", open, "subtract")],
        });
        layers.push(layer);
        break;
      }
      case "dip":
        layers.push(
          solidLayer({
            id: "dip",
            name: "Dip",
            span,
            width: W,
            height: H,
            color,
            transform: {
              opacity: track(together, noPlan, {
                start: 0,
                cover: 1,
                end: 0,
                easeIn: style.easing("enter"),
                easeOut: style.easing("exit"),
              }),
            },
          }),
        );
        break;
      case "split": {
        const first = Math.round(extent / 2);
        const second = extent - first;
        const half = (id: string, name: string, lead: boolean) => {
          const size = lead ? first : second;
          const restAlong = lead ? size / 2 : first + size / 2;
          const offAlong = lead ? -size / 2 : extent + size / 2;
          const rest = horizontal ? pos(restAlong, H / 2) : pos(W / 2, restAlong);
          const off = horizontal ? pos(offAlong, H / 2) : pos(W / 2, offAlong);
          return solid(id, name, horizontal ? size : W, horizontal ? H : size, color, {
            position: track(together, noPlan, { start: off, cover: rest, end: off }),
          });
        };
        layers.push(half("half-a", "First half", true), half("half-b", "Second half", false));
        break;
      }
      case "diagonal": {
        const side = Math.round(Math.hypot(W, H) * 1.2);
        const rad = (TILT * Math.PI) / 180;
        // Far enough that the tilted square, corner first, has fully left the frame.
        const distance = (side / 2) * (Math.cos(rad) + Math.sin(rad)) + extent / 2 + 1;
        layers.push(
          solid("diagonal", "Diagonal", side, side, color, {
            position: slide(pos(W / 2, H / 2), 1, distance, together, noPlan),
            rotation: TILT,
          }),
        );
        break;
      }
      case "blinds": {
        const { plan, timing } = staggered(count, true);
        strips(count, false).forEach((s, i) => {
          const thin: Vec2 = horizontal ? [0, 1] : [1, 0];
          layers.push(
            solid(`blind-${i}`, `Blind ${i + 1}`, s.w, s.h, color, {
              position: still(s.center),
              scale: track(timing(i), plan, { start: thin, cover: [1, 1], end: thin }),
            }),
          );
        });
        break;
      }
      case "shutter": {
        const { plan, timing } = staggered(count);
        strips(count, true).forEach((s, i) => {
          layers.push(
            solid(`shutter-${i}`, `Shutter ${i + 1}`, s.w, s.h, color, {
              position: slide(s.center, i % 2 === 0 ? 1 : -1, extent, timing(i), plan),
            }),
          );
        });
        break;
      }
      case "circles": {
        // Cells are squares of the longer side over `count`: at most 24 × 24 = 576 layers, under
        // the 600 a transition may draw.
        const cell = Math.max(W, H) / count;
        const cols = Math.max(1, Math.min(count, Math.ceil(W / cell - 1e-9)));
        const rows = Math.max(1, Math.min(count, Math.ceil(H / cell - 1e-9)));
        const diameter = round3(Math.hypot(cell, cell) + 1);
        const originX = W / 2 + ox;
        const originY = H / 2 + oy;
        const cells = [];
        for (let r = 0; r < rows; r++)
          for (let c = 0; c < cols; c++) {
            const x = (c + 0.5) * cell;
            const y = (r + 0.5) * cell;
            cells.push({ x, y, distance: Math.hypot(x - originX, y - originY) });
          }
        const farthest = Math.max(1, ...cells.map((c) => c.distance));
        const spreadOf = (len: number) => (len > 1 ? Math.min(Math.floor(0.6 * len), len - 1) : 0);
        const plan: Plan = {
          coverSpread: spreadOf(p.coverEnd),
          uncoverSpread: spreadOf(p.last - p.uncoverStart),
        };
        cells.forEach((c, i) => {
          const share = c.distance / farthest;
          layers.push(
            shapeLayer({
              id: `circle-${i}`,
              name: `Circle ${i + 1}`,
              span,
              contents: [
                ellipseItem("circle", { position: vec(0, 0), size: vec(diameter, diameter) }),
                fillItem("fill", color),
              ],
              transform: {
                position: still(vec(c.x, c.y)),
                scale: track(
                  {
                    inDelay: Math.round(share * plan.coverSpread),
                    outDelay: Math.round(share * plan.uncoverSpread),
                  },
                  plan,
                  { start: [0, 0], cover: [1, 1], end: [0, 0] },
                ),
              },
            }),
          );
        });
        break;
      }
      case "slide": {
        const inStep = stepFor(p.coverEnd, 2, tight);
        const plan: Plan = { coverSpread: inStep, uncoverSpread: 0 };
        const at = pos(W / 2, H / 2);
        // The main color is on top and arrives a beat after the second one; they leave together.
        layers.push(
          solid("slide-main", "Slide", W, H, color, {
            position: slide(at, 1, extent, { inDelay: inStep, outDelay: 0 }, plan),
          }),
          solid("slide-second", "Slide underlay", W, H, secondary, {
            position: slide(at, 1, extent, together, plan),
          }),
        );
        break;
      }
    }

    return { width: W, height: H, background: null, layers };
  },
});
