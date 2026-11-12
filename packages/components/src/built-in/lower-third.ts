import type { TypeRole } from "@kynimo/guidelines";
import type { Animatable, Layer, Mask, ShapeItem } from "@kynimo/scene";
import { defineComponent } from "../define.js";
import {
  ellipseItem,
  enterExit,
  exitOnly,
  exitProp,
  fillItem,
  linePath,
  mapTrack,
  pathItem,
  position,
  propsEnvelope,
  rectItem,
  rectMask,
  rectPath,
  round3,
  shapeLayer,
  speedProp,
  still,
  strokeItem,
  textLayer,
  trimItem,
  vec,
} from "./kit.js";

const VARIANTS = ["bar", "plate", "underline", "split", "minimal", "outline"] as const;
type Variant = (typeof VARIANTS)[number];
const CORNERS = ["bottom-left", "bottom-right", "top-left", "top-right"] as const;

export const lowerThird = defineComponent({
  id: "lower-third",
  version: "1.0.0",
  title: "Lower third",
  description:
    "A name and title strap in a corner of the frame: a title and an optional subtitle with an accent bar, plate, underline, split plates, a dot or an outline. It enters at the start of the instance and slides out at its end.",
  props: {
    title: {
      type: "string",
      description: "The main line, usually a name; it shrinks to fit the width.",
      default: "Alex Rivera",
      maxLength: 120,
    },
    subtitle: {
      type: "string",
      description: "The second line, usually a role; an empty string leaves it out.",
      default: "Director of Motion",
      maxLength: 160,
    },
    variant: {
      type: "enum",
      description: "The look: bar, plate, underline, split, minimal or outline.",
      values: [...VARIANTS],
      default: "bar",
    },
    corner: {
      type: "enum",
      description:
        "Which corner it sits in; right corners right-align the text and slide in from the right.",
      values: [...CORNERS],
      default: "bottom-left",
    },
    width: {
      type: "number",
      description: "Width of the block as a fraction of the composition width, from 0.15 to 0.9.",
      default: 0.38,
      min: 0.15,
      max: 0.9,
    },
    titleRole: {
      type: "enum",
      description: "The type style of the title: headline, title or body.",
      values: ["headline", "title", "body"],
      default: "title",
    },
    subtitleRole: {
      type: "enum",
      description: "The type style of the subtitle: body, caption or label.",
      values: ["body", "caption", "label"],
      default: "body",
    },
    accent: {
      type: "color",
      description: "Color of the bar, line, dot, outline and the split title plate.",
      default: { role: "accent" },
    },
    plateColor: {
      type: "color",
      description: "Color of the plate behind the text (plate and split variants).",
      default: { role: "surface" },
    },
    titleColor: {
      type: "color",
      description: "Title color; the split variant uses the background color on its accent plate.",
      default: { role: "text" },
    },
    subtitleColor: {
      type: "color",
      description: "Subtitle color.",
      default: { role: "textMuted" },
    },
    speed: speedProp,
    exit: exitProp,
  },
  evaluate(props, ctx) {
    const { style } = ctx;
    const variant = props.variant as Variant;
    const left = (props.corner as string).endsWith("left");
    const bottom = (props.corner as string).startsWith("bottom");
    const env = propsEnvelope(ctx, props);
    const subtitle = props.subtitle as string;
    const hasSub = subtitle.length > 0;
    const accent = props.accent as string;

    // Geometry, in composition pixels. `side` is -1 where the block hangs off the left edge and 1
    // on the right: text slides in from that side. `into` points from the near edge into the frame.
    const side = left ? -1 : 1;
    const into = -side;
    const small = style.distance("small");
    const pad = style.spacing("m");
    const xs = style.spacing("xs");
    const marginX = Math.max(style.spacing("xl"), 0.05 * ctx.width);
    const marginY = Math.max(style.spacing("xl"), 0.05 * ctx.height);
    const blockW = round3((props.width as number) * ctx.width);
    const titleType = style.type(props.titleRole as TypeRole);
    const subType = style.type(props.subtitleRole as TypeRole);
    const titleH = round3(titleType.leading * titleType.size + 2);
    const subH = round3(subType.leading * subType.size + 2);
    const plated =
      variant === "bar" || variant === "plate" || variant === "split" || variant === "outline";
    const vpad = plated ? style.spacing("s") : 0;
    const barW = xs;
    const dotD = round3(xs * 1.5);
    const extra = variant === "bar" ? barW : variant === "minimal" ? dotD + style.spacing("s") : 0;
    const textW = round3(Math.max(1, blockW - pad - extra - pad));
    const rowGap = variant === "split" ? 2 * vpad : variant === "underline" ? 2 * xs : xs;
    const blockH = round3(2 * vpad + titleH + (hasSub ? rowGap + subH : 0));
    const nearX = left ? marginX : ctx.width - marginX;
    const top = round3(bottom ? ctx.height - marginY - blockH : marginY);
    const textLeft = round3(left ? nearX + pad + extra : nearX - pad - extra - textW);
    const titleTop = round3(top + vpad);
    const subTop = round3(titleTop + titleH + rowGap);
    const centerY = round3(top + blockH / 2);
    const lineStroke = round3(xs / 2);
    // The bar variant slides text farther so it starts behind the bar and is cut by a mask.
    const slide = variant === "bar" ? style.distance("base") : small;

    // Enter windows: fractions of the enter, delayed by the tight stagger for the subtitle.
    const stagger = style.stagger("tight");
    const ease = style.easing("enter");
    const win = (a: number, b: number, delay = 0): [number, number] => {
      const e = env.enterEnd;
      const s = Math.max(0, Math.min(e - 1, Math.round(e * a) + delay));
      return [s, Math.min(e, Math.max(s + 1, Math.round(e * b) + delay))];
    };

    const roundTrack = (t: Animatable<number>) => mapTrack(t, round3);

    // Motion of one layer resting at (x, y): fades in over `window`, optionally slides in from
    // the side and/or rises, and on the exit fades out and slides back toward the side.
    const motion = (
      x: number,
      y: number,
      o: { window: [number, number]; fade: boolean; fromDx?: number; fromDy?: number },
    ) => {
      const [from, to] = o.window;
      const exitX = x + side * small;
      const sliding = (o.fromDx ?? 0) !== 0;
      const dx = sliding
        ? enterExit(ctx, env, {
            hidden: x + (o.fromDx ?? 0),
            shown: x,
            gone: x + side * slide,
            window: [from, to],
            ease,
          })
        : exitOnly(ctx, env, x, exitX);
      const dy =
        (o.fromDy ?? 0) !== 0
          ? enterExit(ctx, env, { hidden: y + (o.fromDy ?? 0), shown: y, window: [from, to], ease })
          : still(y);
      const opacity = o.fade
        ? enterExit(ctx, env, { hidden: 0, shown: 1, gone: 0, window: [from, to], ease })
        : exitOnly(ctx, env, 1, 0);
      return { x: roundTrack(dx), y: roundTrack(dy), opacity };
    };

    const textLayers = (kinds: {
      title: { window: [number, number]; color: string; slideIn: boolean };
      sub: { window: [number, number]; slideIn: boolean };
    }): Layer[] => {
      const out: Layer[] = [];
      const make = (
        id: "title" | "subtitle",
        content: string,
        type: ReturnType<typeof style.type>,
        h: number,
        y: number,
        color: string,
        window: [number, number],
        slideIn: boolean,
      ) => {
        const m = motion(textLeft, y, {
          window,
          fade: true,
          fromDx: slideIn ? side * slide : 0,
          fromDy: slideIn ? 0 : small,
        });
        const masks: Mask[] = [];
        if (variant === "bar") {
          // Cut the text at the bar's inner edge as it slides, so it comes out from behind the
          // bar: the mask edge stays put on screen while the layer moves under it.
          const edge = (v: number) => {
            const d = v - textLeft;
            return left
              ? rectPath(-pad - d, -h, textW + pad, 2 * h)
              : rectPath(-pad, -h, textW + pad - d, 2 * h);
          };
          masks.push(rectMask(`${id}-clip`, mapTrack(m.x, edge)));
        }
        out.push(
          textLayer({
            id,
            name: id === "title" ? "Lower third title" : "Lower third subtitle",
            span: env.span,
            content,
            box: { mode: "box", width: textW, height: h, autoFit: true },
            font: { family: type.family, weight: type.weight, size: round3(type.size) },
            tracking: type.tracking,
            leading: type.leading,
            align: left ? "left" : "right",
            textCase: type.textCase,
            fill: color,
            masks,
            transform: { position: position(m.x, m.y), opacity: m.opacity },
          }),
        );
      };
      make(
        "title",
        props.title as string,
        titleType,
        titleH,
        titleTop,
        kinds.title.color,
        kinds.title.window,
        kinds.title.slideIn,
      );
      if (hasSub)
        make(
          "subtitle",
          subtitle,
          subType,
          subH,
          subTop,
          props.subtitleColor as string,
          kinds.sub.window,
          kinds.sub.slideIn,
        );
      return out;
    };

    /** A shape layer whose origin is the point `(x, y)`: scaled and faded from there. */
    const shapeAt = (
      id: string,
      name: string,
      x: number,
      y: number,
      contents: ShapeItem[],
      o: {
        scale?: Animatable<[number, number]>;
        fade?: { window: [number, number] };
      } = {},
    ): Layer => {
      const m = motion(x, y, { window: o.fade?.window ?? [0, 0], fade: o.fade !== undefined });
      return shapeLayer({
        id,
        name,
        span: env.span,
        contents,
        transform: {
          position: position(m.x, m.y),
          opacity: m.opacity,
          ...(o.scale === undefined ? {} : { scale: o.scale }),
        },
      });
    };
    const grow = (window: [number, number], from: [number, number]) =>
      enterExit<[number, number]>(ctx, env, { hidden: from, shown: [1, 1], window, ease });

    const layers: Layer[] = [];
    const fadeUpText = (titleColor: string, titleWin: [number, number], subWin: [number, number]) =>
      textLayers({
        title: { window: titleWin, color: titleColor, slideIn: false },
        sub: { window: subWin, slideIn: false },
      });

    switch (variant) {
      case "bar": {
        const w = win(0.4, 1);
        layers.push(
          ...textLayers({
            title: { window: w, color: props.titleColor as string, slideIn: true },
            sub: { window: win(0.4, 1, stagger), slideIn: true },
          }),
          shapeAt(
            "bar",
            "Lower third bar",
            round3(left ? nearX + barW / 2 : nearX - barW / 2),
            round3(top + blockH),
            [
              rectItem("bar", { position: vec(0, -blockH / 2), size: vec(barW, blockH) }),
              fillItem("fill", accent),
            ],
            { scale: grow(win(0, 0.6), [1, 0]) },
          ),
        );
        break;
      }
      case "plate":
        layers.push(
          ...fadeUpText(props.titleColor as string, win(0.4, 1), win(0.4, 1, stagger)),
          shapeAt(
            "plate",
            "Lower third plate",
            nearX,
            centerY,
            [
              rectItem("plate", {
                position: vec(into * (blockW / 2), 0),
                size: vec(blockW, blockH),
                cornerRadius: xs,
              }),
              fillItem("fill", props.plateColor as string),
            ],
            { scale: grow(win(0, 0.6), [0, 1]) },
          ),
        );
        break;
      case "underline": {
        const lineY = round3(titleTop + titleH + xs);
        const from = left ? 0 : textW;
        const to = left ? textW : 0;
        const w = win(0.4, 1);
        layers.push(
          ...fadeUpText(props.titleColor as string, win(0, 0.6), win(0.4, 1, stagger)),
          shapeAt("line", "Lower third line", textLeft, lineY, [
            pathItem("line", linePath(vec(from, 0), vec(to, 0))),
            strokeItem("stroke", accent, lineStroke),
            // The line draws on with the trim; the layer itself just fades out on the exit.
            trimItem("trim", {
              end: enterExit(ctx, env, { hidden: 0, shown: 1, window: w, ease }),
            }),
          ]),
        );
        break;
      }
      case "split": {
        const plateAH = round3(titleH + 2 * vpad);
        const plateBH = round3(subH + 2 * vpad);
        layers.push(
          ...fadeUpText(style.color("background"), win(0.4, 1), win(0.4, 1, stagger)),
          shapeAt(
            "plate-a",
            "Lower third title plate",
            nearX,
            round3(top + plateAH / 2),
            [
              rectItem("plate", {
                position: vec(into * (blockW / 2), 0),
                size: vec(blockW, plateAH),
                cornerRadius: 0,
              }),
              fillItem("fill", accent),
            ],
            { scale: grow(win(0, 0.5), [0, 1]) },
          ),
        );
        if (hasSub)
          layers.push(
            shapeAt(
              "plate-b",
              "Lower third subtitle plate",
              nearX,
              round3(top + plateAH + plateBH / 2),
              [
                rectItem("plate", {
                  position: vec(into * (blockW / 2), 0),
                  size: vec(blockW, plateBH),
                  cornerRadius: 0,
                }),
                fillItem("fill", props.plateColor as string),
              ],
              { scale: grow(win(0, 0.5, stagger), [0, 1]) },
            ),
          );
        break;
      }
      case "minimal": {
        const dotX = round3(left ? nearX + pad + dotD / 2 : nearX - pad - dotD / 2);
        layers.push(
          ...fadeUpText(props.titleColor as string, win(0.1, 0.7), win(0.1, 0.7, stagger)),
          shapeAt(
            "dot",
            "Lower third dot",
            dotX,
            round3(titleTop + titleH / 2),
            [
              ellipseItem("dot", { position: vec(0, 0), size: vec(dotD, dotD) }),
              fillItem("fill", accent),
            ],
            { scale: grow(win(0, 0.5), [0, 0]) },
          ),
        );
        break;
      }
      case "outline": {
        layers.push(
          ...fadeUpText(props.titleColor as string, win(0.4, 1), win(0.4, 1, stagger)),
          shapeAt("outline", "Lower third outline", round3(nearX + into * (blockW / 2)), centerY, [
            rectItem("frame", {
              position: vec(0, 0),
              size: vec(blockW - lineStroke, blockH - lineStroke),
              cornerRadius: xs,
            }),
            strokeItem("stroke", accent, lineStroke, { join: "round" }),
            trimItem("trim", {
              end: enterExit(ctx, env, { hidden: 0, shown: 1, window: win(0, 0.6), ease }),
            }),
          ]),
        );
        break;
      }
    }

    return { width: ctx.width, height: ctx.height, background: null, layers };
  },
});
