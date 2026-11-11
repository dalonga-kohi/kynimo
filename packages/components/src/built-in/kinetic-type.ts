import type { StaggerToken, TypeRole } from "@kynimo/guidelines";
import type { Animatable, RangeSelector, TextAnimator, Vec2 } from "@kynimo/scene";
import { defineComponent } from "../define.js";
import type { ComponentStyle } from "../style.js";
import {
  enterEase,
  exitOnly,
  exitProp,
  HOLD,
  key,
  keys,
  LINEAR,
  propsEnvelope,
  round3,
  selector,
  speedProp,
  still,
  textLayer,
  vec,
} from "./kit.js";

const VARIANTS = [
  "rise",
  "pop",
  "slam",
  "typewriter",
  "blur",
  "cascade",
  "scatter",
  "wave",
] as const;
type Variant = (typeof VARIANTS)[number];
type Unit = RangeSelector["unit"];
type Order = RangeSelector["order"];

const UNITS = ["auto", "characters", "words", "lines"] as const;
const ORDERS = ["auto", "forward", "reverse", "center-out", "edges-in", "random"] as const;
const ROLES = ["display", "headline", "title"] as const;
const CASES = ["auto", "none", "upper", "lower"] as const;

/** How the units of text enter: the unit, the order and what the hidden state looks like. */
interface Recipe {
  unit: Unit;
  order: Order;
  ease: "enter" | "bouncy" | "snappy" | "linear";
}

const RECIPES: Record<Variant, Recipe> = {
  rise: { unit: "words", order: "forward", ease: "enter" },
  pop: { unit: "words", order: "forward", ease: "bouncy" },
  slam: { unit: "words", order: "forward", ease: "snappy" },
  typewriter: { unit: "characters", order: "forward", ease: "linear" },
  blur: { unit: "characters", order: "center-out", ease: "enter" },
  cascade: { unit: "characters", order: "forward", ease: "enter" },
  scatter: { unit: "characters", order: "random", ease: "enter" },
  wave: { unit: "characters", order: "forward", ease: "enter" },
};

const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;

/** Units the renderer will roughly find: words by whitespace, characters without whitespace, non-empty lines. */
export function countUnits(text: string, unit: Unit): number {
  if (unit === "words") return text.split(/\s+/u).filter((w) => w.length > 0).length;
  if (unit === "lines") return text.split(LINE_BREAK).filter((l) => l.trim().length > 0).length;
  return Array.from(text.replace(/\s/gu, "")).length;
}

/** The share of the 0..1 axis the looping bob of `wave` lights up at a time. */
const WAVE_WIDTH = 0.4;
const MAX_WAVE_CYCLES = 200;

