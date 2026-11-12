import type { Animatable, BezierPath, Effect, Layer, Mask, Transform, Vec2 } from "@kynimo/scene";
import { defineComponent } from "../define.js";
import {
  aberrationEffect,
  blurEffect,
  ellipseItem,
  ellipsePath,
  enterEase,
  enterExit,
  exitOnly,
  exitProp,
  fillItem,
  glowEffect,
  HOLD,
  imageLayer,
  key,
  keys,
  mapTrack,
  pathMask,
  position,
  propsEnvelope,
  rectItem,
  rectMask,
  rectPath,
  round3,
  shapeLayer,
  solidLayer,
  speedProp,
  still,
  strokeItem,
  textBaseline,
  textLayer,
  vec,
} from "./kit.js";

const VARIANTS = ["scale", "wipe", "blur", "iris", "rise", "flip", "glitch", "stamp"] as const;
type Variant = (typeof VARIANTS)[number];
const DIRECTIONS = ["left", "right", "up", "down"] as const;
type Direction = (typeof DIRECTIONS)[number];

/** Effect radii and aberration are capped by the scene format. */
const MAX_BLUR = 48;
const MAX_ABERRATION = 32;
/** Without font metrics, an average glyph is this many em wide (capitals of a bold face run wide). */
const GLYPH_WIDTH_EM = 0.65;
/** At most this many glitch jitter keyframes, however long the enter. */
const MAX_JITTER_KEYS = 120;

/** The mark in its own layer space: where its anchor sits and the box it fills. */
interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
}