export const kineticType = defineComponent({
  id: "kinetic-type",
  version: "1.0.0",
  title: "Kinetic type",
  description:
    "An animated headline drawn as point text (no wrapping; use \\n for line breaks) in a display, headline or title style. It enters at the start of the instance, word by word or character by character depending on the variant, and exits at its end.",
  props: {
    text: {
      type: "string",
      description: "The headline. A \\n starts a new line; lines are never wrapped.",
      default: "Make it move",
      maxLength: 500,
    },
    variant: {
      type: "enum",
      description:
        "How the text enters: rise, pop, slam, typewriter, blur, cascade, scatter or wave (wave also keeps bobbing).",
      values: [...VARIANTS],
      default: "rise",
    },
    unit: {
      type: "enum",
      description:
        "What animates one after another: auto (the variant's choice), characters, words or lines.",
      values: [...UNITS],
      default: "auto",
    },
    order: {
      type: "enum",
      description:
        "The order units enter in: auto (the variant's choice), forward, reverse, center-out, edges-in or random.",
      values: [...ORDERS],
      default: "auto",
    },
    role: {
      type: "enum",
      description: "The type style from the style pack: display, headline or title.",
      values: [...ROLES],
      default: "display",
    },
    color: {
      type: "color",
      description: "Text color; a hex color or a color role of the style pack.",
      default: { role: "text" },
      animatable: true,
    },
    useHighlight: {
      type: "boolean",
      description:
        "Whether units start in the highlight color and settle into the text color as they enter.",
      default: false,
    },
    highlight: {
      type: "color",
      description: "The color units enter with when useHighlight is on.",
      default: { role: "accent" },
    },
    align: {
      type: "enum",
      description:
        "Text alignment and anchor: center of the frame, or the left or right safe margin.",
      values: ["left", "center", "right"],
      default: "center",
    },
    position: {
      type: "point",
      description: "Offset of the text from its anchor, in composition pixels.",
      default: [0, 0],
      animatable: true,
    },
    speed: speedProp,
    exit: exitProp,
    stagger: {
      type: "enum",
      description:
        "The delay between units entering: tight, base or loose (the style's stagger tokens).",
      values: ["tight", "base", "loose"],
      default: "base",
    },
    textCase: {
      type: "enum",
      description: "Letter case: auto (the type style's own), none, upper or lower.",
      values: [...CASES],
      default: "auto",
    },
    scale: {
      type: "number",
      description: "Multiplier of the type size, from 0.25 to 4.",
      default: 1,
      min: 0.25,
      max: 4,
      animatable: true,
    },
  },
  evaluate(props, ctx) {
    const { style } = ctx;
    const text = props.text as string;
    const variant = props.variant as Variant;
    const recipe = RECIPES[variant];
    const unit: Unit = props.unit === "auto" ? recipe.unit : (props.unit as Unit);
    const order: Order = props.order === "auto" ? recipe.order : (props.order as Order);
    const type = style.type(props.role as TypeRole);
    const scale = props.scale as number;
    const size = round3(type.size * scale);
    const env = propsEnvelope(ctx, props);

    // Layout. There are no font metrics here, so the vertical centering is an estimate: the
    // baseline of the first line sits 0.35 em below the block's middle, moved up by half the
    // extra lines.
    const lines = Math.max(1, text.split(LINE_BREAK).length);
    const [dx, dy] = props.position as Vec2;
    const align = props.align as "left" | "center" | "right";
    const margin = style.spacing("xl");
    const anchorX =
      align === "center" ? ctx.width / 2 : align === "left" ? margin : ctx.width - margin;
    const anchorY = ctx.height / 2 + dy;
    const baselineY = anchorY + 0.35 * size - ((lines - 1) * type.leading * size) / 2;
    const at = vec(anchorX + dx, baselineY);
    const down = vec(at[0], at[1] + style.distance("small"));

    const animators = enterAnimators();
    function enterAnimators(): TextAnimator[] {
      if (env.enterEnd < 1) return [];
      const count = countUnits(text, unit);
      const sweep = Math.min(
        env.exitStart,
        env.enterEnd + style.stagger(props.stagger as StaggerToken) * Math.max(0, count - 1),
      );
      const seed = order === "random" ? Math.floor(ctx.random() * 0x7fffffff) : 0;
      const easing = recipe.ease === "linear" ? LINEAR : enterEase(ctx, recipe.ease, sweep);
      const reveal = selector(unit, {
        order,
        seed,
        start: keys(key(0, 0, easing), key(sweep, 1, HOLD)),
      });
      const hidden = hiddenState(variant, style);
      const out: TextAnimator[] = [
        {
          name: "Enter",
          selector: reveal,
          properties: {
            opacity: still(0),
            ...hidden,
            ...(props.useHighlight === true ? { fill: still(props.highlight as string) } : {}),
          },
        },
      ];
      if (variant === "wave") {
        const bob = waveBob(ctx.fps, env.enterEnd, env.exitStart);
        if (bob !== null)
          out.push({
            name: "Bob",
            selector: selector("characters", {
              shape: "round",
              end: still(WAVE_WIDTH),
              offset: bob,
            }),
            properties: { position: still(vec(0, -style.distance("small"))) },
          });
      }
      return out;
    }

    return {
      width: ctx.width,
      height: ctx.height,
      background: null,
      layers: [
        textLayer({
          id: "title",
          name: "Kinetic type",
          span: env.span,
          content: text,
          box: { mode: "point" },
          font: { family: type.family, weight: type.weight, size },
          tracking: type.tracking,
          leading: type.leading,
          align,
          textCase: props.textCase === "auto" ? type.textCase : (props.textCase as "none"),
          fill: props.color as string,
          animators,
          transform: {
            position: exitOnly(ctx, env, at, down),
            opacity: exitOnly(ctx, env, 1, 0),
          },
        }),
      ],
    };
  },
});

/** The extra properties of the hidden state: what a unit looks like before it enters (opacity 0 is always there). */
function hiddenState(
  variant: Variant,
  style: ComponentStyle,
): Pick<TextAnimator["properties"], "position" | "scale" | "rotation" | "blur"> {
  const distance = style.distance;
  const scale = style.scale;
  switch (variant) {
    case "rise":
      return { position: still(vec(0, distance("base"))) };
    case "pop":
      return { scale: still<Vec2>([0, 0]) };
    case "slam":
      return { scale: still<Vec2>([2.4, 2.4]) };
    case "typewriter":
      return {};
    case "blur":
      return { blur: still(round3(24 * scale)) };
    case "cascade":
      return { position: still(vec(0, -distance("large"))), rotation: still(-12) };
    case "scatter":
      return { scale: still<Vec2>([1.6, 1.6]), blur: still(round3(8 * scale)) };
    case "wave":
      return { position: still(vec(0, distance("small"))) };
  }
}

/**
 * The `offset` track of the looping bob. The window (a rounded bump `WAVE_WIDTH` wide) starts just
 * before the first character and travels past the last one, then the track jumps back and goes
 * again: a wave that runs along the text over and over. It starts after the enter and finishes its
 * last whole pass before the exit, so nothing is lifted while the text fades. `null` when there is
 * no room for a pass.
 */
function waveBob(
  fps: { num: number; den: number },
  from: number,
  until: number,
): Animatable<number> | null {
  const room = until - from;
  const preferred = Math.max(12, Math.round((1.5 * fps.num) / fps.den));
  const cycles = Math.min(MAX_WAVE_CYCLES, Math.max(1, Math.floor(room / preferred)));
  const length = Math.floor(room / cycles);
  if (length < 2) return null;
  const track = [key(0, -WAVE_WIDTH, HOLD)];
  for (let c = 0; c < cycles; c++) {
    const start = from + c * length;
    track.push(key(start, -WAVE_WIDTH), key(start + length - 1, 1, HOLD));
  }
  return keys(...track);
}