export const logoReveal = defineComponent({
  id: "logo-reveal",
  version: "1.0.0",
  title: "Logo reveal",
  description:
    "A logo image, or a wordmark when there is none, revealed at the center of the frame with an optional tagline beneath it. It enters over the speed's duration at the start of the instance, the tagline a beat later, then holds; with exit on it fades and shrinks over the last frames.",
  props: {
    logo: {
      type: "asset",
      description: "The logo, an image asset of the project; null draws the wordmark text instead.",
      assetType: "image",
      default: null,
    },
    wordmark: {
      type: "string",
      description: "The text drawn when there is no logo, in the display type style.",
      default: "Kynimo",
      maxLength: 60,
    },
    color: {
      type: "color",
      description: "Wordmark color; a hex color or a color role of the style pack.",
      default: { role: "text" },
    },
    tagline: {
      type: "string",
      description: "A line beneath the mark that fades up after it; an empty string leaves it out.",
      default: "",
      maxLength: 120,
    },
    taglineColor: {
      type: "color",
      description: "Tagline color.",
      default: { role: "textMuted" },
    },
    size: {
      type: "number",
      description:
        "Height of the mark as a fraction of the composition height, from 0.05 to 0.9; a logo is never wider than 80% of the width.",
      default: 0.28,
      min: 0.05,
      max: 0.9,
      animatable: true,
    },
    position: {
      type: "point",
      description: "Offset of the mark from the center of the composition, in pixels.",
      default: [0, 0],
      animatable: true,
    },
    variant: {
      type: "enum",
      description:
        "How the mark enters: scale, wipe, blur, iris, rise (out of an accent line), flip, glitch or stamp (with a ring).",
      values: [...VARIANTS],
      default: "scale",
    },
    direction: {
      type: "enum",
      description:
        "Which way the wipe variant sweeps: left, right, up or down. The other variants ignore it.",
      values: [...DIRECTIONS],
      default: "right",
    },
    accent: {
      type: "color",
      description: "Color of the rise variant's line, the stamp variant's ring and the glow.",
      default: { role: "accent" },
    },
    glow: {
      type: "boolean",
      description: "Whether the mark has a soft glow in the accent color.",
      default: false,
    },
    speed: { ...speedProp, default: "slow" },
    exit: { ...exitProp, default: false },
    backdrop: {
      type: "color",
      description: "The color behind the mark when useBackdrop is on.",
      default: { role: "background" },
    },
    useBackdrop: {
      type: "boolean",
      description:
        "Whether a backdrop-colored layer fills the frame behind the mark; off leaves what is under it.",
      default: false,
    },
  },
  evaluate(props, ctx) {
    const { style } = ctx;
    const variant = props.variant as Variant;
    const direction = props.direction as Direction;
    const env = propsEnvelope(ctx, props);
    const accent = props.accent as string;
    const [dx, dy] = props.position as Vec2;
    const cx = ctx.width / 2 + dx;
    const cy = ctx.height / 2 + dy;
    const small = style.distance("small");
    const heightPx = (props.size as number) * ctx.height;

    // The mark: an image fitted to the size, or the wordmark as point text. `anchor` is the point
    // of the layer that sits on the mark's center; `box` is the area the mark fills, both in layer
    // space; `fit` is the layer's uniform scale at rest.
    let anchor: Vec2;
    let box: Box;
    let fit = 1;
    let pad: number;
    let mark: (o: { masks: Mask[]; effects: Effect[]; transform: Partial<Transform> }) => Layer;
    const logoId = props.logo as string | null;
    if (logoId !== null) {
      const asset = ctx.assetSize(logoId);
      if (asset === null)
        throw new Error(
          `logo asset '${logoId}' has no known pixel size; use an image asset of the project`,
        );
      fit = Math.min(heightPx / asset.height, (0.8 * ctx.width) / asset.width);
      anchor = [asset.width / 2, asset.height / 2];
      box = { l: 0, t: 0, r: asset.width, b: asset.height };
      pad = 0.02;
      mark = (o) => imageLayer({ id: "mark", name: "Logo", span: env.span, assetId: logoId, ...o });
    } else {
      const text = props.wordmark as string;
      const type = style.type("display");
      const chars = Math.max(1, Array.from(text).length);
      const em = GLYPH_WIDTH_EM + type.tracking / 1000;
      // The font size is 0.7 of the mark height (a cap-height estimate), shrunk if the estimated
      // width would pass 80% of the composition width.
      const fontSize = round3(Math.min(heightPx * 0.7, (0.8 * ctx.width) / (chars * em)));
      const half = (chars * em * fontSize) / 2;
      // The anchor is the middle of the line, so the baseline sits where `textBaseline` puts it.
      anchor = [0, -textBaseline(0, fontSize, 1, type.leading)];
      box = { l: -half, t: -0.8 * fontSize, r: half, b: 0.25 * fontSize };
      pad = 0.2;
      mark = (o) =>
        textLayer({
          id: "mark",
          name: "Wordmark",
          span: env.span,
          content: text,
          box: { mode: "point" },
          font: { family: type.family, weight: type.weight, size: fontSize },
          tracking: type.tracking,
          leading: type.leading,
          align: "center",
          textCase: type.textCase,
          fill: props.color as string,
          ...o,
        });
    }
    const boxW = box.r - box.l;
    const boxH = box.b - box.t;
    // The padded box masks reveal; it covers a text estimate that is a little off.
    const padded: Box = {
      l: box.l - pad * boxW,
      t: box.t - pad * boxH,
      r: box.r + pad * boxW,
      b: box.b + pad * boxH,
    };
    const midX = (box.l + box.r) / 2;
    const midY = (box.t + box.b) / 2;
    // Where the box sits on screen at rest.
    const screenMidX = cx + (midX - anchor[0]) * fit;
    const screenMidY = cy + (midY - anchor[1]) * fit;
    const screenW = boxW * fit;
    const screenH = boxH * fit;
    const screenBottom = screenMidY + screenH / 2;

    // Enter windows: fractions of the enter.
    const enter = style.easing("enter");
    const win = (a: number, b: number): [number, number] => {
      const e = env.enterEnd;
      if (e < 1) return [0, 0];
      const s = Math.min(e - 1, Math.round(e * a));
      return [s, Math.min(e, Math.max(s + 1, Math.round(e * b)))];
    };
    const full = win(0, 1);
    const fadeWindow = win(0, 0.5);

    const opacity = (window: [number, number]) =>
      enterExit(ctx, env, { hidden: 0, shown: 1, gone: 0, window, ease: enter });
    const holdOpacity = exitOnly(ctx, env, 1, 0);
    const scaleOf = (from: Vec2, ease = enter, window = full): Animatable<Vec2> =>
      enterExit<Vec2>(ctx, env, {
        hidden: vec(from[0] * fit, from[1] * fit),
        shown: vec(fit, fit),
        gone: vec(0.94 * fit, 0.94 * fit),
        window,
        ease,
      });
    const restScale = exitOnly<Vec2>(ctx, env, vec(fit, fit), vec(0.94 * fit, 0.94 * fit));

    let markOpacity: Animatable<number> = holdOpacity;
    let markScale: Animatable<Vec2> = restScale;
    let markX: Animatable<number> | number = cx;
    let markY: Animatable<number> | number = cy;
    const masks: Mask[] = [];
    const effects: Effect[] = [];
    const extra: Layer[] = [];

    switch (variant) {
      case "scale":
        markOpacity = opacity(fadeWindow);
        markScale = scaleOf([0.6, 0.6], enterEase(ctx, "gentle", env.enterEnd));
        break;
      case "wipe": {
        const { l, t, r, b } = padded;
        const start: Record<Direction, BezierPath> = {
          right: rectPath(l, t, l, b),
          left: rectPath(r, t, r, b),
          down: rectPath(l, t, r, t),
          up: rectPath(l, b, r, b),
        };
        masks.push(
          rectMask(
            "reveal",
            enterExit<BezierPath>(ctx, env, {
              hidden: start[direction],
              shown: rectPath(l, t, r, b),
              ease: enter,
            }),
          ),
        );
        break;
      }
      case "blur":
        markOpacity = opacity(fadeWindow);
        effects.push(
          blurEffect(
            "blur",
            enterExit(ctx, env, {
              hidden: round3(Math.min(MAX_BLUR, 40 * style.scale)),
              shown: 0,
              ease: enter,
            }),
          ),
        );
        break;
      case "iris": {
        const reach = Math.hypot((padded.r - padded.l) / 2, (padded.b - padded.t) / 2) * 1.02;
        const mx = (padded.l + padded.r) / 2;
        const my = (padded.t + padded.b) / 2;
        masks.push(
          pathMask(
            "iris",
            enterExit<BezierPath>(ctx, env, {
              hidden: ellipsePath(mx, my, 0, 0),
              shown: ellipsePath(mx, my, reach, reach),
              ease: enter,
            }),
            "add",
          ),
        );
        break;
      }
      case "rise": {
        const lineWindow = win(0, 0.45);
        const riseWindow = win(0.3, 1);
        const lift = enterExit<number>(ctx, env, {
          hidden: round3(cy + style.distance("large")),
          shown: round3(cy),
          window: riseWindow,
          ease: enter,
        });
        markY = lift;
        markOpacity = opacity(riseWindow);
        // The mask keeps its edge in place on screen while the layer moves under it, so the mark
        // comes out from behind the line instead of sliding over everything.
        const clipL = box.l - pad * boxW;
        const clipR = box.r + pad * boxW;
        masks.push(
          rectMask(
            "clip",
            mapTrack(lift, (y) => rectPath(clipL, box.t - boxH, clipR, box.b - (y - cy) / fit)),
          ),
        );
        const lineH = Math.max(1, style.spacing("xs") / 2);
        extra.push(
          shapeLayer({
            id: "line",
            name: "Accent line",
            span: env.span,
            contents: [
              rectItem("line", { position: vec(0, 0), size: vec(screenW, lineH) }),
              fillItem("fill", accent),
            ],
            transform: {
              position: still(vec(screenMidX, screenBottom + lineH / 2)),
              scale: enterExit<Vec2>(ctx, env, {
                hidden: [0, 1],
                shown: [1, 1],
                gone: [0.94, 0.94],
                window: lineWindow,
                ease: enter,
              }),
              opacity: holdOpacity,
            },
          }),
        );
        break;
      }
      case "flip": {
        markOpacity = opacity(win(0, 0.3));
        markScale = enterExit<Vec2>(ctx, env, {
          hidden: [0, round3(fit)],
          shown: vec(fit, fit),
          gone: vec(0.94 * fit, 0.94 * fit),
          ease: enterEase(ctx, "snappy", env.enterEnd),
        });
        break;
      }
      case "glitch": {
        const shake = env.enterEnd;
        const step = Math.max(2, Math.ceil(shake / MAX_JITTER_KEYS));
        const jitter = [];
        for (let f = 0; f < shake; f += step)
          jitter.push(key(f, round3(cx + (ctx.random() * 2 - 1) * small), HOLD));
        markX = keys(...jitter, key(shake, round3(cx), HOLD));
        markOpacity =
          shake < 1
            ? holdOpacity
            : enterExit<number>(ctx, env, {
                hidden: 0,
                shown: 1,
                gone: 0,
                window: [0, 1],
                ease: HOLD,
              });
        effects.push(
          aberrationEffect(
            "aberration",
            enterExit(ctx, env, {
              hidden: round3(Math.min(MAX_ABERRATION, 24 * style.scale)),
              shown: 0,
              ease: enter,
            }),
          ),
        );
        break;
      }
      case "stamp": {
        markOpacity = opacity(win(0, 0.15));
        markScale = scaleOf([1.8, 1.8], enterEase(ctx, "bouncy", env.enterEnd));
        const landed = env.enterEnd;
        if (landed >= 3) {
          const from = Math.max(1, Math.round(landed * 0.3));
          extra.push(
            shapeLayer({
              id: "ring",
              name: "Accent ring",
              span: env.span,
              contents: [
                ellipseItem("ring", {
                  position: vec(0, 0),
                  size: vec(screenW * 1.1, screenH * 1.3),
                }),
                strokeItem("stroke", accent, style.spacing("xs")),
              ],
              transform: {
                position: still(vec(screenMidX, screenMidY)),
                scale: keys(key(from, [1, 1] as Vec2, enter), key(landed, [1.6, 1.6] as Vec2)),
                opacity: keys(key(0, 0, HOLD), key(from, 1, enter), key(landed, 0)),
              },
            }),
          );
        }
        break;
      }
    }

    if (props.glow === true)
      effects.push(
        glowEffect("glow", {
          radius: Math.min(MAX_BLUR, style.spacing("l")),
          color: accent,
          intensity: 0.6,
        }),
      );

    const layers: Layer[] = [];
    const tagline = props.tagline as string;
    if (tagline.length > 0) layers.push(taglineLayer());
    layers.push(
      mark({
        masks,
        effects,
        transform: {
          anchorPoint: still(vec(anchor[0], anchor[1])),
          position: position(markX, markY),
          scale: markScale,
          opacity: markOpacity,
        },
      }),
      ...extra,
    );
    // A component's own background is not drawn (a nested composition is transparent), so the
    // backdrop is also a solid at the bottom of the stack.
    const backdrop = props.useBackdrop === true ? (props.backdrop as string) : null;
    if (backdrop !== null)
      layers.push(
        solidLayer({
          id: "backdrop",
          name: "Backdrop",
          span: env.span,
          width: ctx.width,
          height: ctx.height,
          color: backdrop,
        }),
      );

    return {
      width: ctx.width,
      height: ctx.height,
      background: backdrop,
      layers,
    };

    /** The tagline: a box under the mark that fades up a beat after it. */
    function taglineLayer(): Layer {
      const type = style.type("body");
      const boxWidth = round3(0.9 * ctx.width);
      const boxHeight = round3(type.leading * type.size + 2);
      const centerY = screenBottom + style.spacing("m") + boxHeight / 2;
      const start = Math.min(Math.max(0, env.enterEnd - 1), style.stagger("base"));
      const window: [number, number] =
        env.enterEnd < 1
          ? [0, 0]
          : [start, Math.min(Math.max(env.exitStart, start + 1), env.enterEnd + start)];
      const rise = enterExit<number>(ctx, env, {
        hidden: round3(centerY + small),
        shown: round3(centerY),
        window,
        ease: enter,
      });
      return textLayer({
        id: "tagline",
        name: "Tagline",
        span: env.span,
        content: tagline,
        box: { mode: "box", width: boxWidth, height: boxHeight, autoFit: true },
        font: { family: type.family, weight: type.weight, size: round3(type.size) },
        tracking: type.tracking,
        leading: type.leading,
        align: "center",
        textCase: type.textCase,
        fill: props.taglineColor as string,
        transform: {
          anchorPoint: still(vec(boxWidth / 2, boxHeight / 2)),
          position: position(round3(ctx.width / 2), rise),
          scale: exitOnly<Vec2>(ctx, env, [1, 1], [0.94, 0.94]),
          opacity: enterExit(ctx, env, { hidden: 0, shown: 1, gone: 0, window, ease: enter }),
        },
      });
    }
  },
});
